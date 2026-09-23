import { compositePhotoDrape, bufferToJpegDataUri } from "../src/analysis/drape";
import { sRGBToLab } from "../src/color/convert";
import type { ImageBuffer } from "../src/capture/sampler";

describe("Digital Photo Drape Compositing (Keep-L*)", () => {
  test("recolors masked drape region while preserving original lightness L* folds", () => {
    const width = 100;
    const height = 100;
    const data = new Uint8Array(width * height * 4);
    const mask = new Uint8Array(width * height);

    // Fill image: top half face (unchanged), bottom half clothing folds with varying L*
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        if (y < 50) {
          // Face skin pixel
          data[idx] = 190;
          data[idx + 1] = 145;
          data[idx + 2] = 115;
          data[idx + 3] = 255;
        } else {
          // Clothing fold gradient: L* varies with x
          const shade = 100 + Math.floor(x * 1.2);
          data[idx] = shade;
          data[idx + 1] = shade;
          data[idx + 2] = shade;
          data[idx + 3] = 255;
          mask[y * width + x] = 1; // masked as drape
        }
      }
    }

    const img: ImageBuffer = { width, height, data };
    const targetEmerald = { r: 30, g: 150, b: 110 };

    const draped = compositePhotoDrape(img, mask, targetEmerald);

    // 1. Verify face pixels (y < 50) were NOT touched at all
    for (let y = 0; y < 50; y += 5) {
      for (let x = 0; x < width; x += 5) {
        const idx = (y * width + x) * 4;
        expect(draped.data[idx]).toBe(190);
        expect(draped.data[idx + 1]).toBe(145);
        expect(draped.data[idx + 2]).toBe(115);
      }
    }

    // 2. Verify drape pixels (y >= 50) acquired the emerald green hue while keeping their L* folds
    for (let y = 55; y < height; y += 10) {
      for (let x = 10; x < width - 10; x += 15) {
        const idx = (y * width + x) * 4;
        const origLab = sRGBToLab({ r: data[idx], g: data[idx + 1], b: data[idx + 2] });
        const newLab = sRGBToLab({ r: draped.data[idx], g: draped.data[idx + 1], b: draped.data[idx + 2] });

        // Lightness preserved within 3 L* units
        expect(Math.abs(newLab.L - origLab.L)).toBeLessThanOrEqual(3.5);
        // Chroma and hue shifted towards target green (a* < 0, b* > 0)
        expect(newLab.a).toBeLessThan(-10);
      }
    }
  });

  test("encodes ImageBuffer to valid base64 data URI", () => {
    const width = 20;
    const height = 20;
    const data = new Uint8Array(width * height * 4).fill(128);
    const uri = bufferToJpegDataUri({ width, height, data });

    expect(uri.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(uri.length).toBeGreaterThan(50);
  });
});
