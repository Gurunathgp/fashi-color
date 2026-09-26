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
- **`react-native-web` ships stubs that lie.** `Alert.alert()` is an empty function, so in the web
  export every dialog silently did nothing — including the destructive "Delete all my data" confirm,
  whose callback could never run — and `Share.share()` always rejects when `navigator.share` is
  missing (every desktop browser), which used to be swallowed by a bare `catch`. Import
  `notify`/`confirm` from `src/ui/dialog.ts` and `shareText` from `src/ui/share.ts`; never import
  `Alert` or `Share` from `react-native` directly in this app.
- **White-paper marking is tap-to-place, not drag.** `src/capture/whiteRect.ts` owns the geometry:
  the preview must keep the decoded buffer's aspect ratio, or a tap would not map linearly onto the
  normalised `whiteReferenceRect` the sampler expects. A marked rect outranks the auto-detected
  surface and the sclera prior (reliability 0.8 vs 0.7/0.65), which is the whole point of P1.5.
