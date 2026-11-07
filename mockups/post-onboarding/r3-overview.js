/* Post-onboarding UI spike, round 3: the use-case Overview tab.
   Renders the desk frames (div.main[data-frame="overview|list|plain"][data-count])
   and the phone frames (div.phone[data-pframe="overview|list"][data-scroll]).
   Needs r2-kit.js first: R2.icon, the theme toggle and the rail sidebar.
   Mock clock: Wednesday 4 November 2026, 14:46.
   Throwaway reference material: nothing here ships. */
(function () {
  var I = R2.icon;
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  /* ---------- schedules ---------- */
  var CO = ["Linear", "Notion", "Plane", "Height", "Shortcut", "Asana", "ClickUp", "Jira", "Monday", "Trello"];
  var TPL = {
    scan: { agent: "Researcher", body: "Check the pricing, changelog and docs pages of each competitor in scope.md.\nCompare each page with the last report in this folder.\nWrite report-{{date}}.md: only what changed, with a link to each source page.\nIf nothing changed, write one line and stop." },
    digest: { agent: "Writer", body: "Read this week's reports in this folder.\nWrite digest-{{date}}.md: five bullets, newest first, one link each.\nPost it to #market-intel after a person approves it." },
    pricing: { agent: "Researcher", body: "Open {{url}} and compare it with the last pricing-{{slug}} file in this folder.\nIf a plan, a price or a limit changed, write pricing-{{slug}}-{{date}}.md.\nIf nothing changed, stop without a file." },
    summary: { agent: "Writer", body: "Read every pricing-*.md file from last month.\nWrite pricing-summary-{{month}}.md: one table with the competitor, the plan, the old price, the new price and the date." },
    changelog: { agent: "Researcher", body: "Read the changelog at {{url}} since the last run.\nAdd new entries to changelog-{{slug}}.md, newest first." },
    docs: { agent: "Reviewer", body: "Compare the docs at {{url}} with yesterday's copy.\nList changed pages in docs-{{slug}}-{{date}}.md." },
    hiring: { agent: "Researcher", body: "Read the jobs page at {{url}}.\nWrite hiring-{{slug}}.md: open roles by team, and what changed since last week." },
    social: { agent: "Writer", body: "Search the last hour of posts that name {{name}}.\nAdd notable posts to mentions-{{slug}}.md. Skip ads and reposts." },
  };
  // [name, cadence, agent, on, next label, minutes from now, template key, slug]
  var ALL = [
    ["Competitor scan", "Mon, Thu 09:00", "Researcher", true, "Thu 09:00", 1094, "scan", ""],
    ["Weekly digest to #market-intel", "Fri 16:00", "Writer", true, "Fri 16:00", 2954, "digest", ""],
    ["Monthly pricing summary", "1st of the month 10:00", "Writer", true, "Dec 1 10:00", 38654, "summary", ""],
  ];
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  CO.forEach(function (c, i) {
    var slug = c.toLowerCase();
    var pm = 30 + i * 5, ph = 7 + Math.floor(pm / 60);
    ALL.push(["Pricing page diff: " + c, "Daily " + pad(ph) + ":" + pad(pm % 60), "Researcher", c !== "Linear" && c !== "Trello", "Thu " + pad(ph) + ":" + pad(pm % 60), 1004 + i * 5, "pricing", slug]);
    ALL.push(["Changelog watch: " + c, "Every 6 hours", "Researcher", true, "today " + pad(18) + ":" + pad(i * 2), 194 + i * 2, "changelog", slug]);
    ALL.push(["Docs diff: " + c, "Weekdays " + pad(19) + ":" + pad(i * 5), "Reviewer", true, "today 19:" + pad(i * 5), 254 + i * 5, "docs", slug]);
    ALL.push(["Hiring page scan: " + c, "Sun 20:" + pad(i * 5), "Researcher", c !== "Jira", "Sun 20:" + pad(i * 5), 6074 + i * 5, "hiring", slug]);
    if (i < 7) ALL.push(["Social mentions: " + c, "Hourly at :" + pad(i * 5), "Writer", c !== "Height", "today 15:" + pad(i * 5), 14 + i * 5, "social", slug]);
  });
  var SMALL = [ALL[0], ALL[1], ALL.filter(function (s) { return s[0] === "Pricing page diff: Linear"; })[0]];

  function sorted(list) {
    return list.slice().sort(function (a, b) { return (a[3] === b[3] ? a[5] - b[5] : a[3] ? -1 : 1); });
  }
  function isOn(st, s) { return st.on[s[0]] === undefined ? s[3] : st.on[s[0]]; }
  function nextOf(st, list) {
    var on = list.filter(function (s) { return isOn(st, s); }).sort(function (a, b) { return a[5] - b[5]; });
    return on[0];
  }
  function inLabel(min) {
    if (min < 60) return "in " + min + "m";
    var h = Math.floor(min / 60), m = min % 60;
    if (h < 48) return "in " + h + "h" + (m ? " " + m + "m" : "");
    return "in " + Math.round(h / 24) + " days";
  }
  function hl(text, q) {
    if (!q) return esc(text);
    var i = text.toLowerCase().indexOf(q.toLowerCase());
    return i < 0 ? esc(text) : esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
  }
  function tplBody(s) {
    var t = TPL[s[6]], name = s[0].split(": ")[1] || "";
    var body = t.body.replace(/\{\{url\}\}/g, "https://" + (s[7] || "example") + ".com/" + (s[6] === "pricing" ? "pricing" : s[6] === "hiring" ? "careers" : s[6] === "docs" ? "docs" : "changelog"))
      .replace(/\{\{slug\}\}/g, s[7]).replace(/\{\{name\}\}/g, name);
    return esc(body).replace(/\{\{(\w+)\}\}/g, '<span class="var">{{$1}}</span>');
  }

  /* ---------- outputs ---------- */
  // [file, agent, ago, size, unread]
  var OUTS = [
    ["report-2026-11-04.md", "Researcher", "2h", "3.1 KB", false],
    ["digest-2026-11-04.md", "Writer", "2h", "1.4 KB", true],
    ["report-2026-11-02.md", "Researcher", "2d", "2.6 KB", false],
    ["digest-2026-10-30.md", "Writer", "5d", "1.3 KB", false],
    ["report-2026-10-29.md", "Researcher", "6d", "2.2 KB", false],
    ["pricing-linear-2026-10-29.md", "Researcher", "6d", "0.9 KB", false],
    ["report-2026-10-26.md", "Researcher", "Oct 26", "2.4 KB", false],
    ["digest-2026-10-23.md", "Writer", "Oct 23", "1.2 KB", false],
    ["report-2026-10-22.md", "Researcher", "Oct 22", "2.0 KB", false],
    ["report-2026-10-19.md", "Researcher", "Oct 19", "2.7 KB", false],
    ["competitors.csv", "Lead", "Oct 16", "0.6 KB", false],
    ["scope.md", "Lead", "Oct 16", "1.8 KB", false],
  ];
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function dateOf(file) {
    var m = file.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return "";
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return DAYS[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()];
  }
  var PREVIEW = {
    "report-2026-11-04.md": '<h3>Competitor scan, Wednesday 4 November</h3><p class="md-sub">Manual run, asked by Taras in Slack #market-intel. 10 competitors checked, 3 changed.</p>' +
      "<h4>What changed</h4><table><thead><tr><th>Competitor</th><th>Change</th><th>Source</th></tr></thead><tbody>" +
      '<tr><td class="co">Linear</td><td>Business plan <span class="was">$14</span> $16 per seat. The free tier keeps 250 issues.</td><td><a href="#src">pricing</a></td></tr>' +
      '<tr><td class="co">Plane</td><td>Time tracking ships in the open-source edition.</td><td><a href="#src">changelog</a></td></tr>' +
      '<tr><td class="co">Height</td><td>The public roadmap page is gone.</td><td><a href="#src">site</a></td></tr></tbody></table>' +
      "<h4>Worth a look</h4><p>Two of the three now bundle an AI agent with the paid plan. Linear calls it Triage Intelligence and keeps it on Business only.</p>" +
      "<h4>No change</h4><p>Notion, Shortcut, Asana, ClickUp, Jira, Monday and Trello.</p>" +
      "<h4>Next</h4><ul><li>The digest for #market-intel waits for your approval.</li><li>The next scheduled scan is Thursday at 09:00.</li></ul>",
    "digest-2026-11-04.md": '<h3>Market intel digest, week 45</h3><p class="md-sub">Draft for #market-intel. It posts after a person approves it.</p>' +
      "<ul><li><b>Linear</b> raised the Business plan to $16 per seat.</li><li><b>Plane</b> ships time tracking in its free edition.</li><li><b>Height</b> took its public roadmap down.</li><li><b>Notion</b> added two AI templates for project tracking.</li><li><b>Jira</b> moved Rovo to every paid plan.</li></ul>" +
      '<p>Sources: <a href="#r1">report-2026-11-04.md</a>, <a href="#r2">report-2026-11-02.md</a>.</p>',
    "report-2026-11-02.md": '<h3>Competitor scan, Monday 2 November</h3><p class="md-sub">Scheduled run. 10 competitors checked, 2 changed.</p>' +
      "<h4>What changed</h4><table><thead><tr><th>Competitor</th><th>Change</th><th>Source</th></tr></thead><tbody>" +
      '<tr><td class="co">Notion</td><td>Two AI templates for project tracking.</td><td><a href="#src">changelog</a></td></tr>' +
      '<tr><td class="co">Jira</td><td>Rovo is now on every paid plan, not only Premium.</td><td><a href="#src">pricing</a></td></tr></tbody></table>' +
      "<h4>Next</h4><p>The next scheduled scan is Thursday at 09:00.</p>",
    "scope.md": '<h3>Scope: competitor research</h3><p class="md-sub">Written by the Lead in the planning session, 16 October.</p>' +
      "<h4>Goal</h4><p>Know within a day when a competitor changes its prices, its plans or its product.</p>" +
      "<h4>Competitors</h4><p>Linear, Notion, Plane, Height, Shortcut, Asana, ClickUp, Jira, Monday and Trello. The list lives in <code>competitors.csv</code>.</p>" +
      "<h4>Outputs</h4><ul><li><code>report-{date}.md</code> after each scan.</li><li><code>digest-{date}.md</code> every Friday, posted to #market-intel after approval.</li></ul>",
    "competitors.csv": '<h3>competitors.csv</h3><p class="md-sub">10 rows, 3 columns.</p><table><thead><tr><th>Name</th><th>Pricing page</th><th>Tracked plan</th></tr></thead><tbody>' +
      CO.map(function (c) { return '<tr><td class="co">' + c + '</td><td><a href="#src">' + c.toLowerCase() + ".com/pricing</a></td><td>" + (c === "Linear" || c === "Plane" ? "Business" : "Team") + "</td></tr>"; }).join("") + "</tbody></table>",
  };
  function previewOf(file) {
    if (PREVIEW[file]) return PREVIEW[file];
    if (file.indexOf("report-") === 0) return "<h3>Competitor scan, " + dateOf(file) + '</h3><p class="md-sub">Scheduled run. 10 competitors checked, no change.</p><p>Every pricing, changelog and docs page matches the last report. Nothing to act on.</p>';
    if (file.indexOf("digest-") === 0) return "<h3>Market intel digest, " + dateOf(file) + '</h3><p class="md-sub">Posted to #market-intel after approval.</p><ul><li>No price changes this week.</li><li><b>ClickUp</b> renamed its Business plan to Business Plus.</li></ul>';
    return "<h3>Linear pricing, " + dateOf(file) + '</h3><p class="md-sub">Pricing page diff.</p><p>Business plan: $14 per seat. No change since the last check.</p>';
  }

  /* ---------- sessions (the list tab) ---------- */
  // [unread, title, activity, time, source, agent letter]
  var SESS = [
    [1, "Competitor scan · manual run", "run", "4m", null, "R"],
    [1, "Competitor scan · manual run", "needs", "2h", null, "R"],
    [0, "Competitor scan · Mon 09:00", "", "2d", null, "R"],
    [0, "Add Plane's self-hosted pricing page to the scan", "", "3d", "slack", "R"],
    [0, "Planning: competitor research", "", "5d", null, "R"],
    [0, "Competitor scan · Thu 09:00", "", "6d", null, "R"],
    [0, "Competitor scan · Mon 09:00", "", "Oct 26", null, "R"],
    [0, "Competitor scan · Thu 09:00", "", "Oct 22", null, "R"],
    [0, "Competitor scan · Mon 09:00", "", "Oct 19", null, "R"],
  ];
  var E2E = [
    [1, "Fix flaky e2e in ui-e2e", "run", "12m", null, "C"],
    [1, "Settings page test times out on CI", "", "1h", "slack", "C"],
    [0, "Add a smoke test for the Overview tab", "", "3h", null, "C"],
    [0, "Retry the visual diff on the sessions page", "", "1d", null, "C"],
    [0, "Bump Playwright to 1.58", "", "2d", null, "C"],
    [0, "Why does the login test fail on Mondays?", "", "4d", "slack", "C"],
    [0, "Seed two users for the invite flow test", "", "6d", null, "C"],
  ];

  /* ---------- shell pieces ---------- */
  function tree(active) {
    function row(key, icon, label, tail) {
      return '<a class="trow' + (active === key ? " on" : "") + '" href="#g-' + key + '">' + I(icon) + '<span class="lab">' + label + "</span>" + tail + "</a>";
    }
    return '<aside class="stree"><div class="stree-h"><h2>Sessions</h2><button class="btn xs ghost" type="button">' + I("i-history") + "Legacy sessions</button></div>" +
      '<div class="stree-b"><span class="field sm">' + I("i-search") + "Search sessions<kbd>/</kbd></span>" +
      '<a class="trow" href="#new">' + I("i-plus") + '<span class="lab">New session</span></a>' +
      '<div class="tsec">My groups<span class="c">5</span></div>' +
      row("competitor-research", "i-star-fill star", "competitor-research", '<span class="needs">1</span>') +
      row("release-notes", "i-folder-open", "release-notes", '<span class="c">5</span>') +
      row("oncall-triage", "i-folder-open", "oncall-triage", '<span class="c">8</span>') +
      row("ui-e2e", "i-folder-open", "ui-e2e", '<span class="c">7</span>') +
      row("nogroup", "i-message-square", "No group", '<span class="c">31</span>') +
      '<div class="tsec">Shared with me<span class="c">1</span></div>' +
      row("design-reviews", "i-folder-open", "design-reviews", '<span class="c">3</span>') +
      "</div></aside>";
  }

  function tabstrip(st) {
    function tab(id, cls, icon, label, title, closable) {
      var on = st.tab === id;
      return '<div class="tab' + cls + '" role="tab" tabindex="' + (on ? 0 : -1) + '" aria-selected="' + on + '" data-act="tab" data-tab="' + id + '" title="' + title + '">' +
        I(icon) + '<span class="lab">' + label + "</span>" +
        (closable ? '<span class="tx" title="Close tab">' + I("i-x") + "</span>" : I("i-pin pin")) + "</div>";
    }
    var h = '<div class="tabstrip" role="tablist" aria-label="Main pane tabs">';
    if (st.group === "competitor-research") {
      h += tab("overview", " pinned", "i-layout-dashboard", "Overview", "competitor-research: Overview. Pinned while the group is open.", false);
      h += tab("list", "", "i-hash", "competitor-research", "competitor-research", true);
    } else {
      h += tab("list", "", "i-hash", st.group, st.group, true);
    }
    h += tab("s1", "", "i-message-square", "Fix flaky e2e in ui-e2e", "Fix flaky e2e in ui-e2e", true);
    return h + '<span class="add" title="New session">' + I("i-plus") + "</span></div>";
  }

  function titleRow(st, withNeeds) {
    var uc = st.group === "competitor-research";
    return '<div class="gt-h">' + I("i-hash") + "<h2>" + st.group + '</h2><span class="n">' + (uc ? 12 : 7) + "</span>" +
      '<button class="starb" type="button" aria-label="' + (uc ? "Unstar group" : "Star group") + '" title="' + (uc ? "Starred: shows on Home" : "Star: show on Home") + '">' + I(uc ? "i-star-fill" : "i-star") + "</button>" +
      (withNeeds ? '<a class="needs" href="#needs" data-act="tab" data-tab="list" title="Open the list, filtered to Needs you">1 needs you' + I("i-chevron-right") + "</a>" : "") +
      (uc ? '<span class="key">shared/competitor-research/</span>' : "") + "</div>";
  }

  /* ---------- Overview pieces ---------- */
  function nextBar(st, list) {
    var n = nextOf(st, list);
    var big = list.length > 3;
    var menu = sorted(list).filter(function (s) { return isOn(st, s); }).slice(0, 5);
    return '<div class="ov-next">' +
      '<span class="k">' + I("i-clock") + "Next run</span>" +
      '<span class="when"><b>' + n[4].replace("today ", "Today ") + '</b><span class="in">' + inLabel(n[5]) + "</span></span>" +
      '<span class="vr"></span>' +
      '<span class="what"><a href="#s">' + esc(n[0]) + '</a><span class="m">' + n[1] + " · " + n[2] + "</span></span>" +
      '<span class="sp"></span>' +
      '<a class="last" href="#last" title="' + (big ? "Social mentions: Monday, today 14:30" : "Competitor scan · manual run, today 12:40") + '">' + '<span class="st done">' + I("i-check") + "</span>Last run " + (big ? "16m" : "2h") + " ago</a>" +
      '<span class="vr"></span>' +
      '<span class="onl"><button class="sw md" type="button" role="switch" aria-checked="' + isOn(st, n) + '" aria-label="' + esc(n[0]) + ' enabled" data-act="sw" data-id="' + esc(n[0]) + '"></button>Enabled</span>' +
      '<span class="split"><button class="btn primary" type="button">' + I("i-play") + "Run now</button>" +
      '<button class="btn primary" type="button" aria-label="Run another schedule" aria-haspopup="menu" aria-expanded="' + !!st.menu + '" data-act="menu">' + I("i-chevron-down") + "</button></span>" +
      '<div class="ov-menu" role="menu"' + (st.menu ? "" : " hidden") + '><div class="mh">Run a schedule now</div>' +
      menu.map(function (s, i) {
        return '<button class="mi' + (i === 0 ? " hl" : "") + '" type="button" role="menuitem">' + I("i-play") + '<span class="t">' + esc(s[0]) + '</span><span class="m">' + s[4] + "</span></button>";
      }).join("") +
      (list.length > 5 ? '<div class="ms"></div><button class="mi" type="button" role="menuitem">' + I("i-search") + '<span class="t">Find another of ' + list.length + " schedules</span></button>" : "") +
      "</div></div>";
  }

  function schedRows(st, list, phone) {
    var q = st.q.trim().toLowerCase();
    var rows = sorted(list).filter(function (s) { return !q || (s[0] + " " + s[1] + " " + s[2]).toLowerCase().indexOf(q) >= 0; });
    var h = phone ? "" : '<div class="ov-sh" role="presentation"><span>Schedule</span><span class="r">Next run</span><span class="r">On</span></div>';
    if (!rows.length) return h + '<div class="ov-empty">No schedule matches "' + esc(st.q) + '". Search looks at names, cadences and agents.</div>';
    rows.forEach(function (s, i) {
      var on = isOn(st, s), id = "tpl-" + st.uid + "-" + i, open = !!st.open[s[0]];
      h += '<div class="ov-sr' + (on ? "" : " off") + (st.hov === s[0] ? " hov" : "") + '" role="listitem">' +
        '<div class="tx"><div class="nm" title="' + esc(s[0]) + '">' + hl(s[0], q) + "</div>" +
        '<div class="sub"><span class="cad">' + (phone ? (on ? '<span class="next">' + s[4] + "</span>" : "Paused") : hl(s[1], q)) + '</span><i class="dotsep"></i><span>' + hl(s[2], q) + "</span>" +
        '<i class="dotsep"></i><button class="tplb2" type="button" aria-expanded="' + open + '" aria-controls="' + id + '" data-act="tpl" data-id="' + esc(s[0]) + '">Template' + I("i-chevron-right") + "</button></div></div>" +
        '<div class="nx">' + (phone
          ? '<button class="pb" type="button" aria-label="Run ' + esc(s[0]) + ' now">' + I("i-play") + "</button>"
          : '<span class="t' + (on && s[5] < 1440 ? " soon" : "") + '">' + (on ? s[4] : "Paused") + '</span><button class="btn xs runb" type="button" tabindex="-1">' + I("i-play") + "Run now</button>") + "</div>" +
        '<button class="sw" type="button" role="switch" aria-checked="' + on + '" aria-label="' + esc(s[0]) + ' enabled" data-act="sw" data-id="' + esc(s[0]) + '"></button></div>';
      if (open) {
        h += '<div class="ov-tpl" id="' + id + '"><div class="th">' + I("i-file-text") + "<b>Task template</b>read-only" +
          '<a href="#/schedules/edit">Edit in Schedules' + I("i-external") + "</a></div><pre>" + tplBody(s) + "</pre>" +
          '<div class="kv"><span>Agent <b>' + s[2] + "</b></span><span>Model tier <b>regular</b></span><span>Timeout <b>30 min</b></span><span>Writes to <b class=\"mono\">shared/competitor-research/</b></span></div></div>";
      }
    });
    return h;
  }

  var SCHED_LINK = '<a href="#/schedules?group=competitor-research">Open in Schedules' + I("i-external") + "</a>";
  function schedWidget(st, list) {
    var big = list.length >= 8;
    var on = list.filter(function (s) { return isOn(st, s); }).length;
    var q = st.q.trim().toLowerCase();
    var hits = list.filter(function (s) { return !q || (s[0] + " " + s[1] + " " + s[2]).toLowerCase().indexOf(q) >= 0; }).length;
    return '<section class="w" aria-label="Schedules"><div class="w-h">' + I("i-clock") + '<h3 class="w-t">Schedules</h3><span class="w-n num">' + list.length + "</span>" +
      '<button class="btn xs w-a2" type="button">' + I("i-plus") + "New schedule</button></div>" +
      (big ? '<div class="ov-tool"><label class="field">' + I("i-search") + '<input type="search" data-act="q" value="' + esc(st.q) + '" placeholder="Search ' + list.length + ' schedules" aria-label="Search schedules">' +
        '<button class="clr" type="button" aria-label="Clear search" data-act="clear"' + (st.q ? "" : " hidden") + ">" + I("i-x") + '</button></label><span class="cnt" data-r="cnt">' + (q ? hits + " of " + list.length : list.length + " schedules") + "</span></div>" : "") +
      '<div class="ov-sl' + (big ? " scroll" : "") + '" role="list" data-r="sl">' + schedRows(st, list) + "</div>" +
      '<div class="ov-wf" data-r="sf">' + on + " enabled · " + (list.length - on) + " paused<span class=\"sp\"></span>" + SCHED_LINK + "</div></section>";
  }

  function outRows(st, n, from) {
    return OUTS.slice(0, n || OUTS.length).map(function (o, i) {
      if (i < (from || 0)) return "";
      return '<button class="ov-or" type="button" data-act="out" data-i="' + i + '"' + (i === st.sel ? ' aria-current="true"' : "") + ">" +
        '<span class="u' + (o[4] ? " on" : "") + '"' + (o[4] ? ' title="New since your last visit"' : "") + "></span>" + I(o[0].slice(-4) === ".csv" ? "i-file-sheet" : "i-file-text") +
        '<span class="n">' + o[0] + '</span><span class="who">' + o[1] + '</span><span class="tm">' + o[2] + "</span></button>";
    }).join("");
  }

  function outWidget(st) {
    return '<section class="w grow" aria-label="Outputs"><div class="w-h">' + I("i-folder-open") + '<h3 class="w-t">Outputs</h3><span class="w-n num">' + OUTS.length + "</span>" +
      '<span class="w-n">· 1 new</span><a class="w-a" href="#/file?path=shared/competitor-research/">Open folder' + I("i-external") + "</a></div>" +
      '<div class="ov-ol scroll" role="list" data-r="ol">' + outRows(st) + "</div></section>";
  }

  function previewWidget(st) {
    var o = OUTS[st.sel];
    var from = o[0] === "report-2026-11-04.md" ? "Competitor scan · manual run" : o[1] === "Lead" ? "Planning: competitor research" : o[0].indexOf("digest") === 0 ? "Weekly digest · Fri 16:00" : "Competitor scan · scheduled run";
    return '<section class="w grow ov-pv" aria-label="Preview" data-r="pv"><div class="w-h">' + I(o[0].slice(-4) === ".csv" ? "i-file-sheet" : "i-file-text") + '<h3 class="w-t mono">' + o[0] + "</h3>" +
      '<span class="w-n">' + (/^\d/.test(o[2]) ? o[2] + " ago" : o[2]) + " · " + o[3] + '</span><a class="w-a" href="#/file">Open in Files' + I("i-external") + "</a></div>" +
      '<div class="ov-pb scroll"><article class="md">' + previewOf(o[0]) + "</article></div>" +
      '<div class="ov-pf"><span class="av ' + (o[1] === "Lead" ? "lead" : o[1] === "Writer" ? "a2" : "a1") + '">' + o[1][0] + "</span>" + o[1] + ' wrote it in <a href="#session">' + from + "</a></div></section>";
  }

  var REPLIES = [
    ["Added Plane's self-hosted pricing page to the scan. It starts on Thursday.", "3d"],
    ["The digest now posts on Fridays at 16:00, after your approval.", "5d"],
  ];
  function askWidget(st) {
    var o = OUTS[st.sel];
    return '<section class="w" aria-label="Ask the Lead"><div class="w-h">' + I("i-message-circle") + '<h3 class="w-t">Ask the Lead</h3><span class="w-n">Starts a session in this group</span></div>' +
      REPLIES.map(function (r) {
        return '<a class="ov-rp" href="#lead" title="Lead, ' + r[1] + ' ago">' + '<span class="av lead">L</span><span class="t">' + esc(r[0]) + '</span><span class="tm">' + r[1] + "</span></a>";
      }).join("") +
      '<div class="ov-cmp"><textarea rows="1" aria-label="Message to the Lead" placeholder="Ask a question or ask for a change"></textarea>' +
      '<div class="tb"><button class="att" type="button" aria-pressed="' + !!st.att + '" data-act="att" data-r="att" title="Attach the file you are reading">' + I("i-paperclip") + '<span class="n">' + o[0] + "</span></button>" +
      '<button class="sendb" type="button" aria-label="Send">' + I("i-arrow-up") + "</button></div></div></section>";
  }

  function overview(st, list) {
    return '<div class="ov scroll" role="tabpanel" aria-label="Overview">' + titleRow(st, true) + nextBar(st, list) +
      '<div class="ov-cols"><div class="ov-col">' + schedWidget(st, list) + outWidget(st) + "</div>" +
      '<div class="ov-col">' + previewWidget(st) + askWidget(st) + "</div></div></div>";
  }

  /* ---------- the list tab (today's chrome, as round 2 drew it) ---------- */
  function listTab(st) {
    var rows = st.group === "competitor-research" ? SESS : E2E;
    var h = '<div class="gt" role="tabpanel" aria-label="Session list">' + titleRow(st, false) +
      '<div class="lfb"><span class="field">' + I("i-search") + 'Search this group</span><div class="seg" role="radiogroup" aria-label="Show">' +
      '<button type="button" role="radio" aria-checked="true">All</button><button type="button" role="radio" aria-checked="false">Unread</button><button type="button" role="radio" aria-checked="false">Running</button><button type="button" role="radio" aria-checked="false">Needs you</button></div></div>';
    h += '<div class="grid"><div class="gr hd sess"><span>Title</span><span>Group</span><span>People</span><span>Activity</span><span>Time</span></div>';
    rows.forEach(function (s) {
      var act = s[2] === "run" ? '<span class="st runn sm" title="Running"></span>' : s[2] === "needs" ? '<span class="needs">Needs you</span>' : "";
      h += '<div class="gr sess"><span class="ttl' + (s[0] ? " u" : "") + '"><span class="rm' + (s[0] ? " u" : "") + '"></span>' + (s[4] ? I("i-message-circle") : "") + '<span class="tx">' + esc(s[1]) + '</span></span><span class="dim">' + st.group + "</span>" +
        '<span><span class="avs"><span class="av a1">' + s[5] + "</span>" + (s[4] || s[1].indexOf("Planning") === 0 ? '<span class="av lead">L</span>' : "") + "</span></span><span>" + act + '</span><span class="tm">' + s[3] + "</span></div>";
    });
    var n = st.group === "competitor-research" ? 12 : 7;
    h += '</div><div class="pager"><span>1–' + n + " of " + n + '</span><span class="sp"></span><span>Rows per page</span><span class="sel">50' + I("i-chevron-down") + '</span><button class="btn xs sq" type="button" disabled aria-label="Previous page">' + I("i-chevron-right flip") + '</button><button class="btn xs sq" type="button" disabled aria-label="Next page">' + I("i-chevron-right") + "</button></div></div>";
    return h;
  }

  function sessionTab() {
    return '<div class="gt" role="tabpanel" aria-label="Session"><div class="gt-h">' + I("i-message-square") + "<h2>Fix flaky e2e in ui-e2e</h2></div>" +
      '<p class="muted" style="margin:0;font-size:13px">A session tab. Not part of this mockup.</p></div>';
  }

  /* ---------- desk frame ---------- */
  var uid = 0;
  function desk(main) {
    var st = main._st;
    var list = st.count > 3 ? ALL : SMALL;
    var body = st.tab === "overview" ? overview(st, list) : st.tab === "list" ? listTab(st) : sessionTab();
    var tabs = st.group === "competitor-research" ? 3 : 2;
    main.innerHTML = '<div class="topbar"><div class="crumbs">Sessions' + I("i-chevron-right") + "<b>" + st.group + "</b>" + (st.tab === "overview" ? I("i-chevron-right") + "<b>Overview</b>" : "") +
      '</div><span class="sp"></span><span class="search">' + I("i-search") + "Search or jump to<kbd>⌘K</kbd></span><span class=\"me\">TY</span></div>" +
      '<div class="shell"><div class="shell-row">' + tree(st.group) + '<section class="pane">' + tabstrip(st) + body + "</section></div>" +
      '<div class="sbar"><span><kbd>/</kbd> search</span><span><kbd>?</kbd> keys</span><span class="sp"></span><span>' + tabs + " tabs</span></div></div>";
  }

  function wire(main) {
    var st = main._st;
    var list = function () { return st.count > 3 ? ALL : SMALL; };
    function refreshList() {
      var sl = main.querySelector('[data-r="sl"]');
      if (!sl) return;
      var top = sl.scrollTop;
      sl.innerHTML = schedRows(st, list());
      sl.scrollTop = top;
      var q = st.q.trim().toLowerCase(), all = list();
      var hits = all.filter(function (s) { return !q || (s[0] + " " + s[1] + " " + s[2]).toLowerCase().indexOf(q) >= 0; }).length;
      var cnt = main.querySelector('[data-r="cnt"]');
      if (cnt) cnt.textContent = q ? hits + " of " + all.length : all.length + " schedules";
      var on = all.filter(function (s) { return isOn(st, s); }).length;
      var sf = main.querySelector('[data-r="sf"]');
      if (sf) sf.innerHTML = on + " enabled · " + (all.length - on) + ' paused<span class="sp"></span>' + SCHED_LINK;
      var clr = main.querySelector('[data-act="clear"]');
      if (clr) clr.hidden = !st.q;
    }
    main.addEventListener("click", function (e) {
      var t = e.target.closest("[data-act]");
      if (!t || !main.contains(t)) return;
      var act = t.getAttribute("data-act");
      if (act === "tab") { e.preventDefault(); st.tab = t.getAttribute("data-tab"); st.menu = false; desk(main); return; }
      if (act === "out") {
        st.sel = +t.getAttribute("data-i"); OUTS[st.sel][4] = false;
        var pv = main.querySelector('[data-r="pv"]'); pv.outerHTML = previewWidget(st);
        main.querySelectorAll(".ov-or").forEach(function (b, i) {
          if (i === st.sel) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
          if (i === st.sel) b.querySelector(".u").className = "u";
        });
        var att = main.querySelector('[data-r="att"] .n'); if (att) att.textContent = OUTS[st.sel][0];
        return;
      }
      if (act === "tpl") { var id = t.getAttribute("data-id"); st.open[id] = !st.open[id]; refreshList(); return; }
      if (act === "sw") {
        var sid = t.getAttribute("data-id"), cur = list().filter(function (s) { return s[0] === sid; })[0];
        st.on[sid] = !isOn(st, cur); st.menu = false;
        var keep = main.querySelector('[data-r="sl"]'), top = keep ? keep.scrollTop : 0;
        var ovs = main.querySelector(".ov"), otop = ovs ? ovs.scrollTop : 0;
        desk(main);
        var sl2 = main.querySelector('[data-r="sl"]'); if (sl2) sl2.scrollTop = top;
        var ov2 = main.querySelector(".ov"); if (ov2) ov2.scrollTop = otop;
        return;
      }
      if (act === "menu") { st.menu = !st.menu; t.setAttribute("aria-expanded", st.menu); main.querySelector(".ov-menu").hidden = !st.menu; return; }
      if (act === "att") { st.att = !st.att; t.setAttribute("aria-pressed", st.att); return; }
      if (act === "clear") { st.q = ""; var inp = main.querySelector('[data-act="q"]'); inp.value = ""; refreshList(); inp.focus(); return; }
    });
    main.addEventListener("input", function (e) {
      if (e.target.getAttribute("data-act") !== "q") return;
      st.q = e.target.value; st.hov = null; refreshList();
    });
    main.addEventListener("keydown", function (e) {
      var t = e.target;
      if (t.getAttribute && t.getAttribute("role") === "tab" && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); t.click(); }
      if (e.key === "Escape" && st.menu) { st.menu = false; desk(main); }
    });
  }

  document.querySelectorAll("[data-frame]").forEach(function (main) {
    var kind = main.getAttribute("data-frame"), count = +main.getAttribute("data-count");
    var st = { uid: ++uid, count: count, group: kind === "plain" ? "ui-e2e" : "competitor-research", tab: kind === "overview" ? "overview" : "list", sel: 0, q: "", open: {}, on: {}, hov: null, menu: false, att: false };
    if (count > 3) { st.q = "pricing"; st.open["Pricing page diff: Notion"] = true; st.hov = "Pricing page diff: Height"; }
    main._st = st;
    desk(main);
    wire(main);
  });

  /* ---------- phone frames ---------- */
  function phoneTop(st) {
    return '<div class="psb"><span>9:41</span><span class="dots"><i></i><i></i></span></div>' +
      '<div class="ptop"><button class="back" type="button" aria-label="Back to Sessions">' + I("i-chevron-left") + '</button><span class="tt">competitor-research</span>' +
      '<button class="ib" type="button" aria-label="Unstar group">' + I("i-star-fill") + '</button><button class="ib" type="button" aria-label="More">' + I("i-more") + "</button></div>" +
      '<div class="ptabs" role="tablist" aria-label="competitor-research">' +
      '<button type="button" role="tab" aria-selected="' + (st.tab === "overview") + '" data-act="tab" data-tab="overview">Overview</button>' +
      '<button type="button" role="tab" aria-selected="' + (st.tab === "list") + '" data-act="tab" data-tab="list">Sessions<span class="n">12</span><span class="needs" title="1 needs you">1</span></button></div>';
  }

  function phoneOverview(st) {
    var n = nextOf(st, SMALL), o = OUTS[0];
    var h = '<div class="pscroll" role="tabpanel" aria-label="Overview"><div class="pov">';
    h += '<div class="p-next"><span class="k">' + I("i-clock") + "Next run</span>" +
      '<span class="onl"><button class="sw md" type="button" role="switch" aria-checked="true" aria-label="' + n[0] + ' enabled"></button>Enabled</span>' +
      '<span class="when"><b>' + n[4] + '</b><span class="in">' + inLabel(n[5]) + "</span></span>" +
      '<span class="what"><b>' + n[0] + "</b> · " + n[1] + "</span>" +
      '<span class="split"><button class="btn primary" type="button">' + I("i-play") + 'Run now</button><button class="btn primary" type="button" aria-label="Run another schedule">' + I("i-chevron-down") + "</button></span></div>";
    h += '<section class="w" aria-label="Outputs"><div class="w-h">' + I("i-folder-open") + '<h3 class="w-t">Outputs</h3><span class="w-n num">12</span><a class="w-a" href="#/file">Open folder</a></div>' +
      '<div class="ov-ol">' + '<button class="ov-or" type="button" aria-current="true"><span class="u"></span>' + I("i-file-text") + '<span class="n">' + o[0] + '</span><span class="tm">' + o[2] + "</span></button>" +
      '<div class="p-ex"><b>Competitor scan, Wednesday 4 November</b><p>Linear raised the Business plan to $16 per seat. Plane ships time tracking in its free edition. Height took its public roadmap down.</p>' +
      '<a href="#/file">Read the report' + I("i-chevron-right") + "</a></div>" +
      outRows({ sel: -1 }, 4, 1) +
      '</div><div class="ov-wf">Newest first<span class="sp"></span><a href="#/file">All 12 files' + I("i-chevron-right") + "</a></div></section>";
    h += '<section class="w" aria-label="Schedules" data-anchor="sched"><div class="w-h">' + I("i-clock") + '<h3 class="w-t">Schedules</h3><span class="w-n num">3</span><a class="w-a" href="#/schedules">Open</a></div>' +
      '<div class="ov-sl" role="list">' + schedRows(st, SMALL, true) + '</div><div class="ov-wf">2 enabled · 1 paused</div></section>';
    h += '<section class="w" aria-label="From the Lead"><div class="w-h">' + I("i-message-circle") + '<h3 class="w-t">From the Lead</h3><span class="w-n">last 2 replies</span></div>' +
      REPLIES.map(function (r) { return '<a class="ov-rp" href="#lead"><span class="av lead">L</span><span class="t">' + esc(r[0]) + '</span><span class="tm">' + r[1] + "</span></a>"; }).join("") + "</section>";
    h += "</div></div>";
    h += '<div class="p-cmp"><span class="field">' + I("i-message-circle") + 'Ask the Lead</span><button class="sendb" type="button" aria-label="Send">' + I("i-arrow-up") + "</button></div>";
    return h;
  }

  function phoneList() {
    var h = '<div class="pscroll" role="tabpanel" aria-label="Sessions"><div class="gt">';
    h += '<div class="lfb"><span class="field">' + I("i-search") + 'Search this group</span><div class="seg" role="radiogroup" aria-label="Show"><button type="button" role="radio" aria-checked="true">All</button><button type="button" role="radio" aria-checked="false">Unread</button><button type="button" role="radio" aria-checked="false">Running</button><button type="button" role="radio" aria-checked="false">Needs you</button></div></div>';
    h += '<div class="mrows">' + SESS.map(function (s) {
      var act = s[2] === "run" ? '<span class="st runn sm"></span>' : s[2] === "needs" ? '<span class="needs">Needs you</span>' : "";
      return '<div class="mrow' + (s[0] ? " u" : "") + '"><div class="l1"><span class="t">' + esc(s[1]) + "</span>" + act + I("i-chevron-right") + '</div><div class="l2">Researcher · ' + s[3] + "</div></div>";
    }).join("") + "</div></div></div>";
    return h;
  }

  function phone(el) {
    var st = el._st;
    el.innerHTML = phoneTop(st) + (st.tab === "overview" ? phoneOverview(st) : phoneList());
    if (el.getAttribute("data-scroll") === "sched" && st.tab === "overview") {
      var sc = el.querySelector(".pscroll"), a = el.querySelector('[data-anchor="sched"]');
      var go = function () { sc.scrollTop = a.offsetTop - 12; };
      go();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(go);
    }
  }

  document.querySelectorAll("[data-pframe]").forEach(function (el) {
    el._st = { uid: ++uid, tab: el.getAttribute("data-pframe"), q: "", open: {}, on: {}, hov: null, sel: 0 };
    phone(el);
    el.addEventListener("click", function (e) {
      var t = e.target.closest("[data-act]");
      if (!t) return;
      var act = t.getAttribute("data-act");
      if (act === "tab") { el._st.tab = t.getAttribute("data-tab"); phone(el); }
      if (act === "tpl") { var id = t.getAttribute("data-id"); el._st.open[id] = !el._st.open[id]; phone(el); }
      if (act === "sw") { var sid = t.getAttribute("data-id"), cur = SMALL.filter(function (s) { return s[0] === sid; })[0]; if (cur) { el._st.on[sid] = !isOn(el._st, cur); phone(el); } }
    });
  });
})();
