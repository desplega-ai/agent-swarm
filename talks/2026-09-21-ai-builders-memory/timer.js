// Rehearsal timer: a local tool, loaded only on localhost. Toggle with "t".
// "s" starts and pauses, "r" resets. It also starts when you leave slide 1.
// "save" writes the run to timings.json through serve.ts and keeps a copy in localStorage.

(() => {
  // Planned seconds per slide, from the run of show in script.md. 0 = no target.
  const PLAN = [10, 15, 30, 300, 25, 30, 30, 20, 35, 35, 30, 25, 25, 0, 0];
  const BUDGET = 600;
  const STORE = "deck-timings:2026-09-21-ai-builders-memory";

  const css = `
    #tmr { position: fixed; left: 10px; bottom: 10px; z-index: 100; display: none; width: 300px;
      font-family: "Space Mono", ui-monospace, monospace; font-size: 13px; color: #fafafa;
      background: #09090b; border: 1px solid #f59e0b; border-radius: 12px; padding: 12px; }
    body.tmr #tmr { display: block; }
    #tmr .big { font-size: 34px; font-weight: 700; line-height: 1.1; }
    #tmr .row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    #tmr .dim { color: #a1a1aa; }
    #tmr .ok { color: #4ade80; } #tmr .warn { color: #fcd34d; } #tmr .over { color: #f87171; }
    #tmr .bar { height: 6px; background: #27272a; border-radius: 3px; margin: 8px 0; overflow: hidden; }
    #tmr .bar i { display: block; height: 100%; width: 0; background: #4ade80; }
    #tmr .btns { display: flex; gap: 6px; margin-top: 10px; }
    #tmr button { font: inherit; cursor: pointer; border-radius: 6px; border: 1px solid #52525b;
      background: #27272a; color: #fafafa; padding: 4px 9px; }
    #tmr button:hover { border-color: #f59e0b; }
    #tmr table { width: 100%; border-collapse: collapse; margin-top: 10px; display: none; }
    #tmr.log table { display: table; }
    #tmr td { padding: 1px 0; } #tmr td:not(:first-child) { text-align: right; }
    #tmr tr.now td { color: #fcd34d; }
  `;
  document.head.appendChild(Object.assign(document.createElement("style"), { textContent: css }));

  const card = Object.assign(document.createElement("div"), { id: "tmr" });
  card.innerHTML = `
    <div class="row"><span class="big" id="tmr-total">0:00</span><span class="dim">/ ${fmt(BUDGET)}</span></div>
    <div class="row"><span id="tmr-delta" class="dim">not started</span><span id="tmr-state" class="dim">paused</span></div>
    <div class="bar"><i id="tmr-bar"></i></div>
    <div class="row"><span id="tmr-slide" class="dim">slide 1</span><span id="tmr-cur">0:00</span></div>
    <div class="btns">
      <button data-a="toggle">start</button><button data-a="reset">reset</button>
      <button data-a="log">log</button><button data-a="save">save</button>
    </div>
    <table id="tmr-table"></table>`;
  document.body.append(card);

  let per = PLAN.map(() => 0);
  let running = false;
  let last = performance.now();
  let seen = 0;
  let flash = "";
  let flashUntil = 0;

  const $ = (id) => document.getElementById(id);
  const active = () => [...document.querySelectorAll(".slide")].findIndex((s) => s.classList.contains("active"));

  function fmt(sec) {
    const s = Math.round(Math.abs(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function cls(actual, plan) {
    if (!plan) return "dim";
    return actual <= plan ? "ok" : actual <= plan * 1.2 ? "warn" : "over";
  }

  function render() {
    const i = Math.max(0, active());
    const total = per.reduce((a, b) => a + b, 0);
    // Plan so far: full target of every slide before this one, plus the used part of this one.
    const planned = PLAN.slice(0, i).reduce((a, b) => a + b, 0) + Math.min(per[i], PLAN[i]);
    const delta = total - planned;
    $("tmr-total").textContent = fmt(total);
    $("tmr-total").className = `big ${cls(total, BUDGET)}`;
    const sign = delta > 0.5 ? "+" : delta < -0.5 ? "-" : "";
    $("tmr-delta").textContent = total === 0 ? "not started" : `${sign}${fmt(delta)} vs plan`;
    $("tmr-delta").className = delta > 20 ? "over" : delta > 5 ? "warn" : "ok";
    $("tmr-state").textContent = performance.now() < flashUntil ? flash : running ? "running" : "paused";
    $("tmr-slide").textContent = `slide ${i + 1}${PLAN[i] ? ` · target ${fmt(PLAN[i])}` : " · no target"}`;
    $("tmr-cur").textContent = fmt(per[i]);
    $("tmr-cur").className = cls(per[i], PLAN[i]);
    const bar = $("tmr-bar");
    bar.style.width = PLAN[i] ? `${Math.min(100, (per[i] / PLAN[i]) * 100)}%` : "0";
    bar.style.background = { ok: "#4ade80", warn: "#fcd34d", over: "#f87171", dim: "#52525b" }[cls(per[i], PLAN[i])];
    card.querySelector('[data-a="toggle"]').textContent = running ? "pause" : "start";
    if (card.classList.contains("log")) {
      $("tmr-table").innerHTML = per
        .map((t, n) => `<tr class="${n === i ? "now" : ""}"><td>${n + 1}</td><td class="${cls(t, PLAN[n])}">${fmt(t)}</td><td class="dim">${PLAN[n] ? fmt(PLAN[n]) : "-"}</td></tr>`)
        .join("");
    }
  }

  function tick() {
    const now = performance.now();
    const i = active();
    // Start the clock on the first move away from slide 1.
    if (!running && document.body.classList.contains("tmr") && per.every((t) => t === 0) && seen === 0 && i > 0) running = true;
    if (running && i >= 0) per[i] += (now - last) / 1000;
    last = now;
    seen = i;
    if (document.body.classList.contains("tmr")) render();
  }

  async function save() {
    const run = { at: new Date().toISOString(), total: Math.round(per.reduce((a, b) => a + b, 0)), perSlide: per.map((t) => Math.round(t)), plan: PLAN };
    const local = JSON.parse(localStorage.getItem(STORE) ?? "[]");
    local.push(run);
    localStorage.setItem(STORE, JSON.stringify(local));
    try {
      const res = await fetch("timings.json");
      const all = res.ok ? await res.json() : [];
      all.push(run);
      const put = await fetch("timings.json", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(all) });
      flash = put.ok ? `saved run ${all.length}` : "saved locally";
    } catch {
      flash = "saved locally";
    }
    flashUntil = performance.now() + 2500;
  }

  const actions = {
    toggle: () => { running = !running; last = performance.now(); },
    reset: () => { running = false; per = PLAN.map(() => 0); seen = active(); },
    log: () => card.classList.toggle("log"),
    save,
  };

  card.addEventListener("click", (e) => {
    const a = e.target.closest("button")?.dataset.a;
    if (a) { actions[a](); e.stopPropagation(); }
  });

  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("textarea, input")) return;
    if (e.key === "t") { document.body.classList.toggle("tmr"); seen = active(); }
    else if (!document.body.classList.contains("tmr")) return;
    else if (e.key === "s") actions.toggle();
    else if (e.key === "r") actions.reset();
  });

  if (new URLSearchParams(location.search).has("timer")) document.body.classList.add("tmr");
  seen = active();
  setInterval(tick, 200);
})();
