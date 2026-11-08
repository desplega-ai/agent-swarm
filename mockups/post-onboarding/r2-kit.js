/* Post-onboarding UI spike, round 2: shared behavior.
   - Theme: ?theme=dark|light wins, then localStorage, then light.
   - Exhibit bar: <header class="x-top" data-page="..."> gets its links.
   - Sidebar: <nav class="side" data-active="tools" [data-rail] [data-build-open]
     [data-hover="settings"]> gets the WORK / CONNECT / BUILD markup.
   Throwaway reference material: nothing here ships. */
(function () {
  var root = document.documentElement;
  var PAGES = [
    ["sidebar", "r2-sidebar.html", "Sidebar"],
    ["connect", "r2-connect-hub.html", "Connect hub"],
    ["group", "r2-group-header.html", "Group header"],
    ["home", "r2-home.html", "Home"],
  ];
  var WORK = [
    ["home", "i-home", "Home", "#/"],
    ["sessions", "i-message-square", "Sessions", "#/sessions"],
    ["files", "i-folder-open", "Files", "#/file"],
    ["apps", "i-layout-grid", "Apps", "#/apps"],
    ["pages", "i-globe", "Pages", "#/pages"],
  ];
  var CONNECT = [
    ["channels", "i-message-circle", "Channels", "#/integrations?tab=channels"],
    ["tools", "i-wrench", "Tools", "#/integrations?tab=tools"],
    ["ai", "i-cpu", "AI providers", "#/integrations?tab=ai-providers"],
  ];
  var BUILD = [
    ["agents", "i-bot", "Agents"], ["schedules", "i-clock", "Schedules"],
    ["workflows", "i-workflow", "Workflows"], ["scripts", "i-file-code", "Scripts"],
    ["skills", "i-book-open", "Skills"], ["templates", "i-file-text", "Templates"],
    ["memory", "i-database", "Memory"], ["tasks", "i-list-todo", "Tasks"],
  ];

  function icon(cls) { return '<span class="ic ' + cls + '" aria-hidden="true"></span>'; }

  var badge = "3";
  function item(it, active, extra) {
    var on = it[0] === active;
    var tail = "";
    if (it[0] === "home" && badge !== "0") tail = '<span class="nb" title="' + badge + ' need you">' + badge + '</span><span class="rb"></span>';
    if (it[0] === "ai") tail = '<span class="nd" title="1 key is rate limited"></span><span class="rd"></span>';
    return '<a class="ni' + (on ? " on" : "") + (extra || "") + '" href="' + (it[3] || "#/" + it[0]) + '" title="' + it[2] + '"' +
      (on ? ' aria-current="page"' : "") + ">" + icon(it[1]) + '<span class="lab">' + it[2] + "</span>" + tail + "</a>";
  }

  function sidebar(nav) {
    var active = nav.getAttribute("data-active") || "";
    var rail = nav.hasAttribute("data-rail");
    var buildOpen = nav.hasAttribute("data-build-open") || BUILD.some(function (b) { return b[0] === active; });
    var hover = nav.getAttribute("data-hover") || "";
    badge = nav.getAttribute("data-badge") || "3";
    if (rail) nav.classList.add("rail");
    var h = '<div class="side-head"><span class="logo">' + icon("i-hexagon") + '</span><span class="side-name">Acme swarm</span>' +
      (rail ? "" : '<span class="tog" title="Collapse sidebar">' + icon("i-panel-left") + "</span>") + "</div>";
    h += '<div class="side-body">';
    h += '<div class="ng" role="group" aria-label="Work">' + (rail ? "" : '<div class="nl">Work</div>') +
      WORK.map(function (it) { return item(it, active); }).join("") + "</div>";
    h += '<div class="rsep"></div>';
    h += '<div class="ng" role="group" aria-label="Connect">' + (rail ? "" : '<div class="nl">Connect</div>') +
      CONNECT.map(function (it) { return item(it, active); }).join("") + "</div>";
    h += '<div class="rsep"></div>';
    if (rail) {
      var bOn = BUILD.some(function (b) { return b[0] === active; });
      h += '<div class="ng">' + '<a class="ni' + (bOn ? " on" : "") + (hover === "build" ? " hov" : "") + '" href="#/build" title="Build">' + icon("i-blocks") + '<span class="lab">Build</span></a></div>';
    } else {
      h += '<details class="ng"' + (buildOpen ? " open" : "") + '><summary class="nl">Build<span class="cnt">8</span>' + icon("i-chevron-right") + "</summary>" +
        BUILD.map(function (it) { return item(it, active); }).join("") + "</details>";
    }
    h += "</div>";
    h += '<div class="side-foot">' +
      '<a class="ni' + (active === "settings" ? " on" : "") + (hover === "settings" ? " hov" : "") + '" href="#/settings" title="Settings">' + icon("i-settings") + '<span class="lab">Settings</span>' + icon("i-chevron-right chev") + "</a>" +
      '<a class="ni' + (active === "usage" ? " on" : "") + '" href="#/usage" title="Usage">' + icon("i-chart") + '<span class="lab">Usage</span>' + icon("i-chevron-right chev") + "</a></div>";
    nav.innerHTML = h;
  }

  function exhibit(bar) {
    var cur = bar.getAttribute("data-page");
    bar.innerHTML = '<div class="x-id"><b>Post-onboarding</b><span>Round 2</span></div>' +
      '<nav class="x-nav" aria-label="Round 2 pages">' + PAGES.map(function (p) {
        return '<a href="' + p[1] + '"' + (p[0] === cur ? ' aria-current="page"' : "") + ">" + p[2] + "</a>";
      }).join("") + "</nav>" +
      '<span class="sp"></span><a class="w-a" href="index.html">Index</a>' +
      '<button class="x-theme" id="theme" type="button" title="Toggle theme" aria-label="Toggle theme"></button>';
  }

  document.querySelectorAll(".x-top[data-page]").forEach(exhibit);
  document.querySelectorAll("nav.side").forEach(sidebar);

  var q = new URLSearchParams(location.search).get("theme"), t = "light";
  try { t = q || localStorage.getItem("swarmMock") || "light"; } catch (e) { t = q || "light"; }
  function set(v) {
    t = v; root.classList.toggle("dark", v === "dark"); root.setAttribute("data-theme", v);
    var b = document.getElementById("theme");
    if (b) b.innerHTML = icon(v === "dark" ? "i-sun" : "i-moon");
    document.querySelectorAll(".x-nav a, a.w-a[href='index.html']").forEach(function (a) {
      a.setAttribute("href", a.getAttribute("href").split("?")[0] + "?theme=" + v);
    });
    try { localStorage.setItem("swarmMock", v); } catch (e) { /* file:// without storage */ }
  }
  set(t);
  var btn = document.getElementById("theme");
  if (btn) btn.addEventListener("click", function () { set(t === "dark" ? "light" : "dark"); });

  window.R2 = { icon: icon, sidebar: sidebar };
})();
