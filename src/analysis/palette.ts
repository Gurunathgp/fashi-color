// Palette as a region in OKLCh, not a list of swatches. Plan section 7.1.
//
// Why a region: a fixed swatch list cannot answer "does this specific teal work for her?", which
// is exactly what the drape, the shopping feature and the later outfit scorer all need to ask
// about arbitrary colours. Membership is a continuous 0..1 score, and displayed swatches are
// sampled from the region rather than being the region.
//
// Why OKLCh rather than CIELAB: hue arcs only mean something in a space with uniform hue
// spacing. Measured spread of the six sRGB primary gaps is ~28 degrees in CIELAB against ~15 in
// OKLCh (see the OKLab hue-uniformity test). Skin measurement stays in CIELAB because the skin
// science literature is expressed there.

import type { OKLCh, RGB, Lab } from "../color/convert";
import {
  sRGBToOKLab,
  okLabToOKLCh,
  okLChToOKLab,
  okLabToLinear,
  linearToSRGB,
  sRGBToLab,
  labToSRGB,
  deltaE00,
} from "../color/convert";
import type { Axes, Trend } from "./axes";
import { chromaTolerance, isOlive, UNCALIBRATED_TREND } from "./axes";

export type HueArc = { center: number; halfwidth: number };

export type PaletteRegion = {
  hueArcs: HueArc[];
  /** OKLCh chroma bounds. sRGB tops out near 0.33. */
  Cmin: number;
  Cmax: number;
  /** OKLCh lightness bounds, 0..1. */
  Lmin: number;
  Lmax: number;
  /** User's own skin lightness in OKLab L, for the face-adjacency rule. */
  skinL: number;
  /** Minimum lightness separation for garments worn next to the face. */
  deltaL: number;
};

// ---------------------------------------------------------------------------
// Gamut handling
// ---------------------------------------------------------------------------

function inGamut(rgb: { r: number; g: number; b: number }): boolean {
  return (
    rgb.r >= -0.001 && rgb.r <= 1.001 && rgb.g >= -0.001 && rgb.g <= 1.001 && rgb.b >= -0.001 && rgb.b <= 1.001
  );
}

/**
 * Reduce chroma until the colour fits sRGB, preserving lightness and hue. Binary search rather
 * than per-channel clipping, which would shift hue - the previous swatch code clipped and so
 * silently produced colours outside the stated region.
 */
export function gamutMapOKLCh(c: OKLCh): { rgb: RGB; clipped: boolean; chroma: number } {
  const attempt = (chroma: number) => okLabToLinear(okLChToOKLab({ L: c.L, C: chroma, h: c.h }));
  if (inGamut(attempt(c.C))) {
    return { rgb: linearToSRGB(attempt(c.C)), clipped: false, chroma: c.C };
  }
  let lo = 0;
  let hi = c.C;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(attempt(mid))) lo = mid;
    else hi = mid;
  }
  return { rgb: linearToSRGB(attempt(lo)), clipped: true, chroma: lo };
}

// ---------------------------------------------------------------------------
// Region construction
// ---------------------------------------------------------------------------

/** Hue anchors in OKLCh degrees, measured from sRGB primaries rather than guessed. */
const HUE = {
  red: 29,
  orange: 55,
  gold: 85,
  olive: 120,
  green: 143,
  teal: 180,
  blue: 264,
  violet: 300,
  magenta: 328,
} as const;

/**
 * Build the wearable region from the measured axes.
 *
 * Warm skin is served by the red-through-gold arc plus a teal counterpoint; cool skin by the
 * blue-violet-magenta arc plus cool green. Olive gets its own arc rather than being forced into
 * one of the two. Chroma ceiling scales with skin depth because deeper skin genuinely carries
 * higher saturation, which is also why South Asian traditional palettes are so saturated.
 */
export function paletteFor(axes: Axes, skin: Lab, trend: Trend = UNCALIBRATED_TREND): PaletteRegion {
  const okSkin = okLabToOKLCh(sRGBToOKLab(labToSRGB(skin)));
  const warm = axes.W >= trend.splitW;
  const olive = isOlive(axes, trend);

  const hueArcs: HueArc[] = olive
    ? [
        { center: HUE.olive, halfwidth: 32 },
        { center: HUE.teal, halfwidth: 30 },
        { center: HUE.red, halfwidth: 24 },
      ]
    : warm
      ? [
          { center: HUE.orange, halfwidth: 40 },
          { center: HUE.gold, halfwidth: 28 },
          { center: HUE.teal, halfwidth: 26 },
        ]
      : [
          { center: HUE.blue, halfwidth: 40 },
          { center: HUE.magenta, halfwidth: 32 },
          { center: HUE.green, halfwidth: 24 },
        ];

  const tol = chromaTolerance(skin.L);
  // Muted readings want a lower ceiling; bright readings tolerate the full range.
  const clarityScale = axes.C >= trend.splitC ? 1 : 0.72;
  const Cmax = Math.min(0.32, (0.1 + tol * 0.22) * clarityScale);

  return {
    hueArcs,
    Cmin: 0.02,
    Cmax,
    Lmin: 0.2,
    Lmax: 0.95,
    skinL: okSkin.L,
    // Roughly 12 CIELAB L* units expressed in OKLab L, which is ~0.1 over the mid range.
    deltaL: 0.1,
  };
}

/** Small helper: CIELAB -> approximate sRGB, only used to obtain the skin's OKLab lightness. */

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

function angularDistance(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

function softBand(value: number, lo: number, hi: number, softness: number): number {
  if (value < lo) return Math.exp(-((lo - value) ** 2) / (2 * softness * softness));
  if (value > hi) return Math.exp(-((value - hi) ** 2) / (2 * softness * softness));
  return 1;
}

export type MembershipOpts = {
  /** Tops, outerwear and scarves sit next to the face and must clear the lightness gap. */
  faceAdjacent?: boolean;
};

/**
 * Fuzzy AND across hue, chroma and lightness, returning 0..1.
 *
 * The face-adjacency term is the mathematical form of "colours that need distance from your
 * face": garment lightness too close to skin lightness is what actually reads as washed out.
 * Bounds are anchored to the user's measured values, not to a tone prototype, so two users in
 * the same cell do not receive identical output.
 */
export function membership(color: OKLCh, region: PaletteRegion, opts: MembershipOpts = {}): number {
  let hue = 0;
  if (region.hueArcs.length === 0) hue = 1;
  else {
    for (const arc of region.hueArcs) {
      const d = angularDistance(color.h, arc.center);
      hue = Math.max(hue, d <= arc.halfwidth ? 1 : Math.exp(-((d - arc.halfwidth) ** 2) / (2 * 18 * 18)));
    }
  }
  // Very low chroma is neutral: neutrals are free anchors and should not be judged on hue.
  const neutral = color.C < 0.03;
  if (neutral) hue = 1;

  const chroma = softBand(color.C, region.Cmin, region.Cmax, 0.05);
  const light = softBand(color.L, region.Lmin, region.Lmax, 0.08);
  const gap = Math.abs(color.L - region.skinL);
  const face = !opts.faceAdjacent || gap >= region.deltaL ? 1 : Math.exp(-((region.deltaL - gap) ** 2) / (2 * 0.05 * 0.05));

  return hue * chroma * light * face;
}

/** Score any garment colour against the user's region, as a percentage. */
export function scoreColor(rgb: RGB, region: PaletteRegion, opts: MembershipOpts = {}): number {
  return Math.round(100 * membership(okLabToOKLCh(sRGBToOKLab(rgb)), region, opts));
}

// ---------------------------------------------------------------------------
// Named swatches (CVD-safe: never colour alone)
// ---------------------------------------------------------------------------

const NAMED: { name: string; rgb: RGB }[] = [
  { name: "Ivory", rgb: { r: 245, g: 240, b: 225 } },
  { name: "Cream", rgb: { r: 250, g: 235, b: 205 } },
  { name: "Camel", rgb: { r: 193, g: 154, b: 107 } },
  { name: "Terracotta", rgb: { r: 196, g: 96, b: 66 } },
  { name: "Rust", rgb: { r: 168, g: 75, b: 42 } },
  { name: "Brick Red", rgb: { r: 150, g: 45, b: 40 } },
  { name: "Tomato Red", rgb: { r: 214, g: 62, b: 48 } },
  { name: "Coral", rgb: { r: 240, g: 128, b: 108 } },
  { name: "Peach", rgb: { r: 250, g: 190, b: 160 } },
  { name: "Marigold", rgb: { r: 240, g: 168, b: 40 } },
  { name: "Mustard", rgb: { r: 200, g: 160, b: 45 } },
  { name: "Golden Yellow", rgb: { r: 240, g: 195, b: 70 } },
  { name: "Olive", rgb: { r: 120, g: 120, b: 60 } },
  { name: "Mehendi Green", rgb: { r: 100, g: 125, b: 65 } },
  { name: "Bottle Green", rgb: { r: 30, g: 90, b: 65 } },
  { name: "Emerald", rgb: { r: 40, g: 150, b: 110 } },
  { name: "Mint", rgb: { r: 165, g: 220, b: 200 } },
  { name: "Teal", rgb: { r: 35, g: 130, b: 140 } },
  { name: "Peacock Blue", rgb: { r: 25, g: 110, b: 160 } },
  { name: "Sky Blue", rgb: { r: 150, g: 200, b: 235 } },
  { name: "Royal Blue", rgb: { r: 45, g: 75, b: 175 } },
  { name: "Navy", rgb: { r: 30, g: 45, b: 85 } },
  { name: "Indigo", rgb: { r: 70, g: 60, b: 140 } },
  { name: "Lavender", rgb: { r: 190, g: 175, b: 225 } },
  { name: "Aubergine", rgb: { r: 85, g: 45, b: 80 } },
  { name: "Plum", rgb: { r: 130, g: 60, b: 110 } },
  { name: "Magenta", rgb: { r: 195, g: 55, b: 135 } },
  { name: "Fuchsia", rgb: { r: 225, g: 70, b: 150 } },
  { name: "Rose Pink", rgb: { r: 230, g: 150, b: 175 } },
  { name: "Blush", rgb: { r: 240, g: 200, b: 200 } },
  { name: "Maroon", rgb: { r: 110, g: 35, b: 55 } },
  { name: "Wine", rgb: { r: 125, g: 40, b: 70 } },
  { name: "Charcoal", rgb: { r: 60, g: 60, b: 65 } },
  { name: "Slate Grey", rgb: { r: 115, g: 120, b: 130 } },
  { name: "Stone", rgb: { r: 185, g: 178, b: 165 } },
  { name: "Off White", rgb: { r: 240, g: 240, b: 238 } },
  { name: "Black", rgb: { r: 25, g: 25, b: 28 } },
];

const NAMED_LAB = NAMED.map((n) => ({ ...n, lab: sRGBToLab(n.rgb) }));

/** Nearest perceptual name, so a swatch is never identified by colour alone. */
export function nameColor(rgb: RGB): string {
  const lab = sRGBToLab(rgb);
  let best = NAMED_LAB[0];
  let bestD = Infinity;
  for (const c of NAMED_LAB) {
    const d = deltaE00(lab, c.lab);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best.name;
}

export type Swatch = {
  name: string;
  hex: string;
  rgb: RGB;
  /** Real membership score, 0..100, not a decorative rank. */
  score: number;
  oklch: OKLCh;
  role: "core" | "accent" | "neutral";
};

function hexOf(rgb: RGB): string {
  const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`.toUpperCase();
}

/**
 * Sample display swatches from the region: one core and one accent per hue arc, plus two
 * neutrals. Each is gamut-mapped, scored by its real membership, and named. Sorted by score
 * because CVD users rely on order and text, never hue.
 */
export function sampleSwatches(region: PaletteRegion, count = 8): Swatch[] {
  const out: Swatch[] = [];
  const midL = Math.min(region.Lmax, Math.max(region.Lmin, region.skinL + region.deltaL + 0.06));
  const deepL = Math.max(region.Lmin, region.skinL - region.deltaL - 0.06);

  for (const arc of region.hueArcs) {
    for (const [L, C, role] of [
      [midL, region.Cmax * 0.72, "core"],
      [deepL, region.Cmax * 0.95, "accent"],
    ] as const) {
      const target: OKLCh = { L, C, h: arc.center };
      const mapped = gamutMapOKLCh(target);
      const oklch: OKLCh = { L, C: mapped.chroma, h: arc.center };
      out.push({
        name: nameColor(mapped.rgb),
        hex: hexOf(mapped.rgb),
        rgb: mapped.rgb,
        score: Math.round(100 * membership(oklch, region, { faceAdjacent: true })),
        oklch,
        role,
      });
    }
  }

  // Neutral anchors: low chroma, clear of skin lightness in both directions.
  for (const L of [Math.min(0.95, region.skinL + 0.28), Math.max(0.18, region.skinL - 0.3)]) {
    const target: OKLCh = { L, C: 0.02, h: region.hueArcs[0]?.center ?? 0 };
    const mapped = gamutMapOKLCh(target);
    out.push({
      name: nameColor(mapped.rgb),
      hex: hexOf(mapped.rgb),
      rgb: mapped.rgb,
      score: Math.round(100 * membership({ L, C: mapped.chroma, h: target.h }, region, { faceAdjacent: true })),
      oklch: { L, C: mapped.chroma, h: target.h },
      role: "neutral",
    });
  }

  const seen = new Set<string>();
  return out
    .filter((s) => (seen.has(s.hex) ? false : (seen.add(s.hex), true)))
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}
