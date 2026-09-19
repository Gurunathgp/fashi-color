import {
  sRGBToLab,
  labToSRGB,
  deltaE00,
  sRGBToOKLab,
  okLabToSRGB,
  okLabToOKLCh,
  okLChToOKLab,
  labToLCh,
  lchToLab,
  itaDegrees,
  paletteMembership,
} from "../src/color/convert";
import {
  adaptXYZ,
  D65_WHITE,
  D50_WHITE,
  cctToXYZ,
  cctToXy,
  planckianXy,
  daylightXy,
  estimateCCT,
  estimateDuv,
  estimateCCTandDuv,
  xyToXYZ,
  xyzToXy,
  xyToUv,
} from "../src/color/adapt";

describe("sRGB <-> Lab", () => {
  test("white is L*100, neutral", () => {
    const lab = sRGBToLab({ r: 255, g: 255, b: 255 });
    expect(lab.L).toBeCloseTo(100, 3);
    expect(Math.abs(lab.a)).toBeLessThan(0.01);
    expect(Math.abs(lab.b)).toBeLessThan(0.01);
  });
  test("black is L*0", () => {
    expect(sRGBToLab({ r: 0, g: 0, b: 0 }).L).toBeCloseTo(0, 6);
  });
  test("mid gray is achromatic", () => {
    const lab = sRGBToLab({ r: 128, g: 128, b: 128 });
    expect(Math.abs(lab.a)).toBeLessThan(0.01);
    expect(Math.abs(lab.b)).toBeLessThan(0.01);
    expect(lab.L).toBeGreaterThan(53);
    expect(lab.L).toBeLessThan(54);
  });
  test("round-trips every 17th sRGB code within 1 LSB", () => {
    let worst = 0;
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 17) {
        for (let b = 0; b <= 255; b += 17) {
          const back = labToSRGB(sRGBToLab({ r, g, b }));
          worst = Math.max(worst, Math.abs(back.r - r), Math.abs(back.g - g), Math.abs(back.b - b));
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1);
  });
  test("Lab <-> LCh round-trip", () => {
    const lab = sRGBToLab({ r: 210, g: 90, b: 40 });
    const back = lchToLab(labToLCh(lab));
    expect(back.a).toBeCloseTo(lab.a, 9);
    expect(back.b).toBeCloseTo(lab.b, 9);
  });
  test("ITA of a light neutral-warm skin is in the documented 'intermediate/light' band", () => {
    // sanity of sign & magnitude only; ITA is unreliable at low L* by design (see plan section 3.2)
    const ita = itaDegrees(sRGBToLab({ r: 228, g: 195, b: 172 }));
    expect(ita).toBeGreaterThan(28);
    expect(ita).toBeLessThan(70);
  });
});

describe("OKLab", () => {
  test("round-trips every 17th sRGB code within 1 LSB", () => {
    let worst = 0;
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 17) {
        for (let b = 0; b <= 255; b += 17) {
          const back = okLabToSRGB(sRGBToOKLab({ r, g, b }));
          worst = Math.max(worst, Math.abs(back.r - r), Math.abs(back.g - g), Math.abs(back.b - b));
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1);
  });
  test("white is L=1", () => {
    expect(sRGBToOKLab({ r: 255, g: 255, b: 255 }).L).toBeCloseTo(1, 3);
  });
  test("OKLab <-> OKLCh round-trip", () => {
    const ok = sRGBToOKLab({ r: 40, g: 130, b: 200 });
    const back = okLChToOKLab(okLabToOKLCh(ok));
    expect(back.a).toBeCloseTo(ok.a, 12);
    expect(back.b).toBeCloseTo(ok.b, 12);
  });
  test("hue spacing across the six sRGB primaries is measurably more uniform than CIELAB", () => {
    // This is the documented reason for using OKLCh for palette arcs (plan section 2.1):
    // CIELAB hue angles are perceptually non-uniform, so "40 degrees wide" means very
    // different things in different parts of the wheel. Measured spread of the six
    // primary-to-primary gaps: CIELAB ~28 degrees, OKLCh ~15 degrees.
    const primaries: { r: number; g: number; b: number }[] = [
      { r: 255, g: 0, b: 0 },
      { r: 255, g: 255, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 255, b: 255 },
      { r: 0, g: 0, b: 255 },
      { r: 255, g: 0, b: 255 },
    ];
    const spread = (hues: number[]) => {
      const gaps = hues.map((h, i) => {
        const next = i === hues.length - 1 ? hues[0] + 360 : hues[i + 1];
        return next - h;
      });
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      return Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
    };
    const labSpread = spread(primaries.map((p) => labToLCh(sRGBToLab(p)).h));
    const okSpread = spread(primaries.map((p) => okLabToOKLCh(sRGBToOKLab(p)).h));
    expect(okSpread).toBeLessThan(labSpread);
    expect(okSpread).toBeLessThan(20);
    expect(labSpread).toBeGreaterThan(25);
  });
});

describe("deltaE00 vs Sharma/Melgosa/Huertas CIEDE2000 reference data", () => {
  // Sharma, Wu & Dalal (2005), Table 1. All 34 pairs.
  const CASES: [number[], number[], number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.0200], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0000],
    [[50, -1.1848, -84.8006], [50, 0, -82.7485], 1.0000],
    [[50, -0.9009, -85.5211], [50, 0, -82.7485], 1.0000],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, -1, 2], [50, 0, 0], 2.3669],
    [[50, 2.4900, -0.0010], [50, -2.4900, 0.0009], 7.1792],
    [[50, 2.4900, -0.0010], [50, -2.4900, 0.0010], 7.1792],
    [[50, 2.4900, -0.0010], [50, -2.4900, 0.0011], 7.2195],
    [[50, 2.4900, -0.0010], [50, -2.4900, 0.0012], 7.2195],
    [[50, -0.0010, 2.4900], [50, 0.0009, -2.4900], 4.8045],
    [[50, -0.0010, 2.4900], [50, 0.0010, -2.4900], 4.8045],
    [[50, -0.0010, 2.4900], [50, 0.0011, -2.4900], 4.7461],
    [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[50, 2.5, 0], [56, -27, -3], 31.9030],
    [[50, 2.5, 0], [58, 24, 15], 19.4535],
    [[50, 2.5, 0], [50, 3.1736, 0.5854], 1.0000],
    [[50, 2.5, 0], [50, 3.2972, 0], 1.0000],
    [[50, 2.5, 0], [50, 1.8634, 0.5757], 1.0000],
    [[50, 2.5, 0], [50, 3.2592, 0.3350], 1.0000],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.2630],
    [[61.2901, 3.7196, -5.3901], [61.4292, 2.2480, -4.9620], 1.8731],
    [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
    [[22.7233, 20.0904, -46.6940], [23.0331, 14.9730, -42.5619], 2.0373],
    [[36.4612, 47.8580, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
    [[90.8027, -2.0831, 1.4410], [91.1528, -1.6435, 0.0447], 1.4441],
    [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
    [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
    [[2.0776, 0.0795, -1.1350], [0.9033, -0.0636, -0.5514], 0.9082],
  ];
  test.each(CASES)("pair %#", (a, b, expected) => {
    const got = deltaE00({ L: a[0], a: a[1], b: a[2] }, { L: b[0], a: b[1], b: b[2] });
    expect(got).toBeCloseTo(expected, 3);
  });
  test("is symmetric", () => {
    for (const [a, b] of CASES) {
      const p = { L: a[0], a: a[1], b: a[2] };
      const q = { L: b[0], a: b[1], b: b[2] };
      expect(deltaE00(p, q)).toBeCloseTo(deltaE00(q, p), 9);
    }
  });
  test("identical colours are zero", () => {
    const lab = sRGBToLab({ r: 100, g: 150, b: 200 });
    expect(deltaE00(lab, lab)).toBeCloseTo(0, 9);
  });
});

describe("Bradford chromatic adaptation", () => {
  // The published inverse Bradford matrix is only specified to 7 significant figures, so
  // round-trips are accurate to ~1e-7 relative, not to machine epsilon. Tolerances reflect that.
  test("D65 -> D50 -> D65 is identity", () => {
    for (const xyz of [
      { X: 30, Y: 40, Z: 50 },
      { X: 5, Y: 3, Z: 90 },
      { X: 88, Y: 92, Z: 12 },
    ]) {
      const there = adaptXYZ(xyz, D65_WHITE, D50_WHITE);
      const back = adaptXYZ(there, D50_WHITE, D65_WHITE);
      expect(back.X).toBeCloseTo(xyz.X, 4);
      expect(back.Y).toBeCloseTo(xyz.Y, 4);
      expect(back.Z).toBeCloseTo(xyz.Z, 4);
    }
  });
  test("maps source white exactly onto destination white", () => {
    const w = adaptXYZ(D65_WHITE, D65_WHITE, D50_WHITE);
    expect(w.X).toBeCloseTo(D50_WHITE.X, 4);
    expect(w.Y).toBeCloseTo(D50_WHITE.Y, 4);
    expect(w.Z).toBeCloseTo(D50_WHITE.Z, 4);
  });
  test("same-white adaptation is a no-op", () => {
    const xyz = { X: 41, Y: 33, Z: 27 };
    const out = adaptXYZ(xyz, D65_WHITE, D65_WHITE);
    expect(out.X).toBeCloseTo(xyz.X, 5);
    expect(out.Z).toBeCloseTo(xyz.Z, 5);
  });
});

describe("Planckian locus vs published CIE illuminant chromaticities", () => {
  // These are the regression tests the old implementation lacked. Illuminant A is the
  // published anchor for the tungsten range that dominates Indian indoor lighting.
  test("Illuminant A (2856 K) matches CIE x=0.44758 y=0.40745", () => {
    const { x, y } = planckianXy(2856);
    expect(x).toBeCloseTo(0.44758, 2);
    expect(y).toBeCloseTo(0.40745, 2);
  });
  test("y stays on the blackbody line (0.34-0.42) across 2000-4000 K", () => {
    for (const T of [2000, 2200, 2500, 2700, 3000, 3500, 4000]) {
      const { y } = planckianXy(T);
      expect(y).toBeGreaterThan(0.34);
      expect(y).toBeLessThan(0.42);
    }
  });
  test("warmer means larger x and the locus is monotone in x", () => {
    let prev = Infinity;
    for (const T of [1667, 2000, 2500, 3000, 4000, 5000, 6500, 10000]) {
      const { x } = planckianXy(T);
      expect(x).toBeLessThan(prev);
      prev = x;
    }
    expect(planckianXy(2700).x).toBeGreaterThan(0.44);
  });
  test("all sub-branch handovers are continuous", () => {
    for (const T of [2222, 4000]) {
      const lo = planckianXy(T - 0.5);
      const hi = planckianXy(T + 0.5);
      expect(Math.abs(hi.x - lo.x)).toBeLessThan(0.001);
      expect(Math.abs(hi.y - lo.y)).toBeLessThan(0.001);
    }
  });
  test("clamps outside 1667-25000 K instead of silently returning a constant", () => {
    expect(planckianXy(1200).x).toBeCloseTo(planckianXy(1667).x, 9);
    expect(planckianXy(99999).x).toBeCloseTo(planckianXy(25000).x, 9);
  });
});

describe("CIE daylight locus", () => {
  test("D50 (5003 K) matches x=0.3457 y=0.3585", () => {
    const { x, y } = daylightXy(5003);
    expect(x).toBeCloseTo(0.3457, 3);
    expect(y).toBeCloseTo(0.3585, 3);
  });
  test("D65 (6504 K) matches x=0.3127 y=0.3290", () => {
    const { x, y } = daylightXy(6504);
    expect(x).toBeCloseTo(0.3127, 3);
    expect(y).toBeCloseTo(0.3290, 3);
  });
  test("D75 (7504 K) matches x=0.2990 y=0.3149", () => {
    const { x, y } = daylightXy(7504);
    expect(x).toBeCloseTo(0.2990, 3);
    expect(y).toBeCloseTo(0.3149, 3);
  });
  test("D65 white point round-trips through XYZ", () => {
    const xyz = cctToXYZ(6504, "daylight");
    const xy = xyzToXy(xyz);
    expect(xy.x).toBeCloseTo(0.3127, 3);
    expect(xy.y).toBeCloseTo(0.3290, 3);
  });
});

describe("CCT and Duv estimation", () => {
  test("recovers Planckian CCT to within 1% over 2000-10000 K", () => {
    for (const T of [2000, 2700, 2856, 3000, 3500, 4000, 5000, 6500, 8000, 10000]) {
      const est = estimateCCT(planckianXy(T));
      expect(Math.abs(est - T) / T).toBeLessThan(0.01);
    }
  });
  test("Duv is ~0 on the Planckian locus", () => {
    for (const T of [2700, 3000, 4000, 5000, 6500]) {
      expect(Math.abs(estimateDuv(planckianXy(T)))).toBeLessThan(0.0005);
    }
  });
  test("D65 sits slightly above the Planckian locus, Duv approx +0.0032 as published", () => {
    const duv = estimateDuv({ x: 0.31272, y: 0.32903 });
    expect(duv).toBeGreaterThan(0);
    expect(duv).toBeCloseTo(0.0032, 3);
  });
  test("Duv sign follows displacement in CIE 1960 v", () => {
    const base = planckianXy(4000);
    const uv = xyToUv(base);
    const toXy = (u: number, v: number) => {
      const d = 2 * u - 8 * v + 4;
      return { x: (3 * u) / d, y: (2 * v) / d };
    };
    expect(estimateDuv(toXy(uv.u, uv.v + 0.01))).toBeGreaterThan(0);
    expect(estimateDuv(toXy(uv.u, uv.v - 0.01))).toBeLessThan(0);
  });
  test("magnitude tracks the offset size", () => {
    const uv = xyToUv(planckianXy(4000));
    const toXy = (u: number, v: number) => {
      const d = 2 * u - 8 * v + 4;
      return { x: (3 * u) / d, y: (2 * v) / d };
    };
    const small = Math.abs(estimateDuv(toXy(uv.u, uv.v + 0.004)));
    const big = Math.abs(estimateDuv(toXy(uv.u, uv.v + 0.02)));
    expect(small).toBeGreaterThan(0.002);
    expect(small).toBeLessThan(0.008);
    expect(big).toBeGreaterThan(small * 2);
  });
  test("combined helper agrees with the individual ones", () => {
    const xy = daylightXy(5200);
    const both = estimateCCTandDuv(xy);
    expect(both.cct).toBe(estimateCCT(xy));
    expect(both.duv).toBeCloseTo(estimateDuv(xy), 12);
  });
  test("auto locus selects Planckian at or below 4000 K, daylight above", () => {
    expect(cctToXy(3000)).toEqual(planckianXy(3000));
    expect(cctToXy(6500)).toEqual(daylightXy(6500));
  });
  test("xy <-> XYZ round-trip", () => {
    const xyz = xyToXYZ(0.3457, 0.3585);
    const xy = xyzToXy(xyz);
    expect(xy.x).toBeCloseTo(0.3457, 9);
    expect(xy.y).toBeCloseTo(0.3585, 9);
  });
});

describe("paletteMembership", () => {
  const region = {
    hueArcs: [{ center: 40, halfwidth: 30 }],
    Cmin: 10,
    Cmax: 60,
    Lmin: 30,
    Lmax: 85,
    skinL: 55,
    deltaL: 12,
    isFaceAdjacent: true,
  };
  test("scores 1 inside the region", () => {
    const inside = lchToLab({ L: 75, C: 35, h: 40 });
    expect(paletteMembership(inside, region)).toBeCloseTo(1, 6);
  });
  test("falls off outside the hue arc", () => {
    const inside = lchToLab({ L: 75, C: 35, h: 40 });
    const outside = lchToLab({ L: 75, C: 35, h: 200 });
    expect(paletteMembership(outside, region)).toBeLessThan(paletteMembership(inside, region));
  });
  test("penalises garment lightness too close to skin lightness", () => {
    const near = lchToLab({ L: 56, C: 35, h: 40 });
    const far = lchToLab({ L: 78, C: 35, h: 40 });
    expect(paletteMembership(near, region)).toBeLessThan(paletteMembership(far, region));
  });
  test("face-adjacency constraint only applies when requested", () => {
    const near = lchToLab({ L: 56, C: 35, h: 40 });
    expect(paletteMembership(near, { ...region, isFaceAdjacent: false })).toBeGreaterThan(
      paletteMembership(near, region)
    );
  });
  test("always returns 0..1", () => {
    for (let L = 0; L <= 100; L += 10) {
      for (let C = 0; C <= 100; C += 10) {
        for (let h = 0; h < 360; h += 30) {
          const v = paletteMembership(lchToLab({ L, C, h }), region);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
