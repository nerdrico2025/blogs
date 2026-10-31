"use strict";
/** Aceita com ou sem "#", maiúsculas ou minúsculas e 3 ou 6 dígitos. Devolve #RRGGBB em maiúsculas, ou null se inválido. */
function normalizeHex(value) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? "").trim());
  if (!match) return null;
  const digits = match[1].length === 3 ? [...match[1]].map((d) => d + d).join("") : match[1];
  return `#${digits.toUpperCase()}`;
}

/* Mesmas contas de shared/settings.ts (brandVars), para a prévia mostrar o que será publicado. */
const hexChannels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hexFromChannels = (rgb) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
function shadeHex(hex, amount) {
  return hexFromChannels(hexChannels(hex).map((v) => (amount > 0 ? v + (255 - v) * amount : v * (1 + amount))));
}
function hexContrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = hexChannels(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Texto branco ou preto, o de maior contraste no pior dos fundos. */
function textOnHex(...backgrounds) {
  const worst = (text) => Math.min(...backgrounds.map((bg) => hexContrast(text, bg)));
  return worst("#ffffff") >= worst("#000000") ? "#ffffff" : "#000000";
}
function mixHex(from, to, amount) {
  const [a, b] = [hexChannels(from), hexChannels(to)];
  return hexFromChannels(a.map((v, i) => v + (b[i] - v) * amount));
}
/** Texto, hover e borda do cabeçalho. */
function headerColorsHex(background) {
  const text = textOnHex(background);
  const away = text === "#ffffff" ? "#000000" : "#ffffff";
  return { text, hover: mixHex(background, hexContrast(text, background) >= 7 ? text : away, 0.16), border: mixHex(background, text, 0.15) };
}
/** A cor como texto sobre fundo claro: escurece até 4,5:1. */
function readableHex(hex) {
  let c = hex;
  for (let i = 0; i < 40 && hexContrast(c, "#ffffff") < 4.5; i++) c = shadeHex(c, -0.05);
  return c;
}
