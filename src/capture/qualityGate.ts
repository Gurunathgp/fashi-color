// Capture quality gate. Plan section 5.
//
// The rule is refuse rather than guess: a wrong tone label is the one error a fashion-literate
// user will screenshot, so rejecting a share of photos beats confidently mislabelling them.
//
// Two changes after the audit:
//  - Metrics now arrive from the pixel sampler rather than being passed in as constants, and any
//    check whose input is unavailable reports "skipped" instead of silently passing. A gate that
//    cannot see the data must not claim the photo is good.
//  - Illuminant checks take the estimator's own output, so CCT/Duv are measured rather than
//    assumed.

export type GateStatus = "pass" | "fail" | "warn" | "skipped";

export type GateCheck = {
  id: string;
  label: string;
  status: GateStatus;
  /** Remediation copy: "move to a window" beats "photo rejected". */
  message: string;
  value?: number;
  threshold?: string;
};

export type GateMetrics = {
  ipdPx?: number;
  /** Face height as a fraction of frame height. */
  faceBoxRatio?: number;
  laplacianVar?: number;
  clippedRatio?: number;
  medianLLeft?: number;
  medianLRight?: number;
  medianLForehead?: number;
  medianLChin?: number;
  shadowRatio?: number;
  cct?: number;
  duv?: number;
  yaw?: number;
  pitch?: number;
  cheekNeckDE00?: number;
  highFreqEnergy?: number;
  /** Calibrated per device family; absent means the check is skipped, not passed. */
  highFreqThreshold?: number;
  clothesAdjacentSaturated?: boolean;
  /** Disagreement between neck/jaw/forehead. */
  regionSpreadDE00?: number;
  skinPixelCount?: number;
  /** Reliability reported by the illuminant estimator, 0..1. */
  illuminantReliability?: number;
};

export type GateResult = {
  /** True only if no check failed AND enough checks could actually run. */
  pass: boolean;
  checks: GateCheck[];
  failures: GateCheck[];
  warnings: GateCheck[];
  skipped: GateCheck[];
  /** Makeup detected: sample the neck only. */
  neckOnly: boolean;
  /** Human-readable summary for the UI. */
  summary: string;
};

const ok = (id: string, label: string, value?: number, threshold?: string): GateCheck => ({
  id,
  label,
  status: "pass",
  message: "",
  value,
  threshold,
});

function check(
  id: string,
  label: string,
  value: number | boolean | undefined,
  predicate: (v: number) => boolean,
  failMessage: string,
  threshold: string,
  severity: "fail" | "warn" = "fail",
  skipMessage = "Not measured on this capture path."
): GateCheck {
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) {
    return { id, label, status: "skipped", message: skipMessage, threshold };
  }
  const v = typeof value === "boolean" ? (value ? 1 : 0) : value;
  return predicate(v)
    ? ok(id, label, v, threshold)
    : { id, label, status: severity, message: failMessage, value: v, threshold };
}

export const MIN_SKIN_PIXELS = 400;

export function runQualityGate(m: GateMetrics): GateResult {
  const checks: GateCheck[] = [
    check(
      "faceSize",
      "Face size",
      m.ipdPx,
      (v) => v >= 120,
      "Move closer, or hold the phone steadier at arm's length.",
      "IPD >= 120 px"
    ),
    check(
      "faceFill",
      "Face fills frame",
      m.faceBoxRatio,
      (v) => v >= 0.4,
      "Come closer so your face fills about 40% of the frame height.",
      ">= 0.40 of frame height"
    ),
    check(
      "blur",
      "Sharpness",
      m.laplacianVar,
      (v) => v >= 100,
      "Hold still and tap to focus, then retake.",
      "Laplacian variance >= 100"
    ),
    check(
      "clipping",
      "Exposure",
      m.clippedRatio,
      (v) => v < 0.01,
      "Too bright or too dark in places. Step out of direct sun or lamp glare.",
      "< 1% clipped pixels"
    ),
    check(
      "symmetry",
      "Even lighting",
      m.medianLLeft !== undefined && m.medianLRight !== undefined
        ? Math.abs(m.medianLLeft - m.medianLRight)
        : undefined,
      (v) => v <= 6,
      "One side of your face is brighter. Face the window straight on.",
      "|L* left - right| <= 6"
    ),
    check(
      "verticalGradient",
      "No overhead light",
      m.medianLForehead !== undefined && m.medianLChin !== undefined
        ? Math.abs(m.medianLForehead - m.medianLChin)
        : undefined,
      (v) => v <= 10,
      "Light is coming from above. Move to a window instead of under a ceiling light.",
      "|forehead - chin| <= 10 L*"
    ),
    check(
      "shadow",
      "Shadows",
      m.shadowRatio,
      (v) => v <= 0.15,
      "Too much shadow on your face. Turn towards the light source.",
      "<= 15% of pixels in shadow"
    ),
    check(
      "cct",
      "Light colour temperature",
      m.cct,
      (v) => v >= 2500 && v <= 8000,
      "This light is too strongly coloured to measure through. Try daylight or a plain white lamp.",
      "2500-8000 K"
    ),
    check(
      "duv",
      "Light tint",
      m.duv === undefined ? undefined : Math.abs(m.duv),
      (v) => v <= 0.02,
      "The light has a green or pink tint. Try a different room or daylight.",
      "|Duv| <= 0.02"
    ),
    check(
      "yaw",
      "Head turn",
      m.yaw === undefined ? undefined : Math.abs(m.yaw),
      (v) => v <= 15,
      "Turn to face the camera straight on.",
      "|yaw| <= 15 deg"
    ),
    check(
      "pitch",
      "Head tilt",
      m.pitch === undefined ? undefined : Math.abs(m.pitch),
      (v) => v <= 15,
      "Level your chin so both cheeks and your neck are visible.",
      "|pitch| <= 15 deg"
    ),
    check(
      "beautification",
      "Beauty filter off",
      m.highFreqEnergy !== undefined && m.highFreqThreshold !== undefined
        ? m.highFreqEnergy / m.highFreqThreshold
        : undefined,
      (v) => v >= 1,
      "Skin detail looks smoothed. Turn off beauty mode / AI enhance in your camera settings.",
      "high-frequency energy >= device threshold",
      "fail",
      "No calibrated threshold for this device family yet, so smoothing cannot be ruled out."
    ),
    check(
      "clothingBounce",
      "Neutral clothing",
      m.clothesAdjacentSaturated,
      (v) => v === 0,
      "A strongly coloured top is throwing colour onto your neck. Wear white or grey, or drape a white towel.",
      "no saturated clothing next to the neck"
    ),
    check(
      "regionAgreement",
      "Measurement agreement",
      m.regionSpreadDE00,
      (v) => v <= 8,
      "Neck, jaw and forehead disagree. Check for makeup, tan lines or uneven light.",
      "spread <= 8 dE00",
      "warn"
    ),
    check(
      "sampleSize",
      "Enough skin measured",
      m.skinPixelCount,
      (v) => v >= MIN_SKIN_PIXELS,
      "Not enough clean skin found. Move closer and pull hair back from the jaw and neck.",
      `>= ${MIN_SKIN_PIXELS} accepted pixels`
    ),
    check(
      "illuminantReliability",
      "White balance reference",
      m.illuminantReliability,
      (v) => v >= 0.4,
      "Nothing neutral in frame to anchor colour. Hold a sheet of white paper beside your neck.",
      ">= 0.40 estimator reliability",
      "warn"
    ),
  ];

  const failures = checks.filter((c) => c.status === "fail");
  const warnings = checks.filter((c) => c.status === "warn");
  const skipped = checks.filter((c) => c.status === "skipped");

  // A capture is only good if the essential checks actually ran. Skipping is not passing.
  const essential = ["faceSize", "blur", "clipping", "cct", "sampleSize"];
  const essentialSkipped = skipped.filter((c) => essential.includes(c.id));

  const neckOnly = m.cheekNeckDE00 !== undefined && Number.isFinite(m.cheekNeckDE00) && m.cheekNeckDE00 > 6;

  const pass = failures.length === 0 && essentialSkipped.length === 0;
  const summary = pass
    ? warnings.length === 0
      ? "Good capture."
      : `Usable, with ${warnings.length} caveat${warnings.length > 1 ? "s" : ""}.`
    : failures.length > 0
      ? failures[0].message
      : `Cannot verify this capture: ${essentialSkipped.map((c) => c.label).join(", ")} not measured.`;

  return { pass, checks, failures, warnings, skipped, neckOnly, summary };
}
