"use strict";
const $ = (id) => document.getElementById(id);
const LABELS = { header: "Topo do site", beforeContent: "Antes do conteúdo", inContent: "Dentro do conteúdo", afterContent: "Depois do conteúdo", sidebarTop: "Lateral, no topo", sidebarBottom: "Lateral, no fim", footer: "Rodapé", mobileSticky: "Banner fixo no celular" };
const BUILD = { idle: "publicado", waiting: "na fila", "waiting-slot": "aguardando vaga (outros blogs publicando)", building: "publicando agora" };
let state = null;
let tab = "Marca";

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

function renderTabs() {
  const tabs = $("tabs");
  tabs.replaceChildren();
  for (const sec of document.querySelectorAll("[data-tab]")) {
    const name = sec.dataset.tab;
    sec.hidden = name !== tab;
    const b = make("button", { type: "button", textContent: name, role: "tab" });
    b.setAttribute("aria-selected", String(name === tab));
    b.onclick = () => {
      tab = name;
      renderTabs();
    };
    tabs.append(b);
  }
}

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
    d.append(make("summary", { textContent: `${LABELS[position]}${s.enabled ? " (ativa)" : ""}` }));
    const on = make("input", { type: "checkbox", checked: !!s.enabled });
    on.dataset.f = "enabled";
    const l = make("label", { className: "inline" });
    l.append(on, "Ativa");
    d.append(l);
    const code = make("textarea", { value: s.code || "" });
    code.dataset.f = "code";
    field(d, "Código HTML/JS", code);
    const row = make("div", { className: "row" });
    if (position !== "mobileSticky") {
      const dev = make("select");
      dev.dataset.f = "devices";
      for (const [v, t] of [["both", "Celular e computador"], ["desktop", "Só computador"], ["mobile", "Só celular"]]) dev.append(make("option", { value: v, textContent: t }));
      dev.value = s.devices || "both";
      field(row, "Dispositivos", dev);
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
  field(top, "Slug", slug);
  row.append(top);
  const desc = make("textarea", { value: c.description || "", className: "text", maxLength: 300, rows: 2 });
  desc.style.minHeight = "64px";
  desc.dataset.f = "description";
  field(row, "Descrição", desc);
  return row;
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
  if (state.logoDark) $("b-logo-dark-preview").src = state.logoDark;
  state.categories.slice(0, 3).forEach((c, i) => ($(`pv-item-${i}`).textContent = c.name));
  for (const f of COLOR_FIELDS) {
    f.text.value = f.picker.value.toUpperCase();
    setColorError(f, false);
  }
  renderPreview();
  if (state.warnings.length) show($("contrast"), state.warnings, "warn");
  else $("contrast").replaceChildren();
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
  try {
    state = await promise;
    fill();
    afterFill?.();
    show($("msg"), "Salvo. O site está sendo publicado com as mudanças.", "ok");
    if (warning) $("msg").append(make("div", { className: "msg warn", textContent: warning }));
    // Sem nada na fila (build desligado), não há publicação para anunciar
    if (state.build.state !== "idle" || state.build.pending) watchPublish($("msg").firstChild);
  } catch (err) {
    if (err.status === 401) return enter();
    show($("msg"), err.message, "err");
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$("f-brand").onsubmit = (e) => {
  e.preventDefault();
  const invalid = COLOR_FIELDS.filter((f) => !commitColor(f));
  if (invalid.length) return invalid[0].text.focus();
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
    if (!IMAGE_TYPES.includes(file.type)) return show(info, [label, "Formato não aceito. Envie um arquivo PNG, SVG, JPG ou WebP."], "err");
    if (file.size === 0) return show(info, [label, "O arquivo está vazio. Escolha outro."], "err");
    if (file.size > limit) return show(info, [label, `O arquivo passa do tamanho máximo de ${formatSize(limit)}. Reduza a imagem e envie de novo.`], "err");
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
    return;
  }
  $("login").hidden = true;
  $("app").hidden = false;
  fill();
  renderTabs();
  clearInterval(poll);
  poll = setInterval(async () => {
    try {
      renderBuild((await api("/admin/api/build")).build);
    } catch {}
  }, 4000);
}
enter();
