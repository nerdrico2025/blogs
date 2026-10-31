import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import vm from "node:vm";
import { brandVars, contrastRatio, ensureReadable, shade, textOn } from "../shared/settings.ts";

// O arquivo é um script comum de navegador; aqui roda exatamente o texto que o painel carrega
const scope: {
  normalizeHex?: (value: unknown) => string | null;
  shadeHex?: (hex: string, amount: number) => string;
  textOnHex?: (...backgrounds: string[]) => string;
  readableHex?: (hex: string) => string;
} = {};
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

describe("cor do texto e versões derivadas", () => {
  const colors = ["#000000", "#ffffff", "#1363df", "#a11d33", "#ffee00", "#00ff00", "#777777", "#808080", "#e8590c", "#7a3e9d", "#b4540a", "#174c3c", "#ffcd2a", "#0b6e4f"];

  test("texto sobre o fundo: fundo escuro pede branco, fundo claro pede preto", () => {
    assert.equal(textOn("#000000"), "#ffffff");
    assert.equal(textOn("#a11d33"), "#ffffff");
    assert.equal(textOn("#ffee00"), "#000000");
    assert.equal(textOn("#ffffff"), "#000000");
  });
  test("qualquer cor tem texto com contraste suficiente (4,5:1)", () => {
    for (const c of colors) assert.ok(contrastRatio(textOn(c), c) >= 4.5, c);
  });
  test("cor clara vira um tom legível como texto; cor escura fica exata", () => {
    assert.equal(ensureReadable("#a11d33"), "#a11d33");
    assert.notEqual(ensureReadable("#ffee00"), "#ffee00");
    for (const c of colors) assert.ok(contrastRatio(ensureReadable(c), "#ffffff") >= 4.5, c);
  });
  test("a prévia do painel faz as mesmas contas do site publicado", () => {
    for (const c of colors) {
      assert.equal(scope.textOnHex!(c), textOn(c), c);
      assert.equal(scope.readableHex!(c), ensureReadable(c), c);
      assert.equal(scope.shadeHex!(c, 0.15), shade(c, 0.15), c);
      assert.equal(scope.textOnHex!(c, shade(c, 0.15)), textOn(c, shade(c, 0.15)), c);
    }
  });
  test("cor clara no tema: variáveis publicadas trocam texto e versão legível", () => {
    const vars = brandVars({ theme: { colors: { accent: "#ffee00", accentHover: "#ccbe00", calloutFrom: "#ffee00", calloutTo: "#fff133" }, highlight: "#ffee00" } } as never);
    assert.match(vars, /--cor-principal:#ffee00/);
    assert.match(vars, /--cor-principal-texto:#000000/);
    assert.match(vars, /--cor-cartao-texto:#000000/);
    assert.doesNotMatch(vars, /--cor-principal-legivel:#ffee00/);
    assert.doesNotMatch(vars, /--cor-destaque-legivel:#ffee00/);
  });
});
