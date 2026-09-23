import { SYNTHETIC_BASELINE_TREND } from "../src/analysis/calibrationData";
import {
  deriveLabel,
  fitTrend,
  metalFor,
  isOlive,
  axisConfidence,
  type Axes,
  type CalibrationSample,
} from "../src/analysis/axes";
import { applyQuizAnswers } from "../src/analysis/drape";
import { paletteFor, sampleSwatches } from "../src/analysis/palette";

const storage: Record<string, string> = {};
jest.mock("@react-native-async-storage/async-storage", () => ({
  setItem: jest.fn((key: string, val: string) => {
    storage[key] = val;
    return Promise.resolve();
  }),
  getItem: jest.fn((key: string) => Promise.resolve(storage[key] ?? null)),
  removeItem: jest.fn((key: string) => {
    delete storage[key];
    return Promise.resolve();
  }),
}));

import {
  saveProfile,
  loadProfile,
  clearProfile,
  resultFromStoredProfile,
  type StoredProfile,
} from "../src/storage/profile";

/**
 * Stand-in for real P0.5 captures, shared by both suites below. Only a source:"captured" trend may
 * name a tone, so label assertions need a captured fit rather than the bundled synthetic baseline.
 */
const capturedTrend = fitTrend(
  Array.from({ length: 20 }, (_, i) => {
    const L = 32 + (i * 55) / 19;
    return {
      skin: { L, a: 11 + (L / 100) * 5, b: 17 + (L / 100) * 9 },
      hair: { L: 14 + (i % 3), a: 1.2, b: 2.1 },
    } as CalibrationSample;
  }),
  "captured"
);

describe("Profile Persistence & Result Reconstruction", () => {
  beforeEach(async () => {
    await clearProfile();
  });

  test("resultFromStoredProfile reconstructs full AnalysisResult with valid fields", () => {
    const mockProfile: StoredProfile = {
      version: 1,
      updatedAt: "2026-09-23T12:00:00.000Z",
      axes: {
        W: 0.8,
        D: 0.9,
        C: -0.4,
        zH: 0.8,
        zC: -0.4,
        zL: -0.9,
      },
      skinLab: { L: 52, a: 15, b: 24 },
      hairLab: { L: 13, a: 1.5, b: 2.2 },
      contrast: 39,
      captureCct: 5600,
      illuminantReliability: 0.85,
      naturalHair: true,
      quizAnswers: [],
    };

    const res = resultFromStoredProfile(mockProfile, capturedTrend);

    expect(res.axes.W).toBe(0.8);
    expect(res.skinD65.L).toBe(52);
    expect(res.hairD65.L).toBe(13);
    expect(res.contrast).toBe(39);
    expect(res.metal).toBe("gold");
    expect(res.label.calibrated).toBe(true);
    if (res.label.calibrated) {
      expect(res.label.tone.english).toContain("Autumn");
      expect(res.label.tone.korean).toContain("가을");
    }
    expect(res.swatches.length).toBeGreaterThanOrEqual(6);
    for (const swatch of res.swatches) {
      expect(swatch.name).toBeTruthy();
      expect(swatch.hex.startsWith("#")).toBe(true);
      expect(swatch.score).toBeGreaterThan(0);
    }
    expect(res.gate.pass).toBe(true);
    expect(res.illuminant.cct).toBe(5600);
  });

  test("a saved profile cannot name a tone from the synthetic baseline", () => {
    const mockProfile: StoredProfile = {
      version: 1,
      updatedAt: "2026-09-23T12:00:00.000Z",
      axes: { W: 0.8, D: 0.9, C: -0.4, zH: 0.8, zC: -0.4, zL: -0.9 },
      skinLab: { L: 52, a: 15, b: 24 },
      hairLab: { L: 13, a: 1.5, b: 2.2 },
      contrast: 39,
      captureCct: 5600,
      illuminantReliability: 0.85,
      naturalHair: true,
      quizAnswers: [],
    };

    const res = resultFromStoredProfile(mockProfile, SYNTHETIC_BASELINE_TREND);
    expect(res.label.calibrated).toBe(false);
    // Measurements and palette survive: only the season name is withheld.
    expect(res.swatches.length).toBeGreaterThanOrEqual(6);
    expect(res.skinD65.L).toBe(52);
  });

  test("saveProfile and loadProfile round-trip correctly", async () => {
    expect(await loadProfile()).toBeNull();

    await saveProfile({
      axes: { W: 0.2, D: -0.1, C: 0.5, zH: 0.2, zC: 0.5, zL: 0.1 },
      skinLab: { L: 68, a: 11, b: 20 },
      hairLab: { L: 15, a: 1.2, b: 2.0 },
      contrast: 53,
      captureCct: 5200,
      illuminantReliability: 0.75,
      naturalHair: true,
      quizAnswers: [{ axis: "W", sign: 1 }],
    });

    const loaded = await loadProfile();
    expect(loaded).not.toBeNull();
    expect(loaded?.axes.W).toBe(0.2);
    expect(loaded?.contrast).toBe(53);
    expect(loaded?.quizAnswers).toHaveLength(1);

    await clearProfile();
    expect(await loadProfile()).toBeNull();
  });
});

describe("Drape Quiz Answer Propagation", () => {
  test("quiz answers successfully flip borderline axis and update tone label and metal", () => {
    // Start with a borderline cool-leaning profile (W = -0.1)
    const initialAxes: Axes = {
      W: -0.1,
      D: 0.6,
      C: -0.4,
      zH: -0.1,
      zC: -0.4,
      zL: -0.6,
    };

    const initialLabel = deriveLabel(initialAxes, capturedTrend);
    const initialMetal = metalFor(initialAxes.W, capturedTrend);

    // Initial label is Winter (Cool)
    if (initialLabel.calibrated) {
      expect(initialLabel.tone.english).toContain("Winter");
    }
    expect(initialMetal).not.toBe("gold");

    // User completes drape quiz favoring warm 3 times (+0.2 * 3 = +0.6 shift)
    const quizAnswers: { axis: "W" | "D" | "C"; sign: 1 | -1 }[] = [
      { axis: "W", sign: 1 },
      { axis: "W", sign: 1 },
      { axis: "W", sign: 1 },
    ];

    const nextAxes = applyQuizAnswers(initialAxes, quizAnswers);
    expect(nextAxes.W).toBeCloseTo(0.5, 1);

    // Re-deriving all dependent outputs
    const updatedLabel = deriveLabel(nextAxes, capturedTrend);
    const updatedMetal = metalFor(nextAxes.W, capturedTrend);
    const updatedOlive = isOlive(nextAxes, capturedTrend);
    const updatedPalette = paletteFor(nextAxes, { L: 55, a: 14, b: 22 }, capturedTrend);
    const updatedSwatches = sampleSwatches(updatedPalette);

    // Now the tone has successfully flipped to Autumn (Warm) and metal to Gold
    expect(updatedLabel.calibrated).toBe(true);
    if (updatedLabel.calibrated) {
      expect(updatedLabel.tone.english).toContain("Autumn");
      expect(updatedLabel.tone.korean).toContain("가을");
    }
    expect(updatedMetal).toBe("gold");
    expect(updatedSwatches.length).toBeGreaterThanOrEqual(6);
  });
});
