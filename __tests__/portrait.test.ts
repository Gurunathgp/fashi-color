const fs = require("fs");
const path = require("path");
// Jest runs test files in CommonJS, where __dirname exists at runtime. @types/node is deliberately
// not in tsconfig "types" (its timer globals conflict with React Native's), so declare it locally.
declare const __dirname: string;
import { decodeJpegToBuffer, analyseBuffer } from "../src/capture/analyze";
import { SYNTHETIC_BASELINE_TREND } from "../src/analysis/calibrationData";
import { fitTrend, deriveLabel, type CalibrationSample } from "../src/analysis/axes";
import { compositePhotoDrape, bufferToJpegDataUri } from "../src/analysis/drape";

/**
 * End-to-end pipeline test on a real JPEG.
 *
 * The fixture is a small synthetic South Asian portrait (341x341, generated once and committed) so
 * this test does not depend on a machine-local path.
 */
describe("Real synthetic portrait analysis pipeline", () => {
  const imagePath = path.join(__dirname, "fixtures", "south-asian-portrait.jpg");

  // Stand-in for real P0.5 captures, so the label path can be asserted too.
  const captured: CalibrationSample[] = Array.from({ length: 20 }, (_, i) => {
    const L = 32 + (i * 55) / 19;
    return {
      skin: { L, a: 11 + (L / 100) * 5, b: 17 + (L / 100) * 9 },
      hair: { L: 14 + (i % 3), a: 1.2, b: 2.1 },
    };
  });

  test("fixture is committed and decodes", () => {
    expect(fs.existsSync(imagePath)).toBe(true);
    const bytes = new Uint8Array(fs.readFileSync(imagePath));
    expect(bytes.length).toBeGreaterThan(10000);

    const buffer = decodeJpegToBuffer(bytes, 480);
    expect(buffer.width).toBeGreaterThanOrEqual(240);
    expect(buffer.height).toBeGreaterThanOrEqual(240);
  });

  test("measures the portrait end-to-end and refuses a tone name on the synthetic baseline", () => {
    const bytes = new Uint8Array(fs.readFileSync(imagePath));
    const buffer = decodeJpegToBuffer(bytes, 480);

    const result = analyseBuffer(buffer, {
      trend: SYNTHETIC_BASELINE_TREND,
      naturalHair: true,
    });

    // 1. Facial geometry estimated
    expect(result.geometry.box.w).toBeGreaterThan(0.2);
    expect(result.geometry.box.h).toBeGreaterThan(0.3);
    expect(result.geometry.ipdPx).toBeGreaterThan(30);

    // 2. Skin and hair measured (medium-tan wheatish subject, MST 5-6)
    expect(result.skinD65.L).toBeGreaterThan(45);
    expect(result.skinD65.L).toBeLessThan(75);
    expect(result.hairD65.L).toBeLessThan(35);

    // 3. Contrast is positive (hair darker than skin)
    expect(result.contrast).toBeGreaterThan(15);

    // 4. A synthetic trend must NOT name a tone: this is the honesty gate.
    expect(result.label.calibrated).toBe(false);
    if (!result.label.calibrated) {
      expect(result.label.reason).toMatch(/synthetic/i);
    }

    // 5. Metal recommendation and palette still come out of the measurement
    expect(["gold", "silver", "both"]).toContain(result.metal);
    expect(result.swatches.length).toBeGreaterThanOrEqual(6);
    for (const swatch of result.swatches) {
      expect(swatch.hex.startsWith("#")).toBe(true);
      expect(swatch.name).toBeTruthy();
    }

    // 6. The same measurement names a tone once the trend is fitted on captures
    const capturedLabel = deriveLabel(result.axes, fitTrend(captured, "captured"));
    expect(capturedLabel.calibrated).toBe(true);

    // 7. Digital drape compositing on the portrait
    const goldRgb = { r: 198, g: 160, b: 74 };
    const draped = compositePhotoDrape(buffer, result.segmentation.clothingMask, goldRgb);
    expect(draped.width).toBe(buffer.width);
    expect(draped.height).toBe(buffer.height);

    const dataUri = bufferToJpegDataUri(draped, 75);
    expect(dataUri.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(dataUri.length).toBeGreaterThan(500);
  });
});
