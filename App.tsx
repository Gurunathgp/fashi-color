import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Image,
  ActivityIndicator,
  Platform,
  useWindowDimensions,
  type GestureResponderEvent,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as ImagePicker from "expo-image-picker";
// expo-file-system 57 moved the classic API: on the default entry `readAsStringAsync` /
// `deleteAsync` log a deprecation and THROW at runtime, which would break every capture. The
// documented migration is to import them from "expo-file-system/legacy" (see AGENTS.md).
import * as FileSystem from "expo-file-system/legacy";
import { Buffer } from "buffer";

import { analyseBuffer, decodeJpegToBuffer, type AnalysisResult } from "./src/capture/analyze";
import type { ImageBuffer } from "./src/capture/sampler";
import {
  fitTrend,
  UNCALIBRATED_TREND,
  MIN_CALIBRATION_N,
  axisConfidence,
  deriveLabel,
  metalFor,
  isOlive,
  type Trend,
} from "./src/analysis/axes";
import { paletteFor, sampleSwatches } from "./src/analysis/palette";
import {
  drapeQuiz,
  applyQuizAnswers,
  compositePhotoDrape,
  bufferToJpegDataUri,
  type DrapePair,
} from "./src/analysis/drape";
import { ResultCard } from "./src/ui/ResultCard";
import { DrapeComparison } from "./src/ui/DrapeComparison";
import { GateReport } from "./src/ui/GateReport";
import { CameraScreen } from "./src/capture/CameraScreen";
import {
  appendCalibrationSample,
  loadCalibration,
  saveProfile,
  loadProfile,
  clearProfile,
  clearCalibration,
  loadConsent,
  saveConsent,
  resultFromStoredProfile,
  type StoredProfile,
} from "./src/storage/profile";
// Platform dialogs: react-native-web's Alert is a no-op, so `Alert.alert` silently did nothing in
// the web export (see src/ui/dialog.ts).
import { notify, confirm } from "./src/ui/dialog";
// Manual white-paper reference (plan P1.5): the pipeline has always accepted a rect, the UI that
// produces one was the missing piece.
import { rectFromPoint, checkRect, type NormalisedRect } from "./src/capture/whiteRect";

type Screen = "home" | "camera" | "gate" | "result" | "drape" | "white";

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [busy, setBusy] = useState(false);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageBuffer, setImageBuffer] = useState<ImageBuffer | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [savedProfile, setSavedProfile] = useState<StoredProfile | null>(null);
  const [trend, setTrend] = useState<Trend>(UNCALIBRATED_TREND);
  const [answers, setAnswers] = useState<{ axis: "W" | "D" | "C"; sign: 1 | -1 }[]>([]);
  const [quizIndex, setQuizIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // null = still loading from device storage.
  const [consent, setConsent] = useState<boolean | null>(null);
  // Plan §10 risk "dyed hair": asked before the first measurement, never assumed.
  const [naturalHair, setNaturalHair] = useState<boolean | null>(null);
  // Manual white-paper mark (normalised) and the last re-measure report, for the white-ref screen.
  const [whiteRect, setWhiteRect] = useState<NormalisedRect | null>(null);
  const [whiteStatus, setWhiteStatus] = useState<string | null>(null);
  const { width: viewWidth } = useWindowDimensions();

  // Refit the trend from any calibration samples already on the device.
  const refitTrend = useCallback(async () => {
    const cal = await loadCalibration();
    setTrend(fitTrend(cal.samples));
    return cal.samples.length;
  }, []);

  useEffect(() => {
    void refitTrend();
    void loadProfile().then(setSavedProfile);
    void loadConsent().then(setConsent);
  }, [refitTrend]);

  // Picker cache lives on disk (OS cache dir) even though the engine only measures
  // in memory. Delete the previous cache file before each new capture so no photo
  // accumulates — only derived numbers are persisted via saveProfile().
  const deleteCacheFile = useCallback(async (uri: string | null) => {
    if (!uri || uri.startsWith("data:") || uri.startsWith("blob:") || Platform.OS === "web") return;
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch {
      // Best-effort: cache cleanup must never block analysis.
    }
  }, []);

  /**
   * Dyed or coloured hair invalidates the clarity hair term (plan §10), so the answer is
   * required before any capture. Blocking, not defaulted: a silent `true` would quietly
   * mis-measure the burgundy/brown case the plan explicitly calls out for this market.
   */
  const requireHairAnswer = useCallback(() => {
    if (naturalHair !== null) return true;
    notify(
      "Is this your natural hair colour?",
      "Dyed or coloured hair changes the clarity reading, so answer Natural or Dyed below, then start the capture again."
    );
    return false;
  }, [naturalHair]);

  const analyse = useCallback(
    async (uri: string, assetBase64?: string | null, whiteReferenceRect?: NormalisedRect) => {
      setBusy(true);
      setError(null);
      try {
        let bytes: Uint8Array;
        if (assetBase64) {
          bytes = new Uint8Array(Buffer.from(assetBase64, "base64"));
        } else if (Platform.OS === "web" || uri.startsWith("data:") || uri.startsWith("blob:")) {
          const resp = await fetch(uri);
          const arrayBuf = await resp.arrayBuffer();
          bytes = new Uint8Array(arrayBuf);
        } else {
          const base64 = await FileSystem.readAsStringAsync(uri, { encoding: "base64" });
          bytes = new Uint8Array(Buffer.from(base64, "base64"));
        }
        const buf = decodeJpegToBuffer(bytes);
        setImageBuffer(buf);
        const r = analyseBuffer(buf, { trend, naturalHair: naturalHair ?? true, whiteReferenceRect });
        setResult(r);
        setAnswers([]);
        setQuizIndex(0);
        setScreen("gate");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [trend, naturalHair]
  );

  const pickPhoto = useCallback(async () => {
    if (!requireHairAnswer()) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      notify("Photo access needed", "Fashi reads the photo on-device and never uploads it.");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 1,
      base64: true,
    });
    if (res.canceled || !res.assets?.[0]) return;
    await deleteCacheFile(imageUri);
    setImageUri(res.assets[0].uri);
    await analyse(res.assets[0].uri, res.assets[0].base64);
  }, [analyse, deleteCacheFile, imageUri, requireHairAnswer]);

  const takePhoto = useCallback(() => {
    if (!requireHairAnswer()) return;
    setScreen("camera");
  }, [requireHairAnswer]);

  const quiz: DrapePair[] = useMemo(() => {
    if (!result) return [];
    const conf = axisConfidence(
      result.axes,
      trend,
      result.measurement.regionSpreadDE00,
      result.illuminant.reliability
    );
    return drapeQuiz(result.axes, trend, conf.weakest);
  }, [result, trend]);

  const currentPair: DrapePair | undefined = quiz[Math.min(quizIndex, Math.max(0, quiz.length - 1))];

  const { drapeUriA, drapeUriB } = useMemo(() => {
    if (!imageBuffer || !result?.segmentation?.clothingMask || !currentPair) {
      return { drapeUriA: null, drapeUriB: null };
    }
    try {
      const drapedA = compositePhotoDrape(imageBuffer, result.segmentation.clothingMask, currentPair.a.rgb);
      const drapedB = compositePhotoDrape(imageBuffer, result.segmentation.clothingMask, currentPair.b.rgb);
      return {
        drapeUriA: bufferToJpegDataUri(drapedA, 75),
        drapeUriB: bufferToJpegDataUri(drapedB, 75),
      };
    } catch {
      return { drapeUriA: null, drapeUriB: null };
    }
  }, [imageBuffer, result, currentPair]);

  const adjustedResult = useMemo(() => {
    if (!result) return null;
    if (answers.length === 0) return result;
    const nextAxes = applyQuizAnswers(result.axes, answers);
    const confidence = axisConfidence(
      nextAxes,
      trend,
      result.measurement.regionSpreadDE00,
      result.illuminant.reliability
    );
    const label = deriveLabel(nextAxes, trend);
    const palette = paletteFor(nextAxes, result.skinD65, trend);
    const swatches = sampleSwatches(palette);
    const metal = metalFor(nextAxes.W, trend);
    const olive = isOlive(nextAxes, trend);
    return {
      ...result,
      axes: nextAxes,
      confidence,
      label,
      palette,
      swatches,
      metal,
      olive,
    };
  }, [result, answers, trend]);

  const addToCalibration = useCallback(async () => {
    if (!result || !Number.isFinite(result.skinD65.L)) {
      notify("Nothing to add", "This capture produced no usable skin measurement.");
      return;
    }
    const n = await appendCalibrationSample(result.skinD65, result.hairD65);
    const fitted = await refitTrend();
    notify(
      "Added to calibration",
      `${n} subject${n === 1 ? "" : "s"} stored. ${
        fitted >= MIN_CALIBRATION_N
          ? "Trend is now fitted; tone labels are enabled."
          : `${MIN_CALIBRATION_N - fitted} more needed before tone labels are meaningful.`
      }`
    );
  }, [result, refitTrend]);

  // White-reference screen (plan P1.5): the preview keeps the decoded buffer's aspect ratio, so a
  // tap maps linearly onto normalised image coordinates.
  const previewWidth = Math.min(Math.max(220, viewWidth - 64), 360);
  const previewHeight = imageBuffer
    ? Math.max(160, Math.round((previewWidth * imageBuffer.height) / imageBuffer.width))
    : 240;

  const onTapPreview = useCallback(
    (event: GestureResponderEvent) => {
      if (!imageBuffer) return;
      const { locationX, locationY } = event.nativeEvent;
      setWhiteRect(
        rectFromPoint(
          locationX / previewWidth,
          locationY / previewHeight,
          imageBuffer.width,
          imageBuffer.height
        )
      );
      setWhiteStatus(null);
    },
    [imageBuffer, previewWidth, previewHeight]
  );

  const reanalyseWithWhiteRef = useCallback(() => {
    if (!imageBuffer || !whiteRect) return;
    const check = checkRect(whiteRect, imageBuffer.width, imageBuffer.height);
    if (!check.ok) {
      setWhiteStatus(check.reason);
      return;
    }
    // Re-runs the whole pipeline (illuminant -> adaptation -> gate -> axes) on the pixels we
    // already hold in memory: no photo is read from disk or re-uploaded to do this.
    const r = analyseBuffer(imageBuffer, {
      trend,
      naturalHair: naturalHair ?? true,
      whiteReferenceRect: whiteRect,
    });
    setResult(r);
    setAnswers([]);
    setQuizIndex(0);
    setWhiteStatus(
      `Re-measured: illuminant ${r.illuminant.method} at ${Math.round(r.illuminant.cct)} K ` +
        `(reliability ${r.illuminant.reliability.toFixed(2)}), gate re-run on the corrected pixels.`
    );
  }, [imageBuffer, whiteRect, trend, naturalHair]);

  const persist = useCallback(async () => {
    const r = adjustedResult;
    if (!r) return;
    const record = {
      axes: r.axes,
      skinLab: r.skinD65,
      hairLab: r.hairD65,
      contrast: r.contrast,
      captureCct: r.illuminant.cct,
      illuminantReliability: r.illuminant.reliability,
      naturalHair: naturalHair ?? true,
      quizAnswers: answers,
    };
    await saveProfile(record);
    const loaded = await loadProfile();
    setSavedProfile(loaded);
    notify(
      "Saved on device",
      "Only the numbers were stored (axes, Lab, contrast, CCT). Picker cache is deleted; no photo is kept."
    );
  }, [adjustedResult, answers, naturalHair]);

  // First-run consent (P1.11): explicit opt-in before any capture.
  if (consent === null) {
    return <View style={styles.root} />;
  }
  if (!consent) {
    return (
      <View style={styles.root}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={styles.home}>
          <Text style={styles.h1}>Before you begin</Text>
          <Text style={styles.p}>
            Fashi analyses your colouring entirely on this device. Nothing is uploaded, ever.
          </Text>
          <Text style={styles.consentBullet}>
            • Your photo is decoded in memory and its cache file is deleted right after measuring —
            no photo is kept.
          </Text>
          <Text style={styles.consentBullet}>
            • Only numbers are stored: axis scores, Lab values and calibration samples.
          </Text>
          <Text style={styles.consentBullet}>
            • You can delete everything at any time with “Delete all my data” on the home screen.
          </Text>
          <Text style={styles.consentBullet}>
            • Consent and data stay on this phone; uninstalling the app removes them.
          </Text>
          <Pressable
            style={styles.primary}
            onPress={() => {
              void saveConsent().then(() => setConsent(true));
            }}
          >
            <Text style={styles.primaryText}>Agree and continue</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />

      {screen === "home" && (
        <ScrollView contentContainerStyle={styles.home}>
          <Text style={styles.h1}>Fashi</Text>
          <Text style={styles.h2}>Personal colour analysis · India MVP</Text>
          <Text style={styles.p}>
            Runs entirely on this device. By taking or choosing a photo you consent to on-device
            measurement — nothing is uploaded. The photo is decoded in memory and its picker cache
            is deleted; only numbers (axes, Lab, contrast) are ever stored.
          </Text>
          <Text style={styles.p}>
            Best light: face a window in daylight, no overhead lamp, white or grey top. Holding a
            sheet of white paper beside your neck inserts a white reference that sharply improves
            accuracy (P0.3 verdict pending — synthetic data says drape-only without it). Fashi
            automatically looks for that white surface in the photo when you hold it up; if it misses
            it, capture anyway and mark the sheet yourself from the home screen.
          </Text>

          <View style={styles.hairBlock}>
            <Text style={styles.h2}>Is this your natural hair colour?</Text>
            <View style={styles.hairRow}>
              <Pressable
                style={[styles.hairOpt, naturalHair === true && styles.hairOn]}
                onPress={() => setNaturalHair(true)}
                accessibilityRole="button"
                accessibilityState={{ selected: naturalHair === true }}
                accessibilityLabel="Natural hair colour"
              >
                <Text style={[styles.hairText, naturalHair === true && styles.hairTextOn]}>
                  Natural
                </Text>
              </Pressable>
              <Pressable
                style={[styles.hairOpt, naturalHair === false && styles.hairOn]}
                onPress={() => setNaturalHair(false)}
                accessibilityRole="button"
                accessibilityState={{ selected: naturalHair === false }}
                accessibilityLabel="Dyed or coloured hair"
              >
                <Text style={[styles.hairText, naturalHair === false && styles.hairTextOn]}>
                  Dyed or coloured
                </Text>
              </Pressable>
            </View>
            {naturalHair === null && (
              <Text style={styles.caption}>
                Pick one before measuring — dyed hair changes the clarity reading, so the hair term
                would be dropped.
              </Text>
            )}
          </View>

          <View style={[styles.statusBox, trend.calibrated ? styles.statusOk : styles.statusWarn]}>
            <Text style={styles.statusTitle}>
              {trend.calibrated ? `Trend fitted on ${trend.n} captures` : "Trend not yet calibrated"}
            </Text>
            <Text style={styles.statusBody}>
              {trend.calibrated
                ? "Tone labels are enabled. Split points come from your own captures, not Western prototypes."
                : `The engine reports measurements, palette and metal, but refuses to name a tone until ${MIN_CALIBRATION_N} real calibration captures are stored (P0.5/P0.6). Currently ${trend.n}.`}
            </Text>
          </View>

          {savedProfile && (
            <View style={styles.savedCard}>
              <View style={styles.savedCardHeader}>
                <Text style={styles.savedCardEyebrow}>Your Saved Profile</Text>
                <Text style={styles.savedCardDate}>
                  {new Date(savedProfile.updatedAt).toLocaleDateString()}
                </Text>
              </View>
              {(() => {
                const pLabel = deriveLabel(savedProfile.axes, trend);
                const pMetal = metalFor(savedProfile.axes.W, trend);
                return (
                  <>
                    <Text style={styles.savedCardTriple}>
                      {pLabel.calibrated ? pLabel.triple : "Measured Profile"}
                    </Text>
                    {pLabel.calibrated && (
                      <Text style={styles.savedCardTone}>
                        {pLabel.tone.korean} · {pLabel.tone.english}
                      </Text>
                    )}
                    <Text style={styles.savedCardMetal}>
                      {pMetal === "gold" ? "✦ Gold Suits You" : pMetal === "silver" ? "✦ Silver Suits You" : "✦ Both Metals Suit You"}
                    </Text>
                  </>
                );
              })()}
              <Pressable
                style={styles.savedCardBtn}
                onPress={() => {
                  const reconstructed = resultFromStoredProfile(savedProfile, trend);
                  setResult(reconstructed);
                  setImageBuffer(null);
                  setImageUri(null);
                  setAnswers([]);
                  setQuizIndex(0);
                  setScreen("result");
                }}
              >
                <Text style={styles.savedCardBtnText}>View saved measurements & palette →</Text>
              </Pressable>
            </View>
          )}

          <Pressable
            style={styles.primary}
            onPress={takePhoto}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Take a photo"
          >
            <Text style={styles.primaryText}>Take a photo</Text>
          </Pressable>
          <Pressable
            style={styles.secondary}
            onPress={pickPhoto}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Choose an existing photo"
          >
            <Text style={styles.secondaryText}>Choose an existing photo</Text>
          </Pressable>

          {busy && (
            <View style={styles.busy}>
              <ActivityIndicator />
              <Text style={styles.busyText}>Decoding and measuring on device…</Text>
            </View>
          )}
          {error && <Text style={styles.error}>{error}</Text>}

          {imageUri && <Image source={{ uri: imageUri }} style={styles.preview} resizeMode="cover" />}

          {result && (
            <View style={styles.jump}>
              <Pressable
                style={styles.linkBtn}
                onPress={() => setScreen("gate")}
                accessibilityRole="button"
              >
                <Text style={styles.linkText}>Capture quality report</Text>
              </Pressable>
              <Pressable
                style={styles.linkBtn}
                onPress={() => setScreen("result")}
                accessibilityRole="button"
              >
                <Text style={styles.linkText}>Measurements and palette</Text>
              </Pressable>
              <Pressable
                style={styles.linkBtn}
                onPress={() => setScreen("drape")}
                accessibilityRole="button"
              >
                <Text style={styles.linkText}>Drape A/B quiz</Text>
              </Pressable>
              {imageBuffer && (
                <Pressable
                  style={styles.linkBtn}
                  onPress={() => setScreen("white")}
                  accessibilityRole="button"
                  accessibilityLabel="Mark white paper and re-measure"
                >
                  <Text style={styles.linkText}>Mark white paper and re-measure</Text>
                </Pressable>
              )}
              <Pressable
                style={styles.linkBtn}
                onPress={addToCalibration}
                accessibilityRole="button"
              >
                <Text style={styles.linkText}>Add this capture to calibration set</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.notes}>
            <Text style={styles.notesTitle}>Build status</Text>
            <Text style={styles.notesBody}>
              Colour maths, Bradford adaptation, Planckian and daylight loci, CCT/Duv, illuminant
              estimation, pixel sampling, quality gate, axes, palette region, and digital draping are
              implemented and unit-tested.
            </Text>
            <Text style={styles.notesBody}>
              Facial geometry, head pose (yaw/pitch), the sclera illuminant prior, and the clothing
              bounce check come from a pixel-based geometric estimator (src/capture/faceLandmarker.ts
              + segmentation.ts). It is not MediaPipe: the 478 mesh points are anchored from the
              measured face box, and the sclera/clothing masks are colour heuristics. Replacing it
              with the TFLite Face Landmarker + Selfie Multiclass models is still P1.2/P1.3 work.
            </Text>
            <Text style={styles.notesBody}>
              Calibration on this device: {trend.n} capture{trend.n === 1 ? "" : "s"}.
              {trend.n > 0 ? " Long-press below to clear." : ""}
            </Text>
            <Text style={styles.notesBody}>
              The bundled Monk Skin Tone baseline (calibrationData.ts) is synthetic reference data,
              so it is never fitted as your calibration: a tone name needs {MIN_CALIBRATION_N}+ real
              captures.
            </Text>
            {trend.n > 0 && (
              <Pressable
                onLongPress={async () => {
                  await clearCalibration();
                  await refitTrend();
                }}
                style={styles.reset}
              >
                <Text style={styles.resetText}>Long-press to clear calibration set</Text>
              </Pressable>
            )}
            <Pressable
              style={styles.reset}
              accessibilityRole="button"
              accessibilityLabel="Delete all my data"
              onPress={async () => {
                const ok = await confirm(
                  "Delete all stored data?",
                  "Removes saved measurements and calibration samples from this device. Photos are never stored, so there are none to delete.",
                  { confirmText: "Delete", destructive: true }
                );
                if (!ok) return;
                await clearProfile();
                setSavedProfile(null);
                await clearCalibration();
                await refitTrend();
                notify("Deleted", "All stored numbers were removed from this device.");
              }}
            >
              <Text style={styles.resetText}>Delete all my data</Text>
            </Pressable>
          </View>
        </ScrollView>
      )}

      {screen === "camera" && (
        <CameraScreen
          onCapture={async (uri) => {
            await deleteCacheFile(imageUri);
            setImageUri(uri);
            await analyse(uri);
          }}
          onCancel={() => setScreen("home")}
        />
      )}

      {screen === "gate" && result && (
        <ScrollView>
          <Back onPress={() => setScreen("home")} label="Home" />
          <GateReport gate={result.gate} />
          <View style={styles.footerBtns}>
            <Pressable style={styles.primary} onPress={() => setScreen("result")}>
              <Text style={styles.primaryText}>
                {result.gate.pass ? "See measurements" : "See measurements anyway"}
              </Text>
            </Pressable>
            {!result.gate.pass && (
              <Text style={styles.caution}>
                Values from a rejected capture are shown for debugging only. They are not a result.
              </Text>
            )}
          </View>
        </ScrollView>
      )}

      {screen === "result" && adjustedResult && (
        <ScrollView>
          <View style={styles.resultNav}>
            <Back onPress={() => setScreen("home")} label="Home" />
            {(result?.gate?.checks?.length ?? 0) > 0 && (
              <Back onPress={() => setScreen("gate")} label="Quality report" />
            )}
          </View>
          <ResultCard result={adjustedResult} trend={trend} />
          <View style={styles.footerBtns}>
            <Pressable style={styles.primary} onPress={() => setScreen("drape")}>
              <Text style={styles.primaryText}>Refine with drape A/B</Text>
            </Pressable>
            <Pressable style={styles.secondary} onPress={persist}>
              <Text style={styles.secondaryText}>Save numbers on this device</Text>
            </Pressable>
          </View>
        </ScrollView>
      )}

      {screen === "drape" && result && quiz.length > 0 && currentPair && (
        <ScrollView>
          <Back onPress={() => setScreen("result")} label="Measurements" />
          <DrapeComparison
            pair={currentPair}
            index={Math.min(quizIndex, quiz.length - 1)}
            total={quiz.length}
            selected={null}
            drapeUriA={drapeUriA}
            drapeUriB={drapeUriB}
            onSelect={(side) => {
              const pair = currentPair;
              const opt = side === "a" ? pair.a : pair.b;
              setAnswers((prev) => [...prev, { axis: pair.axis, sign: opt.sign }]);
              if (quizIndex + 1 < quiz.length) setQuizIndex(quizIndex + 1);
              else setScreen("result");
            }}
          />
          <View style={styles.footerBtns}>
            <Text style={styles.caption}>
              {answers.length} of {quiz.length} answered. Each answer nudges one axis by 0.2, so the
              quiz can resolve a borderline cell without overriding the measurement.
            </Text>
            <Pressable style={styles.secondary} onPress={() => setScreen("result")}>
              <Text style={styles.secondaryText}>Skip to result</Text>
            </Pressable>
          </View>
        </ScrollView>
      )}

      {screen === "white" && result && imageBuffer && (
        <ScrollView>
          <Back onPress={() => setScreen("home")} label="Home" />
          <View style={styles.home}>
            <Text style={styles.h1}>Mark the white paper</Text>
            <Text style={styles.p}>
              Tap the sheet of white paper in your photo. That patch is read as the scene illuminant,
              which is the single largest error term in the measurement: a marked reference outranks
              both the auto-detected surface and the sclera prior.
            </Text>

            <View style={styles.notes}>
              <Text style={styles.notesTitle}>Illuminant currently in use</Text>
              <Text style={styles.notesBody}>
                {result.illuminant.method} · {Math.round(result.illuminant.cct)} K · Duv{" "}
                {result.illuminant.duv.toFixed(3)} · reliability{" "}
                {result.illuminant.reliability.toFixed(2)}
              </Text>
            </View>

            <Pressable
              onPress={onTapPreview}
              accessibilityRole="button"
              accessibilityLabel="Tap the white paper in the photo"
              style={[styles.tapArea, { width: previewWidth, height: previewHeight }]}
            >
              {imageUri ? (
                <Image
                  source={{ uri: imageUri }}
                  style={{ width: previewWidth, height: previewHeight }}
                  resizeMode="contain"
                />
              ) : (
                <View style={{ width: previewWidth, height: previewHeight }} />
              )}
              {whiteRect && (
                <View
                  pointerEvents="none"
                  style={[
                    styles.patch,
                    {
                      left: whiteRect.x * previewWidth,
                      top: whiteRect.y * previewHeight,
                      width: whiteRect.w * previewWidth,
                      height: whiteRect.h * previewHeight,
                    },
                  ]}
                />
              )}
            </Pressable>

            <Text style={styles.caption}>
              {whiteRect
                ? checkRect(whiteRect, imageBuffer.width, imageBuffer.height).reason
                : "No patch marked yet — tap the paper in the photo above."}
            </Text>
            {whiteStatus && <Text style={styles.notesBody}>{whiteStatus}</Text>}

            <Pressable
              style={styles.primary}
              onPress={reanalyseWithWhiteRef}
              disabled={!whiteRect}
              accessibilityRole="button"
              accessibilityLabel="Re-measure with this white reference"
            >
              <Text style={styles.primaryText}>Re-measure with this reference</Text>
            </Pressable>
            <Pressable
              style={styles.secondary}
              onPress={() => setScreen("home")}
              accessibilityRole="button"
            >
              <Text style={styles.secondaryText}>Back to home</Text>
            </Pressable>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function Back({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <Pressable onPress={onPress} style={styles.back}>
      <Text style={styles.backText}>‹ {label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#FFF", paddingTop: 44, maxWidth: 640, width: "100%", alignSelf: "center" },
  home: { padding: 16, gap: 12, paddingBottom: 40 },
  h1: { fontSize: 30, fontWeight: "800", color: "#111" },
  h2: { fontSize: 15, fontWeight: "600", color: "#333" },
  p: { fontSize: 13, color: "#666", lineHeight: 19 },
  statusBox: { borderRadius: 12, padding: 14, gap: 5 },
  statusOk: { backgroundColor: "#EAF8F0" },
  statusWarn: { backgroundColor: "#FFF4E5" },
  statusTitle: { fontSize: 14, fontWeight: "700", color: "#111" },
  statusBody: { fontSize: 12, color: "#444", lineHeight: 18 },
  primary: { backgroundColor: "#111", padding: 15, borderRadius: 12, alignItems: "center" },
  primaryText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
  secondary: { borderWidth: 1.5, borderColor: "#111", padding: 13, borderRadius: 12, alignItems: "center" },
  secondaryText: { fontWeight: "700", fontSize: 13, color: "#111" },
  busy: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  busyText: { fontSize: 12, color: "#666" },
  error: { fontSize: 12, color: "#9B1C1C", backgroundColor: "#FDECEC", padding: 10, borderRadius: 8 },
  preview: { width: "100%", height: 240, borderRadius: 12, backgroundColor: "#EEE" },
  jump: { gap: 8, marginTop: 4 },
  linkBtn: { paddingVertical: 11, paddingHorizontal: 12, borderRadius: 10, backgroundColor: "#F2F2F2" },
  linkText: { fontSize: 13, fontWeight: "600", color: "#111" },
  notes: { backgroundColor: "#F6F6F6", borderRadius: 12, padding: 14, gap: 7, marginTop: 6 },
  notesTitle: { fontSize: 13, fontWeight: "700", color: "#111" },
  notesBody: { fontSize: 12, color: "#555", lineHeight: 18 },
  reset: { paddingVertical: 8 },
  resetText: { fontSize: 11, color: "#9B1C1C", fontWeight: "600" },
  hairBlock: { gap: 8, marginTop: 4 },
  hairRow: { flexDirection: "row", gap: 10 },
  hairOpt: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: "#CCC",
    borderRadius: 12,
    padding: 12,
    alignItems: "center",
  },
  hairOn: { borderColor: "#111", backgroundColor: "#F4F4F4" },
  hairText: { fontSize: 13, fontWeight: "600", color: "#777" },
  hairTextOn: { color: "#111" },
  consentBullet: { fontSize: 13, color: "#444", lineHeight: 20 },
  back: { paddingHorizontal: 16, paddingVertical: 12 },
  backText: { fontSize: 14, color: "#0A7A55", fontWeight: "700" },
  resultNav: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  savedCard: {
    backgroundColor: "#16181F",
    borderRadius: 14,
    padding: 16,
    gap: 6,
    borderWidth: 1,
    borderColor: "#2E3342",
  },
  savedCardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  savedCardEyebrow: {
    fontSize: 11,
    fontWeight: "700",
    color: "#8E95A5",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  savedCardDate: { fontSize: 11, color: "#727B8E" },
  savedCardTriple: { fontSize: 20, fontWeight: "800", color: "#FFF" },
  savedCardTone: { fontSize: 13, color: "#D0D5DD", fontWeight: "600" },
  savedCardMetal: { fontSize: 12, color: "#F0D078", fontWeight: "700", marginTop: 2 },
  savedCardBtn: {
    backgroundColor: "#FFF",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: "center",
    marginTop: 6,
  },
  savedCardBtnText: { color: "#111", fontSize: 13, fontWeight: "700" },
  footerBtns: { padding: 16, gap: 10, paddingBottom: 40 },
  caution: { fontSize: 12, color: "#8A5A00", lineHeight: 17 },
  caption: { fontSize: 12, color: "#666", lineHeight: 17 },
  tapArea: {
    position: "relative",
    alignSelf: "center",
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#EEE",
  },
  patch: {
    position: "absolute",
    borderWidth: 2,
    borderColor: "#0A7A55",
    backgroundColor: "rgba(10, 122, 85, 0.18)",
  },
});
