import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, Image, ActivityIndicator, Alert } from "react-native";
import { StatusBar } from "expo-status-bar";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system";
import { Buffer } from "buffer";

import { analyseJpeg, type AnalysisResult } from "./src/capture/analyze";
import {
  fitTrend,
  UNCALIBRATED_TREND,
  MIN_CALIBRATION_N,
  axisConfidence,
  type Trend,
} from "./src/analysis/axes";
import { drapeQuiz, applyQuizAnswers, type DrapePair } from "./src/analysis/drape";
import { ResultCard } from "./src/ui/ResultCard";
import { DrapeComparison } from "./src/ui/DrapeComparison";
import { GateReport } from "./src/ui/GateReport";
import {
  appendCalibrationSample,
  loadCalibration,
  saveProfile,
  loadProfile,
  clearCalibration,
} from "./src/storage/profile";

type Screen = "home" | "gate" | "result" | "drape";

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [busy, setBusy] = useState(false);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [trend, setTrend] = useState<Trend>(UNCALIBRATED_TREND);
  const [answers, setAnswers] = useState<{ axis: "W" | "D" | "C"; sign: 1 | -1 }[]>([]);
  const [quizIndex, setQuizIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Refit the trend from any calibration samples already on the device.
  const refitTrend = useCallback(async () => {
    const cal = await loadCalibration();
    setTrend(fitTrend(cal.samples));
    return cal.samples.length;
  }, []);

  useEffect(() => {
    void refitTrend();
    void loadProfile();
  }, [refitTrend]);

  const analyse = useCallback(
    async (uri: string) => {
      setBusy(true);
      setError(null);
      try {
        const base64 = await FileSystem.readAsStringAsync(uri, { encoding: "base64" });
        const bytes = new Uint8Array(Buffer.from(base64, "base64"));
        const r = analyseJpeg(bytes, { trend });
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
    [trend]
  );

  const pickPhoto = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Photo access needed", "Fashi reads the photo on-device and never uploads it.");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
    if (res.canceled || !res.assets?.[0]) return;
    setImageUri(res.assets[0].uri);
    await analyse(res.assets[0].uri);
  }, [analyse]);

  const takePhoto = useCallback(async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Camera access needed", "Fashi reads the frame on-device and never uploads it.");
      return;
    }
    const res = await ImagePicker.launchCameraAsync({ quality: 1 });
    if (res.canceled || !res.assets?.[0]) return;
    setImageUri(res.assets[0].uri);
    await analyse(res.assets[0].uri);
  }, [analyse]);

  const quiz: DrapePair[] = useMemo(() => {
    if (!result) return [];
    const conf = axisConfidence(result.axes, trend, result.measurement.regionSpreadDE00);
    return drapeQuiz(result.axes, trend, conf.weakest);
  }, [result, trend]);

  const adjustedResult = useMemo(() => {
    if (!result) return null;
    if (answers.length === 0) return result;
    return { ...result, axes: applyQuizAnswers(result.axes, answers) };
  }, [result, answers]);

  const addToCalibration = useCallback(async () => {
    if (!result || !Number.isFinite(result.skinD65.L)) {
      Alert.alert("Nothing to add", "This capture produced no usable skin measurement.");
      return;
    }
    const n = await appendCalibrationSample(result.skinD65, result.hairD65);
    const fitted = await refitTrend();
    Alert.alert(
      "Added to calibration",
      `${n} subject${n === 1 ? "" : "s"} stored. ${
        fitted >= MIN_CALIBRATION_N
          ? "Trend is now fitted; tone labels are enabled."
          : `${MIN_CALIBRATION_N - fitted} more needed before tone labels are meaningful.`
      }`
    );
  }, [result, refitTrend]);

  const persist = useCallback(async () => {
    const r = adjustedResult;
    if (!r) return;
    await saveProfile({
      axes: r.axes,
      skinLab: r.skinD65,
      hairLab: r.hairD65,
      contrast: r.contrast,
      captureCct: r.illuminant.cct,
      illuminantReliability: r.illuminant.reliability,
      naturalHair: true,
      quizAnswers: answers,
    });
    Alert.alert("Saved on device", "Only the numbers were stored. No photo was written to disk.");
  }, [adjustedResult, answers]);

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />

      {screen === "home" && (
        <ScrollView contentContainerStyle={styles.home}>
          <Text style={styles.h1}>Fashi</Text>
          <Text style={styles.h2}>Personal colour analysis · India MVP</Text>
          <Text style={styles.p}>
            Runs entirely on this device. The photo is decoded in memory, measured, and discarded —
            nothing is uploaded and no image is written to storage.
          </Text>

          <View style={[styles.statusBox, trend.calibrated ? styles.statusOk : styles.statusWarn]}>
            <Text style={styles.statusTitle}>
              {trend.calibrated ? `Trend fitted on ${trend.n} subjects` : "Trend not yet calibrated"}
            </Text>
            <Text style={styles.statusBody}>
              {trend.calibrated
                ? "Tone labels are enabled. Split points come from your own calibration set, not Western prototypes."
                : `The engine will report measurements but refuse to name a tone until ${MIN_CALIBRATION_N} calibration subjects are stored (P0.5/P0.6). Currently ${trend.n}.`}
            </Text>
          </View>

          <Pressable style={styles.primary} onPress={takePhoto} disabled={busy}>
            <Text style={styles.primaryText}>Take a photo</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={pickPhoto} disabled={busy}>
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
              <Pressable style={styles.linkBtn} onPress={() => setScreen("gate")}>
                <Text style={styles.linkText}>Capture quality report</Text>
              </Pressable>
              <Pressable style={styles.linkBtn} onPress={() => setScreen("result")}>
                <Text style={styles.linkText}>Measurements and palette</Text>
              </Pressable>
              <Pressable style={styles.linkBtn} onPress={() => setScreen("drape")}>
                <Text style={styles.linkText}>Drape A/B quiz</Text>
              </Pressable>
              <Pressable style={styles.linkBtn} onPress={addToCalibration}>
                <Text style={styles.linkText}>Add this capture to calibration set</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.notes}>
            <Text style={styles.notesTitle}>Build status</Text>
            <Text style={styles.notesBody}>
              Colour maths, Bradford adaptation, Planckian and daylight loci, CCT/Duv, illuminant
              estimation, pixel sampling, quality gate, axes, palette region and drape rendering are
              implemented and unit-tested.
            </Text>
            <Text style={styles.notesBody}>
              Still stubbed: MediaPipe face landmarks and hair segmentation. Face geometry currently
              comes from a coarse skin-colour projection, so head pose is reported as not measured
              rather than passed, and neck/jaw/forehead rectangles are approximate.
            </Text>
            <Text style={styles.notesBody}>
              Calibration on this device: {trend.n} subject{trend.n === 1 ? "" : "s"}.
              {trend.n > 0 ? " " : ""}
              {trend.n > 0 ? "Long-press below to reset." : ""}
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
          </View>
        </ScrollView>
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
          <Back onPress={() => setScreen("gate")} label="Quality report" />
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

      {screen === "drape" && result && quiz.length > 0 && (
        <ScrollView>
          <Back onPress={() => setScreen("result")} label="Measurements" />
          <DrapeComparison
            pair={quiz[Math.min(quizIndex, quiz.length - 1)]}
            index={Math.min(quizIndex, quiz.length - 1)}
            total={quiz.length}
            selected={null}
            onSelect={(side) => {
              const pair = quiz[Math.min(quizIndex, quiz.length - 1)];
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
  root: { flex: 1, backgroundColor: "#FFF", paddingTop: 44 },
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
  back: { paddingHorizontal: 16, paddingVertical: 12 },
  backText: { fontSize: 14, color: "#0A7A55", fontWeight: "700" },
  footerBtns: { padding: 16, gap: 10, paddingBottom: 40 },
  caution: { fontSize: 12, color: "#8A5A00", lineHeight: 17 },
  caption: { fontSize: 12, color: "#666", lineHeight: 17 },
});
