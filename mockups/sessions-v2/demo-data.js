/* Shared demo data for the sessions-v2 mockups. Every option reads window.SV2.
   Times are minutes before page load (ago). Glyph states: needs | unread | running | none.
   Dashboard sessions sit directly at their group key. A Slack thread key ends in thread:<ts>: one root is a plain row, 2+ roots show as a nested group. */
(function () {
  const now = Date.now();
  const at = (minAgo) => new Date(now - minAgo * 60000).toISOString();

  const sources = {
    dashboard: { label: "Dashboard" },
    slack: { label: "Slack" },
    telegram: { label: "Telegram" },
  };

  // Group labels for source segments (the server label map).
  const labels = {
    "shared/slack/c0a1eng/": "Slack › #eng",
    "shared/slack/c0b7pricing/": "Slack › #pricing-bot",
    "shared/slack/d0a4lena/": "Slack › DM with the swarm",
    "shared/telegram/772001/": "Telegram › Chat with the swarm",
  };

  const people = {
    taras: { name: "Taras", initials: "TY" },
    lena: { name: "Lena", initials: "LN" },
    marco: { name: "Marco", initials: "MC" },
  };

  const agents = {
    lead: { name: "Lead", initials: "LD" },
    researcher: { name: "Researcher", initials: "RS" },
    coder: { name: "Coder", initials: "CD" },
    reviewer: { name: "Reviewer", initials: "RV" },
  };

  // Empty groups the user created (persist without sessions).
  const savedGroups = ["shared/northwind/legal/"];

  // Timeline builders. Times are minutes ago. Kinds are documented in demo-data-big.js.
  const h = (who, ago, text, via) => ({ kind: "human", who, via: via || "dashboard", at: at(ago), text });
  const rp = (who, ago, text) => ({ kind: "reply", who, at: at(ago), text });
  const l = (ago, status, text) => ({ kind: "lead", at: at(ago), status, text });
  const w = (agent, taskType, ago, status, text, attempts) => Object.assign({ kind: "work", agent, taskType, at: at(ago), status, text }, attempts ? { attempts } : {});
  const fu = (ago, text) => ({ kind: "internal", type: "follow-up", at: at(ago), text });
  const ap = (ago, text) => ({ kind: "approval", agent: "lead", at: at(ago), text });
  // Header fields come from the timeline: tasks = lead + work + internal items, agents = the lead plus the workers that appear,
  // created and last = first and last item, status = the latest swarm reply or step.
  const fit = (s) => {
    const tl = s.timeline;
    s.tasks = tl.filter((t) => t.kind === "lead" || t.kind === "work" || t.kind === "internal").length;
    s.agents = ["lead"];
    tl.forEach((t) => { if (t.kind === "work" && !s.agents.includes(t.agent)) s.agents.push(t.agent); });
    s.created = tl[0].at;
    s.last = tl[tl.length - 1].at;
    s.status = tl.filter((t) => t.kind === "lead" || t.kind === "work").pop().status;
    return s;
  };

  const conversations = [
    {
      id: "cv1", key: "shared/northwind/pricing/", title: "Scrape the supplier price feed",
      source: "dashboard", owner: "taras",
      sessions: [
        {
          id: "s1", title: "Scrape the supplier price feed", glyph: "running", cost: 1.42,
          timeline: [
            h("taras", 95, "Build a scraper for the supplier price feed. Store new prices in the pricing app, dedupe by SKU."),
            l(94, "completed", "Splitting it into the feed parser, dedupe, and the app upsert. Sending the parser to the Coder."),
            w("coder", "implementation", 93, "completed", "Parser done. 312 prices parsed from the last 7 days, 4 malformed entries skipped and logged."),
            fu(70, "Coder finished. The lead queued dedupe and the app upsert."),
            l(69, "completed", "The parser is done: 312 prices from the last 7 days, 4 malformed entries skipped. Dedupe and the upsert are next."),
            h("taras", 6, "Also extract the currency and the unit size."),
            l(5, "completed", "Adding both fields to the parser. Sending it to the Coder."),
            w("coder", "implementation", 2, "running", "Adding currency and unit-size extraction. Running against the 7-day sample."),
          ],
        },
      ],
    },
    {
      id: "cv1b", key: "shared/northwind/pricing/", title: "Streaming XML parser spike",
      source: "dashboard", owner: "taras",
      sessions: [{
        id: "s1b", title: "Streaming XML parser spike", glyph: "unread", cost: 0.61,
        timeline: [
          h("taras", 60, "Try a streaming XML parser for the price feed. The DOM parser uses too much memory on the 30-day backfill."),
          l(59, "completed", "Sending the spike to the Coder."),
          w("coder", "implementation", 58, "completed", "Streaming parser: 30-day backfill in 41 s, peak memory 88 MB (was 1.2 GB). Same 312 rows on the 7-day sample."),
          fu(13, "Coder finished. The lead checked the numbers."),
          l(12, "completed", "The streaming parser works. The 30-day backfill takes 41 s with 88 MB peak memory, down from 1.2 GB."),
        ],
      }],
    },
    {
      id: "cv2", key: "shared/northwind/pricing/", title: "Weekly price digest",
      source: "dashboard", owner: "taras",
      sessions: [{
        id: "s2", title: "Weekly price digest", glyph: "none", cost: 0.88,
        timeline: [
          h("taras", 1500, "Write the weekly price digest for the pricing team."),
          l(1499, "completed", "Sending the price research to the Researcher. I will write the digest from it."),
          w("researcher", "research", 1498, "completed", "Pulled 7 days of price changes. 18 SKUs moved more than 5%: 11 down and 7 up."),
          fu(1442, "Researcher finished. The lead wrote the digest."),
          l(1440, "completed", "Digest ready. 18 SKUs moved more than 5% this week: 11 went down and 7 went up. The biggest drop is the 40 mm bracket at -12%."),
        ],
      }],
    },
    {
      id: "cv3", key: "shared/northwind/infra/", title: "Move the swarm to the new server",
      source: "dashboard", owner: "taras",
      sessions: [{
        id: "s3", title: "Move the swarm to the new server", glyph: "needs", cost: 0.35,
        timeline: [
          h("taras", 300, "Plan the move of the swarm to the new 16-core box. Keep agent-fs data."),
          l(299, "completed", "Sending the volume inventory to the Researcher first."),
          w("researcher", "research", 298, "completed", "Two volumes to move: the agent-fs SQLite volume (4.1 GB) and the MinIO volume (62 GB). Both can be snapshotted live."),
          fu(27, "Researcher finished. The lead drafted the plan."),
          l(26, "paused", "Plan ready: back up the agent-fs SQLite volume and the MinIO volume, then restore on the new host."),
          ap(25, "Approve: stop the API for about 5 minutes to snapshot the volumes?"),
        ],
      }],
    },
    {
      id: "cv4", key: "shared/swarm-app/ios/", title: "Live Activity push tokens",
      source: "dashboard", owner: "taras",
      sessions: [{
        id: "s4", title: "Live Activity push tokens", glyph: "running", cost: 2.1, finishesInSeconds: 8,
        timeline: [
          h("taras", 200, "Store the Live Activity push tokens per device, and replace them when the app sends a new one."),
          l(199, "completed", "Sending it to the Coder."),
          w("coder", "implementation", 198, "completed", "Token table added with a migration. Tokens are keyed by device and activity."),
          fu(150, "Coder finished. The lead queued the replace endpoint."),
          l(149, "completed", "Storage is in. Each device keeps one token per activity, and a new token replaces the old one."),
          h("taras", 30, "Also expire tokens after 8 hours."),
          l(29, "completed", "Adding an expiry job. Sending it to the Coder."),
          w("coder", "implementation", 1, "running", "Writing the expiry job and its test."),
        ],
      }],
    },
    {
      id: "cv5", key: "personal/taras/notes/", title: "Talk outline: agent memory",
      source: "dashboard", owner: "taras",
      sessions: [{
        id: "s5", title: "Talk outline: agent memory", glyph: "none", cost: 0.2,
        timeline: [
          h("taras", 4300, "Outline a 20 minute talk about agent memory. Three sections and one demo."),
          l(4299, "completed", "Sending the outline to the Researcher."),
          w("researcher", "research", 4298, "completed", "Outline: why agents forget, three memory layers, a live recall demo. About 6 slides per section."),
          fu(4202, "Researcher finished. The lead checked the timing."),
          l(4200, "completed", "Outline ready: why agents forget, three memory layers, and a live recall demo. About 18 slides for 20 minutes."),
        ],
      }],
    },
    {
      id: "cv6", key: "shared/slack/c0a1eng/thread:1792505607.111519/", title: "Why is CI red on main?",
      source: "slack", owner: "taras",
      sessions: [
        {
          id: "s6", title: "Why is CI red on main?", glyph: "unread", cost: 0.74,
          timeline: [
            h("lena", 182, "@swarm CI is red on main since the release, anyone looking?", "slack"),
            l(181, "completed", "Checking the failing runs on main. Sending it to the Reviewer."),
            w("reviewer", "review", 180, "completed", "The UI E2E shard fails on the sessions spec. A selector still targets the old \"Show system tasks\" label."),
            fu(152, "Reviewer finished. The lead wrote the summary."),
            l(151, "completed", "The UI E2E shard fails on the sessions spec: a selector still targets the old \"Show system tasks\" label. It is not flaky."),
            rp("taras", 35, "Fix the selector and open a PR, please."),
            l(34, "completed", "Fixing the selector. Sending it to the Coder."),
            w("coder", "implementation", 33, "completed", "PR #2291 opened: selector fixed, the spec passes locally."),
            fu(31, "Coder finished. The lead checked the PR."),
            l(30, "completed", "PR #2291 is open. The selector is fixed and the sessions spec passes locally."),
          ],
        },
        {
          id: "s6b", title: "@Coder: also bump the Playwright timeout", glyph: "unread", cost: 0.12,
          timeline: [
            h("lena", 121, "@Coder can you also bump the Playwright timeout to 60s?", "slack"),
            l(120, "completed", "Sending it to the Coder."),
            w("coder", "implementation", 119, "failed", "No write access to the CI config branch. Stopped."),
            fu(111, "Coder failed. The lead stopped the task."),
            l(110, "failed", "The Coder could not change the timeout. It has no write access to the CI config branch. Someone with access needs to make the change, or grant the Coder access."),
          ],
        },
      ],
    },
    {
      id: "cv7", key: "shared/slack/c0a1eng/thread:1792509911.004100/", title: "Deploy v2.4.3",
      source: "slack", owner: "taras",
      sessions: [{
        id: "s7", title: "Deploy v2.4.3", glyph: "none", cost: 0.31,
        timeline: [
          h("taras", 1450, "@swarm deploy v2.4.3 to production.", "slack"),
          l(1449, "completed", "Sending the deploy to the Coder."),
          w("coder", "implementation", 1448, "completed", "Deploy finished. Health checks pass on all 3 instances."),
          fu(1402, "Coder finished. The lead confirmed the health checks."),
          l(1400, "completed", "v2.4.3 is live. Health checks pass on all 3 instances."),
        ],
      }],
    },
    {
      id: "cv8", key: "shared/slack/d0a4lena/thread:1792511122.000200/", title: "Launch post research",
      source: "slack", owner: "taras",
      sessions: [{
        id: "s8", title: "Launch post research", glyph: "running", cost: 0.95,
        timeline: [
          h("taras", 50, "@swarm what did competitors say in their last 3 launch posts?", "slack"),
          l(49, "completed", "Sending it to the Researcher."),
          w("researcher", "research", 48, "completed", "Read 3 launch posts. All open with one headline number and a short demo clip."),
          fu(20, "Researcher finished. The lead wrote the summary."),
          l(19, "completed", "All 3 competitor posts open with one headline number and a short demo clip."),
          h("taras", 6, "Can you also check how long each post is?", "slack"),
          l(5, "completed", "Counting the words and the reading time. Sending it to the Researcher."),
          w("researcher", "research", 3, "running", "Counting words and reading time for each post."),
        ],
      }],
    },
    {
      id: "cv9", key: "shared/telegram/772001/thread:9/", title: "Price alert format",
      source: "telegram", owner: "taras",
      sessions: [{
        id: "s9", title: "Price alert format", glyph: "unread", cost: 0.09,
        timeline: [
          h("taras", 391, "What should a price alert look like? Keep it short.", "telegram"),
          l(390, "completed", "One line: SKU, old price, new price, and the percent change. Example: \"BRK-40: 12.50 to 11.00 (-12%)\"."),
        ],
      }],
    },
    {
      id: "cv10", key: "shared/northwind/pricing/", title: "Competitor price analysis (Lena)",
      source: "dashboard", owner: "lena", shared: "edit",
      sessions: [{
        id: "s10", title: "Competitor price analysis", glyph: "unread", cost: 0.66,
        timeline: [
          h("lena", 1600, "Compare our price tiers with the 4 closest competitors."),
          l(1599, "completed", "Sending it to the Researcher."),
          w("researcher", "research", 1598, "completed", "Compared 4 competitors. We are level with the median on the entry tier and 8% above it on the mid tier."),
          fu(1502, "Researcher finished. The lead wrote the summary."),
          l(1500, "completed", "We are level with the median on the entry tier and 8% above it on the mid tier. The top tier has no close match."),
        ],
      }],
    },
    {
      id: "cv11", key: "personal/lena/research/", title: "Pricing page teardown",
      source: "dashboard", owner: "lena", shared: "view",
      sessions: [{
        id: "s11", title: "Pricing page teardown", glyph: "none", cost: 0.3,
        timeline: [
          h("lena", 5000, "Break down how three competitors structure their pricing pages."),
          l(4999, "completed", "Sending it to the Researcher."),
          w("researcher", "research", 4998, "completed", "All 3 show annual pricing first, a comparison table below the tiers, and an FAQ at the end."),
          fu(4902, "Researcher finished. The lead wrote the summary."),
          l(4900, "completed", "All 3 pages show annual pricing first, put a comparison table below the tiers, and end with an FAQ."),
        ],
      }],
    },
    {
      id: "cv12", key: "shared/task:s12/", title: "Quick: summarize the customer call",
      source: "dashboard", owner: "taras",
      sessions: [{
        id: "s12", title: "Quick: summarize the customer call", glyph: "none", cost: 0.05,
        timeline: [
          h("taras", 141, "Summarize the customer call notes in three bullets."),
          l(140, "completed", "They like the new sessions view. They want a mobile layout. They ask for shared groups."),
        ],
      }],
    },
    {
      id: "cv13", key: "shared/task:s13/", title: "Draft the PR template tip for Marco",
      source: "dashboard", owner: "taras",
      sessions: [{
        id: "s13", title: "Draft the PR template tip for Marco", glyph: "none", cost: 0.04,
        timeline: [
          h("taras", 2881, "Draft a one-line PR template tip for Marco."),
          l(2880, "completed", "Tip: start the PR body with why the change exists, then link the issue. Reviewers read that first."),
        ],
      }],
    },
  ];

  conversations.forEach((c) => c.sessions.forEach(fit));

  // Legacy view: today's query (dashboard source, mine, newest first, flat).
  const legacy = conversations
    .filter((c) => c.source === "dashboard" && c.owner === "taras")
    .flatMap((c) => c.sessions.filter((s) => !s.forkedFrom).map((s) => ({ id: s.id, title: s.title, status: s.status, tasks: s.tasks, last: s.last })))
    .sort((a, b) => (a.last < b.last ? 1 : -1));

  window.SV2 = { me: "taras", sources, labels, people, agents, savedGroups, conversations, legacy };
})();
