"use strict";
const $ = (id) => document.getElementById(id);
const LABELS = { header: "Topo do site", beforeContent: "Antes do conteúdo", inContent: "Dentro do conteúdo", afterContent: "Depois do conteúdo", sidebarTop: "Lateral, no topo", sidebarBottom: "Lateral, no fim", footer: "Rodapé", mobileSticky: "Banner fixo no celular" };
const BUILD = { idle: "publicado", waiting: "na fila", "waiting-slot": "aguardando vaga (outros blogs publicando)", building: "publicando agora" };
const SCREENS = [
  ["Conteúdo", [["artigos", "Artigos"], ["categorias", "Categorias"], ["autor", "Autor"]]],
  ["Aparência", [["marca", "Marca"], ["home", "Home"]]],
  ["Monetização e dados", [["anuncios", "Anúncios"], ["rastreamento", "Rastreamento"]]],
  ["Integração", [["wordbee", "Wordbee"]]],
];
const SCREEN_NAMES = Object.fromEntries(SCREENS.flatMap(([, list]) => list));
const DEFAULT_SCREEN = "artigos";
let state = null;
let screen = DEFAULT_SCREEN;

async function api(url, options = {}) {
  const res = await fetch(url, { credentials: "same-origin", ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || "Algo deu errado. Tente de novo.");
    err.status = res.status;
    throw err;
  }
  return body;
}
const post = (url, data) => api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

function show(el, text, kind) {
  el.replaceChildren();
  const list = Array.isArray(text) ? text : [text];
  for (const t of list) {
    const d = document.createElement("div");
    d.className = `msg ${kind}`;
    d.textContent = t;
    el.append(d);
  }
}

function field(parent, label, input, hint) {
  const wrap = document.createElement("div");
  const l = document.createElement("label");
  l.textContent = label;
  l.append(document.createElement("br"), input);
  wrap.append(l);
  if (hint) {
    const h = document.createElement("p");
    h.className = "hint";
    h.textContent = hint;
    wrap.append(h);
  }
  parent.append(wrap);
  return input;
}
function make(tag, props = {}) {
  return Object.assign(document.createElement(tag), props);
}
function checks(parent, title, options, selected, name) {
  const box = make("div");
  box.append(make("label", { textContent: title }));
  for (const [value, text] of options) {
    const l = make("label", { className: "inline" });
    const c = make("input", { type: "checkbox", value, checked: selected.includes(value) });
    c.dataset.group = name;
    l.append(c, text);
    box.append(l);
  }
  parent.append(box);
}
const checked = (root, name) => [...root.querySelectorAll(`input[data-group="${name}"]:checked`)].map((c) => c.value);

/** Seção recolhível: lembra aberta ou fechada neste navegador. */
function remember(details, key) {
  try {
    const saved = localStorage.getItem(`admin:sec:${key}`);
    if (saved !== null) details.open = saved === "1";
  } catch {}
  details.addEventListener("toggle", () => {
    try {
      localStorage.setItem(`admin:sec:${key}`, details.open ? "1" : "0");
    } catch {}
  });
}
for (const d of document.querySelectorAll("details[data-sec]")) remember(d, d.dataset.sec);
/** Campo com problema dentro de seção fechada: abre, para o navegador conseguir apontar para ele. */
function openAround(el) {
  for (let d = el.closest("details"); d; d = d.parentElement.closest("details")) d.open = true;
}
document.addEventListener("invalid", (e) => openAround(e.target), true);

/* Alterações não salvas: compara o formulário com o que veio do servidor, então desfazer à mão também limpa o aviso. */
const FORMS = () => [...document.querySelectorAll("#content form[data-tab]")];
const snapshot = (form) => JSON.stringify([...form.elements].filter((el) => ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) && el.type !== "file").map((el) => (el.type === "checkbox" ? el.checked : el.value)));
const baseline = new Map();
function markSaved() {
  for (const form of FORMS()) baseline.set(form, snapshot(form));
  updateDirty();
}
const isDirty = (form) => baseline.has(form) && baseline.get(form) !== snapshot(form);
const anyDirty = () => FORMS().some(isDirty);
function updateDirty() {
  const form = currentForm();
  $("dirty").textContent = form && isDirty(form) ? "Você tem alterações não salvas" : "";
}
const currentForm = () => document.querySelector(`#content form[data-tab="${SCREEN_NAMES[screen]}"]`);
for (const form of FORMS()) for (const type of ["input", "change", "click"]) form.addEventListener(type, () => setTimeout(updateDirty));
/** Sair da tela com alterações: pergunta, e quem desiste de salvar volta ao que está gravado. */
function confirmLeave() {
  if (!anyDirty()) return true;
  if (!confirm("Você tem alterações não salvas. Sair sem salvar?")) return false;
  fill();
  markSaved();
  return true;
}
window.addEventListener("beforeunload", (e) => {
  if (anyDirty()) e.preventDefault();
});

function renderNav() {
  const nav = $("tabs");
  nav.replaceChildren();
  for (const [group, list] of SCREENS) {
    const box = make("div", { className: "nav-group" });
    const title = make("p", { className: "nav-title", textContent: group });
    const ul = make("ul");
    for (const [slug, name] of list) {
      const a = make("a", { href: `/admin/${slug}`, textContent: name });
      a.dataset.slug = slug;
      a.onclick = (e) => {
        // Ctrl/Cmd+clique continua abrindo em outra aba
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        openMenu(false);
        if (slug === screen || !confirmLeave()) return;
        history.pushState(null, "", `/admin/${slug}`);
        showScreen(slug, true);
      };
      const li = make("li");
      li.append(a);
      ul.append(li);
    }
    box.append(title, ul);
    nav.append(box);
  }
}
function screenFromUrl() {
  const slug = location.pathname.replace(/^\/admin\/?/, "").replace(/\/$/, "");
  return SCREEN_NAMES[slug] ? slug : DEFAULT_SCREEN;
}
function showScreen(slug, focus) {
  screen = slug;
  const name = SCREEN_NAMES[slug];
  for (const sec of document.querySelectorAll("[data-tab]")) sec.hidden = sec.dataset.tab !== name;
  for (const a of document.querySelectorAll("#tabs a")) {
    if (a.dataset.slug === slug) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  $("screen-title").textContent = name;
  $("menu-btn").textContent = `Menu: ${name}`;
  document.title = `${name} | Painel do blog`;
  const form = currentForm();
  $("save-actions").hidden = !form;
  // Fora do formulário, o botão ainda envia e o Enter nos campos continua salvando
  if (form) $("save-btn").setAttribute("form", form.id);
  $("msg").replaceChildren();
  updateDirty();
  if (slug === "artigos") loadPosts();
  window.scrollTo(0, 0);
  if (focus) $("screen-title").focus({ preventScroll: true });
}
function openMenu(open) {
  $("side-menu").classList.toggle("open", open);
  $("menu-btn").setAttribute("aria-expanded", String(open));
}
$("menu-btn").onclick = () => openMenu($("menu-btn").getAttribute("aria-expanded") !== "true");
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("menu-btn").getAttribute("aria-expanded") === "true") {
    openMenu(false);
    $("menu-btn").focus();
  }
});
window.addEventListener("popstate", () => {
  if (!confirmLeave()) return history.pushState(null, "", `/admin/${screen}`);
  showScreen(screenFromUrl(), true);
});

function renderBuild(build) {
  const last = build.lastBuild;
  let text = `Site: ${BUILD[build.state] || build.state}${build.pending && build.state === "idle" ? " (nova publicação na fila)" : ""}.`;
  if (build.state === "idle" && last) text += last.ok ? ` Última publicação: ${new Date(last.finishedAt).toLocaleString()}.` : " A última publicação falhou; o site continua na versão anterior.";
  $("build").textContent = text;
}

function renderSlots() {
  const root = $("slots");
  root.replaceChildren();
  const cats = state.categories.map((c) => [String(c.id), c.name]);
  for (const position of state.positions) {
    const s = state.ads.slots[position] || {};
    const d = make("details");
    d.dataset.position = position;
    remember(d, `ads-${position}`);
    d.append(make("summary", { textContent: `${LABELS[position]}${s.enabled ? " (ativa)" : ""}` }));
    const on = make("input", { type: "checkbox", checked: !!s.enabled });
    on.dataset.f = "enabled";
    const l = make("label", { className: "inline" });
    l.append(on, "Ativa");
    d.append(l);
    const code = make("textarea", { value: s.code || "" });
    code.dataset.f = "code";
    field(d, "Código HTML/JS", code, "O bloco que a rede de anúncios fornece para esta posição.");
    const row = make("div", { className: "row" });
    if (position !== "mobileSticky") {
      const dev = make("select");
      dev.dataset.f = "devices";
      for (const [v, t] of [["both", "Celular e computador"], ["desktop", "Só computador"], ["mobile", "Só celular"]]) dev.append(make("option", { value: v, textContent: t }));
      dev.value = s.devices || "both";
      field(row, "Dispositivos", dev, "Onde esta posição aparece.");
    }
    const mh = make("input", { type: "number", min: 0, max: 1000, value: s.minHeight ?? (position === "mobileSticky" ? 60 : 250) });
    mh.dataset.f = "minHeight";
    field(row, "Altura reservada (px)", mh, "Evita que o texto pule quando o anúncio carrega.");
    d.append(row);
    if (position === "inContent") {
      const r2 = make("div", { className: "row" });
      for (const [f, t, def, min] of [["afterParagraph", "Depois do parágrafo", 3, 1], ["repeatEvery", "Repetir a cada (0 = não repete)", 0, 0], ["maxBlocks", "Máximo de blocos", 1, 1]]) {
        const n = make("input", { type: "number", min, max: 100, value: s[f] ?? def });
        n.dataset.f = f;
        field(r2, t, n);
      }
      d.append(r2);
      checks(d, "Tipos de página", [["article", "Artigo"]], s.pageTypes || ["article"], "pageTypes");
    } else {
      checks(d, "Tipos de página", [["home", "Início"], ["article", "Artigo"], ["category", "Categoria"]], s.pageTypes || ["home", "article", "category"], "pageTypes");
    }
    d.append(make("p", { className: "hint", textContent: "Tipos de página e categorias limitam onde o anúncio aparece." }));
    checks(d, "Só nestas categorias (nenhuma marcada = todas)", cats, (s.includeCategories || []).map(String), "include");
    checks(d, "Exceto nestas categorias", cats, (s.excludeCategories || []).map(String), "exclude");
    root.append(d);
  }
}

function catRow(c) {
  const row = make("div", { className: "card" });
  if (c.id) row.dataset.id = c.id;
  const top = make("div", { className: "row" });
  const name = make("input", { value: c.name || "", maxLength: 80, required: true });
  name.dataset.f = "name";
  const slug = make("input", { value: c.slug || "", maxLength: 80, required: true, pattern: "[a-z0-9]+(-[a-z0-9]+)*" });
  slug.dataset.f = "slug";
  field(top, c.id ? `Nome (id ${c.id})` : "Nome (nova)", name);
  field(top, "Slug", slug, "Parte do endereço: minúsculas, sem acento, com hífen.");
  row.append(top);
  const desc = make("textarea", { value: c.description || "", className: "text", maxLength: 300, rows: 2 });
  desc.style.minHeight = "64px";
  desc.dataset.f = "description";
  field(row, "Descrição", desc, "Aparece na página da categoria e nos buscadores.");
  return row;
}

/** Lista fechada de fusos: evita erro de digitação. Um fuso salvo fora da lista continua aparecendo. */
const TIMEZONES = Intl.supportedValuesOf ? Intl.supportedValuesOf("timeZone") : [];
function timezoneSelect(value) {
  const select = make("select");
  select.append(make("option", { value: "", textContent: "Escolha o fuso" }));
  for (const zone of new Set([...TIMEZONES, ...(value ? [value] : [])])) select.append(make("option", { value: zone, textContent: zone }));
  select.value = value;
  return select;
}

/** Linha com campos curtos e botão de remover; `add` respeita o limite da lista. */
function homeRow(fields, values) {
  const row = make("div", { className: "row home-row" });
  for (const [key, label, { zones, ...attrs }] of fields) {
    const input = zones ? timezoneSelect(values[key] || "") : make("input", { value: values[key] || "", ...attrs });
    input.dataset.f = key;
    field(row, label, input);
  }
  const rm = make("button", { type: "button", className: "ghost fix", textContent: "Remover" });
  rm.onclick = () => row.remove();
  row.append(rm);
  return row;
}
const ITEM_FIELDS = [["icon", "Emoji", { maxLength: 16, className: "emoji" }], ["label", "Texto", { maxLength: 60 }], ["href", "Link (opcional)", { maxLength: 500, placeholder: "/sobre/ ou https://" }]];
const CLOCK_FIELDS = [["label", "Cidade", { maxLength: 80 }], ["timezone", "Fuso horário", { zones: true }]];
const readRows = (root) => [...root.children].map((row) => Object.fromEntries([...row.querySelectorAll("[data-f]")].map((el) => [el.dataset.f, el.value])));
function addRow(root, fields, max, what) {
  if (root.children.length >= max) return show($("msg"), `São no máximo ${max} ${what}.`, "warn");
  root.append(homeRow(fields, {}));
}
$("h-tools-add").onclick = () => addRow($("h-tools-items"), ITEM_FIELDS, 6, "itens");
$("h-clocks-add").onclick = () => addRow($("h-clocks"), CLOCK_FIELDS, 12, "cidades");

function fillHome() {
  const { tools, callout, ticker, footerText, searchPlaceholder } = state.home;
  $("h-tools-on").checked = tools.enabled;
  $("h-tools-icon").value = tools.icon;
  $("h-tools-title").value = tools.title;
  $("h-tools-text").value = tools.text;
  $("h-tools-items").replaceChildren(...tools.items.map((it) => homeRow(ITEM_FIELDS, it)));
  $("h-tools-btn-label").value = tools.button.label;
  $("h-tools-btn-href").value = tools.button.href;
  $("h-callout-on").checked = callout.enabled;
  $("h-callout-icon").value = callout.icon;
  $("h-callout-kicker").value = callout.kicker;
  $("h-callout-title").value = callout.title;
  $("h-callout-text").value = callout.text;
  $("h-callout-btn-label").value = callout.button.label;
  $("h-callout-btn-href").value = callout.button.href;
  $("h-ticker-on").checked = ticker.enabled;
  $("h-ticker-rates").checked = ticker.showRates;
  $("h-ticker-clocks").checked = ticker.showClocks;
  $("h-clocks").replaceChildren(...ticker.clocks.map((c) => homeRow(CLOCK_FIELDS, c)));
  $("h-footer").value = footerText;
  $("h-placeholder").value = searchPlaceholder;
}

const REUPLOAD = [["logo", "b-logo"], ["logoDark", "b-logo-dark"], ["favicon", "b-favicon"]];
for (const [, id] of REUPLOAD) $(`${id}-reupload-btn`).onclick = () => $(id).click();

const HEX_ERROR = "Use 6 letras ou números de 0 a 9 e A a F, por exemplo #1E5AA8";
const COLOR_FIELDS = [["c-primary", "primary"], ["c-highlight", "highlight"], ["c-callout", "callout"], ["c-header", "header"]].map(([id, key]) => ({ picker: $(id), text: $(`${id}-hex`), error: $(`${id}-err`), saved: () => state.colors[key].toLowerCase() }));

function setColorError(f, invalid) {
  f.text.setAttribute("aria-invalid", String(invalid));
  if (invalid) show(f.error, HEX_ERROR, "err");
  else f.error.replaceChildren();
}
/** Código ainda inválido no texto: a prévia fica na última cor válida, como o seletor. */
function renderPreview() {
  const [primary, highlight, callout, header] = COLOR_FIELDS.map((f) => (normalizeHex(f.text.value) || f.picker.value).toLowerCase());
  const end = shadeHex(callout, 0.15);
  const vars = { "pv-btn": primary, "pv-btn-text": textOnHex(primary), "pv-tag": readableHex(highlight), "pv-card": callout, "pv-card-end": end, "pv-card-text": textOnHex(callout, end) };
  const hc = headerColorsHex(header);
  const isDefaultHeader = header === "#ffffff";
  Object.assign(vars, { "pv-header": header, "pv-header-text": hc.text, "pv-header-border": hc.border, "pv-header-hover": isDefaultHeader ? shadeHex(primary, 0.92) : hc.hover, "pv-header-hover-text": isDefaultHeader ? readableHex(primary) : hc.text });
  for (const [name, value] of Object.entries(vars)) $("brand-preview").style.setProperty(`--${name}`, value);
  // state ainda vazio antes do primeiro carregamento
  if (!state) return;
  const dark = hc.text === "#ffffff";
  const logo = dark && state.logoDark ? state.logoDark : state.logo;
  if ($("pv-logo").getAttribute("src") !== logo) $("pv-logo").src = logo;
  const warning = $("c-header-warning");
  if (dark && !state.logoDark) {
    if (!warning.firstChild) show(warning, "O fundo está escuro. Se o logotipo ficar difícil de ler, envie uma versão clara", "warn");
  } else warning.replaceChildren();
}
/** Ao sair do campo e ao salvar. Código inválido fica no texto para ser corrigido; o seletor mantém a última cor válida. */
function commitColor(f) {
  const hex = normalizeHex(f.text.value);
  setColorError(f, !hex);
  if (!hex) return false;
  f.text.value = hex;
  f.picker.value = hex.toLowerCase();
  renderPreview();
  return true;
}
for (const f of COLOR_FIELDS) {
  f.picker.addEventListener("input", () => {
    f.text.value = f.picker.value.toUpperCase();
    setColorError(f, false);
    renderPreview();
  });
  f.text.addEventListener("input", () => {
    renderPreview();
    const hex = normalizeHex(f.text.value);
    if (hex) setColorError(f, false);
    // 3 dígitos podem ser o começo de um código de 6: só valem ao sair do campo
    if (hex && f.text.value.replace(/[#\s]/g, "").length === 6) f.picker.value = hex.toLowerCase();
  });
  f.text.addEventListener("blur", () => commitColor(f));
}

function fill() {
  $("title").textContent = state.name;
  $("b-name").value = state.name;
  $("b-logo-preview").src = state.logo;
  $("b-favicon-preview").src = state.favicon;
  $("c-primary").value = state.colors.primary;
  $("c-highlight").value = state.colors.highlight;
  $("c-callout").value = state.colors.callout;
  $("c-header").value = state.colors.header;
  $("b-logo-dark-box").hidden = !state.logoDark;
  for (const [kind, id] of REUPLOAD) $(`${id}-reupload`).hidden = !state.missingOriginals.includes(kind);
  // Aviso de reenvio não pode ficar escondido numa seção recolhida
  if (state.missingOriginals.length) $("sec-images").open = true;
  if (state.logoDark) $("b-logo-dark-preview").src = state.logoDark;
  state.categories.slice(0, 3).forEach((c, i) => ($(`pv-item-${i}`).textContent = c.name));
  for (const f of COLOR_FIELDS) {
    f.text.value = f.picker.value.toUpperCase();
    setColorError(f, false);
  }
  renderPreview();
  if (state.warnings.length) show($("contrast"), state.warnings, "warn");
  else $("contrast").replaceChildren();
  fillAuthor(state.author || {});
  fillHome();
  $("t-gtm").value = state.tracking.gtmId;
  $("t-head").value = state.tracking.headCode;
  $("t-body").value = state.tracking.bodyCode;
  $("a-head").value = state.ads.headScript;
  $("a-txt").value = state.ads.adsTxt;
  renderSlots();
  $("cats").replaceChildren(...state.categories.map(catRow));
  const w = state.wordbee;
  $("wb-info").textContent = w.managedByEnv
    ? `A senha do usuário "${w.user}" é definida pela variável WP_APP_PASSWORD_HASH. Para trocar, mude a variável no Easypanel.`
    : `Usuário: ${w.user}. ${w.hasPassword ? "Já existe uma senha ativa; ela não pode ser vista de novo." : "Ainda não há senha."}`;
  $("wb-new").hidden = w.managedByEnv;
  renderBuild(state.build);
}

/** Troca o "Salvo" pelo resultado real, quando o build termina. Um novo salvamento substitui o acompanhamento anterior. */
let publishWatch = 0;
async function watchPublish(notice) {
  const id = ++publishWatch;
  while (id === publishWatch) {
    await new Promise((r) => setTimeout(r, 2000));
    if (id !== publishWatch) return;
    let build;
    try {
      ({ build } = await api("/admin/api/build"));
    } catch (err) {
      if (err.status === 401) return;
      continue;
    }
    if (build.state !== "idle" || build.pending) continue;
    const last = build.lastBuild;
    if (last?.ok) {
      const time = new Date(last.finishedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      notice.textContent = `Publicado às ${time}. Se não ver a mudança, atualize a página com Cmd+Shift+R.`;
    } else {
      notice.className = "msg err";
      notice.textContent = "Salvo, mas a publicação falhou. O site continua na versão anterior; o painel tentará de novo em alguns minutos.";
    }
    return;
  }
}

async function saved(promise, warning, afterFill) {
  $("save-btn").disabled = true;
  try {
    state = await promise;
    fill();
    markSaved();
    // Restaura o que foi digitado e não salvo (envio de imagem): o aviso de alterações continua valendo
    afterFill?.();
    updateDirty();
    show($("msg"), "Salvo. O site está sendo publicado com as mudanças.", "ok");
    if (warning) $("msg").append(make("div", { className: "msg warn", textContent: warning }));
    // Sem nada na fila (build desligado), não há publicação para anunciar
    if (state.build.state !== "idle" || state.build.pending) watchPublish($("msg").firstChild);
  } catch (err) {
    if (err.status === 401) return enter();
    show($("msg"), err.message, "err");
  } finally {
    $("save-btn").disabled = false;
  }
}

$("f-brand").onsubmit = (e) => {
  e.preventDefault();
  const invalid = COLOR_FIELDS.filter((f) => !commitColor(f));
  if (invalid.length) {
    openAround(invalid[0].text);
    show($("msg"), "Corrija o código de cor marcado antes de salvar.", "err");
    return invalid[0].text.focus();
  }
  saved(post("/admin/api/brand", { name: $("b-name").value, colors: { primary: $("c-primary").value, highlight: $("c-highlight").value, callout: $("c-callout").value, header: $("c-header").value } }));
};
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
const LOGO_MAX_BYTES = 200 * 1024;
const formatSize = (bytes) => (bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`);

/** Largura e altura da imagem; null se o navegador não conseguir ler (o servidor dá a resposta final). */
async function imageSize(file) {
  try {
    if (file.type === "image/svg+xml") {
      const svg = new DOMParser().parseFromString(await file.text(), "image/svg+xml").documentElement;
      const box = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
      if (box.length === 4 && box[2] > 0 && box[3] > 0) return { width: box[2], height: box[3] };
      const [width, height] = ["width", "height"].map((a) => svg.getAttribute(a) || "");
      return /^[\d.]+(px)?$/.test(width) && /^[\d.]+(px)?$/.test(height) ? { width: parseFloat(width), height: parseFloat(height) } : null;
    }
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

function logoWarning(file, size) {
  // SVG é vetor: a largura em px não limita a qualidade
  if (!size || file.type === "image/svg+xml" || size.width >= 200) return "";
  return `O logotipo tem ${size.width} px de largura, menos que os 200 px recomendados, e pode ficar borrado. Se puder, envie uma versão maior.`;
}
function faviconWarning(_file, size) {
  if (!size || size.width === size.height) return "";
  return `O favicon não é quadrado (${size.width} × ${size.height} px). Ele foi centralizado com sobras transparentes e pode ficar pequeno na aba. Se puder, envie uma versão quadrada.`;
}

function upload(input, url, info, maxBytes, warningFor) {
  input.onchange = async () => {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    const label = `Arquivo escolhido: ${file.name} (${formatSize(file.size)}).`;
    const limit = Math.min(maxBytes, state.maxUploadBytes);
    const reject = (text) => {
      show(info, label, "warn");
      show($("msg"), text, "err");
    };
    if (!IMAGE_TYPES.includes(file.type)) return reject("Formato não aceito. Envie um arquivo PNG, SVG, JPG ou WebP.");
    if (file.size === 0) return reject("O arquivo está vazio. Escolha outro.");
    if (file.size > limit) return reject(`O arquivo passa do tamanho máximo de ${formatSize(limit)}. Reduza a imagem e envie de novo.`);
    const warning = warningFor(file, await imageSize(file));
    show(info, label, "ok");
    if (warning) info.append(make("div", { className: "msg warn", textContent: warning }));
    // O envio salva só a imagem: nome e cores ainda não salvos continuam no formulário
    const name = $("b-name").value;
    const typed = COLOR_FIELDS.map((f) => f.text.value);
    const restore = () => {
      $("b-name").value = name;
      COLOR_FIELDS.forEach((f, i) => {
        f.text.value = typed[i];
        commitColor(f);
      });
      const pending = COLOR_FIELDS.some((f) => f.picker.value !== f.saved());
      if (pending) info.append(make("div", { className: "msg warn", textContent: "As cores escolhidas ainda não foram salvas. Clique em Salvar e publicar." }));
    };
    saved(api(url, { method: "POST", headers: { "Content-Type": file.type }, body: file }), warning, restore);
  };
}
upload($("b-logo"), "/admin/api/logo", $("b-logo-info"), LOGO_MAX_BYTES, logoWarning);
upload($("b-logo-dark"), "/admin/api/logo-dark", $("b-logo-dark-info"), LOGO_MAX_BYTES, logoWarning);
$("c-header-reset").onclick = () => {
  const f = COLOR_FIELDS[3];
  f.text.value = "#FFFFFF";
  commitColor(f);
};
upload($("b-favicon"), "/admin/api/favicon", $("b-favicon-info"), Infinity, faviconWarning);
const POST_STATUS = { publish: "Publicado", draft: "Rascunho", future: "Agendado", trash: "Na lixeira" };
const plainTitle = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
let posts = [];

const postChecks = () => [...$("p-rows").querySelectorAll("input[type=checkbox]")];
function updateSelection() {
  const boxes = postChecks();
  const selected = boxes.filter((c) => c.checked).length;
  $("p-bulk").hidden = selected === 0;
  $("p-delete-many").textContent = `Excluir selecionados (${selected})`;
  $("p-all").checked = boxes.length > 0 && selected === boxes.length;
}
/** Só o que está na lista pode estar selecionado: ao buscar, a seleção de quem saiu dela é desfeita. */
function renderPosts() {
  const q = plainTitle($("p-search").value.trim());
  const keep = new Set(postChecks().filter((c) => c.checked).map((c) => c.value));
  const list = posts.filter((p) => plainTitle(p.title).includes(q));
  $("p-rows").replaceChildren(...list.map((p) => {
    const tr = make("tr");
    const box = make("input", { type: "checkbox", value: p.slug, checked: keep.has(p.slug), onchange: updateSelection });
    box.setAttribute("aria-label", `Selecionar: ${p.title}`);
    const cell = (child, label) => {
      const td = make("td");
      if (label) td.dataset.label = label;
      td.append(child);
      tr.append(td);
    };
    cell(box);
    cell(p.status === "publish" ? make("a", { href: p.link, target: "_blank", rel: "noopener", textContent: p.title }) : p.title);
    cell(p.category, "Categoria");
    cell(p.date ? new Date(p.date).toLocaleDateString("pt-BR") : "", "Data");
    cell(POST_STATUS[p.status] || p.status, "Status");
    const del = make("button", { type: "button", className: "ghost", textContent: "Excluir", onclick: () => deletePosts([p]) });
    del.setAttribute("aria-label", `Excluir: ${p.title}`);
    cell(del);
    return tr;
  }));
  $("p-count").textContent = list.length === posts.length ? `${posts.length} artigo(s)` : `${list.length} de ${posts.length} artigo(s)`;
  updateSelection();
}
async function loadPosts() {
  try {
    ({ posts } = await api("/admin/api/posts"));
    renderPosts();
  } catch (err) {
    if (err.status === 401) return enter();
    show($("msg"), err.message, "err");
  }
}
async function deletePosts(list) {
  const SHOWN = 10;
  const titles = list.slice(0, SHOWN).map((p) => `"${p.title}"`).join("\n");
  const more = list.length > SHOWN ? `\ne mais ${list.length - SHOWN}` : "";
  const what = list.length === 1 ? "este artigo" : `estes ${list.length} artigos`;
  if (!confirm(`Excluir ${what}?\n\n${titles}${more}\n\nEsta ação não pode ser desfeita.`)) return;
  try {
    const r = await post("/admin/api/posts/delete", { slugs: list.map((p) => p.slug) });
    posts = r.posts;
    renderPosts();
    const n = r.deleted.length;
    const notes = [];
    if (n) notes.push(n === 1 ? "1 artigo excluído. Ele sai do site quando a publicação terminar." : `${n} artigos excluídos. Eles saem do site quando a publicação terminar.`);
    if (r.missing.length) notes.push(`${r.missing.length} já não existia(m).`);
    show($("msg"), notes, "ok");
    if (r.failed.length) $("msg").append(make("div", { className: "msg err", textContent: `Não foi possível excluir: ${r.failed.join(", ")}. Atualize a lista e tente de novo.` }));
    if (n && (r.build.state !== "idle" || r.build.pending)) watchPublish($("msg").firstChild);
  } catch (err) {
    if (err.status === 401) return enter();
    show($("msg"), err.message, "err");
  }
}
$("p-search").oninput = renderPosts;
$("p-clear").onclick = () => {
  for (const c of postChecks()) c.checked = false;
  updateSelection();
};
$("p-all").onchange = () => {
  for (const c of postChecks()) c.checked = $("p-all").checked;
  updateSelection();
};
$("p-delete-many").onclick = () => {
  const chosen = new Set(postChecks().filter((c) => c.checked).map((c) => c.value));
  deletePosts(posts.filter((p) => chosen.has(p.slug)));
};

const AUTHOR_LINK_KEYS = ["site", "instagram", "linkedin", "youtube", "x"];
const lines = (el) => el.value.split("\n").map((l) => l.trim()).filter(Boolean);
function readAuthor() {
  return {
    name: $("au-name").value,
    role: $("au-role").value,
    bioShort: $("au-short").value,
    bioFull: $("au-full").value,
    photoAlt: $("au-alt").value,
    credentials: lines($("au-credentials")),
    specialties: lines($("au-specialties")),
    links: Object.fromEntries(AUTHOR_LINK_KEYS.map((k) => [k, $(`au-${k}`).value])),
    email: $("au-email").value,
  };
}
function renderAuthorPreview() {
  const name = $("au-name").value.trim();
  const photo = name && state?.author?.photo;
  $("au-pv-name").textContent = name || state?.authorFallback || "";
  $("au-pv-role").textContent = name && $("au-role").value.trim() ? `, ${$("au-role").value.trim()}` : "";
  $("au-pv-photo").hidden = !photo;
  if (photo) $("au-pv-photo").src = `${photo.base}-96.webp`;
}
function fillAuthor(a) {
  $("au-fallback").textContent = state.authorFallback;
  $("au-name").value = a.name || "";
  $("au-role").value = a.role || "";
  $("au-short").value = a.bioShort || "";
  $("au-full").value = a.bioFull || "";
  $("au-alt").value = a.photoAlt || "";
  $("au-credentials").value = (a.credentials || []).join("\n");
  $("au-specialties").value = (a.specialties || []).join("\n");
  for (const k of AUTHOR_LINK_KEYS) $(`au-${k}`).value = a.links?.[k] || "";
  $("au-email").value = a.email || "";
  const photo = state.author?.photo;
  $("au-photo-preview").hidden = !photo;
  $("au-photo-remove").hidden = !photo;
  if (photo) $("au-photo-preview").src = `${photo.base}-192.webp`;
  renderAuthorPreview();
}
for (const id of ["au-name", "au-role"]) $(id).addEventListener("input", renderAuthorPreview);
$("f-author").onsubmit = (e) => {
  e.preventDefault();
  saved(post("/admin/api/author", readAuthor()));
};
$("au-photo").onchange = () => {
  const file = $("au-photo").files[0];
  $("au-photo").value = "";
  if (!file) return;
  const info = $("au-photo-info");
  const label = `Arquivo escolhido: ${file.name} (${formatSize(file.size)}).`;
  const reject = (text) => {
    show(info, label, "warn");
    show($("msg"), text, "err");
  };
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return reject("Formato não aceito. Envie um arquivo PNG, JPG ou WebP.");
  if (file.size === 0) return reject("O arquivo está vazio. Escolha outro.");
  if (file.size > state.maxUploadBytes) return reject(`O arquivo passa do tamanho máximo de ${formatSize(state.maxUploadBytes)}. Reduza a imagem e envie de novo.`);
  show(info, label, "ok");
  // O envio salva só a foto: o que foi digitado e ainda não salvo continua no formulário
  const draft = readAuthor();
  saved(api("/admin/api/author-photo", { method: "POST", headers: { "Content-Type": file.type }, body: file }), "", () => fillAuthor(draft));
};
$("au-photo-remove").onclick = () => {
  if (!confirm("Remover a foto do autor? A imagem será apagada do servidor.")) return;
  $("au-photo-info").replaceChildren();
  const draft = readAuthor();
  saved(post("/admin/api/author", { ...draft, removePhoto: true }), "", () => fillAuthor(draft));
};

$("f-home").onsubmit = (e) => {
  e.preventDefault();
  saved(post("/admin/api/home", {
    tools: { enabled: $("h-tools-on").checked, icon: $("h-tools-icon").value, title: $("h-tools-title").value, text: $("h-tools-text").value, items: readRows($("h-tools-items")), button: { label: $("h-tools-btn-label").value, href: $("h-tools-btn-href").value } },
    callout: { enabled: $("h-callout-on").checked, icon: $("h-callout-icon").value, kicker: $("h-callout-kicker").value, title: $("h-callout-title").value, text: $("h-callout-text").value, button: { label: $("h-callout-btn-label").value, href: $("h-callout-btn-href").value } },
    ticker: { enabled: $("h-ticker-on").checked, showRates: $("h-ticker-rates").checked, showClocks: $("h-ticker-clocks").checked, clocks: readRows($("h-clocks")) },
    footerText: $("h-footer").value,
    searchPlaceholder: $("h-placeholder").value,
  }));
};
$("f-tracking").onsubmit = (e) => {
  e.preventDefault();
  const hasGtmCode = /googletagmanager\.com\/gtm\.js/i.test($("t-head").value + $("t-body").value);
  if ($("t-gtm").value.trim() && hasGtmCode && !confirm("O ID do Tag Manager está preenchido e um dos campos de código também traz o código do Tag Manager. Isso pode duplicar as medições. Salvar assim mesmo?")) return;
  saved(post("/admin/api/tracking", { gtmId: $("t-gtm").value, headCode: $("t-head").value, bodyCode: $("t-body").value }));
};
$("f-ads").onsubmit = (e) => {
  e.preventDefault();
  const slots = {};
  for (const d of document.querySelectorAll("#slots details")) {
    const s = { pageTypes: checked(d, "pageTypes"), includeCategories: checked(d, "include").map(Number), excludeCategories: checked(d, "exclude").map(Number) };
    for (const el of d.querySelectorAll("[data-f]")) s[el.dataset.f] = el.type === "checkbox" ? el.checked : el.value;
    slots[d.dataset.position] = s;
  }
  saved(post("/admin/api/ads", { headScript: $("a-head").value, adsTxt: $("a-txt").value, slots }));
};
$("add-cat").onclick = () => $("cats").append(catRow({}));
$("f-cats").onsubmit = (e) => {
  e.preventDefault();
  const categories = [...$("cats").children].map((row) => {
    const c = row.dataset.id ? { id: Number(row.dataset.id) } : {};
    for (const el of row.querySelectorAll("[data-f]")) c[el.dataset.f] = el.value;
    return c;
  });
  saved(post("/admin/api/categories", { categories }));
};
$("wb-new").onclick = async () => {
  if (!confirm("A senha atual vai parar de funcionar e o Wordbee precisará da nova. Continuar?")) return;
  try {
    const r = await post("/admin/api/wordbee-password", {});
    $("wb-password").textContent = r.password;
    $("wb-result").hidden = false;
    state.wordbee.hasPassword = true;
  } catch (err) {
    show($("msg"), err.message, "err");
  }
};
$("wb-copy").onclick = () => navigator.clipboard.writeText($("wb-password").textContent).then(() => ($("wb-copy").textContent = "Copiado"));
$("logout").onclick = async () => {
  if (!confirmLeave()) return;
  await post("/admin/api/logout", {});
  location.reload();
};
$("login-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await post("/admin/api/login", { user: $("user").value, password: $("password").value });
    $("password").value = "";
    enter();
  } catch (err) {
    show($("login-msg"), err.message, "err");
  }
};

let poll = null;
async function enter() {
  try {
    state = await api("/admin/api/state");
  } catch {
    $("login").hidden = false;
    $("app").hidden = true;
    document.body.classList.remove("in-app");
    return;
  }
  $("login").hidden = true;
  $("app").hidden = false;
  document.body.classList.add("in-app");
  fill();
  renderNav();
  showScreen(screenFromUrl(), false);
  markSaved();
  clearInterval(poll);
  poll = setInterval(async () => {
    try {
      renderBuild((await api("/admin/api/build")).build);
    } catch {}
  }, 4000);
}
enter();
