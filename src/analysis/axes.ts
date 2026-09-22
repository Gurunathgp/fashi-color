// Three-axis personal-colour analysis. Plan section 3.
//
// The engine measures continuous axes and derives a label at render time; it never predicts a
// season directly. Corrections applied 9/3/2026 after audit:
//
//  1. Korean 8-tone mapping was inverted on all four warm cells: Spring is warm/LIGHT and
//     Autumn is warm/DEEP, so a "Warm . Deep . Muted" reading must print Autumn Mute, not
//     Spring Light. Also there is no "Summer Bright" in the standard 8-tone system, so the
//     cool/light/bright cell maps to Summer Light, and the discriminating axis differs per
//     season (Spring/Winter split on chroma; Summer/Autumn split on depth).
//  2. The old DEFAULT_TREND constants were invented, not fitted, and produced z-scores as
//     extreme as -7.5 on the app's own demo presets. Trends must now be fitted from real
//     captures via fitTrend(); until then the engine reports calibrated:false and refuses to
//     emit a label (UNCALIBRATED_TREND has zeroed statistics purely so the maths stays defined).
//  3. computeAxes now returns the underlying z-scores. isOlive needs z_C, which previously had
//     no path out of the function, so the olive/neutral outcome - the single most important
//     feature for South Asian skin - could never fire.

import type { Lab } from "../color/convert";
import { labToLCh } from "../color/convert";

export type Axes = {
  /** + warm (yellow residual), - cool (pink residual). */
  W: number;
  /** + deep, - light. */
  D: number;
  /** + bright/clear, - muted/soft. */
  C: number;
  /** Standardised hue residual (= W). */
  zH: number;
  /** Standardised chroma residual. Needed for olive detection. */
  zC: number;
  /** Standardised lightness (= -D). */
  zL: number;
};

export type Trend = {
  /** Hue as a function of L*: h = slopeH * L + interceptH. */
  slopeH: number;
  interceptH: number;
  /** Chroma as a function of L*: C = slopeC * L + interceptC. */
  slopeC: number;
  interceptC: number;
  /** Robust scale (MAD * 1.4826) of each residual. */
  madH: number;
  madC: number;
  /** Lightness centre and scale of the calibration population. */
  meanL: number;
  sdL: number;
  /** Split points, as quantiles of the in-market distribution. Zero means median split. */
  splitW: number;
  splitD: number;
  splitC: number;
  /** False until fitTrend() has run on real captures. Gates label display. */
  calibrated: boolean;
  /** Subjects behind the fit, for honest confidence reporting. */
  n: number;
};

/**
 * Placeholder statistics. Deliberately not "sensible defaults": any label derived from these is
 * meaningless, which is why calibrated is false and deriveLabel refuses to name a season.
 */
export const UNCALIBRATED_TREND: Trend = {
  slopeH: 0,
  interceptH: 0,
  slopeC: 0,
  interceptC: 0,
  madH: 1,
  madC: 1,
  meanL: 0,
  sdL: 1,
  splitW: 0,
  splitD: 0,
  splitC: 0,
  calibrated: false,
  n: 0,
};

// ---------------------------------------------------------------------------
// Robust statistics
// ---------------------------------------------------------------------------

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median absolute deviation, scaled to be a consistent estimator of sigma for normal data. */
export function mad(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const m = median(xs);
  const scaled = 1.4826 * median(xs.map((x) => Math.abs(x - m)));
  return scaled > 1e-9 ? scaled : 1;
}

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Theil-Sen slope: median of pairwise slopes. Resistant to the outliers a small calibration set will contain. */
function theilSen(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      const dx = xs[j] - xs[i];
      if (Math.abs(dx) > 1e-9) slopes.push((ys[j] - ys[i]) / dx);
    }
  }
  if (slopes.length === 0) return { slope: 0, intercept: median(ys) || 0 };
  const slope = median(slopes);
  const intercept = median(ys.map((y, i) => y - slope * xs[i]));
  return { slope, intercept };
}

// ---------------------------------------------------------------------------
// Calibration (P0.6)
// ---------------------------------------------------------------------------

export type CalibrationSample = { skin: Lab; hair: Lab };

/**
 * Fit the L*-conditioned hue and chroma trends that define the axes, then set split points from
 * the observed distribution. Percentile splits are what stop ~80% of Indian users landing in a
 * single "Deep" cell (plan section 3.4).
 *
 * Needs at least MIN_CALIBRATION_N subjects spanning a wide skin-tone range; below that the fit
 * is returned with calibrated:false so nothing downstream will show a label.
 */
export const MIN_CALIBRATION_N = 15;

export function fitTrend(samples: CalibrationSample[]): Trend {
  if (samples.length < 3) return { ...UNCALIBRATED_TREND, n: samples.length };

  const Ls = samples.map((s) => s.skin.L);
  const lch = samples.map((s) => labToLCh(s.skin));
  // Skin hue sits in the first quadrant (roughly 20-80 degrees), so no wrap handling is needed
  // for the fit itself; residual wrapping is handled in computeAxes.
  const hs = lch.map((c) => c.h);
  const Cs = lch.map((c) => c.C);

  const fitH = theilSen(Ls, hs);
  const fitC = theilSen(Ls, Cs);

  const resH = hs.map((h, i) => h - (fitH.slope * Ls[i] + fitH.intercept));
  const resC = Cs.map((c, i) => c - (fitC.slope * Ls[i] + fitC.intercept));

  const madH = mad(resH);
  const madC = mad(resC);
  const meanL = median(Ls);
  const sdL = mad(Ls);

  // Split at the population median of each axis so the eight cells are actually populated.
  const zH = resH.map((r) => r / madH);
  const zC = resC.map((r) => r / madC);
  const zL = Ls.map((L) => (L - meanL) / sdL);
  const cVals = samples.map((s, i) => 0.75 * zC[i] + 0.25 * hairClarityTerm(s.hair));

  return {
    slopeH: fitH.slope,
    interceptH: fitH.intercept,
    slopeC: fitC.slope,
    interceptC: fitC.intercept,
    madH,
    madC,
    meanL,
    sdL,
    splitW: median(zH),
    splitD: median(zL.map((z) => -z)),
    splitC: median(cVals),
    calibrated: samples.length >= MIN_CALIBRATION_N,
    n: samples.length,
  };
}

/**
 * Hair contribution to clarity: jet black (L* around 12) reads clear, soft brown-black reads
 * muted. Kept small (0.25 weight) because hair lightness is near-constant in this market and
 * because dyed hair invalidates it entirely - see naturalHair in AnalysisInput.
 */
function hairClarityTerm(hair: Lab): number {
  return -(hair.L - 20) / 15;
}

// ---------------------------------------------------------------------------
// Axes
// ---------------------------------------------------------------------------

export type AnalysisInput = {
  skin: Lab;
  hair: Lab;
  /** Season theory describes natural colouring; dyed hair drops the hair term. */
  naturalHair?: boolean;
};

export function computeAxes(input: AnalysisInput, trend: Trend): Axes {
  const { skin, hair, naturalHair = true } = input;
  const { h, C } = labToLCh(skin);

  const expectedH = trend.slopeH * skin.L + trend.interceptH;
  const expectedC = trend.slopeC * skin.L + trend.interceptC;

  let rH = h - expectedH;
  // Wrap into (-180, 180]: a residual of 350 degrees is really -10.
  rH = ((rH % 360) + 540) % 360 - 180;
  const rC = C - expectedC;

  const zH = rH / (trend.madH || 1);
  const zC = rC / (trend.madC || 1);
  const zL = (skin.L - trend.meanL) / (trend.sdL || 1);

  // Clamp: a z beyond +/-6 means the sample is outside anything the calibration set covered, or
  // the capture is corrupt. Reporting -7.5 as if it were a measurement is false precision.
  const clamp = (z: number) => Math.max(-6, Math.min(6, z));

  const W = clamp(zH);
  const D = clamp(-zL);
  const Cval = clamp(naturalHair ? 0.75 * zC + 0.25 * hairClarityTerm(hair) : zC);

  return { W, D, C: Cval, zH: W, zC: clamp(zC), zL: clamp(zL) };
}

// ---------------------------------------------------------------------------
// Label derivation
// ---------------------------------------------------------------------------

export type ToneKey =
  | "spring-light"
  | "spring-bright"
  | "summer-light"
  | "summer-mute"
  | "autumn-mute"
  | "autumn-deep"
  | "winter-bright"
  | "winter-deep";

export type ToneLabel = {
  key: ToneKey;
  /** Korean consumer-facing name, the primary label once localised. */
  korean: string;
  /** English gloss of the Korean name. */
  english: string;
  /** Lead copy for India: self-explanatory without a tutorial (plan section 1.1). */
  triple: string;
};

/**
 * Warm/cool x light/deep x bright/muted -> Korean 8-tone.
 *
 * Season quadrant comes from warmth and depth:
 *   warm + light  -> Spring     cool + light -> Summer
 *   warm + deep   -> Autumn     cool + deep  -> Winter
 * The third axis then picks the subtype, and which subtype names exist differs by season:
 *   Spring: Light / Bright      Summer: Light / Mute
 *   Autumn: Mute / Deep         Winter: Bright / Deep
 */
const TONES: Record<string, ToneLabel> = {
  // key order: warm(+/-), deep(+/-), bright(+/-)
  "+-+": { key: "spring-bright", korean: "봄웜 브라이트", english: "Spring Warm Bright", triple: "" },
  "+--": { key: "spring-light", korean: "봄웜 라이트", english: "Spring Warm Light", triple: "" },
  "++-": { key: "autumn-mute", korean: "가을웜 뮤트", english: "Autumn Warm Mute", triple: "" },
  "+++": { key: "autumn-deep", korean: "가을웜 딥", english: "Autumn Warm Deep", triple: "" },
  "--+": { key: "summer-light", korean: "여름쿨 라이트", english: "Summer Cool Light", triple: "" },
  "---": { key: "summer-mute", korean: "여름쿨 뮤트", english: "Summer Cool Mute", triple: "" },
  "-++": { key: "winter-bright", korean: "겨울쿨 브라이트", english: "Winter Cool Bright", triple: "" },
  "-+-": { key: "winter-deep", korean: "겨울쿨 딥", english: "Winter Cool Deep", triple: "" },
};

export function describeTriple(axes: Axes, trend: Trend): string {
  const warmth =
    axes.W > trend.splitW + 0.35 ? "Warm" : axes.W < trend.splitW - 0.35 ? "Cool" : "Neutral";
  const depth = axes.D >= trend.splitD ? "Deep" : "Light";
  const clarity = axes.C >= trend.splitC ? "Bright" : "Muted";
  return `${warmth} · ${depth} · ${clarity}`;
}

export type LabelResult =
  | { calibrated: false; reason: string; triple: null; tone: null }
  | { calibrated: true; reason: null; triple: string; tone: ToneLabel };

/**
 * Derive the displayed label. Returns calibrated:false rather than guessing when the trend has
 * not been fitted - the plan's rule is that refusing beats confidently mislabelling.
 */
export function deriveLabel(axes: Axes, trend: Trend): LabelResult {
  if (!trend.calibrated) {
    return {
      calibrated: false,
      reason:
        trend.n === 0
          ? "No calibration data yet. Run P0.5 captures, then fitTrend()."
          : `Only ${trend.n} calibration subjects; ${MIN_CALIBRATION_N} needed before a tone label is meaningful.`,
      triple: null,
      tone: null,
    };
  }
  const sW = axes.W >= trend.splitW ? "+" : "-";
  const sD = axes.D >= trend.splitD ? "+" : "-";
  const sC = axes.C >= trend.splitC ? "+" : "-";
  const tone = TONES[`${sW}${sD}${sC}`];
  const triple = describeTriple(axes, trend);
  return { calibrated: true, reason: null, triple, tone: { ...tone, triple } };
}

// ---------------------------------------------------------------------------
// Derived outputs (consumed by the palette and, later, the outfit scorer)
// ---------------------------------------------------------------------------

export type Metal = "gold" | "silver" | "both";

/** Lead output for India: one binary the user can check against jewellery they already own. */
export function metalFor(W: number, trend: Trend = UNCALIBRATED_TREND): Metal {
  const w = W - trend.splitW;
  if (w > 0.35) return "gold";
  if (w < -0.35) return "silver";
  return "both";
}

/**
 * Olive / neutral undertone. First-class outcome, not a tiebreak: forcing olive skin into a
 * warm/cool binary is where a large share of South and Southeast Asian users lose trust.
 */
export function isOlive(axes: Axes, trend: Trend = UNCALIBRATED_TREND): boolean {
  return Math.abs(axes.W - trend.splitW) <= 0.5 && axes.zC <= -0.5;
}

/** Personal contrast: target lightness gap for garments worn next to the face. */
export function personalContrast(skin: Lab, hair: Lab): number {
  return skin.L - hair.L;
}

/** Chroma tolerance rises as skin deepens. Maps L* 85 -> ~0.2, L* 30 -> ~1.0. */
export function chromaTolerance(skinL: number): number {
  return Math.min(1, Math.max(0.15, (75 - skinL) / 55 + 0.2));
}

export type Confidence = {
  W: number;
  D: number;
  C: number;
  weakest: "W" | "D" | "C";
  /** Overall 0..1, the minimum of the three. */
  overall: number;
};

/**
 * Distance-to-split confidence, degraded by (a) measurement disagreement between the
 * neck/jaw/forehead sites and (b) illuminant-estimator reliability (plan §3.4:
 * min(distance to split, illuminant-error propagation via P0.3 budget, agreement)).
 * Region disagreement is the cheapest honest signal available: if the
 * three sampling sites disagree, something contaminated the capture.
 * Illuminant reliability 0..1 comes from combineEstimates(); unknown maps to 0.5
 * so confidence degrades gracefully rather than collapsing or overstating.
 */
export function axisConfidence(
  axes: Axes,
  trend: Trend,
  regionSpreadDE00 = 0,
  illuminantReliability = 0.5
): Confidence {
  const sharpness = 0.8;
  const regionPenalty = Math.exp(-Math.max(0, regionSpreadDE00) / 6);
  const rel = Number.isFinite(illuminantReliability)
    ? Math.min(1, Math.max(0, illuminantReliability))
    : 0.5;
  // 0.5 + 0.5*rel: perfect reference keeps full confidence, failed estimator halves it.
  // Matches P0.3 finding that ΔE≈1 white-point error already flips ~48% of labels.
  const illuminantPenalty = 0.5 + 0.5 * rel;
  const penalty = regionPenalty * illuminantPenalty;
  const c = (v: number, split: number) =>
    Math.min(1, Math.abs(v - split) / sharpness) * penalty;
  const W = c(axes.W, trend.splitW);
  const D = c(axes.D, trend.splitD);
  const C = c(axes.C, trend.splitC);
  let weakest: "W" | "D" | "C" = "W";
  if (D < W && D <= C) weakest = "D";
  else if (C < W && C < D) weakest = "C";
  return { W, D, C, weakest, overall: Math.min(W, D, C) };
}
