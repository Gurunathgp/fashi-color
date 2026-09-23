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
  measureHairFromMask,
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
import {
  detectFaceLandmarks,
  MIN_PLAUSIBLE_FACE_CONFIDENCE,
  type FaceLandmarks,
} from "./faceLandmarker";
import {
  segmentMulticlass,
  type MulticlassSegmentation,
} from "./segmentation";

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
  geometry: FaceGeometry;
  landmarks: FaceLandmarks;
  segmentation: MulticlassSegmentation;
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

export function analyseBuffer(img: ImageBuffer, opts: AnalysisOptions): AnalysisResult {
  const { landmarks, geometry, confidence: faceConfidence, scleraPixels } = detectFaceLandmarks(img);
  const segmentation = segmentMulticlass(img, landmarks);
  const measurement = measureSkin(img, geometry);
  const hair = measureHairFromMask(img, segmentation.hairMask) ?? measureHair(img, geometry);

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

  // Sclera prior (plan §4 & P1.5): natural neutral cue present in every face
  if (scleraPixels.length >= 4) {
    estimates.push(fromNeutralPatch(scleraPixels, "sclera", 0.65));
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
  // Only forward geometry-derived metrics when the detector considers the box plausible. The
  // estimator returns 0.2 for "skin-like pixels found, but this is not a face"; a gate that
  // accepts a guess as a measurement is worse than one that reports "not measured".
  const faceUsable = faceConfidence >= MIN_PLAUSIBLE_FACE_CONFIDENCE;
  const gate = runQualityGate({
    ...metrics,
    yaw: faceUsable ? geometry.yaw : undefined,
    pitch: faceUsable ? geometry.pitch : undefined,
    ipdPx: faceUsable ? metrics.ipdPx : undefined,
    faceBoxRatio: faceUsable ? metrics.faceBoxRatio : undefined,
    cct: illuminant.cct,
    duv: illuminant.duv,
    highFreqThreshold: opts.highFreqThreshold,
    illuminantReliability: illuminant.reliability,
    clothesAdjacentSaturated: segmentation.clothingBounce.clothesAdjacentSaturated,
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
    geometry,
    landmarks,
    segmentation,
  };
}

/** Convenience wrapper for a JPEG file's bytes. */
export function analyseJpeg(bytes: Uint8Array, opts: AnalysisOptions): AnalysisResult {
  return analyseBuffer(decodeJpegToBuffer(bytes), opts);
}
