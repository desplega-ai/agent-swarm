/* Shared demo runtime for all three session-log mockups.
   Drives push/load-all/reset + counter + the "agent is running" footer +
   scroll-anchoring + jump-to-latest + theme. Each option supplies a
   renderEntry(entry,i) and afterMount(scope). Data: window.DEMO_LOGS. */
(function () {
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  }
  // Minimal, safe markdown → HTML for agent output.
  function mdToHtml(src) {
    var lines = esc(src).replace(/\r\n/g, "\n").split("\n");
    var html = "", i = 0, list = null;
    function close() { if (list) { html += "</" + list + ">"; list = null; } }
    while (i < lines.length) {
      var line = lines[i];
      if (/^```/.test(line)) { close(); i++; var buf = []; while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; } i++; html += "<pre><code>" + buf.join("\n") + "</code></pre>"; continue; }
      var h = line.match(/^(#{1,6})\s+(.*)$/); if (h) { close(); html += "<h4>" + inline(h[2]) + "</h4>"; i++; continue; }
      var b = line.match(/^\s*([-*•]|[✅✓☑])\s+(.*)$/u);
      var o = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (b) { if (list !== "ul") { close(); html += "<ul>"; list = "ul"; } var emoji = /[✅✓☑]/u.test(b[1]); html += "<li" + (emoji ? ' class="chk"' : "") + ">" + (emoji ? '<span class="mk">' + b[1] + "</span> " : "") + inline(b[2]) + "</li>"; i++; continue; }
      if (o) { if (list !== "ol") { close(); html += "<ol>"; list = "ol"; } html += "<li>" + inline(o[1]) + "</li>"; i++; continue; }
      if (!line.trim()) { close(); i++; continue; }
      close(); var para = [line]; i++;
      while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^\s*([-*•]|[✅✓☑])\s/u.test(lines[i]) && !/^\s*\d+[.)]\s/.test(lines[i])) { para.push(lines[i]); i++; }
      html += "<p>" + inline(para.join(" ")) + "</p>";
    }
    close();
    return html;
  }

  var SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';

  function init(opts) {
    var data = window.DEMO_LOGS || { entries: [] };
    var entries = data.entries || [];
    var total = entries.length;
    var initial = Math.min(opts.initial == null ? 4 : opts.initial, total);
    try { var np = new URLSearchParams(location.search).get("n"); if (np === "all") initial = total; else if (np && !isNaN(+np)) initial = Math.min(Math.max(0, +np), total); } catch (e) {}
    var $ = function (id) { return document.getElementById(id); };
    var vp = $("vp"), stream = $("stream"), jump = $("jump"), jumplabel = $("jumplabel"),
        counter = $("counter"), running = $("running"),
        bNext = $("btn-next"), bAll = $("btn-all"), bReset = $("btn-reset"), live = $("live");
    var rendered = 0, pending = 0;
    var atBottom = function () { return vp.scrollHeight - vp.scrollTop - vp.clientHeight < 72; };

    function setRunning(on) {
      if (!running) return;
      running.classList.toggle("done", !on);
      running.innerHTML = on
        ? '<span class="orb" aria-hidden="true"></span><span class="rtext">Agent is working…</span><span class="rmeta">streaming · ' + rendered + "/" + total + "</span>"
        : '<span class="rcheck" aria-hidden="true">✓</span><span class="rtext">Session complete</span><span class="rmeta">' + total + " events</span>";
      if (live) { live.classList.toggle("idle", !on); var lt = live.querySelector(".ltext"); if (lt) lt.textContent = on ? "Live" : "Idle"; }
    }
    function updateCounter() {
      if (counter) counter.textContent = rendered + " / " + total;
      var done = rendered >= total;
      [bNext, bAll].forEach(function (b) { if (b) { b.disabled = done; b.classList.toggle("is-disabled", done); } });
      if (bReset) bReset.disabled = rendered === initial;
    }
    function refreshPill() {
      if (atBottom()) { jump.classList.remove("show"); pending = 0; jumplabel.textContent = ""; return; }
      jump.classList.add("show"); // always offer "scroll to bottom" while scrolled up
      jumplabel.textContent = pending > 0 ? (pending + " new message" + (pending === 1 ? "" : "s")) : "";
    }
    function pushN(n, animate) {
      var stick = atBottom();
      var start = rendered, end = Math.min(total, rendered + n);
      for (var i = start; i < end; i++) {
        var out = opts.renderEntry(entries[i], i);
        var nodes = out == null ? [] : (out.nodeType === 11 ? [].slice.call(out.childNodes) : (Array.isArray(out) ? out : [out]));
        nodes.forEach(function (nd) { if (nd.nodeType === 1 && animate) nd.classList.add("entering"); stream.appendChild(nd); });
      }
      rendered = end;
      if (opts.afterMount) opts.afterMount(stream);
      updateCounter(); setRunning(rendered < total);
      if (animate) {
        if (stick) requestAnimationFrame(function () { vp.scrollTo({ top: vp.scrollHeight, behavior: "smooth" }); });
        else { pending += (end - start); refreshPill(); }
      }
    }
    function reset() {
      stopPlay();
      if (opts.onReset) opts.onReset();
      stream.innerHTML = ""; rendered = 0; pending = 0; jump.classList.remove("show");
      pushN(initial, false);
      vp.scrollTop = vp.scrollHeight;
    }

    vp.addEventListener("scroll", refreshPill);
    jump.setAttribute("aria-label", "Scroll to latest");
    jump.onclick = function () { vp.scrollTo({ top: vp.scrollHeight, behavior: "smooth" }); pending = 0; jump.classList.remove("show"); };
    if (bNext) bNext.onclick = function () { pushN(1, true); };
    if (bAll) bAll.onclick = function () { pushN(total - rendered, true); };
    if (bReset) bReset.onclick = reset;

    // theme
    var root = document.documentElement, tb = $("theme");
    function setTheme(t) { root.classList.toggle("dark", t === "dark"); if (tb) tb.innerHTML = t === "dark" ? SUN : MOON; try { localStorage.swarmMock = t; } catch (e) {} }
    setTheme((function () { try { var u = new URLSearchParams(location.search).get("theme"); if (u === "dark" || u === "light") return u; return localStorage.swarmMock || "light"; } catch (e) { return "light"; } })());
    if (tb) tb.onclick = function () { setTheme(root.classList.contains("dark") ? "light" : "dark"); };

    // auto-play (selectable messages/sec)
    var bPlay = $("btn-play"), speedSel = $("speed"), timer = null;
    var PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l11-7z"/></svg>';
    var PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z"/></svg>';
    function speed() { return speedSel ? (+speedSel.value || 2) : 2; }
    function stopPlay() { if (timer) { clearInterval(timer); timer = null; } if (bPlay) bPlay.innerHTML = PLAY; }
    function startPlay() { if (timer) return; if (rendered >= total) reset(); if (bPlay) bPlay.innerHTML = PAUSE; timer = setInterval(function () { if (rendered >= total) { stopPlay(); return; } pushN(1, true); }, Math.max(60, Math.round(1000 / speed()))); }
    if (bPlay) { bPlay.innerHTML = PLAY; bPlay.onclick = function () { timer ? stopPlay() : startPlay(); }; }
    if (speedSel) speedSel.onchange = function () { if (timer) { stopPlay(); startPlay(); } };

    // embed mode (used by the side-by-side compare screen): hide the mockup chrome
    try { if (new URLSearchParams(location.search).get("embed") === "1") document.body.classList.add("embed"); } catch (e) {}
    // cross-frame control sync: the compare screen broadcasts actions to every iframe
    window.addEventListener("message", function (ev) {
      var d = ev.data; if (!d || !d.__swarmDemo) return;
      if (d.action === "next") pushN(1, true);
      else if (d.action === "all") pushN(total - rendered, true);
      else if (d.action === "reset") reset();
      else if (d.action === "theme") setTheme(d.value);
    });

    reset();
    return { pushN: pushN, reset: reset };
  }

  window.SwarmDemo = { init: init, mdToHtml: mdToHtml, esc: esc };
})();
