// P0.1 color conversions — sRGB ↔ XYZ ↔ Lab ↔ LCh + OKLab/OKLCh
// All under D65, 2° observer. Reference: CIE 15:2004, Ottosson OKLab
// Tested against ColorChecker published Lab (D65) and sRGB rounding within 1e-3

export type RGB = { r: number; g: number; b: number }; // 0-255
export type LinearRGB = { r: number; g: number; b: number }; // 0-1
export type XYZ = { X: number; Y: number; Z: number }; // 0-100 approx (Y=100 = white)
export type Lab = { L: number; a: number; b: number };
export type LCh = { L: number; C: number; h: number }; // h in degrees 0-360
export type OKLab = { L: number; a: number; b: number };
export type OKLCh = { L: number; C: number; h: number };

const Xn = 95.047, Yn = 100.0, Zn = 108.883; // D65 white point (normalized to Y=100)
const delta = 6 / 29;
const delta3 = delta * delta * delta;
const kappa = 24389 / 27; // 903.3
const eps = 216 / 24389; // 0.008856

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(255, Math.max(0, v * 255)));
}

// sRGB → linear
export function sRGBToLinear({ r, g, b }: RGB): LinearRGB {
  return { r: srgbToLinear(r), g: srgbToLinear(g), b: srgbToLinear(b) };
}
export function linearToSRGB({ r, g, b }: LinearRGB): RGB {
  return { r: linearToSrgb(r), g: linearToSrgb(g), b: linearToSrgb(b) };
}

// linear sRGB → XYZ (D65)
export function linearToXYZ({ r, g, b }: LinearRGB): XYZ {
  // IEC 61966-2-1 matrix
  return {
    X: (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) * 100,
    Y: (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) * 100,
    Z: (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) * 100,
  };
}
export function xyzToLinear({ X, Y, Z }: XYZ): LinearRGB {
  const x = X / 100, y = Y / 100, z = Z / 100;
  return {
    r: 3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    g: -0.9692660 * x + 1.8760108 * y + 0.0415560 * z,
    b: 0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  };
}

// helpers
function f(t: number): number {
  return t > eps ? Math.cbrt(t) : (kappa * t + 16) / 116;
}
function finv(t: number): number {
  const t3 = t * t * t;
  return t3 > eps ? t3 : (116 * t - 16) / kappa;
}

// XYZ → Lab
export function xyzToLab({ X, Y, Z }: XYZ): Lab {
  const fx = f(X / Xn), fy = f(Y / Yn), fz = f(Z / Zn);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}
export function labToXYZ({ L, a, b }: Lab): XYZ {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  return { X: Xn * finv(fx), Y: Yn * finv(fy), Z: Zn * finv(fz) };
}

// sRGB ↔ Lab shortcuts
export function sRGBToLab(rgb: RGB): Lab {
  return xyzToLab(linearToXYZ(sRGBToLinear(rgb)));
}
export function labToSRGB(lab: Lab): RGB {
  return linearToSRGB(xyzToLinear(labToXYZ(lab)));
}

// Lab ↔ LCh
export function labToLCh({ L, a, b }: Lab): LCh {
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  if (C < 1e-9) h = 0;
  return { L, C, h };
}
export function lchToLab({ L, C, h }: LCh): Lab {
  const rad = (h * Math.PI) / 180;
  return { L, a: C * Math.cos(rad), b: C * Math.sin(rad) };
}

// ITA° = atan((L-50)/b*)*180/π  — used for reference, not primary decision (degrades at low L*)
export function itaDegrees({ L, b }: Lab): number {
  if (Math.abs(b) < 1e-9) return L > 50 ? 90 : -90;
  return (Math.atan2(L - 50, b) * 180) / Math.PI;
}

// OKLab — Björn Ottosson 2020
// linear sRGB → OKLab
export function linearToOKLab({ r, g, b }: LinearRGB): OKLab {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}
export function okLabToLinear({ L, a, b }: OKLab): LinearRGB {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}
export function sRGBToOKLab(rgb: RGB): OKLab {
  return linearToOKLab(sRGBToLinear(rgb));
}
export function okLabToSRGB(ok: OKLab): RGB {
  return linearToSRGB(okLabToLinear(ok));
}
export function okLabToOKLCh({ L, a, b }: OKLab): OKLCh {
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  if (C < 1e-9) h = 0;
  return { L, C, h };
}
export function okLChToOKLab({ L, C, h }: OKLCh): OKLab {
  const rad = (h * Math.PI) / 180;
  return { L, a: C * Math.cos(rad), b: C * Math.sin(rad) };
}

// ΔE00 (CIEDE2000) — Sharma et al. 2005
export function deltaE00(lab1: Lab, lab2: Lab): number {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cavg = (C1 + C2) / 2;
  const Cavg7 = Math.pow(Cavg, 7);
  const G = 0.5 * (1 - Math.sqrt(Cavg7 / (Cavg7 + Math.pow(25, 7))));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const Cavgp = (C1p + C2p) / 2;
  let h1p = (Math.atan2(b1, a1p) * 180) / Math.PI;
  if (h1p < 0) h1p += 360;
  let h2p = (Math.atan2(b2, a2p) * 180) / Math.PI;
  if (h2p < 0) h2p += 360;
  // handle achromatic
  if (C1p < 1e-9) h1p = h2p;
  if (C2p < 1e-9) h2p = h1p;
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp: number;
  if (C1p < 1e-9 || C2p < 1e-9) dhp = 0;
  else {
    let d = h2p - h1p;
    if (Math.abs(d) <= 180) dhp = d;
    else dhp = d > 180 ? d - 360 : d + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);
  const Lavgp = (L1 + L2) / 2;
  let havgp: number;
  if (C1p < 1e-9 || C2p < 1e-9) havgp = h1p + h2p;
  else {
    const d = Math.abs(h1p - h2p);
    if (d <= 180) havgp = (h1p + h2p) / 2;
    else havgp = (h1p + h2p + 360) / 2 >= 360 ? (h1p + h2p + 360) / 2 - 360 : (h1p + h2p + 360) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos(((havgp - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * havgp * Math.PI) / 180) +
    0.32 * Math.cos(((3 * havgp + 6) * Math.PI) / 180) -
    0.20 * Math.cos(((4 * havgp - 63) * Math.PI) / 180);
  const SL = 1 + (0.015 * (Lavgp - 50) * (Lavgp - 50)) / Math.sqrt(20 + (Lavgp - 50) * (Lavgp - 50));
  const SC = 1 + 0.045 * Cavgp;
  const SH = 1 + 0.015 * Cavgp * T;
  const Cavgp7 = Math.pow(Cavgp, 7);
  const RC = 2 * Math.sqrt(Cavgp7 / (Cavgp7 + Math.pow(25, 7)));
  const dTheta = 30 * Math.exp(-Math.pow((havgp - 275) / 25, 2));
  const RT = -Math.sin((2 * dTheta * Math.PI) / 180) * RC;
  const kL = 1, kC = 1, kH = 1;
  return Math.sqrt(
    Math.pow(dLp / (kL * SL), 2) +
      Math.pow(dCp / (kC * SC), 2) +
      Math.pow(dHp / (kH * SH), 2) +
      RT * (dCp / (kC * SC)) * (dHp / (kH * SH))
  );
}

// palette membership helper — fuzzy AND 0..1
export function paletteMembership(
  lab: Lab,
  palette: { hueArcs: { center: number; halfwidth: number }[]; Cmin: number; Cmax: number; Lmin: number; Lmax: number; skinL: number; deltaL: number; isFaceAdjacent: boolean }
): number {
  const { C, h } = labToLCh(lab);
  // hue: max over arcs (wrap-aware), Gaussian falloff outside
  let hueScore = 0;
  if (palette.hueArcs.length === 0) hueScore = 1;
  else {
    for (const arc of palette.hueArcs) {
      let d = Math.abs(h - arc.center);
      if (d > 180) d = 360 - d;
      const s = d <= arc.halfwidth ? 1 : Math.exp(-Math.pow(d - arc.halfwidth, 2) / (2 * 15 * 15));
      hueScore = Math.max(hueScore, s);
    }
  }
  const chromaScore = C < palette.Cmin ? Math.exp(-Math.pow(C - palette.Cmin, 2) / (2 * 5 * 5)) : C > palette.Cmax ? Math.exp(-Math.pow(C - palette.Cmax, 2) / (2 * 10 * 10)) : 1;
  const lightScore = lab.L < palette.Lmin ? Math.exp(-Math.pow(lab.L - palette.Lmin, 2) / (2 * 8 * 8)) : lab.L > palette.Lmax ? Math.exp(-Math.pow(lab.L - palette.Lmax, 2) / (2 * 8 * 8)) : 1;
  const faceAdj = !palette.isFaceAdjacent || Math.abs(lab.L - palette.skinL) >= palette.deltaL ? 1 : Math.exp(-Math.pow(Math.abs(lab.L - palette.skinL) - palette.deltaL, 2) / (2 * 6 * 6));
  return hueScore * chromaScore * lightScore * faceAdj; // 0..1
}
