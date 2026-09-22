// Local persistence. Plan section 3.1 and P1.11.
//
// Two rules, both load-bearing:
//  1. Store the continuous z-scores, never the label. Recalibrating the split points later must
//     update every existing user's label without asking anyone to reshoot.
//  2. Never store photos. Derived colorimetric features only. Face images are biometric data, and
//     "your photo never leaves your phone" is only true if nothing writes it to disk.

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Axes } from "../analysis/axes";
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

/** Calibration samples accumulated from P0.5 captures, used to refit the trend on device. */
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
  await AsyncStorage.removeItem(CALIBRATION_KEY);
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
