// MediaPipe Selfie Multiclass segmentation abstraction & drape masking.
// Plan section 4.1, 4.2, 5, and P1.2 / P1.3.
//
// HONESTY NOTE: this is a colour/geometry heuristic, not the Selfie Multiclass TFLite model. Face,
// neck, hair and clothing masks are derived from the measured face box plus per-pixel luma/chroma
// tests, and hair detection in particular only finds dark hair (luma < 90) - grey or bleached hair
// falls through to the forehead-strip fallback in sampler.ts. Running the real model is still open
// (P1.3).
//
// Produces:
//   - Face skin (class 1)
//   - Neck / body skin (class 2: below chin 152, bounded by jaw width)
//   - Hair (class 3)
//   - Clothes / drape region (class 4: below neck/jaw line, used for digital draping)
//
// Also evaluates the clothingBounce gate check (plan section 5): flags saturated clothing adjacent
// to the neck that would reflect colour onto skin pixels.

import type { RGB, Lab } from "../color/convert";
import { sRGBToLab, labToLCh } from "../color/convert";
import type { ImageBuffer } from "./sampler";
import type { FaceLandmarks } from "./faceLandmarker";

export type MulticlassSegmentation = {
  /** Face skin pixel mask (1 = face skin, 0 = other), length = width * height. */
  faceMask: Uint8Array;
  /** Neck skin pixel mask (1 = neck skin, 0 = other). */
  neckMask: Uint8Array;
  /** Hair mask (1 = hair, 0 = other). */
  hairMask: Uint8Array;
  /** Clothing / drape region mask (1 = clothing, 0 = other). */
  clothingMask: Uint8Array;
  /** Clothing color bounce check for the quality gate. */
  clothingBounce: {
    clothesAdjacentSaturated: boolean;
    adjacentChroma: number;
    adjacentLab: Lab;
  };
};

function px(img: ImageBuffer, x: number, y: number): RGB {
  const o = (y * img.width + x) * 4;
  return { r: img.data[o], g: img.data[o + 1], b: img.data[o + 2] };
}

/**
 * Derives multiclass segmentation masks from face landmarks and pixel statistics.
 * Heuristic estimator, not the Selfie Multiclass model: see the note at the top of this file.
 */
export function segmentMulticlass(
  img: ImageBuffer,
  landmarks: FaceLandmarks
): MulticlassSegmentation {
  const totalPx = img.width * img.height;
  const faceMask = new Uint8Array(totalPx);
  const neckMask = new Uint8Array(totalPx);
  const hairMask = new Uint8Array(totalPx);
  const clothingMask = new Uint8Array(totalPx);

  const chinPx = {
    x: Math.floor(landmarks.chin.x * img.width),
    y: Math.floor(landmarks.chin.y * img.height),
  };
  const foreheadPx = {
    x: Math.floor(landmarks.foreheadTop.x * img.width),
    y: Math.floor(landmarks.foreheadTop.y * img.height),
  };
  const leftJawPx = {
    x: Math.floor(landmarks.leftJaw.x * img.width),
    y: Math.floor(landmarks.leftJaw.y * img.height),
  };
  const rightJawPx = {
    x: Math.floor(landmarks.rightJaw.x * img.width),
    y: Math.floor(landmarks.rightJaw.y * img.height),
  };

  const faceCenter = {
    x: Math.floor((landmarks.leftIris.x + landmarks.rightIris.x) * 0.5 * img.width),
    y: Math.floor((foreheadPx.y + chinPx.y) * 0.5),
  };
  const faceRadiusX = Math.abs(rightJawPx.x - leftJawPx.x) * 0.5;
  const faceRadiusY = Math.abs(chinPx.y - foreheadPx.y) * 0.5;

  // Neck bounds: below chin, horizontally bounded within jaw width
  const neckTopY = chinPx.y;
  const neckBottomY = Math.min(img.height - 1, Math.floor(chinPx.y + faceRadiusY * 0.55));
  const neckHalfW = faceRadiusX * 0.65;

  // Drape / clothing bounds: from neck bottom down to chest/frame edge
  const drapeTopY = Math.floor(chinPx.y + faceRadiusY * 0.40);

  // Scan and categorize pixels
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const idx = y * img.width + x;
      const p = px(img, x, y);

      // Normalized distance to face oval
      const dx = (x - faceCenter.x) / Math.max(1, faceRadiusX);
      const dy = (y - faceCenter.y) / Math.max(1, faceRadiusY);
      const inFaceOval = dx * dx + dy * dy <= 1.0;

      // Hair detection: crown above forehead, sides outside cheek oval
      const isAboveBrows = y < foreheadPx.y + faceRadiusY * 0.35 && y >= Math.max(0, foreheadPx.y - faceRadiusY * 0.7);
      const isAroundCrown = Math.abs(x - faceCenter.x) <= faceRadiusX * 1.15;
      const isLateralHair = inFaceOval && Math.abs(dx) > 0.75 && y < chinPx.y - faceRadiusY * 0.3;

      // Dark, low saturation characteristics of typical hair
      const luma = 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;
      const isDark = luma < 90 && Math.abs(p.r - p.b) < 35;

      if ((isAboveBrows && isAroundCrown) || isLateralHair) {
        if (isDark) {
          hairMask[idx] = 1;
          continue;
        }
      }

      // Face skin
      if (inFaceOval && y < chinPx.y - faceRadiusY * 0.05) {
        faceMask[idx] = 1;
        continue;
      }

      // Neck skin
      if (y >= neckTopY && y <= neckBottomY && Math.abs(x - faceCenter.x) <= neckHalfW) {
        neckMask[idx] = 1;
        continue;
      }

      // Clothing / drape region
      if (y >= drapeTopY) {
        // Exclude neck
        if (!(y <= neckBottomY && Math.abs(x - faceCenter.x) <= neckHalfW * 0.85)) {
          clothingMask[idx] = 1;
        }
      }
    }
  }

  // Detect clothing bounce: inspect clothing pixels immediately adjacent to the neck
  const adjacentChromaSamples: number[] = [];
  const adjacentLabs: Lab[] = [];

  const checkY0 = Math.max(0, neckBottomY - 5);
  const checkY1 = Math.min(img.height - 1, neckBottomY + Math.floor(faceRadiusY * 0.35));

  for (let y = checkY0; y <= checkY1; y += 2) {
    for (let x = Math.floor(faceCenter.x - neckHalfW * 1.6); x <= Math.floor(faceCenter.x + neckHalfW * 1.6); x += 2) {
      if (x < 0 || x >= img.width) continue;
      const idx = y * img.width + x;
      if (clothingMask[idx]) {
        const p = px(img, x, y);
        const lab = sRGBToLab(p);
        const { C } = labToLCh(lab);
        adjacentChromaSamples.push(C);
        adjacentLabs.push(lab);
      }
    }
  }

  const adjacentChroma =
    adjacentChromaSamples.length > 0
      ? adjacentChromaSamples.reduce((a, b) => a + b, 0) / adjacentChromaSamples.length
      : 0;

  const meanAdjacentLab: Lab =
    adjacentLabs.length > 0
      ? {
          L: adjacentLabs.reduce((a, b) => a + b.L, 0) / adjacentLabs.length,
          a: adjacentLabs.reduce((a, b) => a + b.a, 0) / adjacentLabs.length,
          b: adjacentLabs.reduce((a, b) => a + b.b, 0) / adjacentLabs.length,
        }
      : { L: NaN, a: NaN, b: NaN };

  // Plan section 5 gate: saturated clothing adjacent to neck (> 24 Chroma) reflects colored light
  const clothesAdjacentSaturated = adjacentChroma > 24;

  return {
    faceMask,
    neckMask,
    hairMask,
    clothingMask,
    clothingBounce: {
      clothesAdjacentSaturated,
      adjacentChroma,
      adjacentLab: meanAdjacentLab,
    },
  };
}
