import { detectWhiteReference, type ImageBuffer } from "../src/capture/sampler";
import { analyseBuffer } from "../src/capture/analyze";
import { UNCALIBRATED_TREND } from "../src/analysis/axes";
import type { RGB } from "../src/color/convert";

// ---------------------------------------------------------------------------
// Synthetic frames for the white-paper reference path (plan P1.5).
//
// The auto-detector is the honest fallback for when no rect was marked manually:
// it must find a neutral patch outside the face, and it must stay silent when the
// only bright pixels are sclera/specular (inside the face) or clipped/tinted
// surfaces that carry no usable chromaticity.
// ---------------------------------------------------------------------------

function makeImage(
  width: number,
  height: number,
  fill: RGB,
  patches: { x: number; y: number; w: number; h: number; rgb: RGB }[] = []
): ImageBuffer {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill.r;
    data[i * 4 + 1] = fill.g;
    data[i * 4 + 2] = fill.b;
    data[i * 4 + 3] = 255;
  }
  for (const p of patches) {
    for (let y = p.y; y < p.y + p.h; y++) {
      for (let x = p.x; x < p.x + p.w; x++) {
        const o = (y * width + x) * 4;
        data[o] = p.rgb.r;
        data[o + 1] = p.rgb.g;
        data[o + 2] = p.rgb.b;
        data[o + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

const SKIN: RGB = { r: 200, g: 160, b: 130 };
const PAPER: RGB = { r: 244, g: 244, b: 242 };
const BG: RGB = { r: 45, g: 45, b: 50 };
const FACE = { x: 0.2, y: 0.15, w: 0.45, h: 0.6 };

describe("detectWhiteReference", () => {
  test("finds a neutral patch outside the face box", () => {
    const img = makeImage(120, 120, SKIN, [{ x: 85, y: 8, w: 30, h: 30, rgb: PAPER }]);
    const det = detectWhiteReference(img, FACE);
    if (!det) throw new Error("expected a detection");
    expect(det.n).toBeGreaterThanOrEqual(64);
    expect(det.rgb.r).toBeCloseTo(244, 1);
    expect(det.rgb.b).toBeCloseTo(242, 1);
    expect(det.rect.x).toBeGreaterThan(FACE.x + FACE.w);
  });

  test("returns null when the frame contains no neutral surface", () => {
    const img = makeImage(120, 120, SKIN);
    expect(detectWhiteReference(img, FACE)).toBeNull();
  });

  test("ignores bright neutral pixels inside the face box (sclera, specular)", () => {
    const img = makeImage(120, 120, SKIN, [
      { x: 40, y: 40, w: 25, h: 25, rgb: { r: 250, g: 250, b: 248 } },
    ]);
    expect(detectWhiteReference(img, FACE)).toBeNull();
  });

  test("rejects blown-out pure white as clipped", () => {
    const img = makeImage(120, 120, SKIN, [
      { x: 85, y: 8, w: 30, h: 30, rgb: { r: 255, g: 255, b: 255 } },
    ]);
    expect(detectWhiteReference(img, FACE)).toBeNull();
  });

  test("rejects a bright saturated colour", () => {
    const img = makeImage(120, 120, SKIN, [
      { x: 85, y: 8, w: 30, h: 30, rgb: { r: 170, g: 195, b: 245 } },
    ]);
    expect(detectWhiteReference(img, FACE)).toBeNull();
  });
});

describe("analyseBuffer white-reference integration", () => {
  test("anchors the illuminant on an auto-detected white surface", () => {
    const img = makeImage(160, 160, BG, [
      { x: 20, y: 20, w: 70, h: 120, rgb: SKIN },
      { x: 105, y: 30, w: 45, h: 40, rgb: PAPER },
    ]);
    const r = analyseBuffer(img, { trend: UNCALIBRATED_TREND });
    expect(r.illuminant.method).toBe("white-reference-auto");
    expect(r.illuminant.reliability).toBeGreaterThanOrEqual(0.7);
  });

  test("falls back to priors when no white surface is present", () => {
    const img = makeImage(160, 160, BG, [{ x: 20, y: 20, w: 70, h: 120, rgb: SKIN }]);
    const r = analyseBuffer(img, { trend: UNCALIBRATED_TREND });
    expect(r.illuminant.method).not.toBe("white-reference-auto");
    expect(Number.isFinite(r.illuminant.cct)).toBe(true);
  });
});
