// Review mode: leave comments on any element or on a whole slide.
// Turn on with ?debug=1 or the "c" key. Comments save to comments.json through
// serve.ts (bun serve.ts). Opened as a plain file, they fall back to
// localStorage and the "download" button.

(() => {
  const STORE = "deck-comments:2026-09-21-ai-builders-memory";
  let comments = [];
  let on = false;
  let served = false;
  let hovered = null;
  let listOpen = false;

  const css = `
    #dbg-bar, #dbg-pop, #dbg-list { font-family: "Space Mono", ui-monospace, monospace; font-size: 13px; z-index: 100; }
    #dbg-bar { position: fixed; top: 10px; right: 10px; display: none; gap: 8px; align-items: center;
      background: #09090b; color: #fafafa; padding: 8px 12px; border-radius: 10px; border: 1px solid #f59e0b; }
    body.dbg #dbg-bar { display: flex; }
    #dbg-bar b { color: #fcd34d; }
    #dbg-bar button, #dbg-pop button, #dbg-list button { font: inherit; cursor: pointer; border-radius: 6px;
      border: 1px solid #52525b; background: #27272a; color: #fafafa; padding: 4px 9px; }
    #dbg-bar button:hover, #dbg-pop button:hover { border-color: #f59e0b; }
    body.dbg .slide.active, body.dbg .slide.active * { cursor: crosshair !important; }
    .dbg-hover { outline: 4px solid #0ea5e9 !important; outline-offset: 4px; }
    .dbg-pin { position: fixed; z-index: 90; min-width: 26px; height: 26px; padding: 0 7px; border-radius: 13px;
      background: #f59e0b; color: #09090b; font: 700 13px/26px "Space Mono", monospace; text-align: center;
      cursor: pointer; box-shadow: 0 2px 8px rgb(0 0 0 / 0.35); transform: translate(-50%, -50%); }
    .dbg-pin.slide-level { background: #0ea5e9; color: #fff; }
    #dbg-pop { position: fixed; display: none; width: 380px; background: #09090b; color: #fafafa;
      border: 1px solid #f59e0b; border-radius: 12px; padding: 12px; box-shadow: 0 10px 40px rgb(0 0 0 / 0.5); }
    #dbg-pop .what { color: #a1a1aa; margin-bottom: 8px; max-height: 3.2em; overflow: hidden; }
    #dbg-pop textarea { width: 100%; height: 110px; background: #18181b; color: #fafafa; border: 1px solid #52525b;
      border-radius: 8px; padding: 8px; font: 14px/1.4 system-ui, sans-serif; resize: vertical; }
    #dbg-pop .row { display: flex; gap: 8px; margin-top: 8px; justify-content: flex-end; }
    #dbg-pop .danger { margin-right: auto; border-color: #7f1d1d; color: #fca5a5; }
    #dbg-list { position: fixed; top: 56px; right: 10px; bottom: 10px; width: 400px; overflow: auto; display: none;
      background: #09090b; color: #e4e4e7; border: 1px solid #3f3f46; border-radius: 12px; padding: 12px; }
    #dbg-list .item { border-bottom: 1px solid #27272a; padding: 10px 0; cursor: pointer; }
    #dbg-list .item.resolved { opacity: 0.45; text-decoration: line-through; }
    #dbg-list .meta { color: #fcd34d; }
    #dbg-list .what { color: #71717a; }
    #dbg-list .body { font: 14px/1.4 system-ui, sans-serif; color: #fafafa; white-space: pre-wrap; margin-top: 4px; }
  `;
  document.head.appendChild(Object.assign(document.createElement("style"), { textContent: css }));

  const bar = Object.assign(document.createElement("div"), { id: "dbg-bar" });
  const pop = Object.assign(document.createElement("div"), { id: "dbg-pop" });
  const list = Object.assign(document.createElement("div"), { id: "dbg-list" });
  const pins = Object.assign(document.createElement("div"), { id: "dbg-pins" });
  document.body.append(bar, pop, list, pins);

  const slides = () => [...document.querySelectorAll(".slide")];
  const activeIndex = () => slides().findIndex((s) => s.classList.contains("active"));
  const open = () => comments.filter((c) => !c.resolved);

  // Path from the slide root to the element, stable across reloads.
  function pathOf(node, slide) {
    const parts = [];
    for (let n = node; n && n !== slide; n = n.parentElement) {
      const same = [...n.parentElement.children].filter((s) => s.localName === n.localName);
      parts.unshift(`${n.localName}:nth-of-type(${same.indexOf(n) + 1})`);
    }
    return parts.join(" > ");
  }

  function resolve(c) {
    const slide = slides()[c.slide - 1];
    if (!slide) return null;
    if (c.target === "slide") return slide;
    try {
      return slide.querySelector(`:scope > ${c.target}`);
    } catch {
      return null;
    }
  }

  async function load() {
    try {
      const res = await fetch("comments.json", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      comments = await res.json();
      served = true;
    } catch {
      served = false;
      comments = JSON.parse(localStorage.getItem(STORE) ?? "[]");
    }
    render();
  }

  async function save() {
    localStorage.setItem(STORE, JSON.stringify(comments));
    if (served) {
      await fetch("comments.json", { method: "PUT", body: JSON.stringify(comments, null, 2) }).catch(() => {
        served = false;
      });
    }
    render();
  }

  function render() {
    bar.innerHTML = `<b>REVIEW</b><span>${open().length} open · ${served ? "saving to comments.json" : "localStorage only"}</span>`;
    const mk = (label, fn) => {
      const b = Object.assign(document.createElement("button"), { textContent: label });
      b.onclick = fn;
      bar.appendChild(b);
    };
    mk("+ slide comment", () => edit({ slideLevel: true }));
    mk(listOpen ? "hide list" : "list", () => {
      listOpen = !listOpen;
      render();
    });
    mk("download", download);
    mk("exit", toggle);

    pins.innerHTML = "";
    if (on) {
      const idx = activeIndex() + 1;
      let slideLevel = 0;
      comments.forEach((c, i) => {
        if (c.resolved || c.slide !== idx) return;
        const node = resolve(c);
        if (!node) return;
        const r = node.getBoundingClientRect();
        const pin = Object.assign(document.createElement("div"), { className: "dbg-pin", textContent: String(i + 1), title: c.comment });
        if (c.target === "slide") {
          pin.classList.add("slide-level");
          pin.style.left = `${r.left + 30 + slideLevel++ * 34}px`;
          pin.style.top = `${r.top + 30}px`;
        } else {
          pin.style.left = `${r.right}px`;
          pin.style.top = `${r.top}px`;
        }
        pin.onclick = (e) => {
          e.stopPropagation();
          edit({ existing: c });
        };
        pins.appendChild(pin);
      });
    }

    list.style.display = on && listOpen ? "block" : "none";
    list.innerHTML = comments.length ? "" : "<p>No comments yet. Click any element.</p>";
    comments.forEach((c, i) => {
      const item = Object.assign(document.createElement("div"), { className: `item${c.resolved ? " resolved" : ""}` });
      item.innerHTML = `<div class="meta">#${i + 1} · slide ${c.slide} · ${c.target === "slide" ? "whole slide" : `&lt;${c.tag}&gt;`}</div><div class="what"></div><div class="body"></div>`;
      item.querySelector(".what").textContent = c.text;
      item.querySelector(".body").textContent = c.comment;
      item.onclick = () => {
        location.hash = `#${c.slide}`;
        setTimeout(() => edit({ existing: c }), 80);
      };
      list.appendChild(item);
    });
  }

  function edit({ node, slideLevel, existing, x, y }) {
    const idx = activeIndex();
    const slide = slides()[idx];
    const draft = existing ?? {
      id: `c${Date.now().toString(36)}`,
      slide: idx + 1,
      slideTitle: slide.querySelector("h1, h2")?.textContent.trim() ?? "",
      target: slideLevel ? "slide" : pathOf(node, slide),
      tag: slideLevel ? "section" : node.localName,
      text: slideLevel ? "(whole slide)" : (node.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 140),
      comment: "",
      resolved: false,
    };
    pop.innerHTML = `<div class="what"></div><textarea placeholder="What should change? (Cmd+Enter to save)"></textarea>
      <div class="row"><button class="danger">delete</button><button class="cancel">cancel</button><button class="ok">save</button></div>`;
    pop.querySelector(".what").textContent = `slide ${draft.slide} · ${draft.target === "slide" ? "whole slide" : `<${draft.tag}> ${draft.text}`}`;
    const ta = pop.querySelector("textarea");
    ta.value = draft.comment;
    pop.querySelector(".danger").style.display = existing ? "" : "none";
    pop.style.display = "block";
    pop.style.left = `${Math.min(innerWidth - 400, Math.max(10, x ?? innerWidth / 2 - 190))}px`;
    pop.style.top = `${Math.min(innerHeight - 240, Math.max(10, y ?? 80))}px`;
    ta.focus();
    const close = () => {
      pop.style.display = "none";
    };
    const commit = () => {
      draft.comment = ta.value.trim();
      if (!draft.comment) return close();
      draft.updatedAt = new Date().toISOString();
      if (!existing) comments.push(draft);
      close();
      save();
    };
    pop.querySelector(".ok").onclick = commit;
    pop.querySelector(".cancel").onclick = close;
    pop.querySelector(".danger").onclick = () => {
      comments = comments.filter((c) => c !== existing);
      close();
      save();
    };
    ta.onkeydown = (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
      if (e.key === "Escape") close();
    };
  }

  function download() {
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob([JSON.stringify(comments, null, 2)], { type: "application/json" })),
      download: "comments.json",
    });
    a.click();
  }

  function toggle() {
    on = !on;
    document.body.classList.toggle("dbg", on);
    hovered?.classList.remove("dbg-hover");
    pop.style.display = "none";
    if (on) load();
    else render();
  }

  document.getElementById("stage").addEventListener("mousemove", (e) => {
    if (!on) return;
    const slide = slides()[activeIndex()];
    const node = slide.contains(e.target) && e.target !== slide ? e.target : null;
    if (node === hovered) return;
    hovered?.classList.remove("dbg-hover");
    hovered = node;
    hovered?.classList.add("dbg-hover");
  });

  document.getElementById("stage").addEventListener("click", (e) => {
    if (!on) return;
    e.preventDefault();
    const slide = slides()[activeIndex()];
    if (!slide.contains(e.target)) return;
    if (e.target === slide) edit({ slideLevel: true, x: e.clientX, y: e.clientY });
    else edit({ node: e.target, x: e.clientX, y: e.clientY });
  });

  addEventListener("keydown", (e) => {
    if (e.target.closest?.("textarea, input") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "c") toggle();
  });
  addEventListener("hashchange", () => setTimeout(render, 30));
  addEventListener("keyup", () => on && setTimeout(render, 30));
  addEventListener("resize", () => on && render());
  addEventListener("focus", () => on && served && load());

  if (new URLSearchParams(location.search).has("debug")) toggle();
})();
