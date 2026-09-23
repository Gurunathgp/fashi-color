import { detectFaceLandmarks } from "../src/capture/faceLandmarker";
import { segmentMulticlass } from "../src/capture/segmentation";
import type { ImageBuffer } from "../src/capture/sampler";

function createSynthesizedFaceBuffer(opts: {
  width?: number;
  height?: number;
  clothingColor?: { r: number; g: number; b: number };
} = {}): ImageBuffer {
  const width = opts.width ?? 320;
  const height = opts.height ?? 320;
  const data = new Uint8Array(width * height * 4);

  const faceCenterX = width * 0.5;
  const faceCenterY = height * 0.45;
  const faceRadiusX = width * 0.22;
  const faceRadiusY = height * 0.30;

  const clothingColor = opts.clothingColor ?? { r: 180, g: 180, b: 180 }; // neutral grey default

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;

      const dx = (x - faceCenterX) / faceRadiusX;
      const dy = (y - faceCenterY) / faceRadiusY;
      const distSq = dx * dx + dy * dy;

      // Clothing region (lower quarter)
      if (y > faceCenterY + faceRadiusY * 0.75) {
        data[idx] = clothingColor.r;
        data[idx + 1] = clothingColor.g;
        data[idx + 2] = clothingColor.b;
        data[idx + 3] = 255;
        continue;
      }

      // Hair region (crown / top above forehead)
      if (y < faceCenterY - faceRadiusY * 0.75 && Math.abs(x - faceCenterX) < faceRadiusX * 1.1) {
        data[idx] = 20; // dark hair
        data[idx + 1] = 18;
        data[idx + 2] = 18;
        data[idx + 3] = 255;
        continue;
      }

      // Face skin region
      if (distSq <= 1.0) {
        // Eye level features
        const eyeY = faceCenterY - faceRadiusY * 0.15;
        const leftEyeX = faceCenterX - faceRadiusX * 0.45;
        const rightEyeX = faceCenterX + faceRadiusX * 0.45;

        const dLeftEye = Math.hypot(x - leftEyeX, y - eyeY);
        const dRightEye = Math.hypot(x - rightEyeX, y - eyeY);

        if (dLeftEye < 6 || dRightEye < 6) {
          // Dark pupil / iris
          data[idx] = 25;
          data[idx + 1] = 20;
          data[idx + 2] = 18;
        } else if (dLeftEye < 14 || dRightEye < 14) {
          // White sclera
          data[idx] = 230;
          data[idx + 1] = 228;
          data[idx + 2] = 225;
        } else {
          // Warm wheatish skin
          data[idx] = 190;
          data[idx + 1] = 145;
          data[idx + 2] = 115;
        }
      } else {
        // Neutral background
        data[idx] = 210;
        data[idx + 1] = 210;
        data[idx + 2] = 210;
      }
      data[idx + 3] = 255;
    }
  }

  return { width, height, data };
}

describe("MediaPipe Face Landmarker & Multiclass Segmentation", () => {
  test("detects facial landmarks with 478 anchor points and valid geometry", () => {
    const img = createSynthesizedFaceBuffer();
    const result = detectFaceLandmarks(img);

    expect(result.confidence).toBeGreaterThan(0.3);
    expect(result.geometry.box.w).toBeGreaterThan(0.2);
    expect(result.geometry.box.h).toBeGreaterThan(0.3);
    expect(result.geometry.ipdPx).toBeGreaterThan(30);

    // Centered synthetic face should have small yaw and pitch (< 15 degrees)
    expect(Math.abs(result.geometry.yaw)).toBeLessThanOrEqual(15);
    expect(Math.abs(result.geometry.pitch)).toBeLessThanOrEqual(15);

    // Landmark anchors
    expect(result.landmarks.chin.y).toBeGreaterThan(result.landmarks.noseTip.y);
    expect(result.landmarks.noseTip.y).toBeGreaterThan(result.landmarks.foreheadTop.y);
    expect(result.landmarks.leftIris.x).toBeLessThan(result.landmarks.rightIris.x);
    expect(result.landmarks.points).toHaveLength(478);
  });

  test("extracts sclera pixels for illuminant estimation prior", () => {
    const img = createSynthesizedFaceBuffer();
    const result = detectFaceLandmarks(img);

    expect(result.scleraPixels.length).toBeGreaterThan(0);
    // Sclera pixels should be bright and near neutral
    for (const p of result.scleraPixels) {
      expect(p.r).toBeGreaterThan(150);
      expect(Math.abs(p.r - p.b)).toBeLessThan(35);
    }
  });

  test("segments multiclass regions: face, neck, hair, and clothing", () => {
    const img = createSynthesizedFaceBuffer();
    const { landmarks } = detectFaceLandmarks(img);
    const seg = segmentMulticlass(img, landmarks);

    const countMask = (mask: Uint8Array) => mask.reduce((acc, v) => acc + (v ? 1 : 0), 0);

    expect(countMask(seg.faceMask)).toBeGreaterThan(500);
    expect(countMask(seg.neckMask)).toBeGreaterThan(100);
    expect(countMask(seg.hairMask)).toBeGreaterThan(200);
    expect(countMask(seg.clothingMask)).toBeGreaterThan(500);
  });

  test("flags saturated clothing bounce next to the neck", () => {
    // Neutral grey clothing
    const neutralImg = createSynthesizedFaceBuffer({
      clothingColor: { r: 160, g: 160, b: 160 },
    });
    const { landmarks: lm1 } = detectFaceLandmarks(neutralImg);
    const seg1 = segmentMulticlass(neutralImg, lm1);
    expect(seg1.clothingBounce.clothesAdjacentSaturated).toBe(false);

    // Highly saturated scarlet red clothing
    const saturatedImg = createSynthesizedFaceBuffer({
      clothingColor: { r: 235, g: 25, b: 35 },
    });
    const { landmarks: lm2 } = detectFaceLandmarks(saturatedImg);
    const seg2 = segmentMulticlass(saturatedImg, lm2);
    expect(seg2.clothingBounce.clothesAdjacentSaturated).toBe(true);
    expect(seg2.clothingBounce.adjacentChroma).toBeGreaterThan(25);
  });
});
