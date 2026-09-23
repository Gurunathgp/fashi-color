// Native camera preview + capture for react-native-vision-camera v5 (Nitro).
// Plan section 5 (cheap-ISP AWB/AE drift) and P1.1-P1.2.
//
// Why this file exists separately from CameraScreen:
//  - v5 replaced the v4 API. There is no `photo` prop and no `ref.takePhoto()`; a photo is taken
//    through a CameraPhotoOutput (`usePhotoOutput()` + `capturePhotoToFile(...)`), which returns a
//    filesystem path (not a `file://` URL).
//  - AE/AWB locks are imperative on the CameraController (`lockCurrentExposure()`,
//    `lockCurrentWhiteBalance()`), and they are one-way: `controller.configure()` only accepts
//    low-light-boost / smooth-autofocus / distortion-correction. Releasing a lock is therefore done
//    by re-mounting the Camera view, which reconfigures the session and returns the pipeline to
//    continuous AE/AWB. The UI badges report the mode read back from the controller, so a lock that
//    could not be confirmed is never displayed as locked.
//  - react-native-vision-camera is a Nitro module: it is not linked in Expo Go and importing it
//    throws at evaluation time. CameraScreen requires this file inside try/catch and falls back to
//    expo-image-picker. Keep the import static (Metro must resolve it for dev-client builds) and
//    keep every camera hook in this file, so the fallback branch never calls a hook.
//
// Requires a dev-client build (`npx expo run:android`); see AGENTS.md.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
  type CameraRef,
} from "react-native-vision-camera";

/** Result of an attempt to freeze a camera property, as reported by the device itself. */
export type LockState = "idle" | "locked" | "unsupported" | "failed";

export type LockReport = { exposure: LockState; whiteBalance: LockState };

export type NativeCameraHandle = {
  /**
   * Captures a JPEG to the app cache and resolves a `file://` URI, or null if the camera is not
   * ready. Throws if the capture pipeline itself fails.
   */
  capture: () => Promise<string | null>;
};

export type NativeCameraViewProps = {
  position: "front" | "back";
  /** Freeze exposure at the metered value before measuring (plan section 5). */
  lockExposure: boolean;
  /** Freeze white balance at the metered value before measuring. */
  lockWhiteBalance: boolean;
  /** Bumped by the parent when a lock is released, to force a fresh session configuration. */
  sessionKey: number;
  onStarted?: () => void;
  onLockReport?: (report: LockReport) => void;
  /** Called when no camera device matches the requested position, so the caller can fall back. */
  onUnavailable?: () => void;
};

export const NativeCameraView = forwardRef<NativeCameraHandle, NativeCameraViewProps>(
  function NativeCameraView(
    { position, lockExposure, lockWhiteBalance, sessionKey, onStarted, onLockReport, onUnavailable },
    ref
  ) {
    const device = useCameraDevice(position);
    const permission = useCameraPermission();
    // 'quality' is the safe default: 'speed' throws on devices that do not advertise
    // supportsSpeedQualityPrioritization.
    const photoOutput = usePhotoOutput({ qualityPrioritization: "quality" });
    const cameraRef = useRef<CameraRef>(null);
    const [started, setStarted] = useState(false);

    // A sessionKey bump re-mounts the Camera view; wait for the new session's onStarted before
    // re-applying locks, otherwise the lock would target a session that no longer exists.
    useEffect(() => {
      setStarted(false);
    }, [sessionKey]);

    useEffect(() => {
      if (!device) onUnavailable?.();
    }, [device, onUnavailable]);

    useImperativeHandle(
      ref,
      () => ({
        async capture() {
          if (!device || !permission.hasPermission) return null;
          const file = await photoOutput.capturePhotoToFile(
            { flashMode: "off", enableShutterSound: false },
            {}
          );
          return file.filePath.startsWith("file://") ? file.filePath : `file://${file.filePath}`;
        },
      }),
      [device, permission.hasPermission, photoOutput]
    );

    // Apply the locks once the session has started, then read the resulting modes back from the
    // device: "locked" is only reported when the controller agrees.
    const applyLocks = useCallback(async () => {
      const controller = cameraRef.current?.controller;
      if (!controller) {
        onLockReport?.({ exposure: "failed", whiteBalance: "failed" });
        return;
      }

      let exposure: LockState = "idle";
      if (lockExposure) {
        if (!controller.device.supportsExposureLocking) {
          exposure = "unsupported";
        } else {
          try {
            await controller.lockCurrentExposure();
            exposure = controller.exposureMode === "locked" ? "locked" : "failed";
          } catch {
            exposure = "failed";
          }
        }
      }

      let whiteBalance: LockState = "idle";
      if (lockWhiteBalance) {
        if (!controller.device.supportsWhiteBalanceLocking) {
          whiteBalance = "unsupported";
        } else {
          try {
            await controller.lockCurrentWhiteBalance();
            whiteBalance = controller.whiteBalanceMode === "locked" ? "locked" : "failed";
          } catch {
            whiteBalance = "failed";
          }
        }
      }

      onLockReport?.({ exposure, whiteBalance });
    }, [lockExposure, lockWhiteBalance, onLockReport]);

    useEffect(() => {
      if (!started) return;
      void applyLocks();
    }, [started, applyLocks]);

    if (!device) return null;

    return (
      <View style={StyleSheet.absoluteFill}>
        <Camera
          // Re-mounting on sessionKey releases an applied AE/AWB lock: a new session is configured,
          // which returns the pipeline to continuous AE/AWB. Without this, "lock off" is a no-op.
          key={sessionKey}
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={permission.hasPermission}
          outputs={[photoOutput]}
          onStarted={() => {
            setStarted(true);
            onStarted?.();
          }}
          onStopped={() => setStarted(false)}
        />
      </View>
    );
  }
);
