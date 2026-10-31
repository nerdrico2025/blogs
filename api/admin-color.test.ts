import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import vm from "node:vm";

// O arquivo é um script comum de navegador; aqui roda exatamente o texto que o painel carrega
const scope: { normalizeHex?: (value: unknown) => string | null } = {};
vm.runInNewContext(readFileSync(new URL("./admin-ui/color.js", import.meta.url), "utf8"), scope);
const normalizeHex = scope.normalizeHex!;

describe("normalização do código de cor", () => {
  const valid: [string, string][] = [
    ["#1E5AA8", "#1E5AA8"],
    ["1E5AA8", "#1E5AA8"],
    ["#1e5aa8", "#1E5AA8"],
    ["1e5aa8", "#1E5AA8"],
    ["#FA0", "#FFAA00"],
    ["FA0", "#FFAA00"],
    ["#fa0", "#FFAA00"],
    ["fa0", "#FFAA00"],
    ["  #1e5aa8\n", "#1E5AA8"],
  ];
  for (const [input, expected] of valid) test(`${JSON.stringify(input)} vira ${expected}`, () => assert.equal(normalizeHex(input), expected));

  for (const input of ["", "   ", "#", "#12", "#1234", "#12345", "#1234567", "##123456", "#GGGGGG", "azul", "#12 345", "rgb(0,0,0)"]) {
    test(`${JSON.stringify(input)} é inválido`, () => assert.equal(normalizeHex(input), null));
  }
  test("valor que não é texto é inválido", () => {
    assert.equal(normalizeHex(undefined), null);
    assert.equal(normalizeHex(null), null);
  });
});
