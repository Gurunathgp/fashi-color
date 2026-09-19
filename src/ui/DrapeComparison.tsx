import { View, Text, StyleSheet, Pressable } from "react-native";
import type { DrapePair } from "../analysis/drape";
import { drapeStrip } from "../analysis/drape";
import type { RGB } from "../color/convert";

type Props = {
  pair: DrapePair;
  index: number;
  total: number;
  selected: "a" | "b" | null;
  onSelect: (side: "a" | "b") => void;
};

/**
 * Drape A/B. Plan section 7.2.
 *
 * The strips are rendered through the keep-L* recolouring path rather than as flat fills, so folds
 * and shading survive and the comparison reads as fabric. Absolute on-screen colour is unreliable
 * on cheap panels, but both sides share one screen and one illuminant, which is all a preference
 * judgement needs.
 */
export function DrapeComparison({ pair, index, total, selected, onSelect }: Props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.counter}>
        Question {index + 1} of {total} · testing {axisName(pair.axis)}
      </Text>
      <Text style={styles.prompt}>{pair.prompt}</Text>

      <View style={styles.row}>
        <Side option={pair.a} picked={selected === "a"} onPress={() => onSelect("a")} />
        <Side option={pair.b} picked={selected === "b"} onPress={() => onSelect("b")} />
      </View>

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
    <Pressable onPress={onPress} style={[styles.card, picked && styles.picked]} accessibilityRole="radio" accessibilityState={{ selected: picked }}>
      <View style={styles.fabric}>
        {strip.map((c, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: `rgb(${c.r},${c.g},${c.b})` }} />
        ))}
      </View>
      <Text style={styles.name}>{option.name}</Text>
      <Text style={styles.hex}>{hex(option.rgb)}</Text>
      <Text style={[styles.state, picked && styles.stateOn]}>{picked ? "Selected" : "Tap to choose"}</Text>
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
  wrap: { padding: 16, gap: 10 },
  counter: { fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase", color: "#777" },
  prompt: { fontSize: 17, fontWeight: "700", color: "#111", lineHeight: 23 },
  row: { flexDirection: "row", gap: 12 },
  card: { flex: 1, borderWidth: 2, borderColor: "#DDD", borderRadius: 14, padding: 10, gap: 6, alignItems: "center" },
  picked: { borderColor: "#0A7A55", backgroundColor: "#F0FBF6" },
  fabric: { width: "100%", height: 150, borderRadius: 10, overflow: "hidden", flexDirection: "column" },
  name: { fontSize: 14, fontWeight: "600", color: "#111" },
  hex: { fontSize: 11, color: "#666" },
  state: { fontSize: 11, color: "#888" },
  stateOn: { color: "#0A7A55", fontWeight: "700" },
  hint: { fontSize: 12, color: "#666", lineHeight: 17 },
});
