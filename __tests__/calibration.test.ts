import {
  MONK_SCALE_ANCHORS,
  SYNTHETIC_BASELINE_SAMPLES,
  SYNTHETIC_BASELINE_TREND,
} from "../src/analysis/calibrationData";
import {
  computeAxes,
  deriveLabel,
  fitTrend,
  MIN_CALIBRATION_N,
  type CalibrationSample,
} from "../src/analysis/axes";

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

import { loadCalibration, clearCalibration, appendCalibrationSample } from "../src/storage/profile";

/**
 * A stand-in for real P0.5 captures: evenly spread lightness with the warm a-b drift the plan
 * documents. Used to prove that captured data does unlock labels, which is the other half of the
 * provenance rule.
 */
function capturedSamples(n: number): CalibrationSample[] {
  return Array.from({ length: n }, (_, i) => {
    const L = 30 + (i * 60) / Math.max(1, n - 1);
    return {
      skin: { L, a: 11 + (L / 100) * 5, b: 17 + (L / 100) * 9 },
      hair: { L: 14 + (i % 3), a: 1.2, b: 2.1 },
    };
  });
}

describe("MST baseline is synthetic reference data, not calibration", () => {
  test("monk scale anchors span MST 1 through 10 with decreasing lightness", () => {
    expect(MONK_SCALE_ANCHORS).toHaveLength(10);
    for (let i = 0; i < MONK_SCALE_ANCHORS.length - 1; i++) {
      expect(MONK_SCALE_ANCHORS[i].lab.L).toBeGreaterThan(MONK_SCALE_ANCHORS[i + 1].lab.L);
    }
  });

  test("contains 50 generated profiles inside plausible South Asian lightness ranges", () => {
    expect(SYNTHETIC_BASELINE_SAMPLES).toHaveLength(50);
    for (const sample of SYNTHETIC_BASELINE_SAMPLES) {
      expect(sample.skin.L).toBeGreaterThanOrEqual(25);
      expect(sample.skin.L).toBeLessThanOrEqual(95);
      expect(sample.hair.L).toBeGreaterThanOrEqual(8);
      expect(sample.hair.L).toBeLessThanOrEqual(25);
    }
  });

  test("baseline trend is marked synthetic and refuses to be calibrated", () => {
    expect(SYNTHETIC_BASELINE_TREND.source).toBe("synthetic");
    expect(SYNTHETIC_BASELINE_TREND.calibrated).toBe(false);
    expect(SYNTHETIC_BASELINE_TREND.n).toBe(50);
    // The slope/mad values are still fitted, so the reference set stays useful for inspection.
    expect(Number.isFinite(SYNTHETIC_BASELINE_TREND.slopeH)).toBe(true);
    expect(SYNTHETIC_BASELINE_TREND.madH).toBeGreaterThan(0);
  });

  test("no tone label can be derived from the synthetic baseline", () => {
    for (const sample of SYNTHETIC_BASELINE_SAMPLES) {
      const axes = computeAxes({ skin: sample.skin, hair: sample.hair }, SYNTHETIC_BASELINE_TREND);
      const label = deriveLabel(axes, SYNTHETIC_BASELINE_TREND);
      expect(label.calibrated).toBe(false);
      if (!label.calibrated) {
        expect(label.triple).toBeNull();
        expect(label.tone).toBeNull();
        expect(label.reason).toMatch(/synthetic/i);
      }
    }
  });

  test("provenance decides calibration, not sample count alone", () => {
    const captured = capturedSamples(MIN_CALIBRATION_N);
    expect(fitTrend(captured, "captured").calibrated).toBe(true);
    expect(fitTrend(captured, "synthetic").calibrated).toBe(false);
    // Below the P0.5 floor nothing calibrates, whatever the provenance says.
    expect(fitTrend(capturedSamples(MIN_CALIBRATION_N - 1), "captured").calibrated).toBe(false);
  });

  test("storage starts empty and only ever holds real captures", async () => {
    await clearCalibration();
    const empty = await loadCalibration();
    expect(empty.samples).toHaveLength(0);

    const count = await appendCalibrationSample({ L: 55, a: 15, b: 24 }, { L: 13, a: 1, b: 2 }, "test");
    expect(count).toBe(1);
    const stored = await loadCalibration();
    expect(stored.samples).toHaveLength(1);
    expect(stored.samples[0].note).toBe("test");

    await clearCalibration();
    expect((await loadCalibration()).samples).toHaveLength(0);
  });
});
