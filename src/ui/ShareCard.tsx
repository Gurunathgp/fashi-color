// Visual Shareable Result Card. Plan section 1.1, 7, and P1.10.
//
// Korean personal-color certificate aesthetic:
//   - Self-explanatory descriptive triple (Warm · Deep · Muted)
//   - Korean 8-tone bilingual classification (가을웜 딥 · Autumn Warm Deep)
//   - Metal recommendation emblem (Gold / Silver / Both)
//   - Olive/Neutral indicator
//   - Top 6 curated palette swatches with CVD-safe names, hex codes, and roles
//   - Privacy verified badge ("100% On-Device · Photo Never Uploaded")

import { useState } from "react";
import { View, Text, StyleSheet, Pressable, Modal } from "react-native";
import type { AnalysisResult } from "../capture/analyze";
import type { Trend } from "../analysis/axes";
// Share text is built in one place (src/ui/share.ts) so the wording is unit-tested, and the
// web path degrades to the clipboard instead of a rejected navigator.share.
import { buildShareCardText, shareText, describeShareOutcome, SHARE_TITLES } from "./share";

type Props = {
  result: AnalysisResult;
  trend: Trend;
  visible: boolean;
  onClose: () => void;
};

export function ShareCard({ result, trend, visible, onClose }: Props) {
  const { axes, label, swatches, metal, olive, skinD65, contrast, illuminant } = result;
  // Outcome of the last share attempt, so the card never claims a share that did not happen.
  const [shareNote, setShareNote] = useState<string | null>(null);

  const triple = label.calibrated ? label.triple : "Measured";
  const toneKorean = label.calibrated ? label.tone.korean : "분석 완료";
  const toneEnglish = label.calibrated ? label.tone.english : "Tone Measured";

  const handleShare = async () => {
    const outcome = await shareText(SHARE_TITLES.card, buildShareCardText(result));
    setShareNote(describeShareOutcome(outcome));
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.cardContainer}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.brandTitle}>F A S H I</Text>
            <Text style={styles.brandSubtitle}>PERSONAL COLOUR INTELLIGENCE · INDIA</Text>
          </View>

          {/* Hero Tone */}
          <View style={styles.heroBox}>
            <Text style={styles.triple}>{triple}</Text>
            <Text style={styles.tone}>
              {toneKorean} <Text style={styles.toneEn}>· {toneEnglish}</Text>
            </Text>
          </View>

          {/* Badges Row */}
          <View style={styles.badgeRow}>
            <View style={[styles.metalBadge, metal === "gold" ? styles.goldBadge : styles.silverBadge]}>
              <Text style={[styles.badgeText, metal === "gold" ? styles.goldText : styles.silverText]}>
                {metal === "gold" ? "✦ WEAR GOLD" : metal === "silver" ? "✦ WEAR SILVER" : "✦ GOLD & SILVER"}
              </Text>
            </View>

            {olive && (
              <View style={styles.oliveBadge}>
                <Text style={styles.oliveText}>✦ OLIVE UNDERTONE</Text>
              </View>
            )}
          </View>

          {/* Top Swatches Grid */}
          <View style={styles.swatchSection}>
            <Text style={styles.swatchSectionTitle}>YOUR SIGNATURE PALETTE</Text>
            <View style={styles.swatchGrid}>
              {swatches.slice(0, 6).map((s) => (
                <View key={s.hex} style={styles.swatchItem}>
                  <View style={[styles.swatchPreview, { backgroundColor: s.hex }]} />
                  <Text style={styles.swatchName} numberOfLines={1}>
                    {s.name}
                  </Text>
                  <Text style={styles.swatchHex}>{s.hex}</Text>
                </View>
              ))}
            </View>
          </View>

          {/* Colorimetric Details */}
          <View style={styles.metricsBox}>
            <View style={styles.metricItem}>
              <Text style={styles.metricLabel}>SKIN L*a*b*</Text>
              <Text style={styles.metricValue}>
                {skinD65.L.toFixed(0)}, {skinD65.a.toFixed(0)}, {skinD65.b.toFixed(0)}
              </Text>
            </View>
            <View style={styles.metricDivider} />
            <View style={styles.metricItem}>
              <Text style={styles.metricLabel}>CONTRAST</Text>
              <Text style={styles.metricValue}>{contrast.toFixed(1)} ΔL*</Text>
            </View>
            <View style={styles.metricDivider} />
            <View style={styles.metricItem}>
              <Text style={styles.metricLabel}>WARMTH W</Text>
              <Text style={styles.metricValue}>{axes.W > 0 ? `+${axes.W.toFixed(2)}` : axes.W.toFixed(2)}</Text>
            </View>
          </View>

          {/* Privacy Seal */}
          <View style={styles.privacySeal}>
            <Text style={styles.privacyText}>🔒 100% ON-DEVICE · PRIVACY VERIFIED · NEVER UPLOADED</Text>
          </View>

          {/* Actions */}
          <View style={styles.actionRow}>
            <Pressable
              style={styles.shareBtn}
              onPress={handleShare}
              accessibilityRole="button"
              accessibilityLabel="Share card"
            >
              <Text style={styles.shareBtnText}>Share card</Text>
            </Pressable>
            <Pressable
              style={styles.closeBtn}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Done"
            >
              <Text style={styles.closeBtnText}>Done</Text>
            </Pressable>
          </View>
          {shareNote && (
            <Text style={styles.shareNote} accessibilityLiveRegion="polite">
              {shareNote}
            </Text>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  cardContainer: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: "#14161A",
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "#2A2E38",
    padding: 24,
    gap: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
  },
  header: {
    alignItems: "center",
    gap: 3,
    borderBottomWidth: 1,
    borderBottomColor: "#222731",
    paddingBottom: 14,
  },
  brandTitle: {
    fontSize: 16,
    fontWeight: "900",
    letterSpacing: 4,
    color: "#FFFFFF",
  },
  brandSubtitle: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.2,
    color: "#8E95A5",
  },
  heroBox: {
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
  },
  triple: {
    fontSize: 26,
    fontWeight: "900",
    color: "#FFFFFF",
    letterSpacing: -0.5,
    textAlign: "center",
  },
  tone: {
    fontSize: 15,
    fontWeight: "700",
    color: "#D0D5DD",
  },
  toneEn: {
    fontWeight: "400",
    color: "#98A2B3",
  },
  badgeRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
  },
  metalBadge: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  goldBadge: {
    backgroundColor: "#2B2414",
    borderColor: "#8A6D27",
  },
  silverBadge: {
    backgroundColor: "#1F2329",
    borderColor: "#4B5565",
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  goldText: { color: "#F0D078" },
  silverText: { color: "#E0E4EB" },
  oliveBadge: {
    backgroundColor: "#1D2821",
    borderColor: "#3E664B",
    borderWidth: 1,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  oliveText: {
    color: "#78D49E",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  swatchSection: {
    gap: 10,
    backgroundColor: "#1B1E26",
    borderRadius: 14,
    padding: 14,
  },
  swatchSectionTitle: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
    color: "#7E8799",
  },
  swatchGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 10,
  },
  swatchItem: {
    width: "31%",
    gap: 4,
  },
  swatchPreview: {
    width: "100%",
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
  },
  swatchName: {
    fontSize: 11,
    fontWeight: "700",
    color: "#E2E5EB",
  },
  swatchHex: {
    fontSize: 10,
    color: "#838B9C",
    fontFamily: "monospace",
  },
  metricsBox: {
    flexDirection: "row",
    backgroundColor: "#1B1E26",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    justifyContent: "space-around",
    alignItems: "center",
  },
  metricItem: {
    alignItems: "center",
    gap: 2,
  },
  metricDivider: {
    width: 1,
    height: 24,
    backgroundColor: "#2C313E",
  },
  metricLabel: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.5,
    color: "#727B8E",
  },
  metricValue: {
    fontSize: 12,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  privacySeal: {
    alignItems: "center",
  },
  privacyText: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.5,
    color: "#0A9968",
  },
  actionRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  shareBtn: {
    flex: 2,
    backgroundColor: "#FFFFFF",
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
  },
  shareBtnText: {
    color: "#111",
    fontSize: 14,
    fontWeight: "800",
  },
  closeBtn: {
    flex: 1,
    backgroundColor: "#252A36",
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
  },
  closeBtnText: {
    color: "#E2E5EB",
    fontSize: 14,
    fontWeight: "700",
  },
  shareNote: {
    fontSize: 12,
    color: "#9AA4B8",
    textAlign: "center",
  },
});
