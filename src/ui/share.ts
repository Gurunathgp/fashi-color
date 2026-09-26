// Share parity across platforms, plus the share-text builders themselves.
//
// On native, `Share.share` opens the OS sheet. On the web export there is no such thing: the
// browser only has `navigator.share` (mobile browsers, and only behind a user gesture) or the
// clipboard, while `react-native-web`'s Share rejects with "Share is not supported in this browser".
// That rejection used to be swallowed by a bare `catch`, so on desktop web the Share button looked
// broken. Now every path reports what actually happened and the clipboard is used when available.

import { Platform, Share } from "react-native";
import type { AnalysisResult } from "../capture/analyze";

export type ShareMethod = "native" | "web-share" | "clipboard" | "unavailable";
export type ShareOutcome = { ok: boolean; method: ShareMethod; message: string };

export const SHARE_TITLES = {
  card: "Fashi personal colour card",
  result: "Fashi colour result",
} as const;

/** Copy for the UI: never claim a share that did not happen. */
export function describeShareOutcome(outcome: ShareOutcome): string {
  switch (outcome.method) {
    case "native":
    case "web-share":
      return "Shared.";
    case "clipboard":
      return "Copied to the clipboard — paste it anywhere.";
    default:
      return outcome.message;
  }
}

function metalWord(metal: AnalysisResult["metal"]): string {
  return metal === "gold" ? "Gold" : metal === "silver" ? "Silver" : "Gold & Silver";
}

/**
 * Text-only result summary (the "Share text" button on the result screen).
 * Kept pure so the wording is unit-tested rather than eyeballed on a device.
 */
export function buildResultShareText(result: AnalysisResult): string {
  const { label, swatches, metal, olive, axes } = result;
  const triple = label.calibrated ? label.triple : "Measured (no tone yet)";
  const tone = label.calibrated ? `${label.tone.korean} · ${label.tone.english}` : "uncalibrated";
  const top = swatches
    .slice(0, 6)
    .map((s) => `${s.name} ${s.hex}`)
    .join(", ");
  return (
    `Fashi colour result (on-device, no photo uploaded)\n` +
    `${triple} — ${tone}\n` +
    `Metal: ${metal}${olive ? " · Olive/neutral" : ""}\n` +
    `Top colours: ${top}\n` +
    `W ${axes.W.toFixed(2)} D ${axes.D.toFixed(2)} C ${axes.C.toFixed(2)}`
  );
}

/**
 * Text version of the visual certificate (the "Share card" button).
 * The visual card itself is still view-only — exporting it as an image needs a native screenshot
 * module, which is tracked separately.
 */
export function buildShareCardText(result: AnalysisResult): string {
  const { axes, label, swatches, metal, olive, skinD65, contrast } = result;
  const triple = label.calibrated ? label.triple : "Measured";
  const toneKorean = label.calibrated ? label.tone.korean : "분석 완료";
  const toneEnglish = label.calibrated ? label.tone.english : "Tone Measured";
  const topColours = swatches
    .slice(0, 6)
    .map((s) => `${s.name} (${s.hex})`)
    .join("\n• ");

  return (
    `✦ FASHI Personal Colour Card ✦\n` +
    `Colouring: ${triple}\n` +
    `Tone: ${toneKorean} (${toneEnglish})\n` +
    `Jewellery: ${metalWord(metal)}${olive ? " · Olive/Neutral" : ""}\n\n` +
    `Best Palette:\n• ${topColours}\n\n` +
    `Skin Lab: ${skinD65.L.toFixed(1)}, ${skinD65.a.toFixed(1)}, ${skinD65.b.toFixed(1)}\n` +
    `Contrast: ${contrast.toFixed(1)} ΔL*\n\n` +
    `Analyzed 100% on-device. No photo was stored or uploaded.`
  );
}

type WebNavigator = {
  share?: (data: { title?: string; text?: string }) => Promise<void>;
  clipboard?: { writeText?: (text: string) => Promise<void> };
};

function webNavigator(): WebNavigator | null {
  const g = globalThis as unknown as { navigator?: WebNavigator };
  return g.navigator ?? null;
}

/** Share text, or copy it, or say plainly that neither is possible here. */
export async function shareText(title: string, message: string): Promise<ShareOutcome> {
  if (Platform.OS === "web") {
    const nav = webNavigator();
    if (typeof nav?.share === "function") {
      try {
        await nav.share({ title, text: message });
        return { ok: true, method: "web-share", message: "" };
      } catch (e) {
        // An AbortError means the user closed the OS sheet: do not silently copy instead.
        if (e instanceof Error && e.name === "AbortError") {
          return { ok: false, method: "web-share", message: "Share was dismissed." };
        }
      }
    }
    if (typeof nav?.clipboard?.writeText === "function") {
      try {
        await nav.clipboard.writeText(message);
        return { ok: true, method: "clipboard", message: "" };
      } catch {
        // fall through to the honest failure below
      }
    }
    return {
      ok: false,
      method: "unavailable",
      message: "This browser cannot share or copy text — select the measurements above instead.",
    };
  }

  try {
    const outcome = await Share.share({ message, title });
    // A dismissed sheet is not a share: say so rather than reporting success.
    if (outcome.action === Share.dismissedAction) {
      return { ok: false, method: "native", message: "Share was dismissed." };
    }
    return { ok: true, method: "native", message: "" };
  } catch (e) {
    return {
      ok: false,
      method: "unavailable",
      message: e instanceof Error ? e.message : "Sharing failed on this device.",
    };
  }
}
