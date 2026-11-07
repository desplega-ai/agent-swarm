/* Post-onboarding UI spike, round 4: the Connect pages.
   Renders Channels, Tools and AI providers into every [data-k] host.
   Host attributes: data-k="channels|tools|ai", data-tab (Tools),
   data-how="<family>" (open How to), data-menu="<key>" (open row menu),
   data-drawer="<key>" (open key drawer). [data-dialog] renders the
   Remove confirm on its own. The AI providers data follows the API
   shapes named in the page's "Where the data comes from" section.
   Throwaway reference material: nothing ships. */
(function () {
  var I = R3.icon;
  var uid = 0;

  /* ---------- AI providers data ---------- */
  var FAMS = [
    {
      id: "claude", mark: "C", name: "Claude subscription", env: "CLAUDE_CODE_OAUTH_TOKEN", vendor: "Anthropic",
      noun: "token", col: "Token", sub: true, chip: '<span class="dchip warn">1 rate limited</span>',
      desc: "Claude Code agents bill your Claude plan instead of paying per token. Agents rotate across the tokens.",
      howLabel: "How to get a token",
      how:
        "<ol>" +
        '<li><span>On a computer with Claude Code, run this command.</span><span class="cmd"><span class="t">claude setup-token</span><button class="btn xs ghost sq" type="button" title="Copy" aria-label="Copy command">' + I("i-copy") + "</button></span></li>" +
        '<li><span>Copy the token that it prints. It starts with <code class="k">sk-ant-oat01-</code>.</span></li>' +
        "<li><span>Paste it in the Add row below. Add one token for each Claude account.</span></li>" +
        "</ol>" +
        '<div class="aside"><p>The swarm runs the unmodified Claude Code CLI. Anthropic documents setup tokens for CI and automation on your own subscription. Do not share a token across people or organizations.</p>' +
        "<p>A token wins over an Anthropic API key when both are set. No subscription? Add an Anthropic API key under Other providers. It bills per token.</p>" +
        '<p><a href="#/docs/harness-configuration">Harness configuration guide' + I("i-external") + "</a></p></div>",
      add: '<span class="field sm">' + I("i-key") + '<span class="ph">Paste a token from claude setup-token</span></span>'  + '<button class="btn" type="button">Add token</button>',
      note: "Costs show the API value of each run. Your plan bills a flat fee.",
      agentsNote: "4 agents run Claude Code. They rotate across the 3 tokens in this pool, and skip a token while it is limited.",
      agents: [["L", "Lead", "lead"], ["C", "coder-1", "worker"], ["C", "coder-2", "worker"], ["R", "reviewer", "worker"]],
      keys: [
        { id: "team-max", name: "team-max", sfx: "…a91f2", slot: 1, plan: "Claude Max 20x", src: "Set by you", price: "$200", today: "$18.40", week: "$212.90", total: "$2,906.10", tasks: "1,184", w5: 62, w7: 41, wo: 38, ws: 17, reset5: "15:40", last: "2 min ago", count: 3, lastLimit: "on 31 Oct at 16:05", checked: "13:41", k2: "Max 20x · today $18.40 · 5 h 62%",
          days: [34, 52, 41, 18, 22, 61, 70, 48, 55, 39, 66, 72, 58, 30] },
        { id: "taras-backup", name: "taras-backup", sfx: "…77c2a", slot: 2, plan: "Claude Max 5x", src: "Estimated", price: "$100", today: "$3.10", week: "$96.20", total: "$1,284.50", tasks: "412", w5: 100, w7: 78, wo: 64, ws: 22, limited: "14:20", last: "50 min ago", count: 7, lastLimit: "today at 13:08", checked: "12:55",
          days: [12, 20, 26, 9, 0, 31, 44, 38, 52, 47, 63, 70, 81, 14] },
        { id: "ops-pro", name: "ops-pro", sfx: "…c0de1", slot: 3, plan: "Claude Pro", src: "Set by you", price: "$20", today: "$0.80", week: "$11.30", total: "$96.40", tasks: "58", w5: 12, w7: 9, wo: 0, ws: 9, reset5: "17:10", last: "1 h ago", count: 0, checked: "13:20", k2: "Pro · today $0.80 · 5 h 12%",
          days: [4, 8, 2, 0, 0, 10, 6, 12, 5, 9, 14, 7, 11, 6] },
      ],
    },
    {
      id: "codex", mark: "X", name: "Codex subscription", env: "codex_oauth_<n>", vendor: "OpenAI",
      noun: "account", col: "Account", sub: true, chip: '<span class="dchip ok">2 signed in</span>',
      desc: "Codex agents bill your ChatGPT plan. Agents rotate across the signed-in accounts.",
      howLabel: "How to sign in",
      how:
        "<ol>" +
        "<li><span>In ChatGPT, open Settings, Security and turn on “Allow device code login”.</span></li>" +
        "<li><span>Click Sign in with ChatGPT below and enter the code on the ChatGPT page.</span></li>" +
        '<li><span>Do it again for each account. Each one adds a slot: <code class="k">codex_oauth_0</code>, <code class="k">codex_oauth_1</code> and so on.</span></li>' +
        "</ol>" +
        '<div class="aside"><p>Device login failed, or no browser here? Run this on a machine with a browser:</p>' +
        '<span class="cmd"><span class="t">npx @desplega.ai/agent-swarm codex-login --api-url https://api.acme.agent-swarm.dev</span><button class="btn xs ghost sq" type="button" title="Copy" aria-label="Copy command">' + I("i-copy") + "</button></span>" +
        '<p><a href="#/docs/codex-oauth">Codex OAuth guide' + I("i-external") + "</a></p></div>",
      add: '<button class="btn" type="button">' + I("i-log-in") + 'Sign in with ChatGPT</button><span class="or">or run codex-login on a machine with a browser</span>',
      note: "Costs show the API value of each run. Your plan bills a flat fee.",
      limitsHead: 'Usage windows <span class="nys" title="Codex does not report its usage windows to the swarm">Not yet supported</span>',
      agentsNote: "2 agents run Codex. They rotate across the 2 accounts in this pool.",
      agents: [["C", "coder-3", "worker"], ["E", "evals-runner", "worker"]],
      keys: [
        { id: "taras-chatgpt", name: "taras@acme.dev", sfx: "slot 0", slot: 1, plan: "ChatGPT Pro 20x", src: "Detected", price: "$200", today: "$22.70", week: "$160.40", total: "$1,902.80", tasks: "733", last: "6 min ago", count: 1, lastLimit: "on 28 Oct at 11:42", checked: "13:50", k2: "Pro 20x · today $22.70",
          days: [40, 28, 33, 12, 9, 47, 52, 61, 44, 38, 57, 49, 66, 41] },
        { id: "ops-chatgpt", name: "ops@acme.dev", sfx: "slot 1", slot: 2, plan: "ChatGPT Plus", src: "Detected", price: "$20", today: "$1.20", week: "$14.80", total: "$88.10", tasks: "64", last: "3 h ago", count: 0, checked: "13:50", k2: "Plus · today $1.20",
          days: [6, 3, 9, 0, 0, 4, 12, 7, 10, 2, 8, 14, 5, 3] },
      ],
    },
    {
      id: "openrouter", mark: "R", name: "OpenRouter", env: "OPENROUTER_API_KEY", vendor: "OpenRouter",
      noun: "key", col: "Key", sub: false, chip: '<span class="dchip ok">Healthy</span>',
      desc: "Claude, Gemini, GPT, Mistral and more through one key, for pi, opencode and fx agents.",
      howLabel: "How to get a key",
      how:
        "<ol>" +
        '<li><span>Create a key at <a href="https://openrouter.ai/settings/keys">openrouter.ai/settings/keys' + I("i-external") + "</a>.</span></li>" +
        '<li><span>Paste it in the Add row below. It starts with <code class="k">sk-or-</code>.</span></li>' +
        "</ol>" +
        '<div class="aside"><p>To send this traffic through your own OpenAI-compatible gateway, set <code class="k">OPENROUTER_BASE_URL</code> in Settings › Configuration › Harness &amp; tools. The gateway must serve <code class="k">/models</code> and <code class="k">/chat/completions</code>.</p>' +
        '<p><a href="#/docs/model-gateways">Model gateways guide' + I("i-external") + "</a></p></div>",
      add: '<span class="field sm">' + I("i-key") + '<span class="ph">Paste an OpenRouter key</span></span>'  + '<button class="btn" type="button">Add key</button>',
      note: 'Base URL <span class="mono">openrouter.ai/api/v1</span> · <a class="ln" href="#/settings/configuration">Change in Configuration</a>',
      limitsHead: "No usage windows: billed per token",
      agentsNote: "3 agents run pi or opencode. They rotate across the 2 keys in this pool.",
      agents: [["P", "pi-researcher", "worker"], ["O", "opencode-1", "worker"], ["W", "writer", "worker"]],
      keys: [
        { id: "or-default", name: "default", sfx: "…3e0b7", slot: 1, plan: "Pay per token", today: "$9.80", week: "$41.20", total: "$612.30", tasks: "905", last: "4 min ago", count: 0, checked: "13:44", k2: "Today $9.80 · 7 d $41.20",
          days: [12, 18, 9, 4, 3, 21, 16, 25, 19, 11, 22, 17, 28, 20] },
        { id: "or-evals", name: "evals", sfx: "…91ad0", slot: 2, plan: "Pay per token", today: "$0.00", week: "$3.60", total: "$27.90", tasks: "41", last: "2 days ago", count: 0, checked: "13:44", k2: "Today $0.00 · 7 d $3.60",
          days: [0, 2, 6, 0, 0, 0, 8, 3, 0, 5, 0, 1, 0, 0] },
      ],
    },
  ];
  var KEY = {}, FAM = {};
  FAMS.forEach(function (f) { FAM[f.id] = f; f.keys.forEach(function (k) { KEY[k.id] = [k, f]; }); });

  var OTHERS = [
    ["A", "Anthropic API key", "ANTHROPIC_API_KEY · Claude Code", "Billed per token. Create a key at <i>console.anthropic.com</i>.", "Add key"],
    ["O", "OpenAI", "OPENAI_API_KEY · Codex, fx", "Used when no ChatGPT sign-in is stored. One key, no rotation.", "Add key"],
    ["V", "Vercel AI Gateway", "AI_GATEWAY_API_KEY · pi, opencode, fx", "Every AI Gateway chat model, including Token Pass credit.", "Add key"],
    ["N", "NaN", "NAN_API_KEY · pi, opencode", "Open-weight models such as GLM, Qwen and DeepSeek.", "Add key"],
    ["H", "Helmcode", "HELMCODE_API_KEY · pi, opencode", "Open-weight models. Org plans include 5, 15 or 40 keys.", "Add key"],
    ["B", "Amazon Bedrock", "AWS_REGION + AWS keys · Claude Code, pi", "Your AWS account. Checked only when a task runs.", "Set up"],
    ["G", "Your own gateway", "OPENROUTER_BASE_URL · pi, opencode", "Any OpenAI-compatible chat completions endpoint.", "Configure"],
    ["M", "Claude Managed Agents", "MANAGED_AGENT_ID · claude-managed", "Runs tasks in Anthropic's cloud sandbox.", "Set up"],
  ];
  var SERVICES = [
    ["E", "Memory embeddings", "EMBEDDING_API_KEY · memory recall", "Any OpenAI-compatible embeddings endpoint.", "Edit", '<span class="dchip ok">Configured</span>'],
    ["T", "Transcription", "TRANSCRIPTION_PROVIDER · chat channels", "Voice notes into task text with ElevenLabs, OpenAI or Groq.", "Set up", '<span class="dchip">Not set</span>'],
  ];
  var UNSUP = [
    ["Google Gemini", "GEMINI_API_KEY", "pi"],
    ["xAI Grok", "XAI_API_KEY", "grok, API key only"],
    ["DeepSeek", "DEEPSEEK_API_KEY", "dsh"],
    ["Amp", "AMP_API_KEY", "amp"],
    ["Cursor", "CURSOR_API_KEY", "cursor"],
    ["Claude Code via a gateway", "ANTHROPIC_BASE_URL", "LiteLLM, CLIProxyAPI"],
    ["Microsoft Foundry", "CLAUDE_CODE_USE_FOUNDRY", "Claude Code"],
    ["Google Vertex AI", "CLAUDE_CODE_USE_VERTEX", "Claude Code"],
  ];

  /* ---------- small builders ---------- */
  function meter(lab, v) {
    return '<span class="mt' + (v >= 75 ? " hi" : "") + '">' + lab + '<span class="bar"><i style="--v:' + v + '%"></i></span><span class="v">' + v + "%</span></span>";
  }
  function limits(k) {
    if (k.w5 == null) return "";
    return '<span class="mts">' + meter("5 h", k.w5) + meter("7 d", k.w7) + "</span>";
  }
  function keyRow(k, f) {
    var k2 = k.limited ? '<span class="k2 warn">' + I("i-timer") + "Rate limited, back at " + k.limited + "</span>" : '<span class="k2">' + k.k2 + "</span>";
    var plan = f.sub ? k.plan + "<small>" + k.src + "</small>" : '<span class="dim">' + k.plan + "</span>";
    return '<div class="gr" data-key="' + k.id + '">' +
      '<span class="kc"><span class="dot' + (k.limited ? " warn" : "") + '" title="' + (k.limited ? "Rate limited" : "Available") + '"></span><span class="tx"><button class="kn" type="button">' + k.name + '</button><span class="sfx">' + k.sfx + "</span>" + k2 + "</span></span>" +
      '<span class="hp-hide plan">' + plan + "</span>" +
      '<span class="hp-hide num">' + k.today + '</span><span class="hp-hide num">' + k.week + "</span>" +
      '<span class="hp-hide">' + limits(k) + "</span>" +
      '<span class="hp-hide dim">' + k.last + "</span>" +
      '<span class="rmc"><button class="rm" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Actions for ' + k.name + '">' + I("i-more") + "</button></span></div>";
  }
  function family(f, howOpen) {
    var n = ++uid, open = howOpen === f.id;
    return '<section class="fam' + (open ? " how-open" : "") + '" data-fam="' + f.id + '" aria-labelledby="fam-' + n + '">' +
      '<div class="fam-h"><span class="mark">' + f.mark + "</span>" +
      '<div class="fam-t"><h2 id="fam-' + n + '">' + f.name + f.chip + "</h2><p>" + f.desc + "</p></div>" +
      '<div class="fam-r">' +
      '<button class="btn ghost howbtn" type="button" aria-expanded="' + open + '" aria-controls="how-' + n + '" title="' + f.howLabel + '">' + I("i-help") + '<span class="bl">' + f.howLabel + "</span>" + I("i-chevron-down") + "</button></div></div>" +
      '<div class="how" id="how-' + n + '">' + f.how + '<p class="cfg">Stored as <code class="k">' + f.env.replace("<", "&lt;").replace(">", "&gt;") + "</code>" + (f.id === "codex" ? ", one slot per account." : ", one entry per " + f.noun + ".") + "</p></div>" +
      '<div class="kt"><div class="gr hd"><span>' + f.col + '</span><span class="hp-hide">Plan</span><span class="hp-hide num">Today</span><span class="hp-hide num">7 days</span><span class="hp-hide lh">' + (f.limitsHead || "Usage limits") + '</span><span class="hp-hide">Last used</span><span></span></div>' +
      f.keys.map(function (k) { return keyRow(k, f); }).join("") + "</div>" +
      '<div class="fam-add">' + f.add + '<span class="fnote">' + f.note + "</span></div></section>";
  }
  function oitem(o) {
    return '<div class="oi"><span class="mark">' + o[0] + '</span><div class="t"><div class="t1"><b>' + o[1] + "</b>" + (o[5] || "") + '</div><div class="t2">' + o[3] + '</div><div class="t3">' + o[2] + "</div></div>" +
      '<button class="btn xs" type="button">' + o[4] + "</button></div>";
  }
  function aiPage(host) {
    var h = '<div class="fams">' + FAMS.map(function (f) { return family(f, host.getAttribute("data-how")); }).join("") + "</div>";
    h += '<div class="sec-h"><h2>Other providers</h2><p>Supported, not set up yet. Add a key to start using one.</p></div>';
    h += '<div class="opanel"><div class="olist">' + OTHERS.map(oitem).join("") + "</div>" +
      '<div class="osub">Swarm services <span>· the API server calls these, not the agents</span></div><div class="olist">' + SERVICES.map(oitem).join("") + "</div></div>";
    h += '<div class="unsup"><div class="unsup-h"><h3>Not on this page yet</h3><span class="nys">Not yet supported</span></div>' +
      "<p>These work today through the worker environment or a swarm secret in Settings › Advanced › Secrets. This page cannot add, pool or track them yet.</p>" +
      '<ul class="ugrid">' + UNSUP.map(function (u) { return "<li><b>" + u[0] + "</b><span><code>" + u[1] + "</code> · " + u[2] + "</span></li>"; }).join("") + "</ul></div>";
    return h;
  }

  /* ---------- row menu ---------- */
  function mi(icon, label, hint, cls, act) {
    return '<button class="mi' + (cls ? " " + cls : "") + '" type="button" role="menuitem"' + (act ? ' data-act="' + act + '"' : "") + ">" + I(icon) + label + (hint ? '<span class="hint">' + hint + "</span>" : "") + "</button>";
  }
  function closeMenus(scope) {
    (scope || document).querySelectorAll(".menu").forEach(function (m) { m.remove(); });
    (scope || document).querySelectorAll('.rm[aria-expanded="true"]').forEach(function (b) { b.setAttribute("aria-expanded", "false"); });
  }
  function openMenu(btn, highlight, anim) {
    closeMenus(btn.closest("[data-k]"));
    var row = btn.closest(".gr"), kf = KEY[row.getAttribute("data-key")], k = kf[0], f = kf[1];
    var h = '<div class="menu' + (anim ? " anim" : "") + '" role="menu" aria-label="Actions for ' + k.name + '" data-key="' + k.id + '">' + mi("i-pencil", "Rename", "", "", "rename");
    if (f.sub) h += mi("i-card", "Set plan", k.plan.replace(/^(Claude|ChatGPT) /, ""), "", "plan");
    if (k.limited) h += mi("i-rotate-ccw", "Clear rate limit", "back " + k.limited, highlight ? "hl" : "", "clear");
    h += '<div class="msep" role="separator"></div>' + mi("i-trash", "Remove " + f.noun + "…", "", "danger", "remove") + "</div>";
    btn.insertAdjacentHTML("afterend", h);
    btn.setAttribute("aria-expanded", "true");
  }

  /* ---------- drawer ---------- */
  function sbtn(icon, label, attr) { return '<button class="btn" type="button"' + (attr || "") + ">" + I(icon) + label + "</button>"; }
  function drawerHTML(k, f) {
    var lim = k.limited, max = Math.max.apply(null, k.days);
    var h = '<div class="dw-h"><div class="dw-t"><span class="mark sm">' + f.mark + "</span><h2>" + k.name + '</h2><span class="sfx">' + k.sfx + "</span>" +
      (lim ? '<span class="dchip warn">Rate limited</span>' : '<span class="dchip ok">Available</span>') +
      '<button class="btn ghost sq x" type="button" data-close aria-label="Close">' + I("i-x") + "</button></div>" +
      '<p class="dw-sub">' + f.name + ' · <span class="mono">' + f.env.replace("<", "&lt;").replace(">", "&gt;") + "</span> · slot " + k.slot + " of " + f.keys.length + "</p>" +
      '<div class="dw-acts">' + sbtn("i-pencil", "Rename") + (f.sub ? sbtn("i-card", "Set plan") : "") + (lim ? sbtn("i-rotate-ccw", "Clear rate limit") : "") + "</div></div>";
    h += '<div class="dw-b">';
    if (lim) {
      h += '<div class="callout">' + I("i-timer") + "<div><p><b>Limited by the 5 h session window until " + lim + ".</b> Agents use the other " + (f.keys.length - 1) + " tokens until then.</p>" +
        "<p>Clear the limit only if you know the window has reset. Agents then try this token on their next task.</p></div></div>";
    }
    h += '<section class="dw-sec"><h3>Usage<span class="hint">' + (f.sub ? "API value of the runs. The plan bills a flat fee." : "Billed per token") + "</span></h3>" +
      '<div class="stats"><div><span>Today</span><b>' + k.today + "</b></div><div><span>7 days</span><b>" + k.week + "</b></div><div><span>All time</span><b>" + k.total + "</b></div><div><span>Tasks</span><b>" + k.tasks + "</b></div></div>" +
      '<div class="chart-h">Last 14 days<span class="nys">Not yet supported</span></div><div class="chart" role="img" aria-label="Daily cost, last 14 days">' +
      k.days.map(function (d, i) { return '<i style="--h:' + Math.round((d / max) * 100) + '%"' + (i === k.days.length - 1 ? ' class="now"' : "") + "></i>"; }).join("") +
      '</div><div class="chart-x"><span>22 Oct</span><span>Today</span></div></section>';
    h += '<section class="dw-sec"><h3>Plan and limits</h3><dl class="kv"><dt>Plan</dt><dd>' + (f.sub ? k.plan + "<small>" + (k.src === "Estimated" ? "Estimated from weekly use" : k.src) + "</small>" : "Pay per token") + "</dd>" +
      (f.sub ? "<dt>List price</dt><dd>" + k.price + " a month</dd>" : "") + "</dl>";
    if (f.id === "claude") {
      var win = [["Session, 5 h", k.w5, lim ? "back " + lim : "resets " + k.reset5], ["Week, all models", k.w7, "resets Sat 09:00"], ["Week, Opus", k.wo, "resets Sat 09:00"], ["Week, Sonnet", k.ws, "resets Sat 09:00"]];
      h += '<ul class="wins">' + win.map(function (w) {
        return '<li><span class="wl">' + w[0] + '</span><span class="mt lg' + (w[1] >= 75 ? " hi" : "") + '"><span class="bar"><i style="--v:' + w[1] + '%"></i></span></span><span class="wr' + (w[1] >= 100 ? " hot" : "") + '"><b>' + w[1] + "%</b> · " + w[2] + "</span></li>";
      }).join("") + "</ul>";
    } else if (f.id === "codex") {
      h += '<p class="nysl"><span class="nys">Not yet supported</span>5 h and 7 d bars. Codex does not report its usage windows to the swarm.</p>';
    } else {
      h += '<p class="dw-p">OpenRouter applies its own credit limits. The swarm records a limit when OpenRouter rejects a call.</p>';
    }
    h += "</section>";
    h += '<section class="dw-sec"><h3>Rate-limit record</h3><ul class="notes">' +
      (lim ? '<li class="warn">' + I("i-timer") + "<span>Limited now, back at " + lim + ". Agents skip this " + f.noun + " until then.</span></li>" : "") +
      "<li>" + I("i-history") + "<span>" + (k.count ? "Last limit " + k.lastLimit + ". " + k.count + (k.count === 1 ? " limit" : " limits") + " since this " + f.noun + " was added." : "No limits since this " + f.noun + " was added.") + "</span></li>" +
      "<li>" + I("i-check") + "<span>Last live check at " + k.checked + ". " + f.vendor + " accepted the " + f.noun + ".</span></li></ul>" +
      '<p class="nysl"><span class="nys">Not yet supported</span>A dated list of every limit. The API keeps the count and the last one only.</p></section>';
    h += '<section class="dw-sec"><h3>Agents on this pool</h3><p class="dw-p">' + f.agentsNote + '</p><ul class="agents">' +
      f.agents.map(function (a) { return '<li><span class="av">' + a[0] + "</span><b>" + a[1] + '</b><span class="h">' + a[2] + "</span></li>"; }).join("") + "</ul>" +
      '<p class="nysl"><span class="nys">Not yet supported</span>Which agent used which ' + f.noun + ".</p></section>";
    h += '<section class="dw-sec dz"><h3>Remove ' + f.noun + '</h3><p class="dw-p">New tasks stop using it. Tasks already running finish with it. Removing it here does not revoke it at ' + f.vendor + ".</p>" +
      '<button class="btn danger-outline wide" type="button" data-act="remove">' + I("i-trash") + "Remove " + f.noun + "</button></section>";
    return h + "</div>";
  }
  function closeDrawer(scope) {
    scope.querySelectorAll(":scope > .scrim, :scope > .drawer").forEach(function (n) { n.remove(); });
    scope.querySelectorAll(".kt .gr.sel").forEach(function (r) { r.classList.remove("sel"); });
  }
  function openDrawer(scope, id, anim) {
    closeMenus(scope); closeDrawer(scope);
    var kf = KEY[id], k = kf[0], f = kf[1], a = anim ? " anim" : "";
    scope.insertAdjacentHTML("beforeend", '<div class="scrim' + a + '" data-close></div><aside class="drawer' + a + '" role="dialog" aria-modal="true" aria-label="' + k.name + ', ' + f.name + '" data-key="' + id + '">' + drawerHTML(k, f) + "</aside>");
    var row = scope.querySelector('.kt .gr[data-key="' + id + '"]');
    if (row) row.classList.add("sel");
  }

  /* ---------- confirm dialog ---------- */
  function dialogHTML(k, f) {
    var n = ++uid, left = f.keys.length - 1;
    return '<div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t-' + n + '" aria-describedby="dlg-d-' + n + '">' +
      '<h3 id="dlg-t-' + n + '">Remove ' + k.name + "?</h3>" +
      '<p id="dlg-d-' + n + '">This takes the ' + f.noun + " <b>" + k.sfx + "</b> out of the " + f.name + " pool. New tasks stop using it. Tasks already running finish with it.</p>" +
      "<p>" + (left ? "The other " + left + " " + f.noun + (left === 1 ? "" : "s") + " stay in the pool. " : "This is the last " + f.noun + ". Agents on this pool wait for credentials until you add one. ") +
      "Removing it here does not revoke it at " + f.vendor + ".</p>" +
      '<div class="acts"><button class="btn" type="button" data-close>Cancel</button><button class="btn danger" type="button" data-close>Remove ' + f.noun + "</button></div></div>";
  }
  function openDialog(scope, id) {
    var kf = KEY[id];
    scope.insertAdjacentHTML("beforeend", '<div class="dlg-wrap anim">' + dialogHTML(kf[0], kf[1]) + "</div>");
  }

  /* ---------- page chrome ---------- */
  var PAGE = { channels: "Channels", tools: "Tools", ai: "AI providers" };
  var TOP = { channels: ["Search channels", "Connect a channel"], ai: ["Search providers and keys", "Add key"] };
  var TABS = [["tools", "Tools", "14"], ["scripts", "Script connections", "4"], ["oauth", "OAuth apps", "3"], ["mcp", "MCP servers", "4"]];
  var SEARCH = { tools: "Search tools", scripts: "Search connections", oauth: "Search OAuth apps", mcp: "Search MCP servers" };
  var ADD = { tools: "Add", scripts: "New script connection", oauth: "Add OAuth app", mcp: "Add MCP server" };

  function topRow(k, phone) {
    var t = TOP[k];
    return '<div class="trow"><span class="field sm" role="search">' + I("i-search") + t[0] + "</span><span class=\"sp\"></span>" +
      (phone ? '<button class="btn primary sq" type="button" aria-label="' + t[1] + '" title="' + t[1] + '">' + I("i-plus") + "</button>"
             : '<button class="btn primary" type="button">' + I("i-plus") + t[1] + "</button>") + "</div>";
  }
  function tabRow(tab) {
    var adv = '<a class="adv" href="#/settings/advanced" title="Settings › Advanced: Connection playground, Raw fetch credentials">Advanced' + I("i-chevron-right") + "</a>";
    return '<div class="tabrow"><div class="utabs" role="tablist" aria-label="Tools">' + TABS.map(function (t) {
      return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (t[0] === tab) + '">' + t[1] + '<span class="n">' + t[2] + "</span></button>";
    }).join("") + adv + "</div>" +
      '<div class="tact"><span class="field sm" role="search">' + I("i-search") + SEARCH[tab] + "</span>" +
      '<button class="btn only-phone" type="button" aria-label="' + SEARCH[tab] + '" title="' + SEARCH[tab] + '">' + I("i-search") + "</button>" +
      '<button class="btn primary" type="button" aria-label="' + ADD[tab] + '" title="' + ADD[tab] + '">' + I("i-plus") + '<span class="bl">' + ADD[tab] + "</span>" + (tab === "tools" ? '<span class="bl">' + I("i-chevron-down") + "</span>" : "") + "</button>" +
      '<span class="vsep"></span>' + adv + "</div></div>";
  }

  function render(host) {
    var k = host.getAttribute("data-k"), tab = host.getAttribute("data-tab") || "tools", phone = host.classList.contains("phone");
    var body = (phone ? "" : '<h1 class="sr-only">' + PAGE[k] + "</h1>") + (k === "tools" ? tabRow(tab) : topRow(k, phone)) + "<div data-content></div>";
    if (phone) {
      host.innerHTML = '<div class="psb"><span>9:41</span><span class="dots"><i></i><i></i></span></div>' +
        '<div class="ptop">' + I("i-menu") + '<h1 class="ptitle">' + PAGE[k] + '</h1><span class="sp"></span><span class="me">TY</span></div>' +
        '<div class="pbody">' + body + "</div>";
    } else {
      host.innerHTML = '<div class="topbar"><nav class="crumbs" aria-label="Breadcrumb"><span class="cg">Connect</span>' + I("i-chevron-right") + '<b aria-current="page">' + PAGE[k] + "</b></nav>" +
        '<span class="sp"></span><span class="search">' + I("i-search") + "Search or jump to<kbd>⌘K</kbd></span><span class=\"me\">TY</span></div>" +
        '<div class="body">' + body + "</div>";
    }
    var slot = host.querySelector("[data-content]");
    if (k === "ai") slot.innerHTML = aiPage(host);
    else slot.appendChild(document.getElementById("t-" + (k === "tools" ? tab : k)).content.cloneNode(true));

    var strip = host.querySelector(".utabs"), sel = strip && strip.querySelector('[aria-selected="true"]');
    if (sel) {
      var x = sel.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
      if (x + sel.offsetWidth > strip.clientWidth) strip.scrollLeft = x - 8;
    }
    var m = host.getAttribute("data-menu");
    if (m) { var b = host.querySelector('.kt .gr[data-key="' + m + '"] .rm'); if (b) openMenu(b, true); }
    var d = host.getAttribute("data-drawer");
    if (d) openDrawer(host, d);
  }

  /* ---------- interaction: one delegated handler per host ---------- */
  function wire(host) {
    host.addEventListener("click", function (e) {
      var t = e.target;
      var tabBtn = t.closest(".utabs [role=tab]");
      if (tabBtn) { host.setAttribute("data-tab", tabBtn.getAttribute("data-tab")); render(host); return; }
      var how = t.closest(".howbtn");
      if (how) { var fam = how.closest(".fam"), on = !fam.classList.contains("how-open"); fam.classList.toggle("how-open", on); how.setAttribute("aria-expanded", String(on)); return; }
      var rm = t.closest(".rm");
      if (rm) { e.stopPropagation(); if (rm.getAttribute("aria-expanded") === "true") closeMenus(host); else openMenu(rm, false, true); return; }
      var item = t.closest(".menu .mi");
      if (item) {
        var id = item.closest(".menu").getAttribute("data-key");
        closeMenus(host);
        if (item.getAttribute("data-act") === "remove") openDialog(host, id);
        return;
      }
      if (t.closest("[data-close]")) {
        var wrap = t.closest(".dlg-wrap");
        if (wrap) { wrap.remove(); return; }
        closeDrawer(host); return;
      }
      var drawerRemove = t.closest(".drawer [data-act=remove]");
      if (drawerRemove) { openDialog(host, drawerRemove.closest(".drawer").getAttribute("data-key")); return; }
      if (t.closest(".menu")) return;
      closeMenus(host);
      var row = t.closest(".kt .gr[data-key]");
      if (row) openDrawer(host, row.getAttribute("data-key"), true);
    });
  }

  document.querySelectorAll("[data-k]").forEach(function (host) { render(host); wire(host); });
  document.querySelectorAll("[data-dialog]").forEach(function (el) {
    var kf = KEY[el.getAttribute("data-dialog")];
    el.innerHTML = dialogHTML(kf[0], kf[1]);
    el.addEventListener("click", function () { /* static exhibit: buttons do nothing */ });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var w = document.querySelector(".dlg-wrap");
    if (w) { w.remove(); return; }
    document.querySelectorAll("[data-k]").forEach(function (h) { closeMenus(h); if (!h.hasAttribute("data-drawer")) closeDrawer(h); });
  });

  /* the three Connect entries switch the page inside a frame */
  document.querySelectorAll(".app").forEach(function (app) {
    var main = app.querySelector(".main[data-k]"), side = app.querySelector("nav.side");
    if (!main || !side) return;
    side.addEventListener("click", function (e) {
      var a = e.target.closest(".ni"); if (!a) return;
      var mm = (a.getAttribute("href") || "").match(/integrations\/(channels|tools|ai-providers)/); if (!mm) return;
      e.preventDefault();
      var k = mm[1] === "ai-providers" ? "ai" : mm[1];
      side.setAttribute("data-active", k); R3.sidebar(side);
      ["data-menu", "data-drawer", "data-how"].forEach(function (x) { main.removeAttribute(x); });
      main.setAttribute("data-k", k); if (k === "tools" && !main.getAttribute("data-tab")) main.setAttribute("data-tab", "tools");
      render(main);
    });
  });
})();
