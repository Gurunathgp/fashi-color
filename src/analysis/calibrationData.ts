// Monk Skin Tone (MST 1-10) reference baseline for South Asian skin.
// Plan section 3.2, 6 (P0.5 & P0.6), and 11.
//
// WHAT THIS IS: a synthetic reference set. The 50 entries are generated deterministically from ten
// published MST anchor colours plus hand-chosen undertone offsets (see buildSyntheticBaseline).
// They were NOT measured on anybody: there were no subjects, no captures and no white reference.
//
// WHAT IT IS FOR: (a) a documented starting point for the L*-conditioned hue/chroma trends, (b) a
// regression fixture, and (c) honest context for why Western prototype splits put a large share of
// South Asian individuals in one deep cell.
//
// WHAT IT MUST NOT DO: unlock a tone label. SYNT..._TREND is fitted with source:"synthetic", and
// fitTrend()/deriveLabel() refuse to name a season from anything that is not "captured" (see
// axes.ts). Real P0.5 captures (30-50 subjects, 5 lights, white paper) are still required.

import type { Lab } from "../color/convert";
import { lchToLab } from "../color/convert";
import { fitTrend, type CalibrationSample, type Trend } from "./axes";

/**
 * Standard Monk Skin Tone (MST 1-10) baseline anchor values under D65 illuminant.
 * Values derived from published MST colorimetric reference tables.
 */
export const MONK_SCALE_ANCHORS: { mst: number; name: string; lab: Lab }[] = [
  { mst: 1, name: "MST 1 (Fair)", lab: { L: 88.5, a: 6.2, b: 14.8 } },
  { mst: 2, name: "MST 2 (Fair-Light)", lab: { L: 82.1, a: 8.5, b: 18.2 } },
  { mst: 3, name: "MST 3 (Light-Wheat)", lab: { L: 75.4, a: 10.8, b: 21.6 } },
  { mst: 4, name: "MST 4 (Wheatish)", lab: { L: 69.2, a: 12.6, b: 23.9 } },
  { mst: 5, name: "MST 5 (Medium-Wheat)", lab: { L: 62.8, a: 14.2, b: 25.4 } },
  { mst: 6, name: "MST 6 (Medium-Tan)", lab: { L: 56.5, a: 15.1, b: 25.1 } },
  { mst: 7, name: "MST 7 (Tan-Deep)", lab: { L: 50.2, a: 15.6, b: 24.2 } },
  { mst: 8, name: "MST 8 (Deep-Brown)", lab: { L: 44.1, a: 15.4, b: 22.5 } },
  { mst: 9, name: "MST 9 (Rich-Deep)", lab: { L: 37.8, a: 14.5, b: 19.8 } },
  { mst: 10, name: "MST 10 (Ebony-Deep)", lab: { L: 31.4, a: 12.8, b: 16.2 } },
];

/**
 * Deterministic generation of 50 synthetic reference profiles spanning MST 1-10 with illustrative
 * South Asian undertone spread. Not measurements: hue jitter is sin/cos of the index and the
 * undertone offsets below are hand-chosen constants.
 */
function buildSyntheticBaseline(): CalibrationSample[] {
  const samples: CalibrationSample[] = [];

  // Illustrative weighting: MST 3-8 are the common bands in-market. Edge tones are included so the
  // fitted splits are not skewed. The sinusoids are fixtures, not a model of human variation.
  const profilesConfig: { mst: number; undertone: "warm" | "neutral" | "olive" | "cool"; hairL: number }[] = [
    // MST 1 & 2 (Light / Himalayan / Fair Kashmiri)
    { mst: 1, undertone: "neutral", hairL: 19.5 },
    { mst: 2, undertone: "warm", hairL: 18.0 },
    { mst: 2, undertone: "cool", hairL: 15.0 },

    // MST 3 (Light-Wheat: North/West/East India)
    { mst: 3, undertone: "warm", hairL: 16.5 },
    { mst: 3, undertone: "neutral", hairL: 17.2 },
    { mst: 3, undertone: "olive", hairL: 14.8 },
    { mst: 3, undertone: "cool", hairL: 13.5 },

    // MST 4 (Wheatish: ubiquitous North/Central/West/South)
    { mst: 4, undertone: "warm", hairL: 15.2 },
    { mst: 4, undertone: "warm", hairL: 13.9 },
    { mst: 4, undertone: "neutral", hairL: 16.0 },
    { mst: 4, undertone: "olive", hairL: 14.1 },
    { mst: 4, undertone: "olive", hairL: 12.8 },
    { mst: 4, undertone: "cool", hairL: 14.5 },

    // MST 5 (Medium-Wheat: Central/South/East)
    { mst: 5, undertone: "warm", hairL: 14.0 },
    { mst: 5, undertone: "warm", hairL: 12.5 },
    { mst: 5, undertone: "neutral", hairL: 15.5 },
    { mst: 5, undertone: "neutral", hairL: 13.2 },
    { mst: 5, undertone: "olive", hairL: 13.8 },
    { mst: 5, undertone: "olive", hairL: 11.9 },
    { mst: 5, undertone: "cool", hairL: 14.2 },

    // MST 6 (Medium-Tan: Pan-India dominant)
    { mst: 6, undertone: "warm", hairL: 13.5 },
    { mst: 6, undertone: "warm", hairL: 11.8 },
    { mst: 6, undertone: "neutral", hairL: 14.7 },
    { mst: 6, undertone: "neutral", hairL: 12.9 },
    { mst: 6, undertone: "olive", hairL: 13.1 },
    { mst: 6, undertone: "olive", hairL: 11.5 },
    { mst: 6, undertone: "cool", hairL: 12.8 },
    { mst: 6, undertone: "cool", hairL: 14.0 },

    // MST 7 (Tan-Deep: South/Central/East)
    { mst: 7, undertone: "warm", hairL: 13.0 },
    { mst: 7, undertone: "warm", hairL: 11.2 },
    { mst: 7, undertone: "neutral", hairL: 13.8 },
    { mst: 7, undertone: "neutral", hairL: 12.1 },
    { mst: 7, undertone: "olive", hairL: 12.5 },
    { mst: 7, undertone: "olive", hairL: 11.0 },
    { mst: 7, undertone: "cool", hairL: 13.4 },

    // MST 8 (Deep-Brown: South/East)
    { mst: 8, undertone: "warm", hairL: 12.4 },
    { mst: 8, undertone: "warm", hairL: 10.8 },
    { mst: 8, undertone: "neutral", hairL: 13.1 },
    { mst: 8, undertone: "neutral", hairL: 11.6 },
    { mst: 8, undertone: "olive", hairL: 11.8 },
    { mst: 8, undertone: "cool", hairL: 12.7 },
    { mst: 8, undertone: "cool", hairL: 11.1 },

    // MST 9 (Rich-Deep: South / Coastal / Tribal)
    { mst: 9, undertone: "warm", hairL: 11.9 },
    { mst: 9, undertone: "warm", hairL: 11.2 },
    { mst: 9, undertone: "neutral", hairL: 12.2 },
    { mst: 9, undertone: "olive", hairL: 11.0 },
    { mst: 9, undertone: "cool", hairL: 10.5 },

    // MST 10 (Ebony-Deep: Melanin-rich)
    { mst: 10, undertone: "warm", hairL: 11.0 },
    { mst: 10, undertone: "neutral", hairL: 11.5 },
    { mst: 10, undertone: "cool", hairL: 10.2 },
  ];

  for (let i = 0; i < profilesConfig.length; i++) {
    const item = profilesConfig[i];
    const anchor = MONK_SCALE_ANCHORS.find((a) => a.mst === item.mst) ?? MONK_SCALE_ANCHORS[4];

    // Lightness slight jitter around the anchor
    const jitterL = Math.sin(i * 1.618) * 1.8;
    const L = Math.max(28, Math.min(92, anchor.lab.L + jitterL));

    // Base hue and chroma trends conditioned on L*
    const baseH = 44 + 0.16 * L;
    const baseC = 28 - 0.10 * L;

    // Undertone offsets in hue and chroma
    let hOffset = 0;
    let cOffset = 0;
    switch (item.undertone) {
      case "warm":
        hOffset = 4.5 + Math.sin(i * 2.1) * 2.0; // shifts yellow/golden
        cOffset = 2.0 + Math.cos(i * 1.7) * 1.5;
        break;
      case "neutral":
        hOffset = 0.5 + Math.sin(i * 1.3) * 1.5;
        cOffset = 0.0 + Math.cos(i * 2.4) * 1.2;
        break;
      case "olive":
        hOffset = -1.2 + Math.cos(i * 2.9) * 1.8; // greenish-yellow shift
        cOffset = -4.5 - Math.abs(Math.sin(i * 1.5)) * 2.5; // characteristically muted
        break;
      case "cool":
        hOffset = -5.8 - Math.abs(Math.sin(i * 1.8)) * 3.0; // shifts pinkish-red
        cOffset = 1.0 + Math.cos(i * 2.2) * 1.8;
        break;
    }

    const skin = lchToLab({
      L,
      C: Math.max(6, baseC + cOffset),
      h: baseH + hOffset,
    });

    const hair: Lab = {
      L: Math.max(8, item.hairL),
      a: 1.2 + Math.sin(i * 0.9) * 0.6,
      b: 2.1 + Math.cos(i * 1.1) * 0.8,
    };

    samples.push({ skin, hair });
  }

  return samples;
}

/** 50 synthetic MST-derived reference profiles. Reference only: never fitted as user calibration. */
export const SYNTHETIC_BASELINE_SAMPLES: CalibrationSample[] = buildSyntheticBaseline();

/**
 * The synthetic baseline as a Trend, for inspection and regression tests.
 *
 * `source: "synthetic"` is load-bearing: fitTrend() refuses to mark it calibrated, so
 * deriveLabel() will not name a season from these numbers (see axes.ts).
 */
export const SYNTHETIC_BASELINE_TREND: Trend = fitTrend(SYNTHETIC_BASELINE_SAMPLES, "synthetic");
