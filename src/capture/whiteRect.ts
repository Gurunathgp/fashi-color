// Manual white-paper reference geometry (plan §4/§5 and P1.5 — the open-work item "manual
// white-paper rect UI not wired").
//
// `analyseBuffer` has always accepted `opts.whiteReferenceRect`; what was missing was the UI that
// produces one. These helpers keep the tap-to-rect maths pure and unit-testable: the user taps on a
// preview whose aspect ratio matches the decoded buffer, so screen pixels map linearly onto the
// normalised rect that `sampleRegion` expects.

export type NormalisedRect = { x: number; y: number; w: number; h: number };

/** Patch size as a fraction of the frame's shorter side. */
export const WHITE_PATCH_FRACTION = 0.16;

/** `detectWhiteReference` refuses fewer than 64 grid samples; mirror that floor for manual marks. */
export const MIN_PATCH_PIXELS = 64;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Patch centred on a normalised tap point.
 *
 * The patch is square in *pixels* (it keeps the same physical shape on a portrait photo) and is
 * clamped so it can never fall outside the frame — a rect hanging off the edge would sample
 * nothing and the re-measure would silently fall back to the auto path.
 */
export function rectFromPoint(
  nx: number,
  ny: number,
  width: number,
  height: number,
  fraction = WHITE_PATCH_FRACTION
): NormalisedRect {
  const shorter = Math.min(width, height);
  const side = Math.max(8, Math.round(shorter * fraction));
  const w = Math.min(1, side / width);
  const h = Math.min(1, side / height);
  const x = Math.min(Math.max(clamp01(nx) - w / 2, 0), 1 - w);
  const y = Math.min(Math.max(clamp01(ny) - h / 2, 0), 1 - h);
  return { x, y, w, h };
}

/** Integer pixel box the sampler will actually read, plus the sample count. */
export function rectPixels(
  rect: NormalisedRect,
  width: number,
  height: number
): { x: number; y: number; w: number; h: number; n: number } {
  const x = Math.round(rect.x * width);
  const y = Math.round(rect.y * height);
  const w = Math.max(1, Math.round(rect.w * width));
  const h = Math.max(1, Math.round(rect.h * height));
  return { x, y, w, h, n: w * h };
}

export type RectCheck = { ok: boolean; reason: string };

/**
 * Honest feedback for the UI. "Refuse rather than guess" applies here too: a patch too small to
 * measure says so instead of feeding a handful of pixels into the illuminant estimator.
 */
export function checkRect(rect: NormalisedRect, width: number, height: number): RectCheck {
  const { w, h, n } = rectPixels(rect, width, height);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, reason: "The patch is outside the photo — tap the paper again." };
  }
  if (n < MIN_PATCH_PIXELS) {
    return {
      ok: false,
      reason: `Only ${n} pixel${n === 1 ? "" : "s"} inside the patch; ${MIN_PATCH_PIXELS} are needed. Move the patch onto a wider sheet.`,
    };
  }
  return { ok: true, reason: `${n} pixels (${w}×${h}) will be read as the white reference.` };
}
