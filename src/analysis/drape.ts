// Digital draping. Plan section 7.2.
//
// The plan is explicit that a flat fill is not acceptable: convert the drape region to CIELAB,
// keep the original L* channel so folds and shading survive, and replace only a* and b*. The
// previous UI drew flat colour blocks, which reads as a paint bucket rather than fabric and makes
// the A/B judgement much weaker.
//
// Absolute on-screen colour is unreliable on cheap panels, but A/B on the same screen under the
// same illuminant is internally consistent, which is all a preference judgement needs.

import type { Lab, RGB } from "../color/convert";
import { sRGBToLab, labToSRGB, labToLCh, lchToLab } from "../color/convert";
import type { Axes, Trend } from "./axes";
import { UNCALIBRATED_TREND } from "./axes";
import type { ImageBuffer } from "../capture/sampler";
import { encode as encodeJpeg } from "jpeg-js";
import { Buffer } from "buffer";

/**
 * Recolour one pixel: keep its lightness, take the target's chroma and hue.
 * Shading and fold detail live almost entirely in L*, so this preserves texture.
 */
export function recolorPixel(source: Lab, targetLab: Lab): Lab {
  const t = labToLCh(targetLab);
  // Scale chroma with the pixel's own lightness so deep folds do not turn into flat saturated
  // patches, and specular highlights stay near-neutral as real fabric does.
  const shading = Math.max(0, Math.min(1, source.L / Math.max(1e-6, targetLab.L)));
  const chromaScale = 0.55 + 0.45 * Math.min(1, shading);
  return lchToLab({ L: source.L, C: t.C * chromaScale, h: t.h });
}

/**
 * Recolour an RGBA buffer in place inside a mask. Runs on the JS thread over a downscaled crop;
 * a full-resolution version belongs in a native frame processor later.
 *
 * @param rgba    Uint8ClampedArray-like, 4 bytes per pixel.
 * @param mask    1 where the drape is, 0 elsewhere. Same pixel count as rgba/4.
 * @param target  Desired drape colour.
 */
export function recolorMasked(
  rgba: Uint8Array | Uint8ClampedArray | number[],
  mask: Uint8Array | number[],
  target: RGB
): void {
  const targetLab = sRGBToLab(target);
  const n = mask.length;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    const src = sRGBToLab({ r: rgba[o], g: rgba[o + 1], b: rgba[o + 2] });
    const out = labToSRGB(recolorPixel(src, targetLab));
    rgba[o] = out.r;
    rgba[o + 1] = out.g;
    rgba[o + 2] = out.b;
  }
}

/**
 * Composites a drape color onto an actual user photo buffer.
 * Per plan section 7.2:
 * Converts the drape region to CIELAB, keeps original L* (so natural fabric folds and shadows survive),
 * and replaces only a* and b*. Never touches face pixels.
 */
export function compositePhotoDrape(
  img: ImageBuffer,
  mask: Uint8Array | number[],
  target: RGB
): ImageBuffer {
  const cloned = new Uint8Array(img.data);
  recolorMasked(cloned, mask, target);
  return { width: img.width, height: img.height, data: cloned };
}

/**
 * Encodes an ImageBuffer to a base64 JPEG data URI for direct display in React Native <Image />.
 */
export function bufferToJpegDataUri(img: ImageBuffer, quality = 80): string {
  const uint8 = img.data instanceof Uint8Array ? img.data : new Uint8Array(img.data);
  const encoded = encodeJpeg(
    { data: uint8 as any, width: img.width, height: img.height },
    quality
  );
  const base64 = Buffer.from(encoded.data).toString("base64");
  return `data:image/jpeg;base64,${base64}`;
}

/**
 * Synthetic fabric strip for the UI: a vertical shading ramp plus a couple of soft folds,
 * recoloured through the same keep-L* path. Lets the A/B comparison read as cloth before the
 * MediaPipe segmentation mask exists, without pretending to be a photo of the user.
 */
export function drapeStrip(target: RGB, steps = 24): RGB[] {
  const targetLab = sRGBToLab(target);
  const out: RGB[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    // Base ramp 62 -> 38 in L*, with two shallow folds.
    const base = 62 - 24 * t;
    const folds = 5 * Math.sin(t * Math.PI * 3) + 2.5 * Math.sin(t * Math.PI * 7);
    const L = Math.max(8, Math.min(96, base + folds));
    out.push(labToSRGB(recolorPixel({ L, a: 0, b: 0 }, targetLab)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quiz: pick the pair that separates the weakest axis
// ---------------------------------------------------------------------------

export type DrapeOption = { rgb: RGB; name: string; /** which side of the axis this favours */ sign: 1 | -1 };
export type DrapePair = { axis: "W" | "D" | "C"; prompt: string; a: DrapeOption; b: DrapeOption };

/**
 * Five pairs, ordered so the least certain axis is asked first. Each pair holds two axes roughly
 * constant and varies the third, which is what makes the answer informative rather than a general
 * preference vote.
 *
 * Every answer is also a supervised label on exactly the borderline faces the measurement is
 * least sure about, which is the plan's substitute for a paid expert panel.
 */
export function drapeQuiz(axes: Axes, trend: Trend = UNCALIBRATED_TREND, weakest: "W" | "D" | "C" = "W"): DrapePair[] {
  const warmVsCool: DrapePair = {
    axis: "W",
    prompt: "Which one makes your skin look clearer, not redder?",
    a: { rgb: { r: 214, g: 138, b: 74 }, name: "Warm Amber", sign: 1 },
    b: { rgb: { r: 176, g: 120, b: 168 }, name: "Cool Orchid", sign: -1 },
  };
  const warmVsCool2: DrapePair = {
    axis: "W",
    prompt: "Gold or silver next to your jaw?",
    a: { rgb: { r: 198, g: 160, b: 74 }, name: "Gold", sign: 1 },
    b: { rgb: { r: 176, g: 180, b: 188 }, name: "Silver", sign: -1 },
  };
  const lightVsDeep: DrapePair = {
    axis: "D",
    prompt: "Which weight of colour holds your face up?",
    a: { rgb: { r: 62, g: 46, b: 82 }, name: "Deep Aubergine", sign: 1 },
    b: { rgb: { r: 206, g: 186, b: 216 }, name: "Light Lilac", sign: -1 },
  };
  const brightVsMuted: DrapePair = {
    axis: "C",
    prompt: "Clear and saturated, or soft and dusty?",
    a: { rgb: { r: 208, g: 40, b: 108 }, name: "Bright Fuchsia", sign: 1 },
    b: { rgb: { r: 178, g: 132, b: 148 }, name: "Dusty Rose", sign: -1 },
  };
  const brightVsMuted2: DrapePair = {
    axis: "C",
    prompt: "One more: which green sits better?",
    a: { rgb: { r: 30, g: 150, b: 110 }, name: "Emerald", sign: 1 },
    b: { rgb: { r: 116, g: 132, b: 104 }, name: "Sage", sign: -1 },
  };

  const all = [warmVsCool, warmVsCool2, lightVsDeep, brightVsMuted, brightVsMuted2];
  return [...all].sort((p, q) => (p.axis === weakest ? -1 : 0) - (q.axis === weakest ? -1 : 0));
}

/**
 * Fold quiz answers back into the axes. Each answer nudges its axis by a fixed step; five answers
 * can move an axis by at most +/-0.6, enough to resolve a borderline cell without overriding the
 * measurement.
 */
export function applyQuizAnswers(axes: Axes, answers: { axis: "W" | "D" | "C"; sign: 1 | -1 }[]): Axes {
  const step = 0.2;
  const next = { ...axes };
  for (const a of answers) {
    if (a.axis === "W") next.W += a.sign * step;
    else if (a.axis === "D") next.D += a.sign * step;
    else next.C += a.sign * step;
  }
  const clamp = (v: number) => Math.max(-6, Math.min(6, v));
  next.W = clamp(next.W);
  next.D = clamp(next.D);
  next.C = clamp(next.C);
  next.zH = next.W;
  return next;
}
