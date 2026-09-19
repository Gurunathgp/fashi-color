// Region sampling and pixel rejection. Plan section 4.
//
// Everything here operates on a plain RGBA buffer plus a face geometry description, so it is
// testable without MediaPipe and can later be fed by a real Face Landmarker + Selfie Multiclass
// mask without changing the maths. Until those models land, geometry comes from a coarse face
// box, which is enough to compute honest gate metrics from real pixels rather than the hardcoded
// constants the app previously passed in.

import type { Lab, RGB } from "../color/convert";
import { sRGBToLab, deltaE00, labToLCh } from "../color/convert";

export type ImageBuffer = {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array | Uint8ClampedArray | number[];
};

/** Normalised (0..1) face geometry. Replaceable by real landmarks later. */
export type FaceGeometry = {
  /** Face oval bounding box. */
  box: { x: number; y: number; w: number; h: number };
  /** Inter-pupillary distance in pixels, for the size gate. */
  ipdPx: number;
  yaw: number;
  pitch: number;
};

export type RegionName = "neck" | "jaw" | "forehead" | "cheekLeft" | "cheekRight" | "sclera";

export type RegionStats = {
  region: RegionName;
  /** Pixels that survived rejection. */
  n: number;
  /** Pixels considered before rejection. */
  considered: number;
  lab: Lab;
  rgb: RGB;
  /** Robust spread of L* within the region, for uniformity checks. */
  madL: number;
};

function px(img: ImageBuffer, x: number, y: number): RGB {
  const o = (y * img.width + x) * 4;
  return { r: img.data[o], g: img.data[o + 1], b: img.data[o + 2] };
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function madOf(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/**
 * Geometric median in the (a*, b*) plane by Weiszfeld iteration, as the plan specifies. More
 * resistant than a per-channel median because it does not treat a* and b* independently.
 */
export function geometricMedianAB(points: { a: number; b: number }[]): { a: number; b: number } {
  if (points.length === 0) return { a: NaN, b: NaN };
  let a = median(points.map((p) => p.a));
  let b = median(points.map((p) => p.b));
  for (let iter = 0; iter < 64; iter++) {
    let wsum = 0;
    let na = 0;
    let nb = 0;
    let coincident = false;
    for (const p of points) {
      const d = Math.hypot(p.a - a, p.b - b);
      if (d < 1e-9) {
        coincident = true;
        continue;
      }
      const w = 1 / d;
      na += p.a * w;
      nb += p.b * w;
      wsum += w;
    }
    if (wsum === 0) break;
    const ca = na / wsum;
    const cb = nb / wsum;
    const moved = Math.hypot(ca - a, cb - b);
    a = ca;
    b = cb;
    if (moved < 1e-6 || coincident) break;
  }
  return { a, b };
}

/** Erythema proxy. Used only to REJECT blush/rosacea pixels; 3-channel sRGB cannot support a
 *  physiological melanin/haemoglobin claim, and the plan is explicit about that limit. */
export function erythemaProxy(rgb: RGB): number {
  const g = Math.max(1, rgb.g) / 255;
  const r = Math.max(1, rgb.r) / 255;
  return Math.log10(1 / g) - Math.log10(1 / r);
}

/** Rough skin-likelihood gate so background pixels cannot leak into a region. */
export function looksLikeSkin(rgb: RGB): boolean {
  const { r, g, b } = rgb;
  if (r < 40 || r > 250) return false;
  if (!(r > g && g > b)) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 8) return false;
  const lab = sRGBToLab(rgb);
  const { C, h } = labToLCh(lab);
  return C > 4 && C < 60 && h > 10 && h < 90;
}

export type SampleOptions = {
  /** Skip the skin-likelihood gate, e.g. when sampling sclera or a white reference. */
  skipSkinGate?: boolean;
};

/**
 * Sample a rectangular sub-region with the plan's rejection rules:
 * specular top 3% luminance, any channel >= 250 (clipped) or all <= 8, L* below region median - 15
 * (shadow), erythema above median + 3 MAD, and non-skin pixels.
 */
export function sampleRegion(
  img: ImageBuffer,
  region: RegionName,
  rect: { x: number; y: number; w: number; h: number },
  opts: SampleOptions = {}
): RegionStats {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(img.width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(img.height, Math.ceil(rect.y + rect.h));

  const raw: { rgb: RGB; lab: Lab; ery: number }[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const rgb = px(img, x, y);
      if (rgb.r >= 250 || rgb.g >= 250 || rgb.b >= 250) continue;
      if (rgb.r <= 8 && rgb.g <= 8 && rgb.b <= 8) continue;
      if (!opts.skipSkinGate && !looksLikeSkin(rgb)) continue;
      raw.push({ rgb, lab: sRGBToLab(rgb), ery: erythemaProxy(rgb) });
    }
  }
  const considered = (x1 - x0) * (y1 - y0);
  if (raw.length === 0) {
    return {
      region,
      n: 0,
      considered,
      lab: { L: NaN, a: NaN, b: NaN },
      rgb: { r: NaN, g: NaN, b: NaN },
      madL: NaN,
    };
  }

  const Ls = raw.map((p) => p.lab.L);
  const medL = median(Ls);
  const specularCut = [...Ls].sort((a, b) => a - b)[Math.floor(Ls.length * 0.97)];
  const eryMed = median(raw.map((p) => p.ery));
  const eryMad = madOf(raw.map((p) => p.ery)) || 1e-6;

  const kept = raw.filter(
    (p) => p.lab.L <= specularCut && p.lab.L >= medL - 15 && p.ery <= eryMed + 3 * eryMad
  );
  const use = kept.length >= 8 ? kept : raw;

  const L = median(use.map((p) => p.lab.L));
  const ab = geometricMedianAB(use.map((p) => ({ a: p.lab.a, b: p.lab.b })));
  const rgb = {
    r: median(use.map((p) => p.rgb.r)),
    g: median(use.map((p) => p.rgb.g)),
    b: median(use.map((p) => p.rgb.b)),
  };
  return {
    region,
    n: use.length,
    considered,
    lab: { L, a: ab.a, b: ab.b },
    rgb,
    madL: madOf(use.map((p) => p.lab.L)),
  };
}

// ---------------------------------------------------------------------------
// Region layout
// ---------------------------------------------------------------------------

/**
 * Derive sampling rectangles from the face box. Deliberately conservative insets so the regions
 * stay well inside the face and clear of hair, nostrils and the blush zone.
 *
 * Weights follow the plan: neck 0.50, jaw 0.30, forehead 0.20. Neck carries the most because it
 * has the least makeup, least tan and no blush zone; forehead is worst for specular and tanning.
 */
export const REGION_WEIGHTS: Record<"neck" | "jaw" | "forehead", number> = {
  neck: 0.5,
  jaw: 0.3,
  forehead: 0.2,
};

export function regionRects(geo: FaceGeometry, img: ImageBuffer) {
  const { x, y, w, h } = geo.box;
  const X = x * img.width;
  const Y = y * img.height;
  const W = w * img.width;
  const H = h * img.height;
  return {
    forehead: { x: X + W * 0.3, y: Y + H * 0.1, w: W * 0.4, h: H * 0.1 },
    jaw: { x: X + W * 0.28, y: Y + H * 0.74, w: W * 0.44, h: H * 0.1 },
    // Below the chin; clamped to the frame by sampleRegion.
    neck: { x: X + W * 0.32, y: Y + H * 1.0, w: W * 0.36, h: H * 0.16 },
    cheekLeft: { x: X + W * 0.14, y: Y + H * 0.5, w: W * 0.16, h: H * 0.12 },
    cheekRight: { x: X + W * 0.7, y: Y + H * 0.5, w: W * 0.16, h: H * 0.12 },
  };
}

export type SkinMeasurement = {
  regions: RegionStats[];
  /** Weighted combination across neck/jaw/forehead. */
  skin: Lab;
  /** Largest pairwise dE00 between contributing regions. Feeds confidence honestly: if the three
   *  sites disagree, something contaminated the measurement. */
  regionSpreadDE00: number;
  /** Cheek vs neck difference; above 6 the plan switches to neck-only sampling (makeup). */
  cheekNeckDE00: number;
};

export function measureSkin(img: ImageBuffer, geo: FaceGeometry): SkinMeasurement {
  const rects = regionRects(geo, img);
  const stats: RegionStats[] = [
    sampleRegion(img, "neck", rects.neck),
    sampleRegion(img, "jaw", rects.jaw),
    sampleRegion(img, "forehead", rects.forehead),
  ];
  const cheekL = sampleRegion(img, "cheekLeft", rects.cheekLeft);
  const cheekR = sampleRegion(img, "cheekRight", rects.cheekRight);

  const valid = stats.filter((s) => s.n > 0 && Number.isFinite(s.lab.L));
  if (valid.length === 0) {
    return {
      regions: [...stats, cheekL, cheekR],
      skin: { L: NaN, a: NaN, b: NaN },
      regionSpreadDE00: NaN,
      cheekNeckDE00: NaN,
    };
  }

  let wsum = 0;
  let L = 0;
  let a = 0;
  let b = 0;
  for (const s of valid) {
    const w = REGION_WEIGHTS[s.region as "neck" | "jaw" | "forehead"] ?? 0;
    wsum += w;
    L += s.lab.L * w;
    a += s.lab.a * w;
    b += s.lab.b * w;
  }
  const skin = wsum > 0 ? { L: L / wsum, a: a / wsum, b: b / wsum } : valid[0].lab;

  let spread = 0;
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      spread = Math.max(spread, deltaE00(valid[i].lab, valid[j].lab));
    }
  }

  const neck = stats.find((s) => s.region === "neck");
  const cheeks = [cheekL, cheekR].filter((c) => c.n > 0);
  const cheekNeck =
    neck && neck.n > 0 && cheeks.length > 0
      ? Math.min(...cheeks.map((c) => deltaE00(c.lab, neck.lab)))
      : NaN;

  return {
    regions: [...stats, cheekL, cheekR],
    skin,
    regionSpreadDE00: spread,
    cheekNeckDE00: cheekNeck,
  };
}

/** Hair sample: strip above the forehead. Replace with the Selfie Multiclass hair mask later. */
export function measureHair(img: ImageBuffer, geo: FaceGeometry): RegionStats {
  const { x, y, w, h } = geo.box;
  const rect = {
    x: x * img.width + w * img.width * 0.3,
    y: Math.max(0, y * img.height - h * img.height * 0.12),
    w: w * img.width * 0.4,
    h: h * img.height * 0.1,
  };
  return sampleRegion(img, "forehead", rect, { skipSkinGate: true });
}

// ---------------------------------------------------------------------------
// Gate metrics, computed from pixels
// ---------------------------------------------------------------------------

/** Variance of a 3x3 Laplacian over the luma of a region: the standard blur measure. */
export function laplacianVariance(img: ImageBuffer, rect: { x: number; y: number; w: number; h: number }): number {
  const x0 = Math.max(1, Math.floor(rect.x));
  const y0 = Math.max(1, Math.floor(rect.y));
  const x1 = Math.min(img.width - 1, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(img.height - 1, Math.ceil(rect.y + rect.h));
  const luma = (x: number, y: number) => {
    const p = px(img, x, y);
    return 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;
  };
  const vals: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      vals.push(luma(x, y - 1) + luma(x, y + 1) + luma(x - 1, y) + luma(x + 1, y) - 4 * luma(x, y));
    }
  }
  if (vals.length === 0) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
}

/**
 * High-frequency energy in the skin region, normalised by region contrast. Beautification filters
 * smooth pores away, so an abnormally low value means the ISP is rewriting the pixels being
 * measured - the dominant capture problem on cheap Android in this market.
 */
export function highFrequencyEnergy(img: ImageBuffer, rect: { x: number; y: number; w: number; h: number }): number {
  const lap = laplacianVariance(img, rect);
  const stats = sampleRegion(img, "jaw", rect, { skipSkinGate: true });
  const scale = Number.isFinite(stats.madL) && stats.madL > 0.5 ? stats.madL : 1;
  return lap / scale;
}

export type ComputedGateMetrics = {
  ipdPx: number;
  faceBoxRatio: number;
  laplacianVar: number;
  clippedRatio: number;
  medianLLeft: number;
  medianLRight: number;
  medianLForehead: number;
  medianLChin: number;
  shadowRatio: number;
  yaw: number;
  pitch: number;
  cheekNeckDE00: number;
  highFreqEnergy: number;
  regionSpreadDE00: number;
  /** Pixels that survived rejection across the three skin regions; a floor guards tiny samples. */
  skinPixelCount: number;
};

export function computeGateMetrics(
  img: ImageBuffer,
  geo: FaceGeometry,
  measurement: SkinMeasurement
): ComputedGateMetrics {
  const rects = regionRects(geo, img);
  const faceRect = {
    x: geo.box.x * img.width,
    y: geo.box.y * img.height,
    w: geo.box.w * img.width,
    h: geo.box.h * img.height,
  };

  // Clipping across the face box.
  let clipped = 0;
  let total = 0;
  const Ls: number[] = [];
  const x0 = Math.max(0, Math.floor(faceRect.x));
  const y0 = Math.max(0, Math.floor(faceRect.y));
  const x1 = Math.min(img.width, Math.ceil(faceRect.x + faceRect.w));
  const y1 = Math.min(img.height, Math.ceil(faceRect.y + faceRect.h));
  const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 64));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const p = px(img, x, y);
      total++;
      if (p.r >= 250 || p.g >= 250 || p.b >= 250 || (p.r <= 8 && p.g <= 8 && p.b <= 8)) clipped++;
      Ls.push(sRGBToLab(p).L);
    }
  }
  const medL = median(Ls);
  const shadowRatio = Ls.length === 0 ? 1 : Ls.filter((L) => L < medL - 15).length / Ls.length;

  const half = { x: faceRect.x, y: faceRect.y + faceRect.h * 0.35, w: faceRect.w / 2, h: faceRect.h * 0.35 };
  const left = sampleRegion(img, "cheekLeft", half, { skipSkinGate: true });
  const right = sampleRegion(img, "cheekRight", { ...half, x: faceRect.x + faceRect.w / 2 }, { skipSkinGate: true });
  const forehead = measurement.regions.find((r) => r.region === "forehead");
  const jaw = measurement.regions.find((r) => r.region === "jaw");

  return {
    ipdPx: geo.ipdPx,
    faceBoxRatio: geo.box.h,
    laplacianVar: laplacianVariance(img, faceRect),
    clippedRatio: total === 0 ? 1 : clipped / total,
    medianLLeft: left.lab.L,
    medianLRight: right.lab.L,
    medianLForehead: forehead?.lab.L ?? NaN,
    medianLChin: jaw?.lab.L ?? NaN,
    shadowRatio,
    yaw: geo.yaw,
    pitch: geo.pitch,
    cheekNeckDE00: measurement.cheekNeckDE00,
    highFreqEnergy: highFrequencyEnergy(img, rects.jaw),
    regionSpreadDE00: measurement.regionSpreadDE00,
    skinPixelCount: measurement.regions
      .filter((r) => r.region === "neck" || r.region === "jaw" || r.region === "forehead")
      .reduce((a, r) => a + r.n, 0),
  };
}
