import { View, Text, StyleSheet } from "react-native";
import type { GateResult, GateCheck } from "../capture/qualityGate";

/**
 * Quality gate report. Plan section 5.
 *
 * Shows skipped checks explicitly rather than folding them into a pass. A gate that could not
 * measure something must not imply the photo was verified on that point.
 */
export function GateReport({ gate }: { gate: GateResult }) {
  const order: GateCheck[] = [...gate.failures, ...gate.warnings, ...gate.skipped, ...gate.checks.filter((c) => c.status === "pass")];
  const seen = new Set<string>();
  const rows = order.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));

  return (
    <View style={styles.wrap}>
      <View style={[styles.banner, gate.pass ? styles.bannerOk : styles.bannerBad]}>
        <Text style={[styles.bannerText, gate.pass ? styles.bannerTextOk : styles.bannerTextBad]}>
          {gate.pass ? "Capture accepted" : "Capture not usable"}
        </Text>
        <Text style={styles.bannerSub}>{gate.summary}</Text>
      </View>

      <Text style={styles.counts}>
        {gate.failures.length} failed · {gate.warnings.length} warning · {gate.skipped.length} not measured ·{" "}
        {gate.checks.filter((c) => c.status === "pass").length} passed
      </Text>

      {rows.map((c) => (
        <View key={c.id} style={styles.row}>
          <Text style={[styles.badge, badgeStyle(c.status)]}>{badgeText(c.status)}</Text>
          <View style={styles.rowBody}>
            <Text style={styles.label}>{c.label}</Text>
            {c.message ? <Text style={styles.msg}>{c.message}</Text> : null}
            <Text style={styles.meta}>
              {c.threshold ?? ""}
              {c.value !== undefined && Number.isFinite(c.value) ? `  ·  measured ${round(c.value)}` : ""}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function round(v: number): string {
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4);
}
function badgeText(s: GateCheck["status"]): string {
  return s === "pass" ? "PASS" : s === "fail" ? "FAIL" : s === "warn" ? "WARN" : "N/A";
}
function badgeStyle(s: GateCheck["status"]) {
  return s === "pass" ? styles.badgePass : s === "fail" ? styles.badgeFail : s === "warn" ? styles.badgeWarn : styles.badgeSkip;
}

const styles = StyleSheet.create({
  wrap: { padding: 16, gap: 10 },
  banner: { borderRadius: 12, padding: 14, gap: 4 },
  bannerOk: { backgroundColor: "#EAF8F0" },
  bannerBad: { backgroundColor: "#FDECEC" },
  bannerText: { fontSize: 16, fontWeight: "700" },
  bannerTextOk: { color: "#0A7A55" },
  bannerTextBad: { color: "#9B1C1C" },
  bannerSub: { fontSize: 13, color: "#444", lineHeight: 18 },
  counts: { fontSize: 12, color: "#666" },
  row: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  badge: { fontSize: 10, fontWeight: "800", paddingHorizontal: 6, paddingVertical: 3, borderRadius: 5, overflow: "hidden", minWidth: 42, textAlign: "center" },
  badgePass: { backgroundColor: "#E4F5EB", color: "#0A7A55" },
  badgeFail: { backgroundColor: "#FBE3E3", color: "#9B1C1C" },
  badgeWarn: { backgroundColor: "#FFF3DA", color: "#8A5A00" },
  badgeSkip: { backgroundColor: "#ECECEC", color: "#555" },
  rowBody: { flex: 1, gap: 2 },
  label: { fontSize: 13, fontWeight: "600", color: "#111" },
  msg: { fontSize: 12, color: "#444", lineHeight: 17 },
  meta: { fontSize: 10, color: "#888" },
});
