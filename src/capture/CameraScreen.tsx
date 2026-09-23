// Capture screen. Plan section 5, 8 and P1.1-P1.2.
//
// Two paths, one UI:
//  - Native: react-native-vision-camera v5 via src/capture/nativeCamera.tsx. That module freezes
//    AE and AWB before measuring and reports the mode read back from the device, so the badges
//    below show what actually happened rather than what was requested.
//  - Fallback: expo-image-picker's camera. Used in Expo Go / simulators / devices with no matching
//    camera, where the Nitro module is not linked. No hardware lock is possible there, and the UI
//    says so instead of claiming one.
//
// The module is required inside try/catch: react-native-vision-camera throws at evaluation time
// when its native side is absent. nativeCamera.tsx owns every camera hook, so this file never calls
// a hook that the fallback path cannot satisfy.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Alert,
  Dimensions,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import type { LockReport, NativeCameraHandle } from "./nativeCamera";

let nativeModule: typeof import("./nativeCamera") | null = null;
try {
  nativeModule = require("./nativeCamera") as typeof import("./nativeCamera");
} catch {
  nativeModule = null;
}

const nativeAvailable = Boolean(nativeModule?.NativeCameraView);

const LOCK_TEXT: Record<string, string> = {
  locked: "LOCKED",
  unsupported: "N/A",
  failed: "FAILED",
  idle: "OFF",
};

type Props = {
  onCapture: (uri: string) => void;
  onCancel: () => void;
};

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");

export function CameraScreen({ onCapture, onCancel }: Props) {
  const [cameraPosition, setCameraPosition] = useState<"front" | "back">("front");
  const [lockAWB, setLockAWB] = useState(true);
  const [lockExposure, setLockExposure] = useState(true);
  // Bumped on every lock toggle: a fresh session is configured, which is the only way to release
  // an AE/AWB lock in VisionCamera v5 (see nativeCamera.tsx).
  const [sessionKey, setSessionKey] = useState(0);
  const [locks, setLocks] = useState<LockReport>({ exposure: "idle", whiteBalance: "idle" });
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<boolean | null>(null);
  const [useFallback, setUseFallback] = useState(!nativeAvailable);

  const cameraRef = useRef<NativeCameraHandle | null>(null);

  const requestPermission = useCallback(async () => {
    const { granted } = await ImagePicker.requestCameraPermissionsAsync();
    setPermission(granted);
  }, []);

  useEffect(() => {
    void requestPermission();
  }, [requestPermission]);

  // Stable callbacks: nativeCamera.tsx re-applies locks when its callbacks change identity, so
  // inline functions here would loop through setLocks.
  const handleLockReport = useCallback((report: LockReport) => setLocks(report), []);
  const handleUnavailable = useCallback(() => setUseFallback(true), []);

  const toggleExposure = useCallback(() => {
    setLockExposure((prev) => !prev);
    setSessionKey((k) => k + 1);
  }, []);
  const toggleAWB = useCallback(() => {
    setLockAWB((prev) => !prev);
    setSessionKey((k) => k + 1);
  }, []);

  const capture = useCallback(async () => {
    setBusy(true);
    try {
      if (!useFallback && cameraRef.current) {
        const uri = await cameraRef.current.capture();
        if (uri) {
          onCapture(uri);
          return;
        }
      }
      const res = await ImagePicker.launchCameraAsync({ quality: 1 });
      if (!res.canceled && res.assets?.[0]?.uri) onCapture(res.assets[0].uri);
    } catch (e) {
      Alert.alert("Camera Error", e instanceof Error ? e.message : "Failed to capture photo");
    } finally {
      setBusy(false);
    }
  }, [onCapture, useFallback]);

  if (permission === false) {
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.h1}>Camera Permission Needed</Text>
        <Text style={styles.p}>
          Fashi needs camera access to measure your personal coloring on-device. Nothing is uploaded.
        </Text>
        <Pressable style={styles.primaryBtn} onPress={requestPermission}>
          <Text style={styles.primaryBtnText}>Grant access</Text>
        </Pressable>
        <Pressable style={styles.cancelBtn} onPress={onCancel}>
          <Text style={styles.cancelBtnText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  // Fallback path: no Nitro module (Expo Go / simulator) or no matching camera device.
  if (useFallback) {
    return (
      <View style={styles.fallbackContainer}>
        <View style={styles.fallbackHeader}>
          <Text style={styles.fallbackTitle}>Camera Mode</Text>
          <Text style={styles.fallbackSubtitle}>
            {nativeAvailable
              ? "No matching camera device was found, so the system camera is used instead."
              : "Hardware AE/AWB lock needs an Android dev-client build (npx expo run:android). In Expo Go the system camera is used and nothing is locked."}
          </Text>
        </View>

        <View style={styles.tipsBox}>
          <Text style={styles.tipsTitle}>Tips for best accuracy:</Text>
          <Text style={styles.tipItem}>• Face a window in natural daylight (no ceiling lamp).</Text>
          <Text style={styles.tipItem}>• Hold a sheet of white paper beside your neck.</Text>
          <Text style={styles.tipItem}>• Ensure beauty mode / AI enhance is turned OFF.</Text>
        </View>

        <Pressable style={styles.primaryBtn} onPress={capture} disabled={busy}>
          {busy ? <ActivityIndicator color="#FFF" /> : <Text style={styles.primaryBtnText}>Launch camera</Text>}
        </Pressable>

        <Pressable style={styles.cancelBtn} onPress={onCancel} disabled={busy}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  const NativeCameraView = nativeModule?.NativeCameraView;
  if (!NativeCameraView) {
    // Defensive: the module loaded at import time but the view is unavailable (fast refresh).
    return <View style={styles.container} />;
  }

  return (
    <View style={styles.container}>
      <NativeCameraView
        ref={cameraRef}
        position={cameraPosition}
        lockExposure={lockExposure}
        lockWhiteBalance={lockAWB}
        sessionKey={sessionKey}
        onLockReport={handleLockReport}
        onUnavailable={handleUnavailable}
      />

      {/* Framing overlay */}
      <View style={styles.overlay} pointerEvents="none">
        <View style={styles.overlayTop} />
        <View style={styles.overlayCenter}>
          <View style={styles.ovalMask} />
          <View style={styles.whiteRefGuide}>
            <Text style={styles.whiteRefText}>Hold white paper here</Text>
          </View>
        </View>
        <View style={styles.overlayBottom}>
          <Text style={styles.guideInstruction}>Fit face inside oval · Neck visible below</Text>
        </View>
      </View>

      {/* Controls header: badges show the mode read back from the device */}
      <View style={styles.headerControls}>
        <Pressable style={styles.iconBtn} onPress={onCancel}>
          <Text style={styles.iconBtnText}>✕</Text>
        </Pressable>

        <View style={styles.badgeRow}>
          <Pressable
            style={[styles.toggleBadge, lockAWB && locks.whiteBalance === "locked" && styles.toggleBadgeOn]}
            onPress={toggleAWB}
          >
            <Text style={[styles.toggleText, lockAWB && locks.whiteBalance === "locked" && styles.toggleTextOn]}>
              AWB {lockAWB ? LOCK_TEXT[locks.whiteBalance] : "OFF"}
            </Text>
          </Pressable>

          <Pressable
            style={[styles.toggleBadge, lockExposure && locks.exposure === "locked" && styles.toggleBadgeOn]}
            onPress={toggleExposure}
          >
            <Text style={[styles.toggleText, lockExposure && locks.exposure === "locked" && styles.toggleTextOn]}>
              AE {lockExposure ? LOCK_TEXT[locks.exposure] : "OFF"}
            </Text>
          </Pressable>
        </View>

        <Pressable
          style={styles.iconBtn}
          onPress={() => setCameraPosition((prev) => (prev === "front" ? "back" : "front"))}
        >
          <Text style={styles.iconBtnText}>⟳</Text>
        </Pressable>
      </View>

      {lockAWB && locks.whiteBalance === "unsupported" && (
        <View style={styles.lockWarning}>
          <Text style={styles.lockWarningText}>
            This device cannot lock white balance. Hold white paper in the guide so the illuminant can
            be measured instead.
          </Text>
        </View>
      )}

      {/* Shutter */}
      <View style={styles.bottomBar}>
        <Pressable style={styles.shutterBtn} onPress={capture} disabled={busy}>
          {busy ? <ActivityIndicator color="#0A7A55" /> : <View style={styles.shutterInner} />}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  permissionContainer: {
    flex: 1,
    backgroundColor: "#FFF",
    padding: 24,
    justifyContent: "center",
    alignItems: "center",
    gap: 16,
  },
  fallbackContainer: {
    flex: 1,
    backgroundColor: "#FFF",
    padding: 24,
    justifyContent: "center",
    gap: 20,
  },
  fallbackHeader: {
    gap: 8,
  },
  fallbackTitle: {
    fontSize: 26,
    fontWeight: "800",
    color: "#111",
  },
  fallbackSubtitle: {
    fontSize: 13,
    color: "#555",
    lineHeight: 19,
  },
  tipsBox: {
    backgroundColor: "#F7F8FA",
    borderRadius: 14,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  tipsTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#111",
  },
  tipItem: {
    fontSize: 12,
    color: "#4B5565",
    lineHeight: 18,
  },
  h1: { fontSize: 24, fontWeight: "800", color: "#111", textAlign: "center" },
  p: { fontSize: 13, color: "#666", textAlign: "center", lineHeight: 19 },
  primaryBtn: {
    backgroundColor: "#111",
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: "center",
  },
  primaryBtnText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
  cancelBtn: {
    paddingVertical: 12,
    alignItems: "center",
  },
  cancelBtnText: { color: "#666", fontWeight: "600", fontSize: 13 },
  overlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: "space-between",
  },
  overlayTop: {
    height: SCREEN_HEIGHT * 0.12,
  },
  overlayCenter: {
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  ovalMask: {
    width: SCREEN_WIDTH * 0.65,
    height: SCREEN_HEIGHT * 0.44,
    borderRadius: SCREEN_WIDTH * 0.33,
    borderWidth: 2,
    borderColor: "rgba(255, 255, 255, 0.75)",
    borderStyle: "dashed",
    backgroundColor: "transparent",
  },
  whiteRefGuide: {
    position: "absolute",
    right: SCREEN_WIDTH * 0.04,
    bottom: 20,
    width: 60,
    height: 75,
    borderWidth: 1.5,
    borderColor: "rgba(255, 255, 255, 0.6)",
    borderRadius: 6,
    justifyContent: "center",
    alignItems: "center",
    padding: 4,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
  },
  whiteRefText: {
    fontSize: 8,
    color: "#FFF",
    textAlign: "center",
    fontWeight: "700",
  },
  overlayBottom: {
    paddingBottom: 110,
    alignItems: "center",
  },
  guideInstruction: {
    color: "#FFF",
    fontSize: 12,
    fontWeight: "600",
    textShadowColor: "rgba(0, 0, 0, 0.75)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  headerControls: {
    position: "absolute",
    top: 48,
    left: 16,
    right: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  badgeRow: {
    flexDirection: "row",
    gap: 8,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  iconBtnText: {
    color: "#FFF",
    fontSize: 18,
    fontWeight: "700",
  },
  toggleBadge: {
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.3)",
  },
  toggleBadgeOn: {
    backgroundColor: "rgba(10, 122, 85, 0.8)",
    borderColor: "#0A7A55",
  },
  toggleText: {
    color: "#DDD",
    fontSize: 10,
    fontWeight: "700",
  },
  toggleTextOn: {
    color: "#FFF",
  },
  lockWarning: {
    position: "absolute",
    top: 100,
    left: 16,
    right: 16,
    backgroundColor: "rgba(138, 90, 0, 0.85)",
    borderRadius: 10,
    padding: 10,
  },
  lockWarningText: {
    color: "#FFF",
    fontSize: 11,
    lineHeight: 16,
  },
  bottomBar: {
    position: "absolute",
    bottom: 30,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  shutterBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: "#FFF",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.2)",
  },
  shutterInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#FFF",
  },
});
