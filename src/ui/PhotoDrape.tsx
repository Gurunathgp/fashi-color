// Photo-based Digital Drape Component. Plan section 7.2 and P1.8.
//
// Composites the drape color onto the user's actual photo below the chin,
// keeping original L* so real fabric folds and shading survive.
// Displays Option A and Option B side-by-side with identical crop.

import { View, Text, StyleSheet, Pressable, Image } from "react-native";
import type { RGB } from "../color/convert";

type Props = {
  drapeUriA: string | null;
  drapeUriB: string | null;
  nameA: string;
  nameB: string;
  rgbA: RGB;
  rgbB: RGB;
  selected: "a" | "b" | null;
  onSelect: (side: "a" | "b") => void;
};

export function PhotoDrape({
  drapeUriA,
  drapeUriB,
  nameA,
  nameB,
  rgbA,
  rgbB,
  selected,
  onSelect,
}: Props) {
  const hex = (c: RGB) => {
    const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
    return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
  };

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {/* Option A */}
        <Pressable
          style={[styles.card, selected === "a" && styles.cardSelected]}
          onPress={() => onSelect("a")}
          accessibilityRole="radio"
          accessibilityState={{ selected: selected === "a" }}
        >
          <View style={styles.imageWrap}>
            {drapeUriA ? (
              <Image source={{ uri: drapeUriA }} style={styles.photo} resizeMode="cover" />
            ) : (
              <View style={[styles.fallbackFabric, { backgroundColor: `rgb(${rgbA.r},${rgbA.g},${rgbA.b})` }]} />
            )}
            <View style={[styles.colorIndicator, { backgroundColor: `rgb(${rgbA.r},${rgbA.g},${rgbA.b})` }]} />
          </View>
          <View style={styles.info}>
            <Text style={styles.name}>{nameA}</Text>
            <Text style={styles.hex}>{hex(rgbA)}</Text>
            <Text style={[styles.status, selected === "a" && styles.statusActive]}>
              {selected === "a" ? "✓ Selected" : "Tap to choose"}
            </Text>
          </View>
        </Pressable>

        {/* Option B */}
        <Pressable
          style={[styles.card, selected === "b" && styles.cardSelected]}
          onPress={() => onSelect("b")}
          accessibilityRole="radio"
          accessibilityState={{ selected: selected === "b" }}
        >
          <View style={styles.imageWrap}>
            {drapeUriB ? (
              <Image source={{ uri: drapeUriB }} style={styles.photo} resizeMode="cover" />
            ) : (
              <View style={[styles.fallbackFabric, { backgroundColor: `rgb(${rgbB.r},${rgbB.g},${rgbB.b})` }]} />
            )}
            <View style={[styles.colorIndicator, { backgroundColor: `rgb(${rgbB.r},${rgbB.g},${rgbB.b})` }]} />
          </View>
          <View style={styles.info}>
            <Text style={styles.name}>{nameB}</Text>
            <Text style={styles.hex}>{hex(rgbB)}</Text>
            <Text style={[styles.status, selected === "b" && styles.statusActive]}>
              {selected === "b" ? "✓ Selected" : "Tap to choose"}
            </Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  row: {
    flexDirection: "row",
    gap: 12,
  },
  card: {
    flex: 1,
    borderWidth: 2,
    borderColor: "#E2E5EB",
    borderRadius: 14,
    padding: 8,
    gap: 8,
    alignItems: "center",
    backgroundColor: "#FAFAFA",
  },
  cardSelected: {
    borderColor: "#0A7A55",
    backgroundColor: "#F0FBF6",
  },
  imageWrap: {
    width: "100%",
    height: 180,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#EAEAEA",
    position: "relative",
  },
  photo: {
    width: "100%",
    height: "100%",
  },
  fallbackFabric: {
    width: "100%",
    height: "100%",
  },
  colorIndicator: {
    position: "absolute",
    bottom: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "#FFFFFF",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3,
    elevation: 3,
  },
  info: {
    alignItems: "center",
    gap: 2,
  },
  name: {
    fontSize: 13,
    fontWeight: "700",
    color: "#111",
  },
  hex: {
    fontSize: 11,
    color: "#666",
    fontFamily: "monospace",
  },
  status: {
    fontSize: 11,
    color: "#888",
    marginTop: 2,
  },
  statusActive: {
    color: "#0A7A55",
    fontWeight: "800",
  },
});
