import {
  fitTrend,
  computeAxes,
  deriveLabel,
  describeTriple,
  metalFor,
  isOlive,
  axisConfidence,
  chromaTolerance,
  personalContrast,
  median,
  mad,
  quantile,
  UNCALIBRATED_TREND,
  MIN_CALIBRATION_N,
  type CalibrationSample,
  type Trend,
} from "../src/analysis/axes";
import { sRGBToLab, labToLCh, lchToLab, type Lab } from "../src/color/convert";

// ---------------------------------------------------------------------------
// A synthetic South Asian calibration population.
//
// Built so hue and chroma genuinely trend with lightness, which is the confound the residual
// approach exists to remove. Skin L* spans 35-80 (roughly MST 3-9), hair is near-black throughout,
// and a controlled warm/cool spread is layered on top of the trend.
// ---------------------------------------------------------------------------
function makePopulation(n = 40): CalibrationSample[] {
  const out: CalibrationSample[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const L = 35 + t * 45;
    // Population trend: hue rises and chroma falls as skin lightens.
    const hTrend = 42 + 0.18 * L;
    const cTrend = 30 - 0.12 * L;
    // Deterministic pseudo-random offsets, so the fit sees real scatter but tests stay stable.
    const jitterH = Math.sin(i * 2.399) * 5;
    const jitterC = Math.cos(i * 1.777) * 3.5;
    const skin = lchToLab({ L, C: Math.max(6, cTrend + jitterC), h: hTrend + jitterH });
    const hair: Lab = { L: 11 + ((i * 7) % 9), a: 1.5, b: 2.5 };
    out.push({ skin, hair });
  }
  return out;
}

const POP = makePopulation();
const TREND = fitTrend(POP);

describe("robust statistics", () => {
  test("median handles odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  test("mad is scaled to estimate sigma and never returns zero", () => {
    const s = mad([10, 12, 14, 16, 18]);
    expect(s).toBeGreaterThan(2);
    expect(s).toBeLessThan(4);
    expect(mad([5, 5, 5, 5])).toBe(1);
  });
  test("quantile interpolates", () => {
    expect(quantile([0, 10], 0.5)).toBeCloseTo(5, 9);
    expect(quantile([0, 5, 10], 0.25)).toBeCloseTo(2.5, 9);
  });
});

describe("fitTrend", () => {
  test("recovers the population hue and chroma slopes", () => {
    expect(TREND.slopeH).toBeCloseTo(0.18, 1);
    expect(TREND.slopeC).toBeCloseTo(-0.12, 1);
  });
  test("marks itself calibrated only above the minimum subject count", () => {
    expect(fitTrend(makePopulation(MIN_CALIBRATION_N)).calibrated).toBe(true);
    expect(fitTrend(makePopulation(MIN_CALIBRATION_N - 1)).calibrated).toBe(false);
    expect(fitTrend([]).calibrated).toBe(false);
  });
  test("split points sit at the population median so all eight cells are reachable", () => {
    const zs = POP.map((s) => computeAxes({ skin: s.skin, hair: s.hair }, TREND));
    const above = zs.filter((a) => a.W >= TREND.splitW).length / zs.length;
    expect(above).toBeGreaterThan(0.4);
    expect(above).toBeLessThan(0.6);
    const deep = zs.filter((a) => a.D >= TREND.splitD).length / zs.length;
    expect(deep).toBeGreaterThan(0.4);
    expect(deep).toBeLessThan(0.6);
  });
  test("does not collapse the population into one or two cells", () => {
    // This is the failure mode the plan warns about: Western prototype splits put ~80% of Indian
    // users in "Deep". Percentile splits must spread the population out.
    const keys = new Set<string>();
    let maxShare = 0;
    const counts = new Map<string, number>();
    for (const s of POP) {
      const axes = computeAxes({ skin: s.skin, hair: s.hair }, TREND);
      const label = deriveLabel(axes, TREND);
      if (!label.calibrated) continue;
      keys.add(label.tone.key);
      counts.set(label.tone.key, (counts.get(label.tone.key) ?? 0) + 1);
    }
    for (const c of counts.values()) maxShare = Math.max(maxShare, c / POP.length);
    expect(keys.size).toBeGreaterThanOrEqual(4);
    expect(maxShare).toBeLessThan(0.5);
  });
});

describe("computeAxes", () => {
  test("z-scores stay in a plausible range on the population it was fitted to", () => {
    for (const s of POP) {
      const a = computeAxes({ skin: s.skin, hair: s.hair }, TREND);
      expect(Math.abs(a.W)).toBeLessThan(4);
      expect(Math.abs(a.D)).toBeLessThan(4);
      expect(Math.abs(a.C)).toBeLessThan(4);
    }
  });
  test("clamps pathological inputs instead of reporting false precision", () => {
    // The old engine reported W = -7.5 on its own demo data. A z beyond +/-6 means the sample is
    // outside anything the calibration covered, so it is clamped rather than presented.
    const wild = computeAxes({ skin: { L: 50, a: -40, b: -40 }, hair: { L: 12, a: 1, b: 2 } }, TREND);
    expect(wild.W).toBeGreaterThanOrEqual(-6);
    expect(wild.W).toBeLessThanOrEqual(6);
  });
  test("warmer skin at the same lightness gives a higher W", () => {
    const L = 55;
    const cool = lchToLab({ L, C: 20, h: 40 });
    const warm = lchToLab({ L, C: 20, h: 70 });
    const hair: Lab = { L: 12, a: 1, b: 2 };
    const wCool = computeAxes({ skin: cool, hair }, TREND).W;
    const wWarm = computeAxes({ skin: warm, hair }, TREND).W;
    expect(wWarm).toBeGreaterThan(wCool);
  });
  test("deeper skin gives a higher D", () => {
    const hair: Lab = { L: 12, a: 1, b: 2 };
    const light = computeAxes({ skin: lchToLab({ L: 75, C: 20, h: 55 }), hair }, TREND).D;
    const deep = computeAxes({ skin: lchToLab({ L: 40, C: 20, h: 55 }), hair }, TREND).D;
    expect(deep).toBeGreaterThan(light);
  });
  test("hue residual is invariant to absolute hue offset once the trend is refitted", () => {
    // The whole point of residuals: an absolute threshold like "warm if h > 52" misclassifies deep
    // skin wholesale, but a residual against the population trend does not.
    const shifted = POP.map((s) => {
      const lch = labToLCh(s.skin);
      return { skin: lchToLab({ ...lch, h: lch.h + 12 }), hair: s.hair };
    });
    const shiftedTrend = fitTrend(shifted);
    const before = computeAxes({ skin: POP[10].skin, hair: POP[10].hair }, TREND).W;
    const after = computeAxes({ skin: shifted[10].skin, hair: shifted[10].hair }, shiftedTrend).W;
    expect(Math.abs(after - before)).toBeLessThan(0.35);
  });
  test("dyed hair drops the hair term from clarity", () => {
    const skin = lchToLab({ L: 55, C: 22, h: 58 });
    const hair: Lab = { L: 38, a: 12, b: 8 }; // dyed burgundy-brown
    const natural = computeAxes({ skin, hair, naturalHair: true }, TREND).C;
    const dyed = computeAxes({ skin, hair, naturalHair: false }, TREND).C;
    expect(natural).not.toBeCloseTo(dyed, 3);
  });
  test("exposes the z-scores olive detection needs", () => {
    const a = computeAxes({ skin: POP[5].skin, hair: POP[5].hair }, TREND);
    expect(Number.isFinite(a.zH)).toBe(true);
    expect(Number.isFinite(a.zC)).toBe(true);
    expect(Number.isFinite(a.zL)).toBe(true);
    expect(a.zH).toBeCloseTo(a.W, 9);
  });
});

describe("Korean 8-tone mapping", () => {
  // Season quadrant comes from warmth x depth; the third axis picks the subtype.
  //   warm + light -> Spring    cool + light -> Summer
  //   warm + deep  -> Autumn    cool + deep  -> Winter
  const T: Trend = { ...TREND, splitW: 0, splitD: 0, splitC: 0, calibrated: true, n: 40 };
  const axesFor = (W: number, D: number, C: number) => ({ W, D, C, zH: W, zC: 0, zL: -D });

  test("warm and light is Spring", () => {
    expect(deriveLabel(axesFor(1, -1, 1), T).tone!.key).toBe("spring-bright");
    expect(deriveLabel(axesFor(1, -1, -1), T).tone!.key).toBe("spring-light");
  });
  test("warm and deep is Autumn", () => {
    expect(deriveLabel(axesFor(1, 1, 1), T).tone!.key).toBe("autumn-deep");
    expect(deriveLabel(axesFor(1, 1, -1), T).tone!.key).toBe("autumn-mute");
  });
  test("cool and light is Summer", () => {
    expect(deriveLabel(axesFor(-1, -1, 1), T).tone!.key).toBe("summer-light");
    expect(deriveLabel(axesFor(-1, -1, -1), T).tone!.key).toBe("summer-mute");
  });
  test("cool and deep is Winter", () => {
    expect(deriveLabel(axesFor(-1, 1, 1), T).tone!.key).toBe("winter-bright");
    expect(deriveLabel(axesFor(-1, 1, -1), T).tone!.key).toBe("winter-deep");
  });
  test("no invented tones: only the eight standard names appear", () => {
    const valid = new Set([
      "spring-light",
      "spring-bright",
      "summer-light",
      "summer-mute",
      "autumn-mute",
      "autumn-deep",
      "winter-bright",
      "winter-deep",
    ]);
    for (const W of [-1, 1]) {
      for (const D of [-1, 1]) {
        for (const C of [-1, 1]) {
          const tone = deriveLabel(axesFor(W, D, C), T).tone!;
          expect(valid.has(tone.key)).toBe(true);
        }
      }
    }
  });
  test("the English triple never contradicts the season name", () => {
    for (const W of [-1, 1]) {
      for (const D of [-1, 1]) {
        for (const C of [-1, 1]) {
          const axes = axesFor(W, D, C);
          const { tone, triple } = deriveLabel(axes, T) as { tone: NonNullable<ReturnType<typeof deriveLabel>["tone"]>; triple: string };
          const saysDeep = triple.includes("Deep");
          const seasonIsDeep = tone.key.startsWith("autumn") || tone.key.startsWith("winter");
          expect(saysDeep).toBe(seasonIsDeep);
          const saysWarm = triple.startsWith("Warm");
          const seasonIsWarm = tone.key.startsWith("spring") || tone.key.startsWith("autumn");
          if (saysWarm) expect(seasonIsWarm).toBe(true);
        }
      }
    }
  });
});

describe("label gating", () => {
  test("refuses to name a tone when the trend is not calibrated", () => {
    const axes = computeAxes({ skin: POP[0].skin, hair: POP[0].hair }, UNCALIBRATED_TREND);
    const label = deriveLabel(axes, UNCALIBRATED_TREND);
    expect(label.calibrated).toBe(false);
    expect(label.tone).toBeNull();
    expect(label.reason).toMatch(/calibration/i);
  });
  test("says how many more subjects are needed", () => {
    const partial = fitTrend(makePopulation(8));
    const label = deriveLabel(computeAxes({ skin: POP[0].skin, hair: POP[0].hair }, partial), partial);
    expect(label.calibrated).toBe(false);
    expect(label.reason).toContain("8");
  });
  test("emits a tone once calibrated", () => {
    const label = deriveLabel(computeAxes({ skin: POP[20].skin, hair: POP[20].hair }, TREND), TREND);
    expect(label.calibrated).toBe(true);
    expect(label.tone!.korean.length).toBeGreaterThan(0);
    expect(label.triple).toMatch(/·/);
  });
});

describe("derived outputs", () => {
  test("metal follows warmth with a neutral band", () => {
    expect(metalFor(1.2, TREND)).toBe("gold");
    expect(metalFor(-1.2, TREND)).toBe("silver");
    expect(metalFor(TREND.splitW, TREND)).toBe("both");
  });
  test("olive fires for neutral warmth with low chroma", () => {
    const olive = { W: TREND.splitW + 0.1, D: 0.4, C: -0.7, zH: 0.1, zC: -0.9, zL: -0.4 };
    const notOlive = { W: TREND.splitW + 1.4, D: 0.4, C: -0.7, zH: 1.4, zC: -0.9, zL: -0.4 };
    const highChroma = { W: TREND.splitW + 0.1, D: 0.4, C: 0.6, zH: 0.1, zC: 0.8, zL: -0.4 };
    expect(isOlive(olive, TREND)).toBe(true);
    expect(isOlive(notOlive, TREND)).toBe(false);
    expect(isOlive(highChroma, TREND)).toBe(false);
  });
  test("chroma tolerance rises as skin deepens", () => {
    expect(chromaTolerance(40)).toBeGreaterThan(chromaTolerance(80));
    expect(chromaTolerance(30)).toBeLessThanOrEqual(1);
    expect(chromaTolerance(95)).toBeGreaterThanOrEqual(0.15);
  });
  test("personal contrast is skin minus hair lightness", () => {
    expect(personalContrast({ L: 60, a: 0, b: 0 }, { L: 12, a: 0, b: 0 })).toBe(48);
  });
});

describe("confidence", () => {
  test("is low near a split and high far from it", () => {
    const near = axisConfidence({ W: TREND.splitW + 0.02, D: 2, C: 2, zH: 0, zC: 0, zL: 0 }, TREND);
    expect(near.W).toBeLessThan(0.1);
    expect(near.weakest).toBe("W");
    const far = axisConfidence({ W: TREND.splitW + 2, D: 2, C: 2, zH: 0, zC: 0, zL: 0 }, TREND);
    expect(far.W).toBeCloseTo(1, 6);
  });
  test("region disagreement degrades every axis", () => {
    const clean = axisConfidence({ W: 2, D: 2, C: 2, zH: 0, zC: 0, zL: 0 }, TREND, 0);
    const messy = axisConfidence({ W: 2, D: 2, C: 2, zH: 0, zC: 0, zL: 0 }, TREND, 12);
    expect(messy.overall).toBeLessThan(clean.overall);
  });
  test("identifies the weakest axis", () => {
    const c = axisConfidence({ W: 2, D: 2, C: TREND.splitC + 0.05, zH: 0, zC: 0, zL: 0 }, TREND);
    expect(c.weakest).toBe("C");
  });
});

describe("describeTriple", () => {
  test("uses a neutral band rather than forcing warm or cool", () => {
    const t: Trend = { ...TREND, splitW: 0 };
    expect(describeTriple({ W: 0.1, D: 1, C: 1, zH: 0, zC: 0, zL: 0 }, t)).toContain("Neutral");
    expect(describeTriple({ W: 1.5, D: 1, C: 1, zH: 0, zC: 0, zL: 0 }, t)).toContain("Warm");
    expect(describeTriple({ W: -1.5, D: 1, C: 1, zH: 0, zC: 0, zL: 0 }, t)).toContain("Cool");
  });
});
