import { useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import type { DrapePair } from "../analysis/drape";
import { drapeStrip } from "../analysis/drape";
import type { RGB } from "../color/convert";
import { PhotoDrape } from "./PhotoDrape";

type Props = {
  pair: DrapePair;
  index: number;
  total: number;
  selected: "a" | "b" | null;
  onSelect: (side: "a" | "b") => void;
  drapeUriA?: string | null;
  drapeUriB?: string | null;
};

/**
 * Drape A/B. Plan section 7.2.
 *
 * Supports both photo-based digital draping on the user's actual photo
 * and keep-L* fabric fold strips.
 */
export function DrapeComparison({
  pair,
  index,
  total,
  selected,
  onSelect,
  drapeUriA,
  drapeUriB,
}: Props) {
  const hasPhotoDrapes = Boolean(drapeUriA && drapeUriB);
  const [viewMode, setViewMode] = useState<"photo" | "strip">(hasPhotoDrapes ? "photo" : "strip");

  return (
    <View style={styles.wrap}>
      <View style={styles.topBar}>
        <Text style={styles.counter}>
          Question {index + 1} of {total} · testing {axisName(pair.axis)}
        </Text>

        {hasPhotoDrapes && (
          <View style={styles.modeTabs}>
            <Pressable
              style={[styles.modeTab, viewMode === "photo" && styles.modeTabActive]}
              onPress={() => setViewMode("photo")}
            >
              <Text style={[styles.modeTabText, viewMode === "photo" && styles.modeTabTextActive]}>
                Photo drape
              </Text>
            </Pressable>
            <Pressable
              style={[styles.modeTab, viewMode === "strip" && styles.modeTabActive]}
              onPress={() => setViewMode("strip")}
            >
              <Text style={[styles.modeTabText, viewMode === "strip" && styles.modeTabTextActive]}>
                Fabric strips
              </Text>
            </Pressable>
          </View>
        )}
      </View>

      <Text style={styles.prompt}>{pair.prompt}</Text>

      {viewMode === "photo" && hasPhotoDrapes ? (
        <PhotoDrape
          drapeUriA={drapeUriA ?? null}
          drapeUriB={drapeUriB ?? null}
          nameA={pair.a.name}
          nameB={pair.b.name}
          rgbA={pair.a.rgb}
          rgbB={pair.b.rgb}
          selected={selected}
          onSelect={onSelect}
        />
      ) : (
        <View style={styles.row}>
          <Side option={pair.a} picked={selected === "a"} onPress={() => onSelect("a")} />
          <Side option={pair.b} picked={selected === "b"} onPress={() => onSelect("b")} />
        </View>
      )}

      <Text style={styles.hint}>
        Look at your jawline and under-eye area, not the colour itself. The better one makes skin look
        clearer and more even.
      </Text>
    </View>
  );
}

function Side({
  option,
  picked,
  onPress,
}: {
  option: { rgb: RGB; name: string };
  picked: boolean;
  onPress: () => void;
}) {
  const strip = drapeStrip(option.rgb, 20);
  return (
    <Pressable
      onPress={onPress}
      style={[styles.card, picked && styles.picked]}
      accessibilityRole="radio"
      accessibilityState={{ selected: picked }}
    >
      <View style={styles.fabric}>
        {strip.map((c, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: `rgb(${c.r},${c.g},${c.b})` }} />
        ))}
      </View>
      <Text style={styles.name}>{option.name}</Text>
      <Text style={styles.hex}>{hex(option.rgb)}</Text>
      <Text style={[styles.state, picked && styles.stateOn]}>
        {picked ? "Selected" : "Tap to choose"}
      </Text>
    </Pressable>
  );
}

function hex(c: RGB): string {
  const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
}

function axisName(a: "W" | "D" | "C"): string {
  return a === "W" ? "warm vs cool" : a === "D" ? "light vs deep" : "bright vs muted";
}

const styles = StyleSheet.create({
  wrap: { padding: 16, gap: 12 },
  topBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  counter: { fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase", color: "#777" },
  modeTabs: {
    flexDirection: "row",
    backgroundColor: "#EFEFEF",
    borderRadius: 8,
    padding: 2,
  },
  modeTab: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  modeTabActive: {
    backgroundColor: "#FFFFFF",
  },
  modeTabText: {
    fontSize: 10,
    fontWeight: "600",
    color: "#666",
  },
  modeTabTextActive: {
    color: "#111",
    fontWeight: "800",
  },
  prompt: { fontSize: 17, fontWeight: "700", color: "#111", lineHeight: 23 },
  row: { flexDirection: "row", gap: 12 },
  card: {
    flex: 1,
    borderWidth: 2,
    borderColor: "#DDD",
    borderRadius: 14,
    padding: 10,
    gap: 6,
    alignItems: "center",
  },
  picked: { borderColor: "#0A7A55", backgroundColor: "#F0FBF6" },
  fabric: { width: "100%", height: 150, borderRadius: 10, overflow: "hidden", flexDirection: "column" },
  name: { fontSize: 14, fontWeight: "600", color: "#111" },
  hex: { fontSize: 11, color: "#666" },
  state: { fontSize: 11, color: "#888" },
  stateOn: { color: "#0A7A55", fontWeight: "700" },
  hint: { fontSize: 12, color: "#666", lineHeight: 17 },
});
