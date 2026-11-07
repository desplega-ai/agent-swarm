/* Post-onboarding UI spike, round 5: Connect › AI providers.
   Renders the page into every [data-k="ai"] host. Host attributes:
     data-tab="llm|s1|emb|tr"  the open tab (default llm)
     data-open="<provider>"    an expanded LLM row
     data-add="<pick>"         the Add menu, open, with that row highlighted
     data-sheet="<sheet>"      a side panel, open, pre-filled
   [data-sheet-demo="<sheet>"] renders a side panel on its own, and
   [data-vstates] renders the Test and add results. Sheet ids: an LLM
   provider id, "s1-<host>", "emb" or "tr". Pre-opened exhibit states
   render without motion: headless capture freezes the first frame.
   The data follows the files named in the page's sources section.
   Throwaway reference material: nothing ships. */
(function () {
  var I = R3.icon;
  var uid = 0;

  /* ---------- provider marks (inline copies of the app's logo files) ---------- */
  var LOGO = {
    "anthropic": "<path d=\"M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z\"></path>",
    "openai": "<path d=\"M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z\"></path>",
    "openrouter": "<path d=\"M16.804 1.957l7.22 4.105v.087L16.73 10.21l.017-2.117-.821-.03c-1.059-.028-1.611.002-2.268.11-1.064.175-2.038.577-3.147 1.352L8.345 11.03c-.284.195-.495.336-.68.455l-.515.322-.397.234.385.23.53.338c.476.314 1.17.796 2.701 1.866 1.11.775 2.083 1.177 3.147 1.352l.3.045c.694.091 1.375.094 2.825.033l.022-2.159 7.22 4.105v.087L16.589 22l.014-1.862-.635.022c-1.386.042-2.137.002-3.138-.162-1.694-.28-3.26-.926-4.881-2.059l-2.158-1.5a21.997 21.997 0 00-.755-.498l-.467-.28a55.927 55.927 0 00-.76-.43C2.908 14.73.563 14.116 0 14.116V9.888l.14.004c.564-.007 2.91-.622 3.809-1.124l1.016-.58.438-.274c.428-.28 1.072-.726 2.686-1.853 1.621-1.133 3.186-1.78 4.881-2.059 1.152-.19 1.974-.213 3.814-.138l.02-1.907z\"></path>",
    "deepseek": "<path d=\"M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z\"></path>",
    "xai": "<path d=\"M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z\"></path>",
    "devin": "<path d=\"M3 3h7.4c5.16 0 8.6 3.7 8.6 9s-3.44 9-8.6 9H3V3zm3 3v12h4.4c3.5 0 5.6-2.4 5.6-6s-2.1-6-5.6-6H6z\"></path><circle cx=\"20.5\" cy=\"12\" r=\"1.6\"></circle>",
    "vercel": "<path d=\"M24 22.525H0l12-21.05 12 21.05z\"/>",
    "microsoft": "<path d=\"M0 0v11.408h11.408V0zm12.594 0v11.408H24V0zM0 12.594V24h11.408V12.594zm12.594 0V24H24V12.594z\"/>",
    "claudemanaged": "<path d=\"M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z\" opacity=\"0.55\"></path><circle cx=\"19.6\" cy=\"4.4\" r=\"2.4\" fill=\"currentColor\"></circle>",
    "bedrock": "<path d=\"M4 4.5h16a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1zm0 6h16a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1zm0 6h16a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1z\"/>",
    "nan": "<rect x=\"7\" y=\"3\" width=\"2\" height=\"18\" rx=\"1\"/><rect x=\"15\" y=\"3\" width=\"2\" height=\"18\" rx=\"1\"/><rect x=\"3\" y=\"7\" width=\"18\" height=\"2\" rx=\"1\"/><rect x=\"3\" y=\"15\" width=\"18\" height=\"2\" rx=\"1\"/><rect x=\"11\" y=\"-1.5\" width=\"2\" height=\"27\" rx=\"1\" transform=\"rotate(45 12 12)\"/>",
    "helmcode": "<path d=\"M12 4.5a7.5 7.5 0 1 1 0 15a7.5 7.5 0 1 1 0-15zm0 2.2a5.3 5.3 0 1 0 0 10.6a5.3 5.3 0 1 0 0-10.6z\"/><circle cx=\"12\" cy=\"12\" r=\"2.5\"/><rect x=\"11\" y=\"1\" width=\"2\" height=\"22\" rx=\"1\"/><rect x=\"11\" y=\"1\" width=\"2\" height=\"22\" rx=\"1\" transform=\"rotate(45 12 12)\"/><rect x=\"11\" y=\"1\" width=\"2\" height=\"22\" rx=\"1\" transform=\"rotate(90 12 12)\"/><rect x=\"11\" y=\"1\" width=\"2\" height=\"22\" rx=\"1\" transform=\"rotate(135 12 12)\"/>",
    "route": "s:<circle cx=\"6\" cy=\"19\" r=\"3\"/><path d=\"M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15\"/><circle cx=\"18\" cy=\"5\" r=\"3\"/>",
    "cloud": "s:<path d=\"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z\"/>",
    "link": "s:<path d=\"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\"/><path d=\"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\"/>"
  };
  function svg(id) {
    var b = LOGO[id], stroke = b.indexOf("s:") === 0;
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"' +
      (stroke ? ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + b.slice(2) : ' fill="currentColor" fill-rule="evenodd">' + b) + "</svg>";
  }
  /* m: a LOGO id, "@X" for a monogram, or "!i-name" for a lucide mask icon */
  function logo(m, cls) {
    var inner = m.charAt(0) === "@" ? '<span class="mg">' + m.slice(1) + "</span>" : m.charAt(0) === "!" ? I(m.slice(1)) : svg(m);
    return '<span class="lg' + (cls ? " " + cls : "") + '" aria-hidden="true">' + inner + "</span>";
  }

  /* ---------- small builders ---------- */
  function k(code) { return '<code class="k">' + code + "</code>"; }
  function ext(label, href) { return '<a class="ln" href="' + href + '">' + label + I("i-external") + "</a>"; }
  function cmd(t) { return '<span class="cmd"><span class="t">' + t + '</span><button class="btn xs ghost sq" type="button" title="Copy" aria-label="Copy command">' + I("i-copy") + "</button></span>"; }
  function btn(label, cls, attrs) { return '<button class="btn' + (cls ? " " + cls : "") + '" type="button"' + (attrs ? " " + attrs : "") + ">" + label + "</button>"; }
  function stl(tone, text) {
    var ic = tone === "busy" ? '<span class="spin" aria-hidden="true"></span>' : I(tone === "ok" ? "i-circle-check" : tone === "err" ? "i-circle-x" : tone === "wait" ? "i-clock" : "i-info");
    return '<span class="stl' + (tone ? " " + tone : "") + '" role="status">' + ic + "<span>" + text + "</span></span>";
  }

  /* ---------- every provider the dashboard can add (Add menu + side panels) ---------- */
  var TOKEN_TERMS = "The swarm runs the unmodified Claude Code CLI. Anthropic documents setup tokens for CI and automation on your own subscription. Do not share a token across people or organizations.";
  function keyField(label, key, ph, extra) {
    var f = { label: label, key: key, ph: ph, secret: true };
    for (var x in extra || {}) f[x] = extra[x];
    return f;
  }
  var CAT = {
    claude: {
      name: "Claude subscription", logo: "anthropic", type: "Subscription", runs: "Claude Code", noun: "token", vendor: "Anthropic", live: true,
      addLabel: "Add token", how: "How to get a token",
      sub: "Claude Code agents bill your Claude plan instead of paying per token. Agents rotate across the tokens.",
      steps: [["On a computer with Claude Code, run this command.", cmd("claude setup-token")], "Copy the token that it prints. It starts with " + k("sk-ant-oat01-") + ".", "Paste it below. Add one token for each Claude account."],
      terms: TOKEN_TERMS, docs: ["Harness guide", "#/docs/harness-configuration"],
      fields: [
        keyField("Subscription token", "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-...", { demo: "sk-ant-oat01-••••••••••••••••••••••••7Qx2", focus: true, check: "Starts with sk-ant-oat01-", help: "A token wins over an Anthropic API key when both are set." }),
        { label: "Name", opt: true, ph: "For example team-max", demo: "design-max", help: "Shows in the key list. Rename changes it later." },
        { label: "Plan", opt: true, select: "Estimate from weekly use", help: "Prices the token on the Usage page: Pro, Max 5x, Max 20x or Team. Set plan changes it later." },
      ],
      alt: 'No subscription? <button class="lnk" type="button" data-sheet-switch="anthropic">Use an Anthropic API key instead</button>. It bills per token.',
    },
    codex: {
      name: "Codex (ChatGPT)", logo: "openai", type: "OAuth", runs: "Codex", noun: "account", vendor: "OpenAI", signIn: true,
      addLabel: "Sign in another account", how: "How to sign in",
      sub: "Codex agents bill your ChatGPT plan. Agents rotate across the signed-in accounts.",
      steps: ["In ChatGPT, open Settings, Security and turn on “Allow device code login”. Workspace admins control it for team workspaces.", "Click Sign in with ChatGPT, then enter the code on the ChatGPT page.", "Do it again for each account. Each one adds a slot: " + k("codex_oauth_0") + ", " + k("codex_oauth_1") + " and so on."],
      other: ["Device login failed, or no browser here? Run this on a machine with a browser.", cmd("npx @desplega.ai/agent-swarm codex-login --api-url https://api.acme.agent-swarm.dev")],
      docs: ["Codex OAuth guide", "#/docs/provider-auth/codex-oauth"],
    },
    anthropic: {
      name: "Anthropic API key", logo: "anthropic", type: "API key", runs: "Claude Code, pi, opencode", noun: "key", vendor: "Anthropic", live: true,
      sub: "Billed per token. Claude Code uses it when no subscription token is set. Agents rotate across the keys.",
      steps: ["Create a key at " + ext("console.anthropic.com", "https://console.anthropic.com") + ".", "Paste it below. It starts with " + k("sk-ant-api03-") + "."],
      docs: ["Harness guide", "#/docs/harness-configuration"],
      fields: [keyField("API key", "ANTHROPIC_API_KEY", "sk-ant-api03-...")],
    },
    openai: {
      name: "OpenAI", logo: "openai", type: "API key", runs: "Codex, fx", noun: "key", vendor: "OpenAI", live: true,
      sub: "Codex uses it when no ChatGPT sign-in is stored. Memory and transcription can reuse it.",
      steps: ["Create a key at " + ext("platform.openai.com/api-keys", "https://platform.openai.com/api-keys") + ".", "Paste it below. It starts with " + k("sk-") + "."],
      docs: ["Harness guide", "#/docs/harness-configuration"],
      fields: [keyField("API key", "OPENAI_API_KEY", "sk-...")],
    },
    deepseek: {
      name: "DeepSeek", logo: "deepseek", type: "API key", runs: "dsh", noun: "key", vendor: "DeepSeek", live: true,
      sub: "DeepSeek models for the dsh harness. dsh can also reach them through OpenRouter: the model prefix picks the route.",
      steps: ["Create a key at " + ext("platform.deepseek.com/api_keys", "https://platform.deepseek.com/api_keys") + ".", "Paste it below. It starts with " + k("sk-") + "."],
      docs: ["dsh guide", "#/docs/provider-auth/dsh"],
      fields: [keyField("API key", "DEEPSEEK_API_KEY", "sk-...")],
    },
    xai: {
      name: "xAI Grok", logo: "xai", type: "API key", runs: "grok", noun: "key", vendor: "xAI", live: true,
      sub: "The xAI Grok CLI. grok workers can also run OpenRouter models with the OpenRouter key.",
      steps: ["Create a key at " + ext("console.x.ai", "https://console.x.ai") + ".", "Paste it below. It starts with " + k("xai-") + "."],
      docs: ["Grok guide", "#/docs/provider-auth/grok"],
      fields: [keyField("API key", "XAI_API_KEY", "xai-...")],
    },
    amp: {
      name: "Amp", logo: "@A", type: "API key", runs: "amp", noun: "token", vendor: "Amp",
      sub: "Workers on Sourcegraph's Amp CLI. Amp bills its own usage.",
      steps: ["Open " + ext("ampcode.com/settings/security", "https://ampcode.com/settings/security#access-token") + ".", "Create an access token. It starts with " + k("sgamp_") + ".", "Paste it below."],
      docs: ["Amp guide", "#/docs/provider-auth/amp"],
      fields: [keyField("Access token", "AMP_API_KEY", "sgamp_...")],
    },
    cursor: {
      name: "Cursor", logo: "@C", type: "API key", runs: "cursor", noun: "key", vendor: "Cursor",
      sub: "Workers on the Cursor agent. Cursor bills its own usage.",
      steps: ["Create a key at " + ext("cursor.com/dashboard/api", "https://cursor.com/dashboard/api") + ".", "Paste it below. It starts with " + k("key_") + "."],
      docs: ["Cursor guide", "#/docs/provider-auth/cursor"],
      fields: [keyField("API key", "CURSOR_API_KEY", "key_...")],
    },
    devin: {
      name: "Devin", logo: "devin", type: "API key", runs: "devin", noun: "key", vendor: "Devin",
      sub: "Managed cloud agents from app.devin.ai.",
      steps: ["In " + ext("app.devin.ai", "https://app.devin.ai") + ", create a service user key or a personal access token.", "Copy your organization ID.", "Paste both below."],
      docs: ["Harness providers guide", "#/docs/harness-providers"],
      fields: [keyField("API key", "DEVIN_API_KEY", "cog_..."), { label: "Organization ID", key: "DEVIN_ORG_ID", mono: true, ph: "org_..." }],
    },
    bedrock: {
      name: "Amazon Bedrock", logo: "bedrock", type: "API key", runs: "Claude Code, pi", noun: "setup", vendor: "AWS", config: true,
      sub: "Routes pi and Claude Code calls to Bedrock. Auth goes through the AWS SDK credential chain.",
      steps: ["Pick a region where Bedrock serves your models.", "Leave the keys empty to use a profile, AWS SSO or an assumed role on the workers. Or paste static keys below.", "For pi, set the model with the " + k("amazon-bedrock/") + " prefix."],
      docs: ["Bedrock auth guide", "#/docs/harness-providers#pi-mono--amazon-bedrock-auth"],
      fields: [
        { label: "AWS region", key: "AWS_REGION", mono: true, ph: "us-east-1" },
        { label: "Access key ID", opt: true, key: "AWS_ACCESS_KEY_ID", secret: true, ph: "AKIA..." },
        { label: "Secret access key", opt: true, key: "AWS_SECRET_ACCESS_KEY", secret: true, ph: "Paste the secret key" },
        { label: "pi model", opt: true, key: "MODEL_OVERRIDE", mono: true, ph: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0" },
      ],
    },
    managed: {
      name: "Claude Managed Agents", logo: "claudemanaged", type: "API key", runs: "claude-managed", noun: "setup", vendor: "Anthropic", config: true,
      sub: "Runs swarm tasks in Anthropic's cloud sandbox.",
      steps: [["Run this once. It creates the agent and the environment at Anthropic.", cmd("bunx @desplega.ai/agent-swarm claude-managed-setup")], "Paste the IDs that it prints below."],
      docs: ["Managed Agents guide", "#/docs/harness-configuration#claude-managed-agents"],
      fields: [
        keyField("Anthropic API key", "ANTHROPIC_API_KEY", "sk-ant-..."),
        { label: "Managed agent ID", key: "MANAGED_AGENT_ID", mono: true, ph: "agent_..." },
        { label: "Managed environment ID", key: "MANAGED_ENVIRONMENT_ID", mono: true, ph: "env_..." },
        { label: "MCP base URL", key: "MCP_BASE_URL", mono: true, ph: "https://api.swarm.example.com", help: "Must be public HTTPS, so the sandbox can reach /mcp." },
      ],
    },
    openrouter: {
      name: "OpenRouter", logo: "openrouter", type: "Gateway", runs: "pi, opencode, dsh, grok, fx", noun: "key", vendor: "OpenRouter", live: true,
      addLabel: "Add key", how: "How to get a key",
      sub: "Claude, Gemini, GPT, Mistral and more through one key. Agents rotate across the keys.",
      steps: ["Create a key at " + ext("openrouter.ai/settings/keys", "https://openrouter.ai/settings/keys") + ".", "Paste it below. It starts with " + k("sk-or-v1-") + "."],
      note: "Jev via OpenRouter in System One uses this key too.",
      docs: ["Model gateways guide", "#/docs/provider-auth/model-gateways"],
      fields: [keyField("API key", "OPENROUTER_API_KEY", "sk-or-v1-...")],
    },
    vercel: {
      name: "Vercel AI Gateway", logo: "vercel", type: "Gateway", runs: "pi, opencode, fx", noun: "key", vendor: "Vercel", live: true,
      sub: "Every AI Gateway chat model (GLM, Kimi, Claude, GPT, Gemini and more), including Token Pass.",
      steps: ["In the Vercel dashboard, open AI Gateway, API keys, and create a key.", "Paste it below."],
      note: "Use a Token Pass API key for Token Pass credit. Regular keys use AI Gateway credit.",
      docs: ["Harness guide", "#/docs/harness-configuration#nan-and-helmcode"],
      fields: [keyField("API key", "AI_GATEWAY_API_KEY", "vck_...")],
    },
    nan: {
      name: "NaN", logo: "nan", type: "Gateway", runs: "pi, opencode", noun: "key", vendor: "NaN", live: true,
      sub: "Open-weight models such as GLM, Qwen and DeepSeek for the pi and opencode harnesses.",
      steps: ["Create a key in your NaN account.", "Paste it below."],
      note: k("HELMCODE_API_NAN") + " also works as the key name.",
      docs: ["Harness guide", "#/docs/harness-configuration#nan-and-helmcode"],
      fields: [keyField("API key", "NAN_API_KEY", "sk-..."), { label: "Base URL", opt: true, key: "NAN_BASE_URL", mono: true, ph: "https://api.nan.builders/v1", help: "OpenAI-compatible API root. Leave it empty for the default." }],
    },
    helmcode: {
      name: "Helmcode", logo: "helmcode", type: "Gateway", runs: "pi, opencode", noun: "key", vendor: "Helmcode", live: true,
      sub: "Open-weight models through Helmcode for the pi and opencode harnesses.",
      steps: ["Create a key in your Helmcode organization.", "Paste it below."],
      note: "Helmcode org plans include 5, 15 or 40 keys. Add them all: agents rotate across them.",
      docs: ["Harness guide", "#/docs/harness-configuration#nan-and-helmcode"],
      fields: [keyField("API key", "HELMCODE_API_KEY", "sk-..."), { label: "Base URL", opt: true, key: "HELMCODE_BASE_URL", mono: true, ph: "https://api.helmcode.com/v1", help: "OpenAI-compatible API root. Leave it empty for the default." }],
    },
    gateway: {
      name: "Your own gateway", logo: "route", type: "Gateway", runs: "pi, opencode", noun: "key", vendor: "the gateway", live: true,
      sub: "Any OpenAI-compatible chat completions endpoint, such as LiteLLM. It takes the place of openrouter.ai for the open harnesses.",
      steps: ["Make sure the gateway serves " + k("/models") + " and " + k("/chat/completions") + ".", "Paste its URL and a key below."],
      note: "Jev via OpenRouter in System One stops while a gateway URL is set.",
      docs: ["Model gateways guide", "#/docs/provider-auth/model-gateways"],
      fields: [{ label: "Gateway URL", key: "OPENROUTER_BASE_URL", mono: true, ph: "https://gateway.example.com/v1" }, keyField("API key", "OPENROUTER_API_KEY", "Paste the gateway key")],
    },
  };
  var GROUPS = [
    ["Subscriptions", ["claude", "codex"]],
    ["API keys", ["anthropic", "openai", "deepseek", "xai", "amp", "cursor", "devin", "bedrock", "managed"]],
    ["Gateways and OpenAI-compatible", ["openrouter", "vercel", "nan", "helmcode", "gateway"]],
  ];

  /* ---------- the configured providers (LLMs list) ---------- */
  var CONF = [
    { id: "claude", runs: "Claude Code · 4 agents", count: "3 tokens", status: ["warn", "1 rate limited", "taras-backup is back at 14:20"], today: "$22.30", week: "$320.40", col: "Token", plan: true, limits: true,
      foot: "Agents rotate across the 3 tokens and skip a token while it is limited.",
      keys: [
        { id: "team-max", name: "team-max", sfx: "…a91f2", plan: "Claude Max 20x", src: "Set by you", today: "$18.40", week: "$212.90", w5: 62, w7: 41, used: "Used 2 min ago", pk: "Max 20x · today $18.40 · 5 h 62%" },
        { id: "taras-backup", name: "taras-backup", sfx: "…77c2a", plan: "Claude Max 5x", src: "Estimated", today: "$3.10", week: "$96.20", w5: 100, w7: 78, limited: "14:20", pk: "Max 5x · today $3.10 · 5 h 100%" },
        { id: "ops-pro", name: "ops-pro", sfx: "…c0de1", plan: "Claude Pro", src: "Set by you", today: "$0.80", week: "$11.30", w5: 12, w7: 9, used: "Used 1 h ago", pk: "Pro · today $0.80 · 5 h 12%" },
      ] },
    { id: "codex", runs: "Codex · 2 agents", count: "2 accounts", status: ["ok", "Healthy"], today: "$23.90", week: "$175.20", col: "Account", plan: true,
      foot: "Agents rotate across the 2 accounts.",
      keys: [
        { id: "taras-chatgpt", name: "taras@acme.dev", sfx: "slot 0", plan: "ChatGPT Pro 20x", src: "Detected", today: "$22.70", week: "$160.40", used: "Used 6 min ago", pk: "Pro 20x · today $22.70" },
        { id: "ops-chatgpt", name: "ops@acme.dev", sfx: "slot 1", plan: "ChatGPT Plus", src: "Detected", today: "$1.20", week: "$14.80", used: "Used 3 h ago", pk: "Plus · today $1.20" },
      ] },
    { id: "openrouter", runs: "pi, opencode · 3 agents", count: "2 keys", status: ["ok", "Healthy"], today: "$9.80", week: "$44.80", col: "Key",
      foot: "Agents rotate across the 2 keys. Base URL openrouter.ai/api/v1.",
      keys: [
        { id: "or-default", name: "default", sfx: "…3e0b7", today: "$9.80", week: "$41.20", used: "Used 4 min ago", pk: "Today $9.80 · 7 d $41.20" },
        { id: "or-evals", name: "evals", sfx: "…91ad0", today: "$0.00", week: "$3.60", used: "Used 2 days ago", pk: "Today $0.00 · 7 d $3.60" },
      ] },
    { id: "deepseek", runs: "dsh · 1 agent", count: "1 key", status: ["err", "Failing", "dsh-main rejected, HTTP 401"], today: "$0.00", week: "$6.20", col: "Key",
      foot: "To fix it, add a new key, then remove this one.",
      keys: [
        { id: "dsh-main", name: "dsh-main", sfx: "…4f1c", today: "$0.00", week: "$6.20", rejected: "Rejected by DeepSeek (HTTP 401) on 3 Nov at 09:12", pk: "Today $0.00 · 7 d $6.20" },
      ] },
  ];
  var KEY = {};
  CONF.forEach(function (p) { p.keys.forEach(function (key) { KEY[key.id] = [key, p]; }); });
  var ADDED = { claude: "3 tokens", codex: "2 accounts", deepseek: "1 key", openrouter: "2 keys" };

  /* ---------- System One hosts (SYSTEM_ONE_HOSTS) ---------- */
  var HOSTS = [
    { id: "typesafe", logo: "@T", name: "Jev", via: "TypeSafe", where: "api.typesafe.ai", caps: [["Decide", true]], models: "jev-latest", creds: ["TYPESAFE_API_KEY"], set: true,
      sub: "Typed decisions with Jev on TypeSafe's API.",
      steps: ["Create an API key in your TypeSafe account.", "Paste it below."],
      fields: [keyField("API key", "TYPESAFE_API_KEY", "Paste a TypeSafe key", { demo: "Saved, ends …e41b" })] },
    { id: "openrouter", logo: "openrouter", name: "Jev", via: "OpenRouter", where: "openrouter.ai, with no gateway", caps: [["Decide"]], models: "~typesafe/jev-latest", creds: ["OPENROUTER_API_KEY"], credNote: "Shared with LLMs", set: true, shared: true,
      sub: "Jev through OpenRouter's decisions API, with the OpenRouter key from LLMs." },
    { id: "cloudflare", logo: "cloud", name: "Clef", via: "Cloudflare", where: "Workers AI, also Clairic for extraction", caps: [["Decide"], ["Extract", true]], models: "clef, clef-flash · clairic", creds: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"], set: true,
      sub: "Workers AI runs Clef for decisions and Clairic for extraction. One token and one account ID serve both.",
      steps: ["In the Cloudflare dashboard, create an API token that can use Workers AI.", "Copy your account ID. It has 32 characters.", "Paste both below."],
      fields: [
        keyField("API token", "CLOUDFLARE_API_TOKEN", "Paste a Workers AI token", { demo: "Saved, ends …8c21", help: "CLOUDFLARE_API_KEY also works, so an older secret needs no rename." }),
        { label: "Account ID", key: "CLOUDFLARE_ACCOUNT_ID", mono: true, ph: "32 hex characters", demo: "4f9c2e7a0b1d3c5e6f708192a3b4c5d6", help: "Saved as a global config value, not a secret." },
      ] },
    { id: "laya", logo: "@la", name: "laya", via: "", where: "Your own laya server", caps: [["Decide"]], models: "", modelsText: "Picked from the text", creds: ["LAYA_URL", "LAYA_API_KEY"], set: false,
      sub: "Your own laya server. This swarm's API server calls it directly, with no desplega API in between.",
      steps: ["Run a laya server: " + k("@desplega.ai/laya-server") + " from " + ext("laya-js", "https://github.com/desplega-ai/laya-js") + ", from npm or built from its Dockerfile.", "Paste its base URL below. The API server must reach it.", "Paste the token that you gave the server."],
      fields: [
        { label: "Server URL", key: "LAYA_URL", mono: true, ph: "https://laya.example.com", help: "https only. Plain http works for localhost only. Saved as a global config value, not a secret." },
        keyField("API key", "LAYA_API_KEY", "The token that the server expects", { help: "Saved as a global secret." }),
      ],
      note: "laya has no default model. It picks a checkpoint from the text, and the run output names it. Prefer choice questions on laya for now." },
    { id: "openai", logo: "openai", name: "OpenAI", via: "", where: "api.openai.com decisions", caps: [["Decide"]], models: "gpt-6-luna", creds: ["OPENAI_DECISIONS_API_KEY"], set: false,
      sub: "OpenAI's decisions API. The key needs Decisions access.",
      steps: ["Create a key at " + ext("platform.openai.com/api-keys", "https://platform.openai.com/api-keys") + " with Decisions access.", "Paste it below."],
      fields: [keyField("API key", "OPENAI_DECISIONS_API_KEY", "sk-...", { help: "Not OPENAI_API_KEY. A global key of that name reaches every worker and can change how harnesses sign in. This key serves decisions only." })] },
  ];
  var HOST = {};
  HOSTS.forEach(function (h) { HOST[h.id] = h; });
  function hostName(h, plain) {
    if (plain) return h.name + (h.via ? " via " + h.via : "");
    return h.name + (h.via ? '<span class="via"> via ' + h.via + "</span>" : "");
  }

  /* ---------- LLMs tab ---------- */
  function meter(lab, v) {
    return '<span class="mt' + (v >= 75 ? " hi" : "") + '">' + lab + '<span class="bar"><i style="--v:' + v + '%"></i></span><span class="v">' + v + "%</span></span>";
  }
  function keyRow(key, p) {
    var c = CAT[p.id], st = key.limited ? " warn" : key.rejected ? " err" : "";
    var sub = key.limited ? '<span class="k2 warn">' + I("i-timer") + "Rate limited, back at " + key.limited + "</span>"
      : key.rejected ? '<span class="k2 err">' + I("i-circle-alert") + key.rejected + "</span>"
      : '<span class="k2">' + key.used + "</span>";
    return '<div class="kr" data-key="' + key.id + '">' +
      '<span class="kc"><span class="dot' + st + '" title="' + (key.limited ? "Rate limited" : key.rejected ? "Rejected" : "Available") + '"></span><span class="tx"><span class="k1"><b>' + key.name + '</b><span class="sfx">' + key.sfx + "</span></span>" + sub + '<span class="k3">' + key.pk + "</span></span></span>" +
      '<span class="plan hp-hide">' + (p.plan ? key.plan + "<small>" + key.src + "</small>" : '<span class="dim">Pay per token</span>') + "</span>" +
      '<span class="lim hp-hide">' + (p.limits ? '<span class="mts">' + meter("5 h", key.w5) + meter("7 d", key.w7) + "</span>" : "") + "</span>" +
      '<span class="num hp-hide">' + key.today + '</span><span class="num hp-hide">' + key.week + "</span>" +
      '<span class="rmc"><button class="rm" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Actions for ' + key.name + '">' + I("i-more") + "</button></span></div>";
  }
  function provRow(p, open) {
    var c = CAT[p.id], n = ++uid;
    return '<div class="gr pr" role="button" tabindex="0" aria-expanded="' + open + '" aria-controls="pex-' + n + '" data-prov="' + p.id + '">' +
      '<span class="pn">' + logo(c.logo) + '<span class="t"><b>' + c.name + '</b><span class="u d">' + p.runs + '</span><span class="u p">' + p.count + " · " + p.today + " today</span></span></span>" +
      '<span class="hp-hide"><span class="tag">' + c.type + "</span></span>" +
      '<span class="hp-hide">' + p.count + "</span>" +
      '<span class="stc"><span class="dchip ' + p.status[0] + '">' + p.status[1] + "</span>" + (p.status[2] ? '<span class="why ' + p.status[0] + '">' + p.status[2] + "</span>" : "") + "</span>" +
      '<span class="hp-hide num">' + p.today + '</span><span class="hp-hide num">' + p.week + "</span>" +
      '<span class="chev">' + I("i-chevron-right") + "</span></div>" +
      '<div class="pex' + (open ? " shown" : "") + '" id="pex-' + n + '" role="region" aria-label="' + c.name + ' keys"><div>' +
      '<div class="kr kh"><span class="kc"><span class="dot"></span>' + p.col + '</span><span class="plan">' + (p.plan ? "Plan" : "Billing") + '</span><span class="lim">' + (p.limits ? "Usage limits" : "") + '</span><span></span><span></span><span></span></div>' +
      p.keys.map(function (key) { return keyRow(key, p); }).join("") +
      '<div class="kf">' + btn(I("i-plus") + (c.addLabel || "Add " + c.noun), "", 'data-sheet-open="' + p.id + '"') + '<span class="kfn">' + p.foot + "</span></div>" +
      "</div></div>";
  }
  function llmTab(host) {
    var open = host.getAttribute("data-open");
    return '<div class="grid plist">' +
      '<div class="gr hd"><span>Provider</span><span class="hp-hide">Type</span><span class="hp-hide">Keys</span><span>Status</span><span class="hp-hide num">Today</span><span class="hp-hide num">7 days</span><span></span></div>' +
      CONF.map(function (p) { return provRow(p, p.id === open); }).join("") +
      '<div class="gr tot"><span><span class="d">8 keys across 4 providers</span><span class="p">Today $56.00 · 7 days $546.60</span></span><span class="hp-hide"></span><span class="hp-hide"></span><span class="hp-hide"></span><span class="hp-hide num">$56.00</span><span class="hp-hide num">$546.60</span><span class="hp-hide"></span></div></div>' +
      '<p class="foot-note">' + I("i-info") + "Today and 7 days show the API value of each run. Subscriptions bill a flat monthly fee.</p>";
  }

  /* ---------- System One tab ---------- */
  function s1Tab() {
    var h = '<p class="tab-intro"><span>System One runs fast typed decisions and extraction in workflows and gates.</span>' + ext("Workflows guide", "#/docs/concepts/workflows") + "</p>";
    h += '<div class="s1-def">' +
      '<div><h3>Decisions<span class="ck">SYSTEM_ONE_DEFAULT_PROVIDER</span></h3><p class="d">For a node or call that names no provider. Applies to the next decision.</p>' +
      '<span class="inp" role="combobox" aria-expanded="false" aria-label="Default decision host"><span class="v wl">' + logo("@T", "sm") + "Jev via TypeSafe</span>" + I("i-chevron-down") + "</span></div>" +
      '<div><h3>Extraction</h3><p class="d">Cloudflare is the only host that extracts, so there is nothing to pick.</p>' +
      '<span class="inp dis" aria-disabled="true"><span class="v wl">' + logo("cloud", "sm") + "Clairic via Cloudflare</span>" + I("i-lock") + "</span></div></div>";
    h += '<div class="grid hosts"><div class="gr hd"><span>Host</span><span>Serves<span class="lgd">default</span></span><span>Models</span><span>Credential</span><span>Status</span><span></span></div>' +
      HOSTS.map(function (x) {
        return '<div class="gr"><span class="pn">' + logo(x.logo) + '<span class="t"><b>' + hostName(x) + '</b><span class="u">' + x.where + "</span></span></span>" +
          "<span>" + x.caps.map(function (c) { return '<span class="cap' + (c[1] ? " def" : "") + '"' + (c[1] ? ' title="Default host for ' + (c[0] === "Decide" ? "decisions" : "extraction") + '"' : "") + ">" + c[0] + "</span>"; }).join("") + "</span>" +
          (x.models ? '<span class="mono dim">' + x.models + "</span>" : '<span class="dim">' + x.modelsText + "</span>") +
          '<span class="cred">' + x.creds.map(k).join("") + (x.credNote ? "<small>" + x.credNote + "</small>" : "") + "</span>" +
          '<span><span class="dchip' + (x.set ? " ok" : "") + '">' + (x.set ? "Configured" : "Not set") + "</span></span>" +
          '<span class="act">' + btn(x.set ? "Edit" : "Set up", x.set ? "xs ghost" : "xs", 'data-sheet-open="s1-' + x.id + '"') + "</span></div>";
      }).join("") + "</div>";
    return h;
  }

  /* ---------- Embeddings tab ---------- */
  function dl(rows) { return "<dl>" + rows.map(function (r) { return "<dt>" + r[0] + "</dt><dd>" + r[1] + "</dd>"; }).join("") + "</dl>"; }
  function embTab() {
    return '<p class="tab-intro"><span>Memory turns each memory into a vector, so agents find it by meaning. With no embeddings, recall falls back to keyword search.</span>' + ext("Memory guide", "#/docs/architecture/memory") + "</p>" +
      '<section class="cfg" aria-label="Memory embeddings"><div class="cfg-h">' + logo("openrouter", "xl") +
      '<div class="t"><h2>OpenRouter<span class="dchip ok">Memory works</span></h2><p><span class="mono">openai/text-embedding-3-small</span> · 512 dims · tested today at 13:42</p></div>' +
      '<div class="acts">' + btn(I("i-rotate-ccw") + "Test again", "", 'data-act="test"') + "</div></div>" +
      '<div class="cfg-b">' + dl([
        ["Provider", "OpenRouter"],
        ["Model", '<span class="mono">openai/text-embedding-3-small</span><span class="sc info">Recommended</span>'],
        ["Dimensions", "512<small>fixed for every model</small>"],
        ["Key", k("EMBEDDING_API_KEY") + "<small>a copy of the OpenRouter key …3e0b7</small>"],
        ["Endpoint", '<span class="mono">https://openrouter.ai/api/v1</span>'],
        ["Last test", "Today at 13:42<small>512 dims, 240 ms</small>"],
      ]) +
      "<aside><h3>Before you change it</h3><p>Memories that have a vector keep it. A new model makes vectors that do not match the old ones, so recall of older memories gets worse.</p>" +
      "<p>Memories with no vector, or one of the wrong size, get a new one in the background when the API server starts.</p>" +
      "<p>The key is a copy. If you remove the OpenRouter key on LLMs, memory still works.</p></aside></div>" +
      '<details class="adv-d"><summary>' + I("i-chevron-right") + 'Advanced: edit the stored values<span class="ks">3 keys</span></summary>' + dl([
        [k("EMBEDDING_API_KEY"), "Set<small>sk-or-v1-…3e0b7</small>"],
        [k("EMBEDDING_API_BASE_URL"), '<span class="mono">https://openrouter.ai/api/v1</span>'],
        [k("EMBEDDING_MODEL"), '<span class="mono">openai/text-embedding-3-small</span>'],
      ]) + "</details></section>";
  }

  /* ---------- Transcription tab ---------- */
  var TR = [["ElevenLabs", "ELEVENLABS_API_KEY", true], ["OpenAI", "OPENAI_API_KEY", false], ["Groq", "GROQ_API_KEY", false]];
  function trTab() {
    return '<p class="tab-intro"><span>Transcription turns voice notes and audio files from chat channels into task text.</span>' + ext("Voice notes guide", "#/docs/integrations/chat-sdk#voice-notes") + "</p>" +
      '<section class="cfg" aria-label="Transcription"><div class="cfg-h">' + logo("@E", "xl") +
      '<div class="t"><h2>ElevenLabs<span class="dchip ok">On</span></h2><p>Auto-detected: reuses ' + k("ELEVENLABS_API_KEY") + ", already configured on the swarm.</p></div></div>" +
      '<div class="cfg-b">' + dl([
        ["Provider", "ElevenLabs<small>auto-detected</small>"],
        ["Model", '<span class="mono">scribe_v2</span><small>provider default</small>'],
        ["Key", k("ELEVENLABS_API_KEY")],
        ["Endpoint", '<span class="mono">https://api.elevenlabs.io/v1</span><small>provider default</small>'],
        ["Applies", "To the next voice note. No restart."],
      ]) +
      "<aside><h3>Auto-detect order</h3><p>With no key of its own, transcription reuses the first of these keys that the swarm has.</p>" +
      '<ol class="order">' + TR.map(function (t, i) {
        return '<li><span class="n">' + (i + 1) + "</span>" + (t[2] ? '<span class="ic i-check" role="img" aria-label="set"></span>' : '<span class="ic i-minus" role="img" aria-label="not set"></span>') + "<span>" + t[0] + "</span>" + k(t[1]) + "</li>";
      }).join("") + "</ol></aside></div>" +
      '<details class="adv-d"><summary>' + I("i-chevron-right") + 'Advanced: edit the stored values<span class="ks">4 keys</span></summary>' + dl([
        [k("TRANSCRIPTION_PROVIDER"), "Not set<small>auto-detect</small>"],
        [k("TRANSCRIPTION_API_KEY"), "Not set<small>write-only</small>"],
        [k("TRANSCRIPTION_BASE_URL"), "Not set<small>provider default</small>"],
        [k("TRANSCRIPTION_MODEL"), "Not set<small>provider default</small>"],
      ]) + "</details></section>";
  }

  /* ---------- side panels ---------- */
  function field(f, demo) {
    var val = demo && f.demo, input;
    if (f.select) {
      input = '<span class="inp" role="combobox" aria-expanded="false" aria-label="' + f.label + '"><span class="v">' + f.select + "</span>" + I("i-chevron-down") + "</span>";
    } else {
      input = '<span class="inp' + (f.secret || f.mono ? " mono" : "") + (val && f.focus ? " focus" : "") + '" role="textbox" aria-label="' + f.label + '">' +
        (f.secret ? I("i-key") : "") + (val ? '<span class="v">' + val + "</span>" : '<span class="ph' + (/\s/.test(f.ph) ? " pw" : "") + '">' + f.ph + "</span>") +
        (f.secret ? '<button class="btn xs ghost sq" type="button" title="Show the value" aria-label="Show the value">' + I("i-eye") + "</button>" : "") + "</span>";
    }
    return '<div class="fld"><div class="fld-l"><span>' + f.label + "</span>" + (f.opt ? '<span class="opt">Optional</span>' : "") + (f.key ? '<span class="ck">' + f.key + "</span>" : "") + "</div>" + input +
      (val && f.check ? '<p class="chk ok">' + I("i-check") + f.check + "</p>" : "") +
      (f.warn ? '<p class="chk warn">' + I("i-alert") + f.warn + "</p>" : "") +
      (f.help ? '<p class="hlp">' + f.help + "</p>" : "") + "</div>";
  }
  function stepsHTML(steps) {
    return '<ol class="steps">' + steps.map(function (s) {
      return Array.isArray(s) ? "<li><span>" + s[0] + "</span>" + s[1] + "</li>" : "<li><span>" + s + "</span></li>";
    }).join("") + "</ol>";
  }
  function provBody(id, demo) {
    var c = CAT[id];
    var h = '<section class="sh-sec"><h3>' + (c.signIn ? "Sign in" : c.config ? "Before you start" : "Get a " + c.noun) + ext(c.docs[0], c.docs[1]) + "</h3>" + stepsHTML(c.steps) +
      (c.terms ? '<p class="terms">' + c.terms + "</p>" : "") + (c.note ? '<p class="terms">' + c.note + "</p>" : "") + "</section>";
    if (c.fields) {
      h += '<section class="sh-sec"><h3>' + (c.config ? "Settings" : "Add the " + c.noun) + "</h3>" + c.fields.map(function (f) { return field(f, demo); }).join("") +
        (c.alt ? '<p class="alt">' + c.alt + "</p>" : "") + "</section>";
    }
    if (c.other) h += '<section class="sh-sec"><h3>Other ways to sign in</h3>' + stepsHTML([c.other]).replace('class="steps"', 'class="steps plain"') + "</section>";
    return h;
  }
  function provFoot(id, state) {
    var c = CAT[id], noun = c.noun;
    if (c.signIn) {
      if (state === "testing") return stl("busy", "Waiting for you to approve in ChatGPT…") + btn("Cancel", "", "data-close") + btn('<span class="spin" aria-hidden="true"></span>Waiting', "primary", "disabled");
      if (state === "verified") return stl("ok", "Signed in. The account joined the pool as slot 2.") + btn("Sign in another", "", 'data-act="save"') + btn("Done", "primary", "data-close");
      return stl("", "Each sign-in adds one account to the pool.") + btn("Cancel", "", "data-close") + btn(I("i-log-in") + "Sign in with ChatGPT", "primary", 'data-act="save"');
    }
    if (c.config) {
      if (state === "verified") return stl("ok", "Saved. Workers restart to apply it.") + btn("Done", "primary", "data-close");
      return stl("", (id === "bedrock" ? "No live check here: AWS checks it when a task runs. " : "") + "Workers restart to apply it.") + btn("Cancel", "", "data-close") + btn("Save", "primary", 'data-act="save"');
    }
    if (state === "testing") return stl("busy", "Testing the " + noun + " with " + c.vendor + "…") + btn("Cancel", "", "disabled") + btn('<span class="spin" aria-hidden="true"></span>Testing', "primary", "disabled");
    if (state === "verified") return stl("ok", c.vendor + " accepted the " + noun + ". The " + noun + " ending 7Qx2 joined the pool.") + btn("Add another", "", 'data-act="again"') + btn("Done", "primary", "data-close");
    if (state === "rejected") return stl("err", "The key ending 7Qx2 was rejected (HTTP 401). Nothing was saved.") + btn("Cancel", "", "data-close") + btn("Test and add " + noun, "primary", 'data-act="save"');
    if (state === "unchecked") return stl("wait", "Saved. Waiting for a worker to check this key.") + btn("Add another", "", 'data-act="again"') + btn("Done", "primary", "data-close");
    return stl("", c.live ? "Test and add checks the " + noun + " with " + c.vendor + " first. A rejected " + noun + " is not saved." : c.name + " has no live check. A worker checks the " + noun + " on its next task.") +
      btn("Cancel", "", "data-close") + btn((c.live ? "Test and add " : "Add ") + noun, "primary", 'data-act="save"');
  }
  function hostBody(x) {
    if (x.shared) {
      return '<div class="note-i">' + I("i-info") + "<div><p>This host uses " + k("OPENROUTER_API_KEY") + ' from the LLMs tab. Add or remove keys there.</p><p>It calls openrouter.ai directly. It stops while <code class="k">OPENROUTER_BASE_URL</code> points at a gateway.</p></div></div>' +
        '<section class="sh-sec"><h3>Models</h3><p class="hlp">' + k("~typesafe/jev-latest") + " by default. A node can name another OpenRouter id, such as " + k("typesafe/jev-1.13") + ".</p></section>";
    }
    return '<section class="sh-sec"><h3>Get a key' + ext("Workflows guide", "#/docs/concepts/workflows") + "</h3>" + stepsHTML(x.steps) + (x.note ? '<p class="terms">' + x.note + "</p>" : "") + "</section>" +
      '<section class="sh-sec"><h3>' + (x.fields.length > 1 ? "Credentials" : "Credential") + "</h3>" + x.fields.map(function (f) { return field(f, x.set); }).join("") + "</section>";
  }
  function hostFoot(x, state) {
    if (x.shared) return stl("", "Edit the key on the LLMs tab.") + btn("Close", "", "data-close") + btn("Open OpenRouter keys", "primary", 'data-goto="openrouter"');
    if (state === "verified") return stl("ok", "Saved. The next decision uses it.") + btn("Done", "primary", "data-close");
    return stl("", "The swarm checks the key before a workflow's first decision.") + btn("Cancel", "", "data-close") + btn("Save", "primary", 'data-act="save"');
  }
  var EMB = [["openai", "OpenAI"], ["openrouter", "OpenRouter", true], ["vercel", "Vercel AI Gateway"], ["microsoft", "Azure / Microsoft Foundry"], ["link", "Custom"]];
  var EMB_MODELS = [
    ["openai/text-embedding-3-small", "Cheapest, and faster than the large model.", true],
    ["openai/text-embedding-3-large", "Higher quality, slower, 6.5x the price of the recommended model."],
    ["google/gemini-embedding-001", "Strong on multilingual and code text, 7.5x the price of the recommended model."],
  ];
  function embBody() {
    return '<div class="note-i">' + I("i-info") + "<div><p>Memories that have a vector keep it. A new model makes vectors that do not match the old ones, so recall of older memories gets worse.</p><p>Memory stores 512 numbers per vector. The test fails on a model that returns another size.</p></div></div>" +
      '<section class="sh-sec"><h3>Provider</h3><div class="popts" role="radiogroup" aria-label="Embeddings provider">' + EMB.map(function (o) {
        return '<button class="popt" type="button" role="radio" aria-checked="' + (o[0] === "vercel") + '">' + logo(o[0], "sm") + '<span class="nm">' + o[1] + "</span>" + (o[2] ? '<span class="sc ok">In use</span>' : "") + "</button>";
      }).join("") + "</div></section>" +
      '<section class="sh-sec"><h3>Model<span class="ck">EMBEDDING_MODEL</span></h3><div class="mlist" role="radiogroup" aria-label="Model">' + EMB_MODELS.map(function (m) {
        return '<button class="mrow" type="button" role="radio" aria-checked="' + !!m[2] + '"><span class="rd"></span><span><span class="m1">' + m[0] + (m[2] ? '<span class="sc info">Recommended</span>' : "") + '</span><span class="m2">' + m[1] + "</span></span></button>";
      }).join("") + "</div></section>" +
      '<section class="sh-sec"><h3>Key</h3>' + field(keyField("AI Gateway API key", "EMBEDDING_API_KEY", "vck_...", { demo: "vck_••••••••••••••••••••Gk2P", help: "Create one in the " + ext("Vercel dashboard", "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys") + ". Calls " + k("https://ai-gateway.vercel.sh/v1") + "." }), true) + "</section>";
  }
  function embFoot(state) {
    if (state === "testing") return stl("busy", "Testing the endpoint…") + btn("Cancel", "", "disabled") + btn('<span class="spin" aria-hidden="true"></span>Testing', "primary", "disabled");
    if (state === "verified") return stl("ok", "Memory works. 512 dims, 260 ms. Saved.") + btn("Done", "primary", "data-close");
    return stl("wait", "Tests when you stop typing.") + btn("Cancel", "", "data-close") + btn("Test and switch", "primary", 'data-act="save"');
  }
  function trBody() {
    return '<section class="sh-sec"><h3>Provider<span class="ck">TRANSCRIPTION_PROVIDER</span></h3><div class="seg" role="radiogroup" aria-label="Transcription provider">' +
      ["Auto-detect", "ElevenLabs", "OpenAI", "Groq"].map(function (x) { return '<button type="button" role="radio" aria-checked="' + (x === "Groq") + '">' + x + "</button>"; }).join("") + "</div>" +
      '<p class="hlp">Auto-detect uses the first key in the order ElevenLabs, OpenAI, Groq. A pinned provider uses only its own key.</p>' +
      '<p class="chk warn">' + I("i-alert") + "The swarm has no GROQ_API_KEY. Add an API key below, or transcription turns off.</p></section>" +
      '<section class="sh-sec"><h3>Key and model</h3>' +
      field(keyField("API key", "TRANSCRIPTION_API_KEY", "Paste a Groq key", { opt: true, help: "Overrides the auto-detected key. Only the API server reads it. Agents and scripts never get it." })) +
      field({ label: "Model", opt: true, key: "TRANSCRIPTION_MODEL", mono: true, ph: "whisper-large-v3-turbo", help: "Empty uses the Groq default." }) +
      field({ label: "Base URL", opt: true, key: "TRANSCRIPTION_BASE_URL", mono: true, ph: "https://api.groq.com/openai/v1", help: "Applies only with the API key above. OpenAI also covers self-hosted whisper servers." }) + "</section>";
  }
  function trFoot(state) {
    if (state === "verified") return stl("ok", "Saved. The next voice note uses Groq.") + btn("Done", "primary", "data-close");
    return stl("", "Applies to the next voice note. No restart.") + btn("Cancel", "", "data-close") + btn("Save", "primary", 'data-act="save"');
  }

  function spec(id, state, demo) {
    if (CAT[id]) { var c = CAT[id]; return { logo: c.logo, title: c.name, tags: [c.type], sub: c.sub, body: provBody(id, demo), foot: provFoot(id, state) }; }
    if (id.indexOf("s1-") === 0) {
      var x = HOST[id.slice(3)];
      return { logo: x.logo, title: hostName(x, true), tags: x.caps.map(function (c) { return c[0]; }), sub: x.sub, body: hostBody(x), foot: hostFoot(x, state) };
    }
    if (id === "emb") return { logo: "!i-database", title: "Change embeddings provider", tags: [], sub: "Memory recall finds memories by meaning with these vectors. Pick a preset, a model and a key.", body: embBody(), foot: embFoot(state) };
    return { logo: "!i-mic", title: "Change transcription provider", tags: [], sub: "Pin a provider, or give transcription a key of its own.", body: trBody(), foot: trFoot(state) };
  }
  function sheetHTML(id, state, demo) {
    var s = spec(id, state || "idle", demo), n = ++uid;
    return '<div class="sh-h">' + logo(s.logo, "xl") + '<div class="t"><h2 id="sh-t-' + n + '">' + s.title + s.tags.map(function (t) { return '<span class="tag">' + t + "</span>"; }).join("") + "</h2><p>" + s.sub + "</p></div>" +
      '<button class="btn ghost sq x" type="button" data-close aria-label="Close">' + I("i-x") + "</button></div>" +
      '<div class="sh-b">' + s.body + '</div><div class="sh-f">' + s.foot + "</div>";
  }
  function footFor(id, state) { return spec(id, state, false).foot; }

  /* ---------- Add menu ---------- */
  function menuGroups(kind) {
    if (kind === "s1") {
      return [["System One hosts", HOSTS.map(function (x) {
        return { pick: "s1-" + x.id, logo: x.logo, name: hostName(x, true), hint: x.caps.map(function (c) { return c[0]; }).join(", ") + " · " + x.creds.join(", "), added: x.set ? "Set" : "" };
      })]];
    }
    return GROUPS.map(function (g) {
      return [g[0], g[1].map(function (id) { return { pick: id, logo: CAT[id].logo, name: CAT[id].name, hint: CAT[id].runs, added: ADDED[id] || "" }; })];
    });
  }
  function amenuHTML(kind, hl, anim) {
    var n = ++uid, groups = menuGroups(kind), count = 0;
    groups.forEach(function (g) { count += g[1].length; });
    var label = kind === "s1" ? "Add credential" : "Add provider";
    return '<div class="amenu' + (anim ? " anim" : "") + '" role="dialog" aria-label="' + label + '">' +
      '<div class="am-s">' + I("i-search") + '<input type="text" role="combobox" aria-expanded="true" aria-controls="aml-' + n + '" aria-autocomplete="list" aria-label="Search ' + (kind === "s1" ? "hosts" : "providers") + '" placeholder="Search ' + count + " " + (kind === "s1" ? "hosts" : "providers") + '" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>' +
      '<div class="am-l" id="aml-' + n + '" role="listbox" aria-label="' + label + '">' +
      groups.map(function (g) {
        return '<div class="am-g" role="group" aria-label="' + g[0] + '"><div class="am-gh" aria-hidden="true">' + g[0] + "</div>" + g[1].map(function (it) {
          return '<button type="button" class="am-i' + (it.pick === hl ? " hl" : "") + '" role="option" aria-selected="' + (it.pick === hl) + '" data-pick="' + it.pick + '" data-q="' + (it.name + " " + it.hint).toLowerCase() + '">' +
            logo(it.logo, "sm") + '<span class="nm">' + it.name + '</span><span class="h">' + it.hint + "</span>" + (it.added ? '<span class="ok">' + I("i-check") + it.added + "</span>" : "") + "</button>";
        }).join("") + "</div>";
      }).join("") + '<p class="am-none" hidden>No provider matches. Your own gateway takes any OpenAI-compatible endpoint.</p></div></div>';
  }
  function closeAdd(host) {
    host.querySelectorAll(".amenu").forEach(function (m) { m.remove(); });
    host.querySelectorAll('[data-act="add"]').forEach(function (b) { b.setAttribute("aria-expanded", "false"); });
  }
  function openAdd(host, hl, anim) {
    var b = host.querySelector('[data-act="add"]'); if (!b) return;
    closeAdd(host); closeMenus(host);
    var kind = (host.getAttribute("data-tab") || "llm") === "s1" ? "s1" : "llm";
    b.insertAdjacentHTML("afterend", amenuHTML(kind, hl || (kind === "s1" ? "s1-laya" : "claude"), anim));
    b.setAttribute("aria-expanded", "true");
    if (anim) { var inp = host.querySelector(".amenu input"); if (inp) inp.focus({ preventScroll: true }); }
  }
  function filterAdd(menu, q) {
    q = q.trim().toLowerCase();
    var any = false;
    menu.querySelectorAll(".am-g").forEach(function (g) {
      var vis = 0;
      g.querySelectorAll(".am-i").forEach(function (it) { var on = !q || it.getAttribute("data-q").indexOf(q) > -1; it.hidden = !on; if (on) vis++; });
      g.hidden = vis === 0; if (vis) any = true;
    });
    menu.querySelector(".am-none").hidden = any;
    moveHl(menu, 0, true);
  }
  function moveHl(menu, dir, first) {
    var items = Array.prototype.filter.call(menu.querySelectorAll(".am-i"), function (it) { return !it.hidden; });
    if (!items.length) return;
    var i = items.findIndex(function (it) { return it.classList.contains("hl"); });
    var next = first ? 0 : Math.max(0, Math.min(items.length - 1, (i < 0 ? 0 : i + dir)));
    menu.querySelectorAll(".am-i").forEach(function (it) { it.classList.remove("hl"); it.setAttribute("aria-selected", "false"); });
    items[next].classList.add("hl"); items[next].setAttribute("aria-selected", "true");
    items[next].scrollIntoView({ block: "nearest" });
  }

  /* ---------- side panel open / close ---------- */
  function closeSheet(host) { host.querySelectorAll(":scope > .scrim, :scope > .drawer").forEach(function (n) { n.remove(); }); }
  function sheetLabel(id) { var s = spec(id, "idle", false); return s.title.replace(/<[^>]+>/g, ""); }
  function openSheet(host, id, anim, state, demo) {
    closeAdd(host); closeMenus(host); closeSheet(host);
    var a = anim ? " anim" : "";
    host.insertAdjacentHTML("beforeend", '<div class="scrim' + a + '" data-close></div><aside class="drawer pnl' + a + '" role="dialog" aria-modal="true" aria-label="' + sheetLabel(id) + '" data-sheet-id="' + id + '">' + sheetHTML(id, state, demo) + "</aside>");
    if (anim) { var x = host.querySelector(".drawer .x"); if (x) x.focus({ preventScroll: true }); }
  }
  function setFoot(drawer, state) {
    var id = drawer.getAttribute("data-sheet-id"), f = drawer.querySelector(".sh-f");
    if (f) f.innerHTML = footFor(id, state);
  }
  function save(drawer) {
    var id = drawer.getAttribute("data-sheet-id"), c = CAT[id];
    var quick = id.indexOf("s1-") === 0 || id === "tr" || (c && c.config);
    if (quick) { setFoot(drawer, "verified"); return; }
    setFoot(drawer, "testing");
    setTimeout(function () {
      if (!drawer.isConnected) return;
      setFoot(drawer, c && !c.live && !c.signIn ? "unchecked" : "verified");
    }, 1500);
  }

  /* ---------- key row menu and remove confirm ---------- */
  function mi(icon, label, hint, cls, act) {
    return '<button class="mi' + (cls ? " " + cls : "") + '" type="button" role="menuitem"' + (act ? ' data-mact="' + act + '"' : "") + ">" + I(icon) + label + (hint ? '<span class="hint">' + hint + "</span>" : "") + "</button>";
  }
  function closeMenus(scope) {
    scope.querySelectorAll(".menu").forEach(function (m) { m.remove(); });
    scope.querySelectorAll('.rm[aria-expanded="true"]').forEach(function (b) { b.setAttribute("aria-expanded", "false"); });
  }
  function openMenu(btnEl) {
    var host = btnEl.closest("[data-k]"); closeMenus(host); closeAdd(host);
    var kp = KEY[btnEl.closest(".kr").getAttribute("data-key")], key = kp[0], p = kp[1], c = CAT[p.id];
    var h = '<div class="menu anim" role="menu" aria-label="Actions for ' + key.name + '" data-key="' + key.id + '">' + mi("i-pencil", "Rename", "", "", "rename");
    if (p.plan) h += mi("i-card", "Set plan", key.plan.replace(/^(Claude|ChatGPT) /, ""), "", "plan");
    if (key.limited) h += mi("i-rotate-ccw", "Clear rate limit", "back " + key.limited, "", "clear");
    h += '<div class="msep" role="separator"></div>' + mi("i-trash", "Remove " + c.noun + "…", "", "danger", "remove") + "</div>";
    btnEl.insertAdjacentHTML("afterend", h);
    btnEl.setAttribute("aria-expanded", "true");
  }
  function dialogHTML(key, p) {
    var c = CAT[p.id], left = p.keys.length - 1, n = ++uid;
    return '<div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t-' + n + '" aria-describedby="dlg-d-' + n + '">' +
      '<h3 id="dlg-t-' + n + '">Remove ' + key.name + "?</h3>" +
      '<p id="dlg-d-' + n + '">This takes the ' + c.noun + " <b>" + key.sfx + "</b> out of the " + c.name + " pool. New tasks stop using it. Tasks already running finish with it.</p>" +
      "<p>" + (left ? "The other " + left + " " + c.noun + (left === 1 ? "" : "s") + " stay in the pool. " : "This is the last " + c.noun + ". Agents on this pool wait for credentials until you add one. ") +
      "Removing it here does not revoke it at " + c.vendor + ".</p>" +
      '<div class="acts">' + btn("Cancel", "", "data-close") + btn("Remove " + c.noun, "danger", "data-close") + "</div></div>";
  }

  /* ---------- page chrome ---------- */
  var TABS = [["llm", "LLMs", "4"], ["s1", "System One", "3"], ["emb", "Embeddings", ""], ["tr", "Transcription", ""]];
  var ACT = { llm: ["Search providers and keys", "Add provider", "add"], s1: ["Search hosts", "Add credential", "add"], emb: [null, "Change provider", "change"], tr: [null, "Change provider", "change"] };
  function tabRow(tab) {
    var a = ACT[tab], add = a[2] === "add";
    return '<div class="tabrow"><div class="utabs" role="tablist" aria-label="AI providers">' + TABS.map(function (t) {
      return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (t[0] === tab) + '">' + t[1] + (t[2] ? '<span class="n">' + t[2] + "</span>" : "") +
        (t[0] === "llm" ? '<span class="tdot" role="img" aria-label="1 provider is failing" title="1 provider is failing"></span>' : "") + "</button>";
    }).join("") + "</div>" +
      '<div class="tact">' + (a[0] ? '<span class="field sm" role="search">' + I("i-search") + a[0] + "</span>" + btn(I("i-search"), "only-phone", 'aria-label="' + a[0] + '" title="' + a[0] + '"') : "") +
      '<button class="btn primary" type="button" data-act="' + a[2] + '" aria-haspopup="' + (add ? "dialog" : "dialog") + '" aria-expanded="false" aria-label="' + a[1] + '" title="' + a[1] + '">' +
      I(add ? "i-plus" : "i-swap") + '<span class="bl">' + a[1] + "</span>" + (add ? '<span class="bl">' + I("i-chevron-down") + "</span>" : "") + "</button></div></div>";
  }
  function render(host) {
    var tab = host.getAttribute("data-tab") || "llm", phone = host.classList.contains("phone");
    var content = tab === "s1" ? s1Tab() : tab === "emb" ? embTab() : tab === "tr" ? trTab() : llmTab(host);
    var body = (phone ? "" : '<h1 class="sr-only">AI providers</h1>') + tabRow(tab) + "<div data-content>" + content + "</div>";
    if (phone) {
      host.innerHTML = '<div class="psb"><span>9:41</span><span class="dots"><i></i><i></i></span></div>' +
        '<div class="ptop">' + I("i-menu") + '<h1 class="ptitle">AI providers</h1><span class="sp"></span><span class="me">TY</span></div>' +
        '<div class="pbody">' + body + "</div>";
    } else {
      host.innerHTML = '<div class="topbar"><nav class="crumbs" aria-label="Breadcrumb"><span class="cg">Connect</span>' + I("i-chevron-right") + '<b aria-current="page">AI providers</b></nav>' +
        '<span class="sp"></span><span class="search">' + I("i-search") + 'Search or jump to<kbd>⌘K</kbd></span><span class="me">TY</span></div>' +
        '<div class="body">' + body + "</div>";
    }
    var strip = host.querySelector(".utabs"), sel = strip && strip.querySelector('[aria-selected="true"]');
    if (sel) {
      var x = sel.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
      if (x + sel.offsetWidth > strip.clientWidth) strip.scrollLeft = x - 8;
    }
    var add = host.getAttribute("data-add"); if (add) openAdd(host, add, false);
    var sh = host.getAttribute("data-sheet"); if (sh) openSheet(host, sh, false, "idle", true);
  }
  function toggleRow(row) {
    var on = row.getAttribute("aria-expanded") !== "true", ex = row.nextElementSibling;
    row.setAttribute("aria-expanded", String(on));
    if (!on) { ex.classList.remove("shown"); closeMenus(row.closest("[data-k]")); return; }
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(function () { if (row.getAttribute("aria-expanded") === "true") ex.classList.add("shown"); }, reduce ? 0 : 210);
  }

  /* ---------- interaction: one delegated handler per host ---------- */
  function wire(host) {
    host.addEventListener("click", function (e) {
      var t = e.target, el;
      if ((el = t.closest(".utabs [role=tab]"))) {
        ["data-add", "data-sheet"].forEach(function (a) { host.removeAttribute(a); });
        host.setAttribute("data-tab", el.getAttribute("data-tab")); render(host); return;
      }
      var dlgWrap = t.closest(".dlg-wrap");
      if (dlgWrap) { if (t.closest("[data-close]") || t === dlgWrap) dlgWrap.remove(); return; }
      if ((el = t.closest('[data-act="add"]'))) {
        if (el.getAttribute("aria-expanded") === "true") closeAdd(host); else openAdd(host, null, true);
        return;
      }
      if ((el = t.closest(".am-i"))) { openSheet(host, el.getAttribute("data-pick"), true); return; }
      if (t.closest(".amenu")) return;
      if ((el = t.closest('[data-act="change"]'))) { openSheet(host, host.getAttribute("data-tab"), true); return; }
      if ((el = t.closest("[data-sheet-open]"))) { e.stopPropagation(); openSheet(host, el.getAttribute("data-sheet-open"), true); return; }
      if ((el = t.closest("[data-sheet-switch]"))) {
        var dw = el.closest(".drawer"), id = el.getAttribute("data-sheet-switch");
        dw.setAttribute("data-sheet-id", id); dw.setAttribute("aria-label", sheetLabel(id)); dw.innerHTML = sheetHTML(id, "idle", false); return;
      }
      if ((el = t.closest("[data-goto]"))) {
        closeSheet(host); host.removeAttribute("data-sheet"); host.setAttribute("data-tab", "llm"); host.setAttribute("data-open", el.getAttribute("data-goto")); render(host); return;
      }
      if ((el = t.closest('.drawer [data-act="save"]'))) { save(el.closest(".drawer")); return; }
      if ((el = t.closest('.drawer [data-act="again"]'))) { var d2 = el.closest(".drawer"); d2.innerHTML = sheetHTML(d2.getAttribute("data-sheet-id"), "idle", false); return; }
      if ((el = t.closest('[data-act="test"]'))) {
        var b = el, html = b.innerHTML; b.innerHTML = '<span class="spin" aria-hidden="true"></span>Testing'; b.disabled = true;
        setTimeout(function () { b.innerHTML = html; b.disabled = false; }, 1200); return;
      }
      if (t.closest("[data-close]")) { closeSheet(host); return; }
      if (t.closest(".drawer")) {
        if ((el = t.closest(".popt, .mrow, .seg button"))) {
          el.parentElement.querySelectorAll('[role="radio"]').forEach(function (r) { r.setAttribute("aria-checked", String(r === el)); });
        }
        return;
      }
      if ((el = t.closest(".rm"))) { e.stopPropagation(); if (el.getAttribute("aria-expanded") === "true") closeMenus(host); else openMenu(el); return; }
      if ((el = t.closest(".menu .mi"))) {
        var kid = el.closest(".menu").getAttribute("data-key"), act = el.getAttribute("data-mact");
        closeMenus(host);
        if (act === "remove") { var kp = KEY[kid]; host.insertAdjacentHTML("beforeend", '<div class="dlg-wrap anim">' + dialogHTML(kp[0], kp[1]) + "</div>"); }
        return;
      }
      if (t.closest(".menu")) return;
      closeMenus(host); closeAdd(host);
      if ((el = t.closest(".pr"))) toggleRow(el);
    });
    host.addEventListener("keydown", function (e) {
      var row = e.target.closest && e.target.closest(".pr");
      if (row && e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleRow(row); return; }
      var menu = e.target.closest && e.target.closest(".amenu");
      if (menu) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveHl(menu, e.key === "ArrowDown" ? 1 : -1); }
        else if (e.key === "Enter") { e.preventDefault(); var hl = menu.querySelector(".am-i.hl:not([hidden])"); if (hl) openSheet(host, hl.getAttribute("data-pick"), true); }
      }
    });
    host.addEventListener("input", function (e) {
      var menu = e.target.closest && e.target.closest(".amenu");
      if (menu) filterAdd(menu, e.target.value);
    });
  }

  /* the sidebar dot shows the worst state on the page: a failing key */
  document.querySelectorAll('nav.side .ni[href$="ai-providers"] .nd').forEach(function (d) {
    d.classList.add("err"); d.title = "1 provider is failing, 1 key is rate limited";
  });
  document.querySelectorAll("[data-k]").forEach(function (host) { render(host); wire(host); });
  document.querySelectorAll("[data-sheet-demo]").forEach(function (el) {
    el.innerHTML = sheetHTML(el.getAttribute("data-sheet-demo"), "idle", true);
  });
  document.querySelectorAll("[data-vstates]").forEach(function (el) {
    el.innerHTML = [["While testing", "claude", "testing"], ["Verified", "claude", "verified"], ["Rejected", "claude", "rejected"], ["No live check", "amp", "unchecked"]].map(function (r) {
      return '<div class="vrow"><span class="vl">' + r[0] + '</span><div class="sh-f">' + footFor(r[1], r[2]) + "</div></div>";
    }).join("");
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var w = document.querySelector(".dlg-wrap"); if (w) { w.remove(); return; }
    document.querySelectorAll("[data-k]").forEach(function (h) {
      if (h.querySelector(".amenu")) { closeAdd(h); var b = h.querySelector('[data-act="add"]'); if (b) b.focus({ preventScroll: true }); return; }
      if (h.querySelector(".menu")) { closeMenus(h); return; }
      closeSheet(h);
    });
  });
  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-k]")) return;
    document.querySelectorAll("[data-k]").forEach(function (h) { closeMenus(h); closeAdd(h); });
  });
})();
