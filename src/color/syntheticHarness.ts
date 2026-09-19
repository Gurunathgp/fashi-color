// P0.3 illuminant error budget + P0.4 synthetic invariance.
//
// Both experiments were rebuilt on 9/3/2026 after the audit found they did not measure what the
// plan asks for:
//
//  P0.4 was an algebraic identity. It synthesised a photo with adapt(D65 -> T) and then corrected
//  it with adapt(T -> D65), passing the *true* white point to the correction step. Those are exact
//  inverses, so the only way it could fail was 8-bit gamut clipping at extreme CCT - which is
//  precisely what the old "33% stable" figure was measuring. It now runs a real illuminant
//  estimator over synthesised pixels and reports clipped cases separately instead of scoring them.
//
//  P0.3 perturbed skin a*/b* by de*cos(theta)*0.6 and labelled the axis "deltaE". Measured, a
//  nominal 5 was a true dE00 of 2.17, so the published curve would have been wrong by ~2.3x. It
//  also left hair unperturbed, though hair feeds the clarity axis, and skipped the 8-bit step. A
//  wrong illuminant estimate is a multiplicative von Kries gain on the whole image, so that is
//  what the experiment now applies - and the x-axis is the measured dE00 of the resulting skin
//  shift, bisected to hit each requested target.

import type { Lab, RGB, XYZ } from "./convert";
import { sRGBToLab, labToSRGB, labToXYZ, xyzToLab, deltaE00 } from "./convert";
import { adaptXYZ, cctToXYZ, D65_WHITE, xyzToXy } from "./adapt";
import {
  computeAxes,
  deriveLabel,
  fitTrend,
  type Axes,
  type Trend,
  type CalibrationSample,
} from "../analysis/axes";
import {
  combineEstimates,
  fromNeutralPatch,
  fromSkinPrior,
  type IlluminantEstimate,
} from "../capture/illuminant";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Simulate a surface of known D65 appearance photographed under illuminant `white`. */
function renderUnder(rgbD65: RGB, white: XYZ): { rgb: RGB; clipped: boolean } {
  const xyz = adaptXYZ(labToXYZ(sRGBToLab(rgbD65)), D65_WHITE, white);
  const lab = xyzToLab(xyz);
  const exact = labToSRGB(lab);
  // labToSRGB already rounds and clamps; detect clipping by re-measuring the error it introduced.
  const back = sRGBToLab(exact);
  const clipped = deltaE00(back, lab) > 1.0;
  return { rgb: exact, clipped };
}

function applyEV(rgb: RGB, ev: number): { rgb: RGB; clipped: boolean } {
  const scale = Math.pow(2, ev);
  const lin = {
    r: Math.pow(rgb.r / 255, 2.2) * scale,
    g: Math.pow(rgb.g / 255, 2.2) * scale,
    b: Math.pow(rgb.b / 255, 2.2) * scale,
  };
  const clipped = lin.r > 1 || lin.g > 1 || lin.b > 1;
  const enc = (v: number) => Math.round(Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.2) * 255);
  return { rgb: { r: enc(lin.r), g: enc(lin.g), b: enc(lin.b) }, clipped };
}

/** Quantise to 8-bit through a JPEG-like rounding step. */
function quantise(rgb: RGB): RGB {
  return { r: Math.round(rgb.r), g: Math.round(rgb.g), b: Math.round(rgb.b) };
}

// ---------------------------------------------------------------------------
// P0.4 - synthetic illuminant invariance, with a real estimator in the loop
// ---------------------------------------------------------------------------

export type SyntheticSubject = {
  name?: string;
  skinRGB: RGB;
  hairRGB: RGB;
  /** Sclera is a near-neutral reference present in every face. Slightly warm/grey, not paper white. */
  scleraRGB?: RGB;
  /** Optional white paper held beside the neck. */
  whiteRefRGB?: RGB;
};

export type SyntheticOpts = {
  subjects: SyntheticSubject[];
  ccts: number[];
  evs: number[];
  trend: Trend;
  /** Which cues the estimator is allowed to use. Mirrors the capture UX being tested. */
  cues?: { sclera?: boolean; whiteRef?: boolean; skinPrior?: boolean };
};

export type InvarianceCase = {
  subject: string;
  cct: number;
  ev: number;
  /** True if synthesis fell outside sRGB; excluded from pass/fail because it is a simulation limit. */
  outOfGamut: boolean;
  /** Error of the estimator's white point, in CCT terms. */
  cctError: number;
  /** dE00 between corrected skin and the true D65 skin. */
  skinDE00: number;
  dW: number;
  dD: number;
  dC: number;
  labelStable: boolean;
};

export type InvarianceReport = {
  cases: InvarianceCase[];
  /** Cases actually scored, i.e. in-gamut. */
  scored: number;
  excludedOutOfGamut: number;
  labelStability: number;
  medianSkinDE00: number;
  p90SkinDE00: number;
  maxDW: number;
  /** Plan's Phase 1 gate: label stable at least 80% across lighting conditions. */
  meetsPlanGate: boolean;
};

function estimateFor(
  subject: SyntheticSubject,
  white: XYZ,
  ev: number,
  cues: NonNullable<SyntheticOpts["cues"]>
): { estimate: IlluminantEstimate; skinObserved: RGB; hairObserved: RGB; clipped: boolean } {
  const skinR = renderUnder(subject.skinRGB, white);
  const hairR = renderUnder(subject.hairRGB, white);
  const skinE = applyEV(skinR.rgb, ev);
  const hairE = applyEV(hairR.rgb, ev);
  const skinObserved = quantise(skinE.rgb);
  const hairObserved = quantise(hairE.rgb);

  const parts: IlluminantEstimate[] = [];
  let clipped = skinR.clipped || skinE.clipped || hairR.clipped;

  if (cues.whiteRef && subject.whiteRefRGB) {
    const r = renderUnder(subject.whiteRefRGB, white);
    const e = applyEV(r.rgb, ev);
    clipped = clipped || r.clipped || e.clipped;
    parts.push(fromNeutralPatch([quantise(e.rgb)], "white-reference", 0.8));
  }
  if (cues.sclera && subject.scleraRGB) {
    const r = renderUnder(subject.scleraRGB, white);
    const e = applyEV(r.rgb, ev);
    clipped = clipped || r.clipped || e.clipped;
    parts.push(fromNeutralPatch([quantise(e.rgb)], "sclera", 0.5));
  }
  if (cues.skinPrior !== false) {
    // The prior knows what skin of this lightness looks like under D65, not this subject's exact
    // chromaticity - otherwise we would be handing it the answer. Approximate by taking the
    // subject's own L* with the population's expected a*/b* from the trend.
    const trueSkinLab = sRGBToLab(subject.skinRGB);
    const priorLab: Lab = { L: trueSkinLab.L, a: 14, b: 18 };
    parts.push(fromSkinPrior([skinObserved], labToXYZ(priorLab)));
  }

  return { estimate: combineEstimates(parts), skinObserved, hairObserved, clipped };
}

export function runSyntheticInvariance(opts: SyntheticOpts): InvarianceReport {
  const cues = opts.cues ?? { sclera: true, whiteRef: false, skinPrior: true };
  const cases: InvarianceCase[] = [];

  for (const subject of opts.subjects) {
    const name = subject.name ?? "subject";
    const truthSkin = sRGBToLab(subject.skinRGB);
    const truthAxes = computeAxes({ skin: truthSkin, hair: sRGBToLab(subject.hairRGB) }, opts.trend);
    const truthLabel = deriveLabel(truthAxes, opts.trend);

    for (const cct of opts.ccts) {
      const white = cctToXYZ(cct);
      const trueCct = cct;
      for (const ev of opts.evs) {
        const { estimate, skinObserved, hairObserved, clipped } = estimateFor(subject, white, ev, cues);

        // Correct with the ESTIMATED white, never the true one.
        const skinCorrected = xyzToLab(adaptXYZ(labToXYZ(sRGBToLab(skinObserved)), estimate.white, D65_WHITE));
        const hairCorrected = xyzToLab(adaptXYZ(labToXYZ(sRGBToLab(hairObserved)), estimate.white, D65_WHITE));

        const axes = computeAxes({ skin: skinCorrected, hair: hairCorrected }, opts.trend);
        const label = deriveLabel(axes, opts.trend);

        cases.push({
          subject: name,
          cct,
          ev,
          outOfGamut: clipped,
          cctError: Math.abs(estimate.cct - trueCct),
          skinDE00: deltaE00(skinCorrected, truthSkin),
          dW: Math.abs(axes.W - truthAxes.W),
          dD: Math.abs(axes.D - truthAxes.D),
          dC: Math.abs(axes.C - truthAxes.C),
          labelStable:
            label.calibrated && truthLabel.calibrated
              ? label.tone.key === truthLabel.tone.key
              : label.calibrated === truthLabel.calibrated,
        });
      }
    }
  }

  const scored = cases.filter((c) => !c.outOfGamut);
  const des = scored.map((c) => c.skinDE00).sort((a, b) => a - b);
  const pick = (q: number) => (des.length === 0 ? NaN : des[Math.min(des.length - 1, Math.floor(des.length * q))]);
  const stability = scored.length === 0 ? 0 : scored.filter((c) => c.labelStable).length / scored.length;

  return {
    cases,
    scored: scored.length,
    excludedOutOfGamut: cases.length - scored.length,
    labelStability: stability,
    medianSkinDE00: pick(0.5),
    p90SkinDE00: pick(0.9),
    maxDW: scored.reduce((m, c) => Math.max(m, c.dW), 0),
    meetsPlanGate: stability >= 0.8,
  };
}

// ---------------------------------------------------------------------------
// P0.3 - illuminant error budget (the go/no-go)
// ---------------------------------------------------------------------------

export type ErrorBudgetPoint = {
  /** Requested white-point error, expressed as the resulting skin dE00. */
  targetSkinDE00: number;
  /** What was actually achieved, averaged over directions. */
  actualSkinDE00: number;
  /** Fraction of (subject, direction) trials whose tone cell changed. */
  flipRate: number;
  meanDW: number;
  p90DW: number;
};

export type ErrorBudgetVerdict = {
  points: ErrorBudgetPoint[];
  /** Largest skin dE00 at which fewer than `flipTolerance` of trials flip. */
  toleranceDE00: number;
  /** What the plan says to do with that number. */
  recommendation:
    | "ship-absolute-label: sclera + skin prior is enough"
    | "require-white-reference: white paper becomes a mandatory capture step"
    | "drape-only: do not ship an absolute label";
};

/**
 * Perturb the estimated illuminant by a von Kries gain in a given chromaticity direction, sized by
 * bisection so the resulting skin shift hits `targetDE00`. This is what a wrong estimate actually
 * does to an image, and it moves skin and hair together.
 */
function perturbWhite(direction: number, magnitude: number): XYZ {
  const xy = xyzToXy(D65_WHITE);
  const rad = (direction * Math.PI) / 180;
  const x = xy.x + Math.cos(rad) * magnitude;
  const y = xy.y + Math.sin(rad) * magnitude;
  return { X: (x / y) * 100, Y: 100, Z: ((1 - x - y) / y) * 100 };
}

function skinShiftFor(skin: Lab, white: XYZ): { lab: Lab; de: number } {
  // Observed under D65, then wrongly corrected as if the illuminant were `white`.
  const wrong = xyzToLab(adaptXYZ(labToXYZ(skin), white, D65_WHITE));
  return { lab: wrong, de: deltaE00(wrong, skin) };
}

export function runErrorBudget(args: {
  subjects: SyntheticSubject[];
  trend: Trend;
  targets?: number[];
  directions?: number[];
  /** Flip fraction still considered acceptable. */
  flipTolerance?: number;
}): ErrorBudgetVerdict {
  const targets = args.targets ?? [1, 2, 3, 5, 8, 12];
  const directions = args.directions ?? [0, 45, 90, 135, 180, 225, 270, 315];
  const flipTolerance = args.flipTolerance ?? 0.1;
  const points: ErrorBudgetPoint[] = [];

  for (const target of targets) {
    let flips = 0;
    let trials = 0;
    let deSum = 0;
    const dws: number[] = [];

    for (const subject of args.subjects) {
      const skin = sRGBToLab(subject.skinRGB);
      const hair = sRGBToLab(subject.hairRGB);
      const truth = computeAxes({ skin, hair }, args.trend);
      const truthLabel = deriveLabel(truth, args.trend);

      for (const dir of directions) {
        // Bisect the chromaticity offset until the skin shift matches the requested dE00.
        let lo = 0;
        let hi = 0.25;
        let white = perturbWhite(dir, hi);
        for (let i = 0; i < 40; i++) {
          const mid = (lo + hi) / 2;
          white = perturbWhite(dir, mid);
          if (skinShiftFor(skin, white).de < target) lo = mid;
          else hi = mid;
        }
        const shifted = skinShiftFor(skin, white);
        const hairShifted = xyzToLab(adaptXYZ(labToXYZ(hair), white, D65_WHITE));

        const axes = computeAxes({ skin: shifted.lab, hair: hairShifted }, args.trend);
        const label = deriveLabel(axes, args.trend);
        const flipped =
          label.calibrated && truthLabel.calibrated
            ? label.tone.key !== truthLabel.tone.key
            : label.calibrated !== truthLabel.calibrated;

        if (flipped) flips++;
        trials++;
        deSum += shifted.de;
        dws.push(Math.abs(axes.W - truth.W));
      }
    }

    dws.sort((a, b) => a - b);
    points.push({
      targetSkinDE00: target,
      actualSkinDE00: trials === 0 ? NaN : deSum / trials,
      flipRate: trials === 0 ? NaN : flips / trials,
      meanDW: dws.length === 0 ? NaN : dws.reduce((a, b) => a + b, 0) / dws.length,
      p90DW: dws.length === 0 ? NaN : dws[Math.min(dws.length - 1, Math.floor(dws.length * 0.9))],
    });
  }

  const passing = points.filter((p) => p.flipRate <= flipTolerance);
  const tolerance = passing.length === 0 ? 0 : Math.max(...passing.map((p) => p.targetSkinDE00));

  const recommendation: ErrorBudgetVerdict["recommendation"] =
    tolerance > 5
      ? "ship-absolute-label: sclera + skin prior is enough"
      : tolerance >= 2
        ? "require-white-reference: white paper becomes a mandatory capture step"
        : "drape-only: do not ship an absolute label";

  return { points, toleranceDE00: tolerance, recommendation };
}

// ---------------------------------------------------------------------------
// Test-retest stability (the Phase 1 ship gate)
// ---------------------------------------------------------------------------

export type StabilityReport = {
  labelStability: number;
  medianSkinDE00: number;
  meetsPlanGate: boolean;
};

/**
 * The plan ships Phase 1 on test-retest stability, not on agreement with any analyst: same
 * subject, five lighting conditions, label stable at least 80% of the time. This runs that check
 * over the synthetic sweep so it can gate CI before real captures exist.
 */
export function runTestRetest(subjects: SyntheticSubject[], trend: Trend): StabilityReport {
  const report = runSyntheticInvariance({
    subjects,
    ccts: [2700, 3000, 4000, 5000, 6500],
    evs: [0],
    trend,
    cues: { sclera: true, skinPrior: true },
  });
  return {
    labelStability: report.labelStability,
    medianSkinDE00: report.medianSkinDE00,
    meetsPlanGate: report.meetsPlanGate,
  };
}

/** Convenience: build a Trend from synthetic subjects so harness tests are self-contained. */
export function trendFromSubjects(subjects: SyntheticSubject[]): Trend {
  const samples: CalibrationSample[] = subjects.map((s) => ({
    skin: sRGBToLab(s.skinRGB),
    hair: sRGBToLab(s.hairRGB),
  }));
  return fitTrend(samples);
}
