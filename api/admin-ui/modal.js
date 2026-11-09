"use strict";
/**
 * Modal único do painel, no lugar de confirm(), alert() e prompt() do navegador.
 * Usa as cores, a fonte e o logotipo do blog (Modal.theme, preenchido pelo admin.js com o estado).
 *
 *   await Modal.confirm({ title, message, confirmLabel, danger }) → true | false
 *   await Modal.alert({ title, message })                         → undefined
 *   await Modal.prompt({ title, message, label, value })          → texto | null
 *
 * Acessível: role="dialog" e aria-modal, foco preso dentro, Esc fecha (= Cancelar), Enter confirma
 * (fora de um botão, que segue com o próprio clique), e o foco volta para onde estava ao fechar.
 */
const Modal = (() => {
  const TEXTOS = { cancelar: "Cancelar", ok: "OK", confirmar: "Confirmar", aviso: "Aviso", confirmacao: "Confirmação" };
  const theme = { primary: "#1363df", fontFamily: "", logo: "" };
  let open = null;

  function el(tag, props = {}, ...children) {
    const e = Object.assign(document.createElement(tag), props);
    for (const c of children) if (c) e.append(c);
    return e;
  }

  function paragraphs(text) {
    return String(text ?? "").split(/\n{2,}/).map((p) => {
      const node = el("p");
      p.split("\n").forEach((line, i) => {
        if (i) node.append(el("br"));
        node.append(line);
      });
      return node;
    });
  }

  function show({ kind, title, message, confirmLabel, cancelLabel, danger, label, value, placeholder }) {
    if (open) open.close(kind === "prompt" ? null : false);
    const previous = document.activeElement;
    return new Promise((resolve) => {
      const id = `modal-${Math.random().toString(36).slice(2)}`;
      const box = el("div", { className: "modal" });
      box.setAttribute("role", kind === "alert" ? "alertdialog" : "dialog");
      box.setAttribute("aria-modal", "true");
      box.setAttribute("aria-labelledby", `${id}-t`);
      box.setAttribute("aria-describedby", `${id}-m`);
      if (theme.fontFamily) box.style.fontFamily = theme.fontFamily;
      box.style.setProperty("--modal-primary", theme.primary);
      box.style.setProperty("--modal-primary-text", typeof textOnHex === "function" ? textOnHex(theme.primary) : "#fff");
      // Cor principal como texto sobre branco (botão Cancelar): escurecida se for clara demais
      box.style.setProperty("--modal-primary-readable", typeof readableHex === "function" ? readableHex(theme.primary) : theme.primary);

      const head = el("div", { className: "modal-head" });
      if (theme.logo) head.append(el("img", { className: "modal-logo", src: theme.logo, alt: "" }));
      head.append(el("h2", { id: `${id}-t`, textContent: title || (kind === "alert" ? TEXTOS.aviso : TEXTOS.confirmacao) }));
      const body = el("div", { className: "modal-body", id: `${id}-m` }, ...paragraphs(message));

      let input = null;
      if (kind === "prompt") {
        const inputId = `${id}-i`;
        input = el("input", { id: inputId, value: value ?? "", placeholder: placeholder ?? "" });
        input.setAttribute("autocomplete", "off");
        body.append(el("label", { htmlFor: inputId, textContent: label || "" }), input);
      }

      const ok = el("button", { type: "button", className: danger ? "danger" : "", textContent: confirmLabel || (kind === "alert" ? TEXTOS.ok : TEXTOS.confirmar) });
      const actions = el("div", { className: "modal-actions" });
      let cancel = null;
      if (kind !== "alert") {
        cancel = el("button", { type: "button", className: "ghost", textContent: cancelLabel || TEXTOS.cancelar });
        actions.append(cancel);
      }
      actions.append(ok);
      box.append(head, body, actions);
      const backdrop = el("div", { className: "modal-backdrop" }, box);

      // O resto da página fica inerte enquanto o modal está aberto
      const siblings = [...document.body.children].filter((c) => c !== backdrop && !c.inert);
      const finish = (result) => {
        document.removeEventListener("keydown", onKey, true);
        siblings.forEach((c) => (c.inert = false));
        backdrop.remove();
        open = null;
        if (previous && typeof previous.focus === "function" && document.contains(previous)) previous.focus();
        resolve(result);
      };
      const accept = () => finish(kind === "prompt" ? input.value : kind === "alert" ? undefined : true);
      const refuse = () => finish(kind === "prompt" ? null : kind === "alert" ? undefined : false);
      open = { close: (r) => finish(r) };

      function onKey(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          refuse();
        } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          e.stopPropagation();
          accept();
        } else if (e.key === "Tab") {
          // Foco preso: do último volta ao primeiro, e vice-versa
          const items = [input, cancel, ok].filter(Boolean);
          const i = items.indexOf(document.activeElement);
          e.preventDefault();
          const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === -1 || i === items.length - 1 ? 0 : i + 1;
          items[next].focus();
        }
      }
      ok.onclick = accept;
      if (cancel) cancel.onclick = refuse;
      backdrop.addEventListener("mousedown", (e) => {
        if (e.target === backdrop) refuse();
      });
      document.addEventListener("keydown", onKey, true);
      document.body.append(backdrop);
      siblings.forEach((c) => (c.inert = true));
      (input || ok).focus();
      if (input) input.select();
    });
  }

  return {
    theme,
    /** Cores, fonte e logotipo do blog, vindos do estado do painel. */
    setTheme(next) {
      Object.assign(theme, Object.fromEntries(Object.entries(next).filter(([, v]) => v)));
    },
    confirm: (opts) => show({ ...opts, kind: "confirm" }),
    alert: (opts) => show({ ...opts, kind: "alert" }),
    prompt: (opts) => show({ ...opts, kind: "prompt" }),
  };
})();
