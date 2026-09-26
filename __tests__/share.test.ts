const fs = require("fs");
const path = require("path");
// Jest runs test files in CommonJS, where __dirname exists at runtime. @types/node is deliberately
// not in tsconfig "types" (its timer globals conflict with React Native's), so declare it locally.
declare const __dirname: string;
import { Platform, Share } from "react-native";
import {
  buildResultShareText,
  buildShareCardText,
  describeShareOutcome,
  shareText,
} from "../src/ui/share";
import { analyseBuffer, decodeJpegToBuffer } from "../src/capture/analyze";
import { SYNTHETIC_BASELINE_TREND } from "../src/analysis/calibrationData";
import { fitTrend, type CalibrationSample, type Trend } from "../src/analysis/axes";

// ---------------------------------------------------------------------------
// Share parity. The bug being pinned down: react-native-web's Share rejects with
// "Share is not supported in this browser" when navigator.share is missing (every
// desktop browser), and that rejection used to be swallowed — so the Share button
// simply looked broken in the web export. Every path must now report the truth.
// ---------------------------------------------------------------------------

const originalOS = Platform.OS;
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function setPlatform(os: string): void {
  Object.defineProperty(Platform, "OS", { value: os, configurable: true, writable: true });
}

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
}

afterEach(() => {
  setPlatform(originalOS);
  if (navigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  } else {
    delete (globalThis as { navigator?: unknown }).navigator;
  }
  jest.restoreAllMocks();
});

describe("share text builders", () => {
  const imagePath = path.join(__dirname, "fixtures", "south-asian-portrait.jpg");

  // Stand-in for real P0.5 captures, so the calibrated wording can be asserted too.
  const captured: CalibrationSample[] = Array.from({ length: 20 }, (_, i) => {
    const L = 32 + (i * 55) / 19;
    return {
      skin: { L, a: 11 + (L / 100) * 5, b: 17 + (L / 100) * 9 },
      hair: { L: 14 + (i % 3), a: 1.2, b: 2.1 },
    };
  });

  function analyse(trend: Trend) {
    const bytes = new Uint8Array(fs.readFileSync(imagePath));
    return analyseBuffer(decodeJpegToBuffer(bytes, 480), { trend, naturalHair: true });
  }

  test("result text keeps the privacy claim and refuses a tone when uncalibrated", () => {
    const text = buildResultShareText(analyse(SYNTHETIC_BASELINE_TREND));
    expect(text).toContain("on-device, no photo uploaded");
    expect(text).toContain("Measured (no tone yet)");
    expect(text).toContain("Metal: ");
    expect(text).toMatch(/W -?\d+\.\d{2} D -?\d+\.\d{2} C -?\d+\.\d{2}/);
  });

  test("result text carries the derived triple once the trend is fitted on captures", () => {
    const result = analyse(fitTrend(captured, "captured"));
    expect(result.label.calibrated).toBe(true);
    const text = buildResultShareText(result);
    expect(text).not.toContain("no tone yet");
    expect(text).toContain(result.label.triple);
  });

  test("card text keeps the certificate wording, the palette and the metrics", () => {
    const result = analyse(fitTrend(captured, "captured"));
    const text = buildShareCardText(result);
    expect(text.startsWith("✦ FASHI Personal Colour Card ✦")).toBe(true);
    expect(text).toContain("Best Palette:");
    expect(text).toContain("Skin Lab:");
    expect(text).toContain("Contrast:");
    expect(text).toContain("Analyzed 100% on-device. No photo was stored or uploaded.");
    // Calibrated trend: the Korean fallback label must not leak through.
    expect(text).not.toContain("분석 완료");
    for (const swatch of result.swatches.slice(0, 6)) {
      expect(text).toContain(`${swatch.name} (${swatch.hex})`);
    }
  });
});

describe("shareText platform behaviour", () => {
  test("native: shares through the OS sheet", async () => {
    setPlatform("android");
    const spy = jest.spyOn(Share, "share").mockResolvedValue({ action: Share.sharedAction });
    const outcome = await shareText("Fashi", "hello");
    expect(spy).toHaveBeenCalledWith({ message: "hello", title: "Fashi" });
    expect(outcome).toMatchObject({ ok: true, method: "native" });
  });

  test("native: a dismissed sheet is reported as not shared", async () => {
    setPlatform("android");
    jest.spyOn(Share, "share").mockResolvedValue({ action: Share.dismissedAction });
    const outcome = await shareText("Fashi", "hello");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/dismissed/i);
  });

  test("native: a thrown share error surfaces instead of vanishing", async () => {
    setPlatform("ios");
    jest.spyOn(Share, "share").mockRejectedValue(new Error("no share sheet"));
    const outcome = await shareText("Fashi", "hello");
    expect(outcome).toMatchObject({ ok: false, method: "unavailable" });
    expect(outcome.message).toBe("no share sheet");
  });

  test("web: uses navigator.share when the browser has it", async () => {
    setPlatform("web");
    const share = jest.fn().mockResolvedValue(undefined);
    setNavigator({ share });
    const outcome = await shareText("Fashi card", "body");
    expect(share).toHaveBeenCalledWith({ title: "Fashi card", text: "body" });
    expect(outcome.method).toBe("web-share");
    expect(outcome.ok).toBe(true);
  });

  test("web: falls back to the clipboard where web share does not exist", async () => {
    setPlatform("web");
    const writeText = jest.fn().mockResolvedValue(undefined);
    setNavigator({ clipboard: { writeText } });
    const outcome = await shareText("Fashi card", "body");
    expect(writeText).toHaveBeenCalledWith("body");
    expect(outcome).toMatchObject({ ok: true, method: "clipboard" });
    expect(describeShareOutcome(outcome)).toMatch(/clipboard/i);
  });

  test("web: a dismissed share sheet is not silently replaced by a copy", async () => {
    setPlatform("web");
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    const share = jest.fn().mockRejectedValue(aborted);
    const writeText = jest.fn();
    setNavigator({ share, clipboard: { writeText } });
    const outcome = await shareText("Fashi card", "body");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/dismissed/i);
    expect(writeText).not.toHaveBeenCalled();
  });

  test("web: says so when the browser can neither share nor copy", async () => {
    setPlatform("web");
    setNavigator({});
    const outcome = await shareText("Fashi card", "body");
    expect(outcome).toMatchObject({ ok: false, method: "unavailable" });
    expect(describeShareOutcome(outcome)).toMatch(/cannot share or copy/i);
  });

  test("describeShareOutcome never claims a share that did not happen", () => {
    expect(describeShareOutcome({ ok: true, method: "native", message: "" })).toBe("Shared.");
    expect(describeShareOutcome({ ok: true, method: "web-share", message: "" })).toBe("Shared.");
    expect(describeShareOutcome({ ok: false, method: "unavailable", message: "nope" })).toBe("nope");
  });
});
