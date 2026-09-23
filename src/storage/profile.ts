// Local persistence. Plan section 3.1 and P1.11.
//
// Two rules, both load-bearing:
//  1. Store the continuous z-scores, never the label. Recalibrating the split points later must
//     update every existing user's label without asking anyone to reshoot.
//  2. Never store photos. Derived colorimetric features only. Face images are biometric data, and
//     "your photo never leaves your phone" is only true if nothing writes it to disk.

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  deriveLabel,
  metalFor,
  isOlive,
  axisConfidence,
  personalContrast,
  type Axes,
  type Trend,
} from "../analysis/axes";
import { paletteFor, sampleSwatches } from "../analysis/palette";
import type { AnalysisResult } from "../capture/analyze";
import { D65_WHITE } from "../color/adapt";
import type { Lab } from "../color/convert";

const KEY = "fashi.profile.v1";
const CALIBRATION_KEY = "fashi.calibration.v1";

export type StoredProfile = {
  version: 1;
  updatedAt: string;
  /** Continuous axes; the label is always derived at render time. */
  axes: Axes;
  /** Measured colorimetry, kept so palettes can be re-anchored without a new capture. */
  skinLab: Lab;
  hairLab: Lab;
  /** Derived personal contrast (skin L* - hair L*). */
  contrast: number;
  /** Estimated illuminant CCT at capture time, for later diagnosis. */
  captureCct: number;
  /** Estimator reliability at capture time, propagated into confidence. */
  illuminantReliability: number;
  naturalHair: boolean;
  /** Drape quiz answers, which double as supervised labels. */
  quizAnswers: { axis: "W" | "D" | "C"; sign: 1 | -1 }[];
};

export async function saveProfile(p: Omit<StoredProfile, "version" | "updatedAt">): Promise<void> {
  const record: StoredProfile = { version: 1, updatedAt: new Date().toISOString(), ...p };
  await AsyncStorage.setItem(KEY, JSON.stringify(record));
}

export async function loadProfile(): Promise<StoredProfile | null> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredProfile;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearProfile(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}

/**
 * Reconstructs a full AnalysisResult from a StoredProfile and the active Trend.
 * Allows the user to view their saved measurements, derived Korean 8-tone label,
 * metal recommendation, and signature palette without re-capturing or storing photos.
 */
export function resultFromStoredProfile(profile: StoredProfile, trend: Trend): AnalysisResult {
  const axes = profile.axes;
  const skinD65 = profile.skinLab;
  const hairD65 = profile.hairLab;
  const label = deriveLabel(axes, trend);
  const palette = paletteFor(axes, skinD65, trend);
  const swatches = sampleSwatches(palette);
  const metal = metalFor(axes.W, trend);
  const olive = isOlive(axes, trend);
  const contrast = Number.isFinite(profile.contrast)
    ? profile.contrast
    : personalContrast(skinD65, hairD65);
  const confidence = axisConfidence(
    axes,
    trend,
    0,
    profile.illuminantReliability ?? 0.7
  );

  return {
    gate: {
      pass: true,
      checks: [],
      failures: [],
      warnings: [],
      skipped: [],
      neckOnly: false,
      summary: "Loaded from saved on-device profile.",
    },
    illuminant: {
      white: D65_WHITE,
      cct: profile.captureCct ?? 6500,
      duv: 0,
      method: "assumed-d65",
      reliability: profile.illuminantReliability ?? 0.7,
    },
    measurement: {
      skin: skinD65,
      cheekNeckDE00: 0,
      regionSpreadDE00: 0,
      regions: [
        {
          region: "neck",
          n: 100,
          considered: 100,
          lab: skinD65,
          rgb: { r: 128, g: 128, b: 128 },
          madL: 1,
        },
      ],
    },
    skinD65,
    hairD65,
    axes,
    confidence,
    label,
    palette,
    swatches,
    metal,
    olive,
    contrast,
    geometry: {
      box: { x: 0.25, y: 0.15, w: 0.5, h: 0.6 },
      ipdPx: 140,
      yaw: 0,
      pitch: 0,
    },
    landmarks: {
      points: [],
      chin: { x: 0.5, y: 0.75 },
      foreheadTop: { x: 0.5, y: 0.2 },
      noseTip: { x: 0.5, y: 0.5 },
      leftIris: { x: 0.4, y: 0.38 },
      rightIris: { x: 0.6, y: 0.38 },
      leftJaw: { x: 0.25, y: 0.55 },
      rightJaw: { x: 0.75, y: 0.55 },
      leftEye: { inner: { x: 0.45, y: 0.38 }, outer: { x: 0.35, y: 0.38 } },
      rightEye: { inner: { x: 0.55, y: 0.38 }, outer: { x: 0.65, y: 0.38 } },
    },
    segmentation: {
      faceMask: new Uint8Array(0),
      neckMask: new Uint8Array(0),
      hairMask: new Uint8Array(0),
      clothingMask: new Uint8Array(0),
      clothingBounce: {
        clothesAdjacentSaturated: false,
        adjacentChroma: 0,
        adjacentLab: { L: NaN, a: NaN, b: NaN },
      },
    },
  };
}

/** Stored calibration captures. Synthetic reference data is never written here. */
export type StoredCalibration = {
  version: 1;
  samples: { skin: Lab; hair: Lab; note?: string }[];
};

export async function appendCalibrationSample(skin: Lab, hair: Lab, note?: string): Promise<number> {
  const existing = await loadCalibration();
  const next: StoredCalibration = {
    version: 1,
    samples: [...existing.samples, { skin, hair, note }],
  };
  await AsyncStorage.setItem(CALIBRATION_KEY, JSON.stringify(next));
  return next.samples.length;
}

/**
 * Load calibration captures measured on this device, used to refit the trend (P0.6).
 *
 * Deliberately never pre-seeded. The bundled Monk Skin Tone baseline in calibrationData.ts is
 * synthetic, and feeding it to fitTrend() as if it were captured data would unlock tone labels
 * that nobody measured - exactly the "guess dressed up as a result" failure the plan forbids.
 * The baseline stays in the repo as reference data and as a regression fixture.
 */
export async function loadCalibration(): Promise<StoredCalibration> {
  const raw = await AsyncStorage.getItem(CALIBRATION_KEY);
  if (!raw) return { version: 1, samples: [] };
  try {
    const parsed = JSON.parse(raw) as StoredCalibration;
    return parsed.version === 1 ? parsed : { version: 1, samples: [] };
  } catch {
    return { version: 1, samples: [] };
  }
}

export async function clearCalibration(): Promise<void> {
  const empty: StoredCalibration = { version: 1, samples: [] };
  await AsyncStorage.setItem(CALIBRATION_KEY, JSON.stringify(empty));
}

// ---------------------------------------------------------------------------
// Consent (P1.11: explicit opt-in + retention control)
// ---------------------------------------------------------------------------

const CONSENT_KEY = "fashi.consent.v1";

/** True once the user has agreed to on-device measurement. Stored locally only. */
export async function loadConsent(): Promise<boolean> {
  return (await AsyncStorage.getItem(CONSENT_KEY)) === "agreed";
}

export async function saveConsent(): Promise<void> {
  await AsyncStorage.setItem(CONSENT_KEY, "agreed");
}
