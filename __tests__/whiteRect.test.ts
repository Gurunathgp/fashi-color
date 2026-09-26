import {
  checkRect,
  clamp01,
  rectFromPoint,
  rectPixels,
  MIN_PATCH_PIXELS,
  WHITE_PATCH_FRACTION,
  type NormalisedRect,
} from "../src/capture/whiteRect";
import { analyseBuffer } from "../src/capture/analyze";
import { UNCALIBRATED_TREND } from "../src/analysis/axes";
import type { ImageBuffer } from "../src/capture/sampler";
import type { RGB } from "../src/color/convert";

// ---------------------------------------------------------------------------
// Manual white-paper reference (plan P1.5 and the open-work item "manual
// white-paper rect UI not wired"). `analyseBuffer` has always accepted a rect;
// these are the pure tap-to-rect helpers the UI now feeds it, plus proof that a
// marked patch really does outrank the auto-detected surface.
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

describe("rectFromPoint", () => {
  test("centres the patch on the tap", () => {
    const rect = rectFromPoint(0.5, 0.5, 640, 480);
    expect(rect.x + rect.w / 2).toBeCloseTo(0.5, 6);
    expect(rect.y + rect.h / 2).toBeCloseTo(0.5, 6);
  });

  test("clamps a corner tap inside the frame instead of hanging off the edge", () => {
    const topLeft = rectFromPoint(0, 0, 640, 480);
    expect(topLeft.x).toBe(0);
    expect(topLeft.y).toBe(0);
    const bottomRight = rectFromPoint(1, 1, 640, 480);
    expect(bottomRight.x + bottomRight.w).toBeCloseTo(1, 6);
    expect(bottomRight.y + bottomRight.h).toBeCloseTo(1, 6);
  });

  test("is square in pixels, not in fractions, on a portrait frame", () => {
    const px = rectPixels(rectFromPoint(0.5, 0.5, 480, 640), 480, 640);
    expect(px.w).toBe(px.h);
    expect(px.w).toBe(Math.round(Math.min(480, 640) * WHITE_PATCH_FRACTION));
  });

  test("tolerates non-finite taps by refusing to move off-frame", () => {
    const rect = rectFromPoint(Number.NaN, Number.NaN, 640, 480);
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(4)).toBe(1);
  });
});

describe("checkRect", () => {
  test("accepts a default patch with room to spare", () => {
    const check = checkRect(rectFromPoint(0.5, 0.5, 640, 480), 640, 480);
    expect(check.ok).toBe(true);
    expect(check.reason).toMatch(/white reference/);
  });

  test("refuses a mark too small to hold the sampler's minimum", () => {
    const tiny: NormalisedRect = { x: 0.5, y: 0.5, w: 0.001, h: 0.001 };
    const check = checkRect(tiny, 100, 100);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(new RegExp(`needed|${MIN_PATCH_PIXELS}`));
  });
});

describe("manual white reference in the pipeline", () => {
  test("a marked patch is used even where auto detection refuses to look", () => {
    // The paper sits inside the face box, where detectWhiteReference deliberately refuses to look —
    // exactly the case the manual mark exists for.
    const img = makeImage(200, 200, BG, [
      { x: 30, y: 30, w: 90, h: 150, rgb: SKIN },
      { x: 55, y: 90, w: 40, h: 30, rgb: PAPER },
    ]);
    const auto = analyseBuffer(img, { trend: UNCALIBRATED_TREND });
    const marked = analyseBuffer(img, {
      trend: UNCALIBRATED_TREND,
      whiteReferenceRect: { x: 55 / 200, y: 90 / 200, w: 40 / 200, h: 30 / 200 },
    });

    expect(marked.illuminant.method).toBe("white-reference");
    expect(marked.illuminant.reliability).toBeGreaterThanOrEqual(0.8);
    expect(auto.illuminant.method).not.toBe("white-reference");
    expect(auto.illuminant.method).not.toBe("white-reference-auto");
  });

  test("a marked patch outranks the auto-detected surface when both find it", () => {
    // Same frame, paper outside the face box: the auto detector finds it, yet the manual mark is the
    // one the combined estimate reports (0.8 beats 0.7 in combineEstimates).
    const img = makeImage(200, 200, BG, [
      { x: 25, y: 25, w: 87, h: 150, rgb: SKIN },
      { x: 131, y: 37, w: 56, h: 50, rgb: PAPER },
    ]);
    const auto = analyseBuffer(img, { trend: UNCALIBRATED_TREND });
    const marked = analyseBuffer(img, {
      trend: UNCALIBRATED_TREND,
      whiteReferenceRect: { x: 131 / 200, y: 37 / 200, w: 56 / 200, h: 50 / 200 },
    });

    expect(auto.illuminant.method).toBe("white-reference-auto");
    expect(marked.illuminant.method).toBe("white-reference");
    expect(marked.illuminant.reliability).toBeGreaterThanOrEqual(auto.illuminant.reliability);
  });
});
