// MediaPipe Face Landmarker abstraction & feature geometry detector.
// Plan section 4.1, 4.2, and P1.2.
//
// HONESTY NOTE: this is a pixel-based geometric ESTIMATOR, not the MediaPipe model. The 478 point
// slots are filled from a measured face box (skin-density bounding box + darkest-pixel eye
// refinement) and only the eleven MediaPipe indices the rest of the app reads are anchored:
//   - Chin landmark 152
//   - Forehead top landmark 10
//   - Left iris center 468, right iris center 473
//   - Left/right eye canthi (33, 133, 263, 362)
//   - Nose tip landmark 1
//   - Left/right jaw lateral bounds (234, 454)
// Running the actual TFLite Face Landmarker is still open (P1.2); until then treat pose, iris
// positions and sclera picks as approximate.
//
// Computes head pose (yaw, pitch) to unlock the quality gate, and isolates sclera pixels to provide
// the physical white-reference illuminant prior.

import type { RGB } from "../color/convert";
import { sRGBToLab, labToLCh } from "../color/convert";
import type { FaceGeometry, ImageBuffer } from "./sampler";

export type NormalizedPoint = { x: number; y: number; z?: number };

/**
 * Confidence at or above which the estimated face box is treated as a real measurement.
 * The estimator returns 0.2 for "skin-like pixels found, but the box is not a plausible face" and 0
 * for "nothing found". Callers (quality gate, pose checks) must treat anything below this as
 * *not measured* rather than as a pass - refusing beats guessing, per plan section 5.
 */
export const MIN_PLAUSIBLE_FACE_CONFIDENCE = 0.3;

export type FaceLandmarks = {
  /** 478 normalized points (0..1 across width/height). */
  points: NormalizedPoint[];
  /** Chin tip (landmark 152). */
  chin: NormalizedPoint;
  /** Forehead top anchor (landmark 10). */
  foreheadTop: NormalizedPoint;
  /** Nose tip (landmark 1). */
  noseTip: NormalizedPoint;
  /** Left eye center / iris (landmark 468). */
  leftIris: NormalizedPoint;
  /** Right eye center / iris (landmark 473). */
  rightIris: NormalizedPoint;
  /** Left jaw lateral anchor (landmark 234). */
  leftJaw: NormalizedPoint;
  /** Right jaw lateral anchor (landmark 454). */
  rightJaw: NormalizedPoint;
  /** Left eye canthi: outer (33), inner (133). */
  leftEye: { inner: NormalizedPoint; outer: NormalizedPoint };
  /** Right eye canthi: inner (362), outer (263). */
  rightEye: { inner: NormalizedPoint; outer: NormalizedPoint };
};

export type LandmarkDetectionResult = {
  landmarks: FaceLandmarks;
  geometry: FaceGeometry;
  confidence: number;
  /** Measured sclera pixels from eye regions around iris, for illuminant estimation. */
  scleraPixels: RGB[];
};

function px(img: ImageBuffer, x: number, y: number): RGB {
  const o = (y * img.width + x) * 4;
  return { r: img.data[o], g: img.data[o + 1], b: img.data[o + 2] };
}

/**
 * Detects face geometry and facial landmarks from an ImageBuffer.
 * Compatible with MediaPipe Face Mesh landmark indices.
 */
export function detectFaceLandmarks(img: ImageBuffer): LandmarkDetectionResult {
  // 1. Locate face bounding region by 2D skin density & feature clustering
  const step = Math.max(1, Math.floor(Math.min(img.width, img.height) / 180));
  let minX = img.width;
  let maxX = 0;
  let minY = img.height;
  let maxY = 0;
  let skinHits = 0;

  const skinMap: boolean[] = new Array(img.width * img.height).fill(false);

  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const p = px(img, x, y);
      // Skin-like check: R > G > B, reasonable saturation, not clipped
      if (p.r > 55 && p.r < 250 && p.r > p.g + 6 && p.g > p.b && p.r - p.b < 130) {
        skinMap[y * img.width + x] = true;
        skinHits++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const totalGrid = Math.ceil(img.width / step) * Math.ceil(img.height / step);
  const coverage = skinHits / Math.max(1, totalGrid);

  // Fallback / default bounding box if no face found
  if (skinHits < 20 || maxX <= minX || maxY <= minY) {
    const defaultBox = { x: 0.25, y: 0.15, w: 0.5, h: 0.6 };
    return makeFallbackLandmarks(defaultBox, img, 0);
  }

  // Refine bounding box insets to eliminate edge artifacts (hair/clothing leakage)
  const faceW = (maxX - minX) / img.width;
  const faceH = (maxY - minY) / img.height;
  const faceX = minX / img.width;
  const faceY = minY / img.height;

  const box = {
    x: Math.max(0, faceX + faceW * 0.04),
    y: Math.max(0, faceY + faceH * 0.03),
    w: Math.min(1 - faceX, faceW * 0.92),
    h: Math.min(1 - faceY, faceH * 0.94),
  };

  // 2. Identify eye level and feature landmarks
  // In typical facial geometry, eyes sit roughly at 38-46% from the top of the face box
  const eyeLevelY = box.y + box.h * 0.40;
  const leftEyeX = box.x + box.w * 0.32;
  const rightEyeX = box.x + box.w * 0.68;
  const noseTipY = box.y + box.h * 0.58;
  const noseTipX = box.x + box.w * 0.50;
  const chinY = Math.min(0.98, box.y + box.h);
  const foreheadY = Math.max(0.02, box.y + box.h * 0.08);

  // Refine eye positions by searching for darker pupil/iris dip in the eye region
  const leftIris = refinePupil(img, leftEyeX, eyeLevelY, box.w * 0.28, box.h * 0.20);
  const rightIris = refinePupil(img, rightEyeX, eyeLevelY, box.w * 0.28, box.h * 0.20);

  const ipdPx = Math.hypot((rightIris.x - leftIris.x) * img.width, (rightIris.y - leftIris.y) * img.height);

  // 3. Compute head pose (yaw, pitch)
  // Yaw: asymmetry of distance from nose tip to eye centers and lateral jaw
  const dLeft = noseTipX - leftIris.x;
  const dRight = rightIris.x - noseTipX;
  const yawAsymmetry = (dRight - dLeft) / Math.max(1e-4, dRight + dLeft);
  const yaw = Math.max(-45, Math.min(45, yawAsymmetry * 40));

  // Pitch: vertical ratio of forehead-to-nose vs nose-to-chin
  const topSpan = noseTipY - foreheadY;
  const botSpan = chinY - noseTipY;
  const pitchRatio = (botSpan - topSpan) / Math.max(1e-4, topSpan + botSpan);
  const pitch = Math.max(-40, Math.min(40, pitchRatio * 35));

  // 4. Sample sclera pixels from medial and lateral areas beside both irises
  const scleraPixels = sampleSclera(img, leftIris, rightIris, box);

  // Build landmark points
  const points: NormalizedPoint[] = new Array(478);
  // Default grid populate
  for (let i = 0; i < 478; i++) {
    points[i] = { x: box.x + (box.w * (i % 20)) / 20, y: box.y + (box.h * Math.floor(i / 20)) / 24 };
  }

  const chin = { x: noseTipX, y: chinY };
  const foreheadTop = { x: noseTipX, y: foreheadY };
  const noseTip = { x: noseTipX, y: noseTipY };
  const leftJaw = { x: box.x, y: eyeLevelY + box.h * 0.25 };
  const rightJaw = { x: box.x + box.w, y: eyeLevelY + box.h * 0.25 };

  const leftEye = {
    outer: { x: Math.max(box.x, leftIris.x - box.w * 0.09), y: leftIris.y },
    inner: { x: Math.min(noseTipX, leftIris.x + box.w * 0.09), y: leftIris.y },
  };
  const rightEye = {
    inner: { x: Math.max(noseTipX, rightIris.x - box.w * 0.09), y: rightIris.y },
    outer: { x: Math.min(box.x + box.w, rightIris.x + box.w * 0.09), y: rightIris.y },
  };

  // Anchor key indices (MediaPipe 468/478 mesh standard)
  points[152] = chin;
  points[10] = foreheadTop;
  points[1] = noseTip;
  points[468] = leftIris;
  points[473] = rightIris;
  points[234] = leftJaw;
  points[454] = rightJaw;
  points[33] = leftEye.outer;
  points[133] = leftEye.inner;
  points[362] = rightEye.inner;
  points[263] = rightEye.outer;

  const plausible = coverage > 0.04 && coverage < 0.88 && box.w > 0.15 && box.h > 0.20;
  const boxArea = box.w * box.h;
  const confidence = plausible ? Math.min(0.95, Math.max(0.4, coverage * 2.5, boxArea * 2.2)) : 0.2;

  const geometry: FaceGeometry = {
    box,
    ipdPx,
    yaw,
    pitch,
  };

  return {
    landmarks: {
      points,
      chin,
      foreheadTop,
      noseTip,
      leftIris,
      rightIris,
      leftJaw,
      rightJaw,
      leftEye,
      rightEye,
    },
    geometry,
    confidence,
    scleraPixels,
  };
}

function refinePupil(
  img: ImageBuffer,
  approxX: number,
  approxY: number,
  spanW: number,
  spanH: number
): NormalizedPoint {
  const x0 = Math.max(0, Math.floor((approxX - spanW / 2) * img.width));
  const x1 = Math.min(img.width - 1, Math.ceil((approxX + spanW / 2) * img.width));
  const y0 = Math.max(0, Math.floor((approxY - spanH / 2) * img.height));
  const y1 = Math.min(img.height - 1, Math.ceil((approxY + spanH / 2) * img.height));

  let minLuma = Infinity;
  let bestX = approxX * img.width;
  let bestY = approxY * img.height;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = px(img, x, y);
      const luma = 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;
      if (luma < minLuma) {
        minLuma = luma;
        bestX = x;
        bestY = y;
      }
    }
  }

  return { x: bestX / img.width, y: bestY / img.height };
}

function sampleSclera(
  img: ImageBuffer,
  leftIris: NormalizedPoint,
  rightIris: NormalizedPoint,
  box: { x: number; y: number; w: number; h: number }
): RGB[] {
  const sclera: RGB[] = [];
  const irises = [leftIris, rightIris];

  const minOffsetPx = Math.max(4, Math.floor(box.w * img.width * 0.035));
  const maxOffsetPx = Math.max(8, Math.floor(box.w * img.width * 0.10));
  const halfHPx = Math.max(2, Math.floor(box.h * img.height * 0.025));

  for (const iris of irises) {
    const cx = Math.floor(iris.x * img.width);
    const cy = Math.floor(iris.y * img.height);

    // Search lateral (left) and medial (right) flanks of each eye
    const flanks = [
      { start: cx - maxOffsetPx, end: cx - minOffsetPx },
      { start: cx + minOffsetPx, end: cx + maxOffsetPx },
    ];

    for (const flank of flanks) {
      for (let y = cy - halfHPx; y <= cy + halfHPx; y++) {
        for (let x = flank.start; x <= flank.end; x++) {
          if (x < 0 || x >= img.width || y < 0 || y >= img.height) continue;
          const p = px(img, x, y);
          // Exclude blown-out pixels
          if (p.r >= 252 || p.g >= 252 || p.b >= 252) continue;
          const lab = sRGBToLab(p);
          const { C } = labToLCh(lab);
          // Sclera: pale, near-neutral, moderate-to-high lightness
          if (lab.L >= 45 && C <= 25) {
            sclera.push(p);
          }
        }
      }
    }
  }

  return sclera;
}

function makeFallbackLandmarks(
  box: { x: number; y: number; w: number; h: number },
  img: ImageBuffer,
  confidence: number
): LandmarkDetectionResult {
  const noseTipX = box.x + box.w * 0.5;
  const eyeY = box.y + box.h * 0.40;
  const leftIris = { x: box.x + box.w * 0.35, y: eyeY };
  const rightIris = { x: box.x + box.w * 0.65, y: eyeY };

  const chin = { x: noseTipX, y: box.y + box.h };
  const foreheadTop = { x: noseTipX, y: box.y + box.h * 0.08 };
  const noseTip = { x: noseTipX, y: box.y + box.h * 0.58 };
  const leftJaw = { x: box.x, y: eyeY + box.h * 0.25 };
  const rightJaw = { x: box.x + box.w, y: eyeY + box.h * 0.25 };

  const points: NormalizedPoint[] = new Array(478).fill(noseTip);

  return {
    landmarks: {
      points,
      chin,
      foreheadTop,
      noseTip,
      leftIris,
      rightIris,
      leftJaw,
      rightJaw,
      leftEye: { inner: leftIris, outer: leftIris },
      rightEye: { inner: rightIris, outer: rightIris },
    },
    geometry: {
      box,
      ipdPx: 0.46 * box.w * img.width,
      yaw: 0,
      pitch: 0,
    },
    confidence,
    scleraPixels: [],
  };
}
