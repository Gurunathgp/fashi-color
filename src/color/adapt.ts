// P0.2 Bradford chromatic adaptation + illuminant loci (Planckian / CIE daylight) + CCT & Duv
//
// Correctness notes (fixed 9/3/2026 after audit):
//  - Planckian locus uses the full Kim et al. (2002) piecewise cubics, all three y-branches.
//    The previous version reused Kim's x(T) 4000-25000K coefficients as a y(x) polynomial,
//    which put Illuminant A at y=0.491 instead of 0.4074 and made the derived white point's
//    Z component 235% wrong. That range (2700-3500K tungsten / warm LED) is exactly what
//    Indian indoor lighting is, so it mattered more than anywhere else.
//  - CCT and Duv are DEFINED against the Planckian locus in CIE 1960 uv, never the daylight
//    locus. Searching the daylight branch made estimateCCT self-consistent with a broken
//    cctToXy and therefore untestable.
//
// References: CIE 15:2004; Kim et al., "Design of Advanced Color Temperature Control System
// for HDTV Applications", J. Korean Phys. Soc. 41 (2002); Ohno, LEUKOS 10(1) 2013 (Duv).

import type { XYZ } from "./convert";

const Bradford = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
] as const;
const BradfordInv = [
  [0.9869929, -0.1470543, 0.1599627],
  [0.4323053, 0.5183603, 0.0492912],
  [-0.00852866, 0.0400428, 0.9684867],
] as const;

function mul3x3(m: readonly (readonly number[])[], v: readonly [number, number, number]): [number, number, number] {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/** Adapt XYZ from source white Ws to destination white Wd (von Kries scaling in Bradford cone space). */
export function adaptXYZ(xyz: XYZ, Ws: XYZ, Wd: XYZ): XYZ {
  const srcCone = mul3x3(Bradford, [Ws.X, Ws.Y, Ws.Z]);
  const dstCone = mul3x3(Bradford, [Wd.X, Wd.Y, Wd.Z]);
  const cone = mul3x3(Bradford, [xyz.X, xyz.Y, xyz.Z]);
  const adapted: [number, number, number] = [
    cone[0] * (dstCone[0] / (srcCone[0] || 1e-9)),
    cone[1] * (dstCone[1] / (srcCone[1] || 1e-9)),
    cone[2] * (dstCone[2] / (srcCone[2] || 1e-9)),
  ];
  const out = mul3x3(BradfordInv, adapted);
  return { X: out[0], Y: out[1], Z: out[2] };
}

/** Standard whites, normalised to Y = 100. */
export const D65_WHITE: XYZ = { X: 95.047, Y: 100, Z: 108.883 };
export const D50_WHITE: XYZ = { X: 96.422, Y: 100, Z: 82.521 };

export function xyToXYZ(x: number, y: number): XYZ {
  const Y = 100;
  return { X: (x / y) * Y, Y, Z: ((1 - x - y) / y) * Y };
}
export function xyzToXy({ X, Y, Z }: XYZ): { x: number; y: number } {
  const s = X + Y + Z;
  return s < 1e-9 ? { x: 0.3127, y: 0.329 } : { x: X / s, y: Y / s };
}

// ---------------------------------------------------------------------------
// Loci
// ---------------------------------------------------------------------------

export const PLANCKIAN_MIN_K = 1667;
export const PLANCKIAN_MAX_K = 25000;
export const DAYLIGHT_MIN_K = 4000;
export const DAYLIGHT_MAX_K = 25000;

/**
 * Planckian (blackbody) locus, Kim et al. 2002. Valid 1667-25000 K; clamped outside.
 * Tungsten and warm "filament-style" LEDs track this closely.
 */
export function planckianXy(T: number): { x: number; y: number } {
  const t = Math.min(PLANCKIAN_MAX_K, Math.max(PLANCKIAN_MIN_K, T));
  const t2 = t * t;
  const t3 = t2 * t;
  const x =
    t <= 4000
      ? -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.179910
      : -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.240390;
  const x2 = x * x;
  const x3 = x2 * x;
  let y: number;
  if (t <= 2222) y = -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683;
  else if (t <= 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;
  return { x, y };
}

/**
 * CIE daylight locus (D-series), valid 4000-25000 K; clamped outside.
 * Daylight, cool-white / neutral phosphor LEDs sit near this.
 */
export function daylightXy(T: number): { x: number; y: number } {
  const t = Math.min(DAYLIGHT_MAX_K, Math.max(DAYLIGHT_MIN_K, T));
  const t2 = t * t;
  const t3 = t2 * t;
  const x =
    t <= 7000
      ? 0.244063 + 0.09911e3 / t + 2.9678e6 / t2 - 4.607e9 / t3
      : 0.237040 + 0.24748e3 / t + 1.9018e6 / t2 - 2.0064e9 / t3;
  const y = -3 * x * x + 2.87 * x - 0.275;
  return { x, y };
}

export type Locus = "planckian" | "daylight" | "auto";

/**
 * CCT -> xy. `auto` follows the plan: Planckian at or below 4000 K (tungsten/warm LED),
 * CIE daylight above (daylight/cool white). Note the two loci differ by ~0.007 in y at the
 * 4000 K handover; that is a genuine physical difference between a blackbody and a D-series
 * illuminant of the same CCT, not an error. Pick an explicit locus when it matters.
 */
export function cctToXy(T: number, locus: Locus = "auto"): { x: number; y: number } {
  if (!Number.isFinite(T) || T <= 0) return { x: 0.3127, y: 0.329 };
  if (locus === "planckian") return planckianXy(T);
  if (locus === "daylight") return daylightXy(T);
  return T > 4000 ? daylightXy(T) : planckianXy(T);
}
export function cctToXYZ(T: number, locus: Locus = "auto"): XYZ {
  const { x, y } = cctToXy(T, locus);
  return xyToXYZ(x, y);
}

// ---------------------------------------------------------------------------
// CIE 1960 UCS + CCT / Duv estimation (Planckian locus only, by definition)
// ---------------------------------------------------------------------------

export function xyToUv({ x, y }: { x: number; y: number }): { u: number; v: number } {
  const d = -2 * x + 12 * y + 3;
  if (Math.abs(d) < 1e-12) return { u: 0, v: 0 };
  return { u: (4 * x) / d, v: (6 * y) / d };
}

function closestPlanckian(uv: { u: number; v: number }): { T: number; du: number; dv: number; dist: number } {
  let bestT = 6500;
  let bestD2 = Infinity;
  // coarse sweep then two refinement passes: cheap, and avoids Ohno's lookup table
  for (let T = PLANCKIAN_MIN_K; T <= PLANCKIAN_MAX_K; T += 25) {
    const p = xyToUv(planckianXy(T));
    const d2 = (uv.u - p.u) ** 2 + (uv.v - p.v) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestT = T;
    }
  }
  for (const step of [2, 0.25]) {
    const lo = Math.max(PLANCKIAN_MIN_K, bestT - step * 20);
    const hi = Math.min(PLANCKIAN_MAX_K, bestT + step * 20);
    for (let T = lo; T <= hi; T += step) {
      const p = xyToUv(planckianXy(T));
      const d2 = (uv.u - p.u) ** 2 + (uv.v - p.v) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestT = T;
      }
    }
  }
  const p = xyToUv(planckianXy(bestT));
  return { T: bestT, du: uv.u - p.u, dv: uv.v - p.v, dist: Math.sqrt(bestD2) };
}

/** Correlated colour temperature: nearest point on the Planckian locus in CIE 1960 uv. */
export function estimateCCT(xy: { x: number; y: number }): number {
  return closestPlanckian(xyToUv(xy)).T;
}

/**
 * Duv: signed distance from the Planckian locus in CIE 1960 uv.
 * Positive = above the locus (greenish), negative = below (pink/purple).
 */
export function estimateDuv(xy: { x: number; y: number }): number {
  const c = closestPlanckian(xyToUv(xy));
  return c.dv >= 0 ? c.dist : -c.dist;
}

/** Both at once; avoids running the locus search twice in the quality gate. */
export function estimateCCTandDuv(xy: { x: number; y: number }): { cct: number; duv: number } {
  const c = closestPlanckian(xyToUv(xy));
  return { cct: c.T, duv: c.dv >= 0 ? c.dist : -c.dist };
}
