/* Post-onboarding UI spike, round 3: shared behavior.
   - Theme: ?theme=dark|light wins, then localStorage, then light.
   - Exhibit bar: <header class="x-top" data-page="..."> gets its links.
   - Sidebar: <nav class="side" data-active="tools" [data-variant="1|2"] [data-rail]
     [data-build-open] [data-hover="settings|build"] [data-badge="3"]>
     gets the WORK / (AUTOMATE) / CONNECT / BUILD markup.
   - R3.fly("settings"|"build", highlight) returns the flyout markup.
   Throwaway reference material: nothing here ships. */
(function () {
  var root = document.documentElement;
  var PAGES = [
    ["sidebar", "r3-sidebar.html", "Sidebar"],
    ["connect", "r3-connect.html", "Connect"],
    ["home", "r3-home.html", "Home"],
  ];
  var IT = {
    home: ["i-home", "Home", "#/"],
    sessions: ["i-message-square", "Sessions", "#/sessions"],
    files: ["i-folder-open", "Files", "#/file"],
    pages: ["i-globe", "Pages", "#/pages"],
    apps: ["i-layout-grid", "Apps", "#/apps"],
    schedules: ["i-clock", "Schedules", "#/schedules"],
    workflows: ["i-workflow", "Workflows", "#/workflows"],
    channels: ["i-message-circle", "Channels", "#/integrations/channels"],
    tools: ["i-wrench", "Tools", "#/integrations/tools"],
    ai: ["i-cpu", "AI providers", "#/integrations/ai-providers"],
    agents: ["i-bot", "Agents", "#/agents"],
    tasks: ["i-list-todo", "Tasks", "#/tasks"],
    skills: ["i-book-open", "Skills", "#/skills"],
    memory: ["i-database", "Memory", "#/memory"],
    scripts: ["i-file-code", "Scripts", "#/scripts"],
  };
  var VARIANTS = {
    "1": [["Work", ["home", "sessions", "files", "pages", "apps", "schedules", "workflows"]], ["Connect", ["channels", "tools", "ai"]]],
    "2": [["Work", ["home", "sessions", "files", "pages", "apps"]], ["Automate", ["schedules", "workflows"]], ["Connect", ["channels", "tools", "ai"]]],
  };
  var BUILD = ["agents", "tasks", "skills", "memory", "scripts"];
  var SETTINGS = [
    ["servers", "i-server", "Servers"], ["people", "i-users", "People"], ["appearance", "i-palette", "Appearance"],
    ["configuration", "i-cog", "Configuration"], ["extensions", "i-puzzle", "Extensions"], ["runtime-pools", "i-layers", "Runtime pools"],
    ["repos", "i-git-branch", "Repos"], ["debug", "i-bug", "Debug"],
  ];
  var ADVANCED = [
    ["secrets", "i-shield", "Secrets"], ["templates", "i-file-text", "Templates"],
    ["playground", "i-flask", "Connection playground"], ["raw-fetch", "i-key", "Raw fetch credentials"],
  ];

  function icon(cls) { return '<span class="ic ' + cls + '" aria-hidden="true"></span>'; }

  var badge = "3";
  function item(key, active, extra) {
    var it = IT[key], on = key === active, tail = "";
    if (key === "home" && badge !== "0") tail = '<span class="nb" title="' + badge + ' need you">' + badge + '</span><span class="rb"></span>';
    if (key === "ai") tail = '<span class="nd" title="1 key is rate limited"></span><span class="rd"></span>';
    return '<a class="ni' + (on ? " on" : "") + (extra || "") + '" href="' + it[2] + '" title="' + it[1] + '"' +
      (on ? ' aria-current="page"' : "") + ">" + icon(it[0]) + '<span class="lab">' + it[1] + "</span>" + tail + "</a>";
  }

  function sidebar(nav) {
    var active = nav.getAttribute("data-active") || "";
    var variant = VARIANTS[nav.getAttribute("data-variant") || "1"];
    var rail = nav.hasAttribute("data-rail");
    var buildOpen = nav.hasAttribute("data-build-open") || BUILD.indexOf(active) > -1;
    var hover = nav.getAttribute("data-hover") || "";
    badge = nav.getAttribute("data-badge") || "3";
    nav.classList.toggle("rail", rail);
    var h = '<div class="side-head"><span class="logo">' + icon("i-hexagon") + "</span>" +
      (rail ? "" : '<span class="side-name">Acme swarm</span><span class="tog" title="Collapse sidebar">' + icon("i-panel-left") + "</span>") + "</div>";
    h += '<div class="side-body">';
    variant.forEach(function (g, i) {
      if (i) h += '<div class="rsep"></div>';
      h += '<div class="ng" role="group" aria-label="' + g[0] + '">' + (rail ? "" : '<div class="nl">' + g[0] + "</div>") +
        g[1].map(function (k) { return item(k, active); }).join("") + "</div>";
    });
    h += '<div class="rsep"></div>';
    if (rail) {
      var bOn = BUILD.indexOf(active) > -1;
      h += '<div class="ng"><a class="ni' + (bOn ? " on" : "") + (hover === "build" ? " hov" : "") + '" href="#/build" title="Build">' + icon("i-blocks") + '<span class="lab">Build</span></a></div>';
    } else {
      h += '<details class="ng"' + (buildOpen ? " open" : "") + '><summary class="nl">Build<span class="cnt">' + BUILD.length + "</span>" + icon("i-chevron-right") + "</summary>" +
        BUILD.map(function (k) { return item(k, active); }).join("") + "</details>";
    }
    h += "</div>";
    h += '<div class="side-foot">' +
      '<a class="ni' + (active === "settings" ? " on" : "") + (hover === "settings" ? " hov" : "") + '" href="#/settings" title="Settings">' + icon("i-settings") + '<span class="lab">Settings</span>' + icon("i-chevron-right chev") + "</a>" +
      '<a class="ni' + (active === "usage" ? " on" : "") + '" href="#/usage" title="Usage">' + icon("i-chart") + '<span class="lab">Usage</span>' + icon("i-chevron-right chev") + "</a></div>";
    nav.innerHTML = h;
  }

  function fi(row, hl) {
    return '<a class="fi' + (row[0] === hl ? " hl" : "") + '" href="#/settings/' + row[0] + '" role="menuitem">' + icon(row[1]) + row[2] + "</a>";
  }
  function fly(kind, hl) {
    if (kind === "build") {
      return '<div class="fh">Build</div>' + BUILD.map(function (k) {
        return '<a class="fi' + (k === hl ? " hl" : "") + '" href="' + IT[k][2] + '" role="menuitem">' + icon(IT[k][0]) + IT[k][1] + "</a>";
      }).join("");
    }
    return '<div class="fh">Settings</div>' + SETTINGS.map(function (r) { return fi(r, hl); }).join("") +
      '<div class="fsep"></div><div class="fl">Advanced</div>' + ADVANCED.map(function (r) { return fi(r, hl); }).join("");
  }

  function exhibit(bar) {
    var cur = bar.getAttribute("data-page");
    bar.innerHTML = '<div class="x-id"><b>Post-onboarding</b><span>Round 3</span></div>' +
      '<nav class="x-nav" aria-label="Round 3 pages">' + PAGES.map(function (p) {
        return '<a href="' + p[1] + '"' + (p[0] === cur ? ' aria-current="page"' : "") + ">" + p[2] + "</a>";
      }).join("") + "</nav>" +
      '<span class="sp"></span><a class="w-a" href="index.html">Index</a>' +
      '<button class="x-theme" id="theme" type="button" title="Toggle theme" aria-label="Toggle theme"></button>';
  }

  document.querySelectorAll(".x-top[data-page]").forEach(exhibit);
  document.querySelectorAll("nav.side").forEach(sidebar);
  document.querySelectorAll("[data-fly]").forEach(function (el) {
    el.innerHTML = fly(el.getAttribute("data-fly"), el.getAttribute("data-hl") || "");
  });

  var q = new URLSearchParams(location.search).get("theme"), t = "light";
  try { t = q || localStorage.getItem("swarmMock") || "light"; } catch (e) { t = q || "light"; }
  function set(v) {
    t = v; root.classList.toggle("dark", v === "dark"); root.setAttribute("data-theme", v);
    var b = document.getElementById("theme");
    if (b) b.innerHTML = icon(v === "dark" ? "i-sun" : "i-moon");
    document.querySelectorAll(".x-nav a, a.w-a[href^='index.html']").forEach(function (a) {
      a.setAttribute("href", a.getAttribute("href").split("?")[0] + "?theme=" + v);
    });
    try { localStorage.setItem("swarmMock", v); } catch (e) { /* file:// without storage */ }
  }
  set(t);
  var btn = document.getElementById("theme");
  if (btn) btn.addEventListener("click", function () { set(t === "dark" ? "light" : "dark"); });

  window.R3 = { icon: icon, sidebar: sidebar, fly: fly };
})();
