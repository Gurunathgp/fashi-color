# Fashi — On-Device Personal Colour Analysis

India-first personal colour analysis for Indian/South Asian skin tones, running **100% on-device**.
A photo is decoded in memory, measured in CIELAB/OKLCh, converted into three continuous axes
(Warmth / Depth / Clarity), and rendered as a Korean 8-tone label, a gold-vs-silver recommendation,
a wearable palette region, a digital drape A/B quiz and a share card. **No backend, no upload, no
photos ever stored** — only derived numbers.

> Full implementation documentation (pipeline, formulas, module reference, gate table, tests,
> verification status and open work) lives in the workspace repo at `E:\fashi\README.md`. The
> executable plan is `session-ses_f9f8.md` in the same repo.

---

## Quick start

```bash
npm install
npx expo start              # Expo Go (camera falls back to the system picker)
npx expo start --web        # browser: camera falls back to file input
npx expo run:android        # dev client: enables the native camera path below
```

Verify the tree the way the last review did:

```bash
npm run verify              # tsc --noEmit + jest, in one shot
npx tsc --noEmit            # strict, includes tests — exit 0
npm test                    # 168 tests / 12 suites, no watch
npx expo config             # must resolve (no PluginError)
npx expo export --platform android
npx expo export --platform web
```

Both exports write to `dist/`, so the second overwrites the first — add `--output-dir dist-web` if you
want to keep both side by side.

---

## How it works (pipeline)

```
photo → jpeg decode (≤640px, box-averaged) → face geometry → multiclass masks →
neck/jaw/forehead sampling → hair mask → illuminant estimation (paper → sclera →
skin prior → shades-of-grey) → Bradford adapt to D65 → 16-check quality gate →
3 axes → Korean 8-tone label → palette/metal/olive/contrast →
drape A/B quiz (re-derives everything) → result + share card
```

Two rules run through every stage:

1. **Refuse rather than guess.** A check that cannot measure reports *not measured*; an unfitted
   trend refuses to name a season; an implausible face box is excluded from pose/size checks.
2. **Store z-scores, derive the label at render time.** Recalibrating later updates stored profiles
   without a reshoot.

---

## Camera (VisionCamera v5)

The native path lives in `src/capture/nativeCamera.tsx` and is loaded through `require()` in
`try/catch` inside `src/capture/CameraScreen.tsx`, so environments without the Nitro module
(Expo Go, simulators, web) fall back to `expo-image-picker` with copy that says plainly that
nothing is locked there.

- Photos: `usePhotoOutput()` + `capturePhotoToFile()` → `file://` URI (the v4 `photo` prop and
  `ref.takePhoto()` do not exist in v5).
- AE/AWB: `controller.lockCurrentExposure()` / `lockCurrentWhiteBalance()` after the session
  starts, with the mode read back from the device — badges show `LOCKED | N/A | FAILED | OFF` and
  never claim a lock the device didn't confirm. Locks release by re-mounting the session
  (`sessionKey`), since locking is one-way in v5.
- **Never list `react-native-vision-camera` in `app.json` plugins** — v5 ships no `app.plugin.js`
  and Expo kills `start`/`prebuild`/`run:android` with `PluginError` when it is listed
  (see `AGENTS.md`). The peer `react-native-nitro-modules` is a declared dependency.

---

## Colour engine

- `src/color/` — hand-rolled sRGB↔XYZ↔Lab↔LCh, OKLab/OKLCh, CIEDE2000, Bradford + Planckian/daylight
  loci with CCT/Duv, and the P0.3 error-budget + P0.4 invariance harness.
- `src/analysis/axes.ts` — Theil–Sen trend fit, `W/D/C` axes, `metalFor`, `isOlive`,
  `axisConfidence`. `Trend.source` is `"none" | "synthetic" | "captured"` and **only `captured`
  may become `calibrated`**, so a synthetic reference set can never name a season.
- `src/analysis/calibrationData.ts` — 50 **synthetic** MST-derived reference profiles: reference
  data and regression fixture, explicitly not calibration.
- `src/analysis/palette.ts` — palette as an OKLCh *region* (`paletteFor`), fuzzy membership with a
  face-adjacency term, gamut-preserving mapping, and CVD-safe named swatches from a 50-colour
  Indian-market lexicon.
- `src/analysis/drape.ts` — keep-L\* recolouring (`recolorMasked`), photo drape compositing
  (`compositePhotoDrape`), and the weakest-axis drape quiz (`drapeQuiz`, answers shift ±0.2).

---

## Privacy

- First-run consent screen before any capture; consent stored locally (`fashi.consent.v1`).
- Photos decode in memory; the picker/camera cache file is deleted after measurement.
- Stored: axes/Lab/contrast/CCT/quiz answers only (`fashi.profile.v1`, `fashi.calibration.v1`).
- "Delete all my data" clears profile + calibration, behind a confirmation that works on every
  platform (see *Web parity* below — on web it used to be a button that silently did nothing).
- Marking white paper re-runs the pipeline on the pixels already held in memory; nothing is read back
  from disk or uploaded to do it.

---

## Web parity (what the browser build really does)

The web export is how this gets demoed without a phone, and two `react-native-web` stubs used to make
it lie:

- `Alert.alert()` is an **empty function** in react-native-web, so every dialog in the app silently
  did nothing on web — including the "Delete all my data" confirmation, whose destructive callback
  could never run. Everything now goes through `src/ui/dialog.ts` (`notify`, `confirm`), which uses
  `window.alert` / `window.confirm` on web and `Alert` on native.
- `Share.share()` **rejects** whenever `navigator.share` is missing (every desktop browser), and the
  rejection used to be swallowed, so the Share buttons looked dead. `src/ui/share.ts` now tries
  `navigator.share`, then the clipboard, then says plainly that this browser can do neither — and the
  UI shows which path was taken. Share wording lives in pure builders (`buildResultShareText`,
  `buildShareCardText`) so it is unit-tested instead of eyeballed.

Capture on web still falls back to the file picker (a browser cannot lock AE/AWB), but the
measurement pipeline is the same code on every platform.

---

## Status & open work

- ✅ 168 tests / 12 suites green · `tsc` clean · android + web bundles export.
- ✅ Web export no longer lies about dialogs or sharing (see *Web parity*): `src/ui/dialog.ts` and
  `src/ui/share.ts` replace the react-native-web stubs, with `__tests__/dialog.test.ts` and
  `__tests__/share.test.ts` pinning the behaviour on both platforms.
- ✅ Manual white-paper marking is wired end to end (P1.5): tap the sheet in the photo on the
  "Mark white paper" screen and the pipeline re-runs with that rect, which outranks the
  auto-detected surface and the sclera prior (`src/capture/whiteRect.ts`, `whiteRect.test.ts`).
- ❌ No P0.5 calibration captures yet — tone labels refuse until 15+ real captures exist.
- ❌ `faceLandmarker.ts` / `segmentation.ts` are pixel heuristics, not the TFLite models.
- ❌ Native camera path type-checked and bundled but not yet run on a device (the splash screen,
  dev-client plugin and `versionCode` in `app.json` are in place for that first `run:android`).
- ❌ Share card is still text-only — no image render (needs a native screenshot module).

See the workspace `README.md` (§15–§17) for the verification log, the full check-by-check gate
table, and the spec-to-code cross-reference.
