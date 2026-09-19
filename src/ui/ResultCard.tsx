import { View, Text, StyleSheet, ScrollView } from "react-native";
import type { AnalysisResult } from "../capture/analyze";
import type { Trend } from "../analysis/axes";
import { describeTriple } from "../analysis/axes";

type Props = {
  result: AnalysisResult;
  trend: Trend;
};

/**
 * Result card. Plan sections 1.1 and 7.
 *
 * Order is deliberate: gold vs silver first, because it is one binary the user can check against
 * jewellery they already own in thirty seconds, and a far smaller claim than a season name. The
 * descriptive triple leads over the Korean tone name because India has no existing personal-colour
 * vocabulary to lean on.
 *
 * Every swatch carries a name, a hex code and a score, and the list is ordered. Roughly one in
 * twelve men has a colour vision deficiency, so a colour product that communicates by hue alone is
 * unusable for them.
 */
export function ResultCard({ result, trend }: Props) {
  const { axes, confidence, label, swatches, metal, olive, skinD65, hairD65, illuminant, contrast } = result;

  return (
    <ScrollView contentContainerStyle={styles.card}>
      {!label.calibrated ? (
        <View style={styles.uncalibrated}>
          <Text style={styles.uncalibratedTitle}>Measurements only — no tone label yet</Text>
          <Text style={styles.uncalibratedBody}>{label.reason}</Text>
          <Text style={styles.uncalibratedBody}>
            The engine is showing what it measured. Naming a season from an unfitted trend would be a
            guess dressed up as a result.
          </Text>
        </View>
      ) : (
        <>
          <Text style={styles.eyebrow}>Your colouring</Text>
          <Text style={styles.triple}>{label.triple}</Text>
          <Text style={styles.tone}>
            {label.tone.korean} · {label.tone.english}
          </Text>
        </>
      )}

      <View style={styles.metalBox}>
        <Text style={styles.sectionTitle}>Gold or silver</Text>
        <Text style={styles.body}>
          {metal === "gold"
            ? "Gold and warm metals light you up. Silver still works away from your face."
            : metal === "silver"
              ? "Silver and white metals light you up. With gold, keep it away from your face — earrings over necklaces."
              : "Both suit you. Your undertone sits in the neutral band, so choose by outfit rather than rule."}
        </Text>
        <Text style={styles.verify}>Check it now against a piece you already own.</Text>
      </View>

      {olive && (
        <View style={styles.oliveBox}>
          <Text style={styles.sectionTitle}>Olive / neutral undertone</Text>
          <Text style={styles.body}>
            Your skin reads neutral with low chroma. Warm-versus-cool tests contradict each other on
            olive skin, so this is reported as its own outcome rather than being forced to one side.
          </Text>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>What was measured</Text>
        <Row label="Skin L*a*b*" value={fmtLab(skinD65)} />
        <Row label="Hair L*" value={Number.isFinite(hairD65.L) ? hairD65.L.toFixed(1) : "not found"} />
        <Row label="Contrast (skin − hair L*)" value={Number.isFinite(contrast) ? contrast.toFixed(1) : "—"} />
        <Row label="Warmth W" value={`${axes.W.toFixed(2)}  (conf ${pct(confidence.W)})`} />
        <Row label="Depth D" value={`${axes.D.toFixed(2)}  (conf ${pct(confidence.D)})`} />
        <Row label="Clarity C" value={`${axes.C.toFixed(2)}  (conf ${pct(confidence.C)})`} />
        <Row label="Weakest axis" value={confidence.weakest} />
        <Row
          label="Light at capture"
          value={`${Math.round(illuminant.cct)} K, Duv ${illuminant.duv.toFixed(4)} (${illuminant.method})`}
        />
        {trend.calibrated ? (
          <Row label="Calibration" value={`fitted on ${trend.n} subjects`} />
        ) : (
          <Row label="Calibration" value="not fitted" />
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Your colours</Text>
        <Text style={styles.caption}>
          Sampled from your palette region, scored by fit, ordered best first. Score is real
          membership, not a rank.
        </Text>
        {swatches.map((s) => (
          <View key={s.hex} style={styles.swatchRow}>
            <View style={[styles.swatch, { backgroundColor: s.hex }]} />
            <View style={styles.swatchText}>
              <Text style={styles.swatchName}>{s.name}</Text>
              <Text style={styles.swatchMeta}>
                {s.hex} · {s.role} · fit {s.score}
              </Text>
            </View>
          </View>
        ))}
      </View>

      <Text style={styles.footnote}>
        Processed entirely on this device. No photo is stored or uploaded; only the numbers above are
        kept, so re-calibration later updates your result without a new photo.
      </Text>
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function fmtLab(lab: { L: number; a: number; b: number }): string {
  if (!Number.isFinite(lab.L)) return "not measured";
  return `${lab.L.toFixed(1)}, ${lab.a.toFixed(1)}, ${lab.b.toFixed(1)}`;
}
function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

const styles = StyleSheet.create({
  card: { padding: 16, gap: 14, paddingBottom: 40 },
  eyebrow: { fontSize: 12, letterSpacing: 1, textTransform: "uppercase", color: "#666" },
  triple: { fontSize: 26, fontWeight: "700", color: "#111" },
  tone: { fontSize: 15, color: "#444" },
  uncalibrated: { backgroundColor: "#FFF4E5", borderRadius: 12, padding: 14, gap: 6 },
  uncalibratedTitle: { fontSize: 15, fontWeight: "700", color: "#8A5A00" },
  uncalibratedBody: { fontSize: 13, lineHeight: 19, color: "#6B4A00" },
  metalBox: { backgroundColor: "#F3F0E8", borderRadius: 12, padding: 14, gap: 6 },
  oliveBox: { backgroundColor: "#EEF3EC", borderRadius: 12, padding: 14, gap: 6 },
  section: { backgroundColor: "#F6F6F6", borderRadius: 12, padding: 14, gap: 8 },
  sectionTitle: { fontSize: 14, fontWeight: "700", color: "#111" },
  body: { fontSize: 13, lineHeight: 19, color: "#333" },
  verify: { fontSize: 12, color: "#666", fontStyle: "italic" },
  caption: { fontSize: 12, color: "#666", lineHeight: 17 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  rowLabel: { fontSize: 12, color: "#666", flexShrink: 1 },
  rowValue: { fontSize: 12, color: "#111", fontWeight: "600", textAlign: "right" },
  swatchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  swatch: { width: 46, height: 46, borderRadius: 8, borderWidth: 1, borderColor: "#DDD" },
  swatchText: { flex: 1 },
  swatchName: { fontSize: 14, fontWeight: "600", color: "#111" },
  swatchMeta: { fontSize: 11, color: "#666", marginTop: 2 },
  footnote: { fontSize: 11, color: "#888", lineHeight: 16 },
});
