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

function fill() {
  $("title").textContent = state.name;
  $("b-name").value = state.name;
  $("b-logo-preview").src = state.logo;
  $("b-favicon-preview").src = state.favicon;
  $("c-primary").value = state.colors.primary;
  $("c-highlight").value = state.colors.highlight;
  $("c-callout").value = state.colors.callout;
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

async function saved(promise) {
  try {
    state = await promise;
    fill();
    show($("msg"), "Salvo. O site está sendo publicado com as mudanças.", "ok");
  } catch (err) {
    if (err.status === 401) return enter();
    show($("msg"), err.message, "err");
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$("f-brand").onsubmit = (e) => {
  e.preventDefault();
  saved(post("/admin/api/brand", { name: $("b-name").value, colors: { primary: $("c-primary").value, highlight: $("c-highlight").value, callout: $("c-callout").value } }));
};
function upload(input, url) {
  input.onchange = () => {
    const file = input.files[0];
    if (file) saved(api(url, { method: "POST", headers: { "Content-Type": file.type }, body: file }));
    input.value = "";
  };
}
upload($("b-logo"), "/admin/api/logo");
upload($("b-favicon"), "/admin/api/favicon");
$("f-tracking").onsubmit = (e) => {
  e.preventDefault();
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
