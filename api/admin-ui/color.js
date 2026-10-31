"use strict";
/** Aceita com ou sem "#", maiúsculas ou minúsculas e 3 ou 6 dígitos. Devolve #RRGGBB em maiúsculas, ou null se inválido. */
function normalizeHex(value) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? "").trim());
  if (!match) return null;
  const digits = match[1].length === 3 ? [...match[1]].map((d) => d + d).join("") : match[1];
  return `#${digits.toUpperCase()}`;
}
