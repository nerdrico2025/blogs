"use strict";
const $ = (id) => document.getElementById(id);
const STEPS = { s0: "", s1: "Passo 1 de 4: sobre o blog", s3: "Passos 2 e 3 de 4: sugestões da IA", s4: "Passo 4 de 4: senha do Wordbee" };
const tokenValue = () => $("token").value;

function go(id) {
  for (const s of ["s0", "s1", "s3", "s4"]) $(s).hidden = s !== id;
  $("steps").textContent = STEPS[id];
  message();
  window.scrollTo(0, 0);
}
function message(text, kind) {
  const m = $("msg");
  m.replaceChildren();
  if (!text) return;
  const d = document.createElement("div");
  d.className = `msg ${kind}`;
  d.textContent = text;
  m.append(d);
}
async function post(url, data) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Setup-Token": tokenValue() }, body: JSON.stringify(data) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || "Algo deu errado. Tente de novo.");
  return body;
}

function catRow(c = {}) {
  const row = document.createElement("div");
  row.className = "card";
  const add = (label, key, attrs = {}) => {
    const l = document.createElement("label");
    l.textContent = label;
    const i = Object.assign(document.createElement("input"), { value: c[key] || "", required: true, ...attrs });
    i.dataset.f = key;
    l.append(i);
    row.append(l);
  };
  add("Nome", "name", { maxLength: 80 });
  add("Slug (sem acento)", "slug", { maxLength: 80, pattern: "[a-z0-9]+(-[a-z0-9]+)*" });
  add("Descrição (até 160 caracteres)", "description", { maxLength: 160 });
  const rm = Object.assign(document.createElement("button"), { type: "button", className: "ghost", textContent: "Remover" });
  rm.onclick = () => row.remove();
  row.append(rm);
  return row;
}

function itemRow(it = {}) {
  const row = document.createElement("div");
  row.className = "row home-row";
  for (const [key, label, maxLength] of [["icon", "Emoji", 16], ["label", "Texto", 60], ["href", "Link", 500]]) {
    const l = document.createElement("label");
    l.textContent = label;
    const i = Object.assign(document.createElement("input"), { value: it[key] || "", maxLength });
    i.dataset.f = key;
    l.append(i);
    row.append(l);
  }
  return row;
}

let hasHome = false;
function fillHome(home) {
  hasHome = Boolean(home);
  $("no-home").hidden = hasHome;
  $("home-fields").hidden = !hasHome;
  if (!home) return;
  $("ht-title").value = home.tools.title;
  $("ht-text").value = home.tools.text;
  $("ht-items").replaceChildren(...home.tools.items.map(itemRow));
  $("ht-btn-label").value = home.tools.button.label;
  $("ht-btn-href").value = home.tools.button.href;
  $("hc-kicker").value = home.callout.kicker;
  $("hc-title").value = home.callout.title;
  $("hc-text").value = home.callout.text;
  $("hc-btn-label").value = home.callout.button.label;
  $("hc-btn-href").value = home.callout.button.href;
  $("h-footer").value = home.footerText;
  $("h-placeholder").value = home.searchPlaceholder;
}
function readHome() {
  if (!hasHome) return null;
  const items = [...$("ht-items").children].map((row) => Object.fromEntries([...row.querySelectorAll("[data-f]")].map((i) => [i.dataset.f, i.value])));
  return {
    tools: { enabled: $("ht-on").checked, title: $("ht-title").value, text: $("ht-text").value, items, button: { label: $("ht-btn-label").value, href: $("ht-btn-href").value } },
    callout: { enabled: $("hc-on").checked, kicker: $("hc-kicker").value, title: $("hc-title").value, text: $("hc-text").value, button: { label: $("hc-btn-label").value, href: $("hc-btn-href").value } },
    footerText: $("h-footer").value,
    searchPlaceholder: $("h-placeholder").value,
  };
}

$("s0").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const info = await post("/admin/setup/api/check", {});
    go("s1");
    $("no-key").hidden = info.aiConfigured;
    $("gen").disabled = !info.aiConfigured;
  } catch (err) {
    message(err.message, "err");
  }
};

$("s1").onsubmit = async (e) => {
  e.preventDefault();
  $("gen").disabled = true;
  $("gen-wait").hidden = false;
  message();
  try {
    const p = await post("/admin/setup/api/generate", { name: $("name").value, niche: $("niche").value, lang: $("lang").value });
    $("tagline").value = p.tagline;
    $("c1").value = p.palette.primary;
    $("c2").value = p.palette.highlight;
    $("c3").value = p.palette.callout;
    $("cats").replaceChildren(...p.categories.map(catRow));
    $("aname").value = p.authorName;
    $("abio").value = p.authorBio;
    $("about").value = p.about;
    fillHome(p.home);
    go("s3");
  } catch (err) {
    message(err.message, "err");
    $("gen").textContent = "Tentar de novo";
  } finally {
    $("gen").disabled = false;
    $("gen-wait").hidden = true;
  }
};

$("add").onclick = () => $("cats").append(catRow());
$("back").onclick = () => go("s1");

$("s3").onsubmit = async (e) => {
  e.preventDefault();
  $("publish").disabled = true;
  try {
    const categories = [...$("cats").children].map((row) => {
      const c = {};
      for (const i of row.querySelectorAll("[data-f]")) c[i.dataset.f] = i.value.trim();
      return c;
    });
    const r = await post("/admin/setup/api/publish", {
      name: $("name").value,
      lang: $("lang").value,
      adminPassword: $("pass").value,
      proposal: {
        tagline: $("tagline").value,
        palette: { primary: $("c1").value, highlight: $("c2").value, callout: $("c3").value },
        categories,
        authorName: $("aname").value,
        authorBio: $("abio").value,
        about: $("about").value,
        home: readHome(),
      },
    });
    $("pass").value = "";
    $("w-url").textContent = r.wordbee.url;
    $("w-user").textContent = r.wordbee.user;
    $("w-pass").textContent = r.wordbee.password;
    $("a-user").textContent = r.adminUser;
    go("s4");
  } catch (err) {
    message(err.message, "err");
    window.scrollTo(0, 0);
  } finally {
    $("publish").disabled = false;
  }
};

$("copy").onclick = () => navigator.clipboard.writeText($("w-pass").textContent).then(() => ($("copy").textContent = "Copiado"));
go("s0");
