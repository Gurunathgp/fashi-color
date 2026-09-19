// Illuminant estimation from image statistics. Plan section P1.5.
//
// This is the piece the synthetic harness was previously missing: without an estimator, a test
// that hands the pipeline the true white point is an algebraic identity and cannot fail. Every
// method here works from pixels only.
//
// Ranked by how much the plan bets on them, cheapest first:
//   1. sclera / teeth as a built-in neutral reference - always present, but small and specular
//   2. skin-prior: faces are a strong colour-constancy cue
//   3. white paper held beside the neck - optional accuracy boost, near-universally available
//   4. grey-world / shades-of-grey - weak baseline, included for comparison
//
// Screen-as-illuminant and flash/no-flash are deferred per the plan's revision for low-end
// Android: they need per-device characterisation that is out of reach at zero budget.

import type { RGB, XYZ } from "../color/convert";
import { sRGBToLinear, linearToXYZ } from "../color/convert";
import { D65_WHITE, adaptXYZ, xyzToXy, estimateCCTandDuv } from "../color/adapt";

export type IlluminantEstimate = {
  /** Estimated scene white in XYZ, normalised to Y = 100. */
  white: XYZ;
  cct: number;
  duv: number;
  method: "sclera" | "skin-prior" | "white-reference" | "shades-of-grey" | "assumed-d65";
  /** 0..1 self-reported reliability, used to propagate into axis confidence. */
  reliability: number;
};

function normaliseToY100(xyz: XYZ): XYZ {
  if (!Number.isFinite(xyz.Y) || xyz.Y <= 1e-9) return { ...D65_WHITE };
  const k = 100 / xyz.Y;
  return { X: xyz.X * k, Y: 100, Z: xyz.Z * k };
}

function rgbToXYZ(rgb: RGB): XYZ {
  return linearToXYZ(sRGBToLinear(rgb));
}

function meanRGB(pixels: RGB[]): RGB {
  if (pixels.length === 0) return { r: 255, g: 255, b: 255 };
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of pixels) {
    r += p.r;
    g += p.g;
    b += p.b;
  }
  return { r: r / pixels.length, g: g / pixels.length, b: b / pixels.length };
}

/**
 * A neutral surface (paper, sclera, grey card) reflects the illuminant, so its measured XYZ *is*
 * the scene white up to a scale factor.
 */
export function fromNeutralPatch(
  pixels: RGB[],
  method: "sclera" | "white-reference",
  reliability: number
): IlluminantEstimate {
  const white = normaliseToY100(rgbToXYZ(meanRGB(pixels)));
  const { cct, duv } = estimateCCTandDuv(xyzToXy(white));
  return { white, cct, duv, method, reliability };
}

/**
 * Skin-prior estimation. Human skin chromaticity under a known illuminant occupies a narrow,
 * well-documented locus; the deviation of measured skin from that locus is attributable to the
 * illuminant. We solve for the von Kries gains that move measured skin onto the expected skin
 * chromaticity for the subject's own lightness.
 *
 * Deliberately conservative: it cannot separate a genuinely unusual undertone from a colour cast,
 * so reliability is capped and it should be blended with a neutral reference when one exists.
 */
export function fromSkinPrior(skinPixels: RGB[], expectedSkinXYZUnderD65: XYZ): IlluminantEstimate {
  const measured = rgbToXYZ(meanRGB(skinPixels));
  const expected = expectedSkinXYZUnderD65;
  // Gains that would carry expected -> measured are the illuminant's effect on a neutral.
  const gx = measured.X / Math.max(1e-9, expected.X);
  const gy = measured.Y / Math.max(1e-9, expected.Y);
  const gz = measured.Z / Math.max(1e-9, expected.Z);
  const white = normaliseToY100({ X: D65_WHITE.X * gx, Y: D65_WHITE.Y * gy, Z: D65_WHITE.Z * gz });
  const { cct, duv } = estimateCCTandDuv(xyzToXy(white));
  return { white, cct, duv, method: "skin-prior", reliability: 0.45 };
}

/**
 * Shades-of-grey (Minkowski p-norm) baseline. p=1 is grey-world, p=infinity is white-patch;
 * p=6 is the usual compromise. Weak on face close-ups because the frame is dominated by one hue,
 * which is exactly why it is only a fallback.
 */
export function fromShadesOfGrey(pixels: RGB[], p = 6): IlluminantEstimate {
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (const px of pixels) {
    const lin = sRGBToLinear(px);
    sr += Math.pow(lin.r, p);
    sg += Math.pow(lin.g, p);
    sb += Math.pow(lin.b, p);
  }
  const n = Math.max(1, pixels.length);
  const lin = {
    r: Math.pow(sr / n, 1 / p),
    g: Math.pow(sg / n, 1 / p),
    b: Math.pow(sb / n, 1 / p),
  };
  const white = normaliseToY100(linearToXYZ(lin));
  const { cct, duv } = estimateCCTandDuv(xyzToXy(white));
  return { white, cct, duv, method: "shades-of-grey", reliability: 0.2 };
}

export function assumedD65(): IlluminantEstimate {
  const { cct, duv } = estimateCCTandDuv(xyzToXy(D65_WHITE));
  return { white: { ...D65_WHITE }, cct, duv, method: "assumed-d65", reliability: 0.05 };
}

/**
 * Combine available estimates, weighting by reliability in the chromaticity plane. A white
 * reference dominates when present; sclera and skin-prior back each other up when it is not.
 */
export function combineEstimates(estimates: IlluminantEstimate[]): IlluminantEstimate {
  const usable = estimates.filter((e) => Number.isFinite(e.white.X) && Number.isFinite(e.white.Z));
  if (usable.length === 0) return assumedD65();
  if (usable.length === 1) return usable[0];
  let wsum = 0;
  let x = 0;
  let y = 0;
  for (const e of usable) {
    const xy = xyzToXy(e.white);
    x += xy.x * e.reliability;
    y += xy.y * e.reliability;
    wsum += e.reliability;
  }
  x /= wsum;
  y /= wsum;
  const white = normaliseToY100({ X: (x / y) * 100, Y: 100, Z: ((1 - x - y) / y) * 100 });
  const { cct, duv } = estimateCCTandDuv({ x, y });
  const best = usable.reduce((a, b) => (b.reliability > a.reliability ? b : a));
  return {
    white,
    cct,
    duv,
    method: best.method,
    // Agreement between independent methods is worth more than any single one.
    reliability: Math.min(0.95, best.reliability + 0.15 * (usable.length - 1)),
  };
}

/** Correct a measured colour to how it would appear under D65. */
export function correctToD65(rgb: RGB, estimate: IlluminantEstimate): XYZ {
  return adaptXYZ(rgbToXYZ(rgb), estimate.white, D65_WHITE);
}
