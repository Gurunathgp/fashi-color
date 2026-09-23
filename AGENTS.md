# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

## Project-specific traps (learned the hard way)

- **Never list `react-native-vision-camera` in `app.json` `plugins`.** v5 ships no `app.plugin.js`,
  and Expo resolves every plugin entry with `@expo/config-plugins`, which throws `PluginError` and
  kills `expo start`, `prebuild` and `run:android`. The CAMERA permission is declared explicitly in
  `app.json` (`android.permissions`), so nothing is lost by omitting the plugin.
- **`react-native-vision-camera` is pinned to v5 (Nitro).** v5 has no `photo` prop and no
  `ref.takePhoto()`: photos go through `usePhotoOutput()` + `capturePhotoToFile(...)`, and AE/AWB
  locks are imperative on `CameraController`. v5 also requires `react-native-nitro-modules` (a peer
  that npm does not install automatically). See `src/capture/nativeCamera.tsx`.
- **`expo-file-system` (57) moved the old API.** `readAsStringAsync` / `deleteAsync` now warn and
  live in `expo-file-system/legacy`; the default entry exposes `File`, `Directory`, `Paths`.
