// Full on-device analysis pipeline: pixels in, axes + label + palette out.
//
// This is the seam the app previously lacked. Before the audit, picking a photo ran the quality
// gate on hardcoded constants and then displayed values from demo presets, so the image had no
// effect on the output at all. Everything here is driven by real pixels.

import { decode as decodeJpeg } from "jpeg-js";
import type { Lab, RGB } from "../color/convert";
import { sRGBToLab, xyzToLab, labToXYZ } from "../color/convert";
import { adaptXYZ, D65_WHITE } from "../color/adapt";
import {
  computeAxes,
  deriveLabel,
  axisConfidence,
  metalFor,
  isOlive,
  personalContrast,
  type Axes,
  type Confidence,
  type LabelResult,
  type Trend,
} from "../analysis/axes";
import { paletteFor, sampleSwatches, type PaletteRegion, type Swatch } from "../analysis/palette";
import {
  measureSkin,
  measureHair,
  computeGateMetrics,
  regionRects,
  sampleRegion,
  detectWhiteReference,
  type FaceGeometry,
  type ImageBuffer,
  type SkinMeasurement,
} from "./sampler";
import { runQualityGate, type GateResult } from "./qualityGate";
import {
  combineEstimates,
  fromNeutralPatch,
  fromSkinPrior,
  fromShadesOfGrey,
  type IlluminantEstimate,
} from "./illuminant";

export type AnalysisOptions = {
  trend: Trend;
  naturalHair?: boolean;
  /** Rectangle (normalised) containing a white paper reference, if the user held one up. */
  whiteReferenceRect?: { x: number; y: number; w: number; h: number };
  /** Per-device high-frequency threshold for beautification detection, once characterised. */
  highFreqThreshold?: number;
};

export type AnalysisResult = {
  gate: GateResult;
  illuminant: IlluminantEstimate;
  measurement: SkinMeasurement;
  skinD65: Lab;
  hairD65: Lab;
  axes: Axes;
  confidence: Confidence;
  label: LabelResult;
  palette: PaletteRegion;
  swatches: Swatch[];
  metal: ReturnType<typeof metalFor>;
  olive: boolean;
  contrast: number;
};

/** Decode a JPEG into an RGBA buffer, downscaling by an integer factor to keep JS work bounded. */
export function decodeJpegToBuffer(bytes: Uint8Array, maxDim = 640): ImageBuffer {
  const raw = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
  const factor = Math.max(1, Math.ceil(Math.max(raw.width, raw.height) / maxDim));
  if (factor === 1) {
    return { width: raw.width, height: raw.height, data: raw.data };
  }
  const w = Math.floor(raw.width / factor);
  const h = Math.floor(raw.height / factor);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Box average over the factor x factor block: cheap antialiasing, avoids sampling noise.
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const sx = x * factor + dx;
          const sy = y * factor + dy;
          if (sx >= raw.width || sy >= raw.height) continue;
          const o = (sy * raw.width + sx) * 4;
          r += raw.data[o];
          g += raw.data[o + 1];
          b += raw.data[o + 2];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Very coarse face locator: finds the largest connected-ish band of skin-like pixels by row/column
 * projection. This is a placeholder for MediaPipe Face Landmarker (P1.2) and is honest about it -
 * it returns confidence so the gate can refuse when the estimate is poor, rather than pretending
 * to have landmarks.
 */
export function locateFace(img: ImageBuffer): { geometry: FaceGeometry; confidence: number } {
  const colScore = new Array(img.width).fill(0);
  const rowScore = new Array(img.height).fill(0);
  let hits = 0;
  const step = Math.max(1, Math.floor(Math.min(img.width, img.height) / 160));
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const o = (y * img.width + x) * 4;
      const r = img.data[o];
      const g = img.data[o + 1];
      const b = img.data[o + 2];
      // Skin-like: R > G > B with moderate separation, not clipped.
      if (r > 60 && r < 250 && r > g + 8 && g > b + 2 && r - b < 120) {
        colScore[x] += 1;
        rowScore[y] += 1;
        hits++;
      }
    }
  }
  const sampled = Math.ceil(img.width / step) * Math.ceil(img.height / step);
  const coverage = hits / Math.max(1, sampled);

  const span = (scores: number[], size: number) => {
    const max = Math.max(...scores);
    if (max <= 0) return { lo: 0, hi: size };
    const thresh = max * 0.35;
    let lo = 0;
    let hi = size - 1;
    while (lo < size && scores[lo] < thresh) lo++;
    while (hi > lo && scores[hi] < thresh) hi--;
    return { lo, hi };
  };
  const cs = span(colScore, img.width);
  const rs = span(rowScore, img.height);

  const w = Math.max(1, cs.hi - cs.lo) / img.width;
  const h = Math.max(1, rs.hi - rs.lo) / img.height;
  const geometry: FaceGeometry = {
    box: { x: cs.lo / img.width, y: rs.lo / img.height, w, h },
    // IPD is roughly 0.46 of face width for adult faces; a stand-in until landmarks exist.
    ipdPx: 0.46 * w * img.width,
    yaw: 0,
    pitch: 0,
  };
  // Plausibility: a face should cover a meaningful but not absurd share of the frame.
  const plausible = coverage > 0.04 && coverage < 0.85 && w > 0.12 && h > 0.12;
  return { geometry, confidence: plausible ? Math.min(0.6, coverage * 2) : 0 };
}

export function analyseBuffer(img: ImageBuffer, opts: AnalysisOptions): AnalysisResult {
  const { geometry, confidence: faceConfidence } = locateFace(img);
  const measurement = measureSkin(img, geometry);
  const hair = measureHair(img, geometry);

  // --- illuminant -------------------------------------------------------
  const estimates: IlluminantEstimate[] = [];
  if (opts.whiteReferenceRect) {
    const r = opts.whiteReferenceRect;
    const patch = sampleRegion(
      img,
      "sclera",
      { x: r.x * img.width, y: r.y * img.height, w: r.w * img.width, h: r.h * img.height },
      { skipSkinGate: true }
    );
    if (patch.n > 0) estimates.push(fromNeutralPatch([patch.rgb], "white-reference", 0.8));
  } else {
    // No manually marked paper: look for a bright neutral surface outside the face
    // (plan P1.5 — under the P0.3 verdict a white reference is near-mandatory).
    const auto = detectWhiteReference(img, geometry.box);
    if (auto) estimates.push(fromNeutralPatch([auto.rgb], "white-reference-auto", 0.7));
  }
  if (Number.isFinite(measurement.skin.L)) {
    // Population prior: expected neutral-warm skin a*/b* at this lightness.
    const prior: Lab = { L: measurement.skin.L, a: 14, b: 18 };
    const neck = measurement.regions.find((x) => x.region === "neck");
    const src = neck && neck.n > 0 ? neck.rgb : measurement.regions[0].rgb;
    if (Number.isFinite(src.r)) estimates.push(fromSkinPrior([src], labToXYZ(prior)));
  }
  // Weak fallback so there is always something to correct with.
  const coarse: RGB[] = [];
  const stepPx = Math.max(1, Math.floor(Math.min(img.width, img.height) / 48));
  for (let y = 0; y < img.height; y += stepPx) {
    for (let x = 0; x < img.width; x += stepPx) {
      const o = (y * img.width + x) * 4;
      coarse.push({ r: img.data[o], g: img.data[o + 1], b: img.data[o + 2] });
    }
  }
  estimates.push(fromShadesOfGrey(coarse));
  const illuminant = combineEstimates(estimates);

  // --- correct to D65 ---------------------------------------------------
  const toD65 = (lab: Lab): Lab =>
    Number.isFinite(lab.L) ? xyzToLab(adaptXYZ(labToXYZ(lab), illuminant.white, D65_WHITE)) : lab;
  // Plan §5: cheek↔neck ΔE00 > 6 → makeup detected → neck-only sampling.
  // The gate reports neckOnly, but reporting alone is not enough — the measurement
  // itself must drop the contaminated jaw/forehead sites.
  const neckRegion = measurement.regions.find((x) => x.region === "neck");
  const makeupDetected =
    Number.isFinite(measurement.cheekNeckDE00) && measurement.cheekNeckDE00 > 6;
  const neckOnly = makeupDetected && !!neckRegion && neckRegion.n > 0 && Number.isFinite(neckRegion.lab.L);
  const skinMeasured = neckOnly && neckRegion ? neckRegion.lab : measurement.skin;
  const skinD65 = toD65(skinMeasured);
  const hairD65 = toD65(hair.lab);

  // --- gate -------------------------------------------------------------
  const metrics = computeGateMetrics(img, geometry, measurement);
  const gate = runQualityGate({
    ...metrics,
    // Face geometry is a placeholder, so pose cannot be measured: report skipped, not pass.
    yaw: undefined,
    pitch: undefined,
    ipdPx: faceConfidence > 0 ? metrics.ipdPx : undefined,
    faceBoxRatio: faceConfidence > 0 ? metrics.faceBoxRatio : undefined,
    cct: illuminant.cct,
    duv: illuminant.duv,
    highFreqThreshold: opts.highFreqThreshold,
    illuminantReliability: illuminant.reliability,
    clothesAdjacentSaturated: undefined,
  });

  // --- axes & outputs ---------------------------------------------------
  const axes = computeAxes(
    { skin: skinD65, hair: hairD65, naturalHair: opts.naturalHair ?? true },
    opts.trend
  );
  const confidence = axisConfidence(
    axes,
    opts.trend,
    measurement.regionSpreadDE00,
    illuminant.reliability
  );
  const label = deriveLabel(axes, opts.trend);
  const palette = paletteFor(axes, skinD65, opts.trend);
  const swatches = sampleSwatches(palette);

  return {
    gate,
    illuminant,
    measurement,
    skinD65,
    hairD65,
    axes,
    confidence,
    label,
    palette,
    swatches,
    metal: metalFor(axes.W, opts.trend),
    olive: isOlive(axes, opts.trend),
    contrast: personalContrast(skinD65, hairD65),
  };
}

/** Convenience wrapper for a JPEG file's bytes. */
export function analyseJpeg(bytes: Uint8Array, opts: AnalysisOptions): AnalysisResult {
  return analyseBuffer(decodeJpegToBuffer(bytes), opts);
}
