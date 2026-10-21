/* Large multi-person sessions for the sessions-v2 mockups (round 7+).
   Load AFTER demo-data.js. Shapes follow PROD-SHAPES.md (2 people taking turns,
   the lead answering every human turn, workers in parallel, failures and retries,
   internal follow-ups and deferred wake-ups). All content is invented.
   Round 10 adds sL1: a 120-character title with a long branch name, to test truncation.

   Timeline kinds added here:
   - human     { who, at, text, via: "dashboard" | "slack" | "telegram" }
   - reply     { who, at, text }  a dashboard reply posted into a Slack thread
   - lead      { at, status, text }                       the swarm's reply (no agent label)
   - work      { agent, taskType, at, status, text, attempts? }  a delegated worker task
   - internal  { at, type: "follow-up" | "deferred" | "resume" | "superseded", text }  hidden by default
   - approval  { at, text } (as before) */
(function () {
  const D = window.SV2;
  const now = Date.now();
  const at = (minAgo) => new Date(now - minAgo * 60000).toISOString();

  D.agents.writer = { name: "Writer", initials: "WR" };
  D.agents.researcher = D.agents.researcher || { name: "Researcher", initials: "RS" };

  const h = (who, ago, text, via) => ({ kind: "human", who, via: via || "dashboard", at: at(ago), text });
  const rp = (who, ago, text) => ({ kind: "reply", who, at: at(ago), text });
  const l = (ago, status, text) => ({ kind: "lead", at: at(ago), status, text });
  const w = (agent, taskType, ago, status, text, attempts) => Object.assign({ kind: "work", agent, taskType, at: at(ago), status, text }, attempts ? { attempts } : {});
  const fu = (ago, text) => ({ kind: "internal", type: "follow-up", at: at(ago), text });
  const it = (type, ago, text) => ({ kind: "internal", type, at: at(ago), text });
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

  D.conversations.push({
    id: "cvB1", key: "shared/northwind/pricing/", title: "Q4 pricing page rewrite",
    source: "dashboard", owner: "taras", shares: [{ who: "lena", access: "edit" }],
    sessions: [fit({
      id: "sB1", title: "Q4 pricing page rewrite", glyph: "unread", cost: 6.84, people: ["taras", "lena"],
      timeline: [
        h("taras", 1560, "Rewrite the pricing page for Q4. Three tiers, annual discount, and a comparison table. Lena owns the copy review."),
        l(1558, "completed", "Plan: research competitor tiers, draft copy, review against the brand guide. Starting research and a first draft in parallel."),
        w("researcher", "research", 1556, "completed", "Compared 6 competitors. 5 of 6 show annual pricing first. Median annual discount is 17%."),
        w("writer", "content", 1556, "completed", "Draft v1: three tiers (Starter, Team, Scale), a feature table with 14 rows, an FAQ with 6 questions."),
        fu(1530, "Researcher finished. The lead merged the findings into the plan."),
        fu(1528, "Writer finished. The lead queued a review."),
        l(1527, "completed", "Draft v1 is ready. Annual pricing shows first, with a 17% discount. Lena, can you review the copy?"),
        h("lena", 1440, "The Scale tier reads like enterprise. Can we call it Business and drop the SSO row from Team?"),
        l(1438, "completed", "Renaming Scale to Business and moving SSO to Business only. Sending it back to the Writer."),
        w("writer", "content", 1436, "completed", "Draft v2: Business tier, SSO only on Business, FAQ updated."),
        fu(1418, "Writer finished. The lead sent draft v2 to the Reviewer."),
        w("reviewer", "review", 1416, "completed", "Brand review: 3 issues. Two headline lengths, and one claim needs a source."),
        fu(1398, "Reviewer finished. The lead asked the Writer to fix the 3 issues."),
        w("writer", "review-fix", 1396, "failed", "Could not open the brand guide (permission denied on the shared drive).", 1),
        w("writer", "review-fix", 1380, "completed", "Fixed the 3 review issues using the cached brand guide.", 2),
        fu(1379, "Writer finished. The lead checked the fixes."),
        l(1378, "completed", "Draft v3 passes review. I will check tomorrow morning whether the finance numbers are final before publishing."),
        it("deferred", 1377, "The lead scheduled a wake-up for tomorrow 09:00."),
        it("resume", 900, "Wake-up at 09:00. The lead resumed the session."),
        l(899, "completed", "Finance confirmed the numbers. One change: Team goes from 29 to 32 per seat. Updating the table."),
        w("writer", "content", 897, "completed", "Team price set to 32 per seat in the table and the FAQ."),
        fu(880, "Writer finished. The lead checked the table."),
        l(879, "completed", "The table now shows 32 per seat for Team. Nothing else changed."),
        h("taras", 600, "Add a toggle for monthly and annual, and make annual the default."),
        l(598, "completed", "Adding the toggle. This needs a small component change, so I am sending it to the Coder."),
        w("coder", "implementation", 596, "failed", "Build failed: the pricing table component expects a single price field.", 1),
        w("coder", "implementation", 560, "failed", "Build failed again: a snapshot test still pins the old markup.", 2),
        w("coder", "implementation", 520, "completed", "Toggle added, annual is the default, snapshot updated. Preview link is ready.", 3),
        fu(500, "Coder finished. The lead opened the preview."),
        l(499, "completed", "The toggle is live in the preview and annual is the default. It took three tries because of a snapshot test."),
        h("lena", 8, "Looks good. Last thing: the FAQ answer about refunds is too long."),
        l(7, "completed", "Shortening the refund answer to two sentences. Sending it to the Writer."),
        w("writer", "content", 4, "running", "Editing the refund answer."),
      ],
    })],
  });

  D.conversations.push({
    id: "cvB2", key: "shared/slack/c0a1eng/thread:1792600000.000100/", title: "Release checklist for v2.5",
    source: "slack", owner: "marco",
    sessions: [fit({
      id: "sB2", title: "Release checklist for v2.5", glyph: "unread", cost: 9.12, people: ["marco", "taras"],
      timeline: [
        h("marco", 260, "@swarm can you run the release checklist for v2.5?", "slack"),
        l(258, "completed", "Running it: changelog, migration check, dependency audit, and a docs link check. Four workers in parallel."),
        w("coder", "implementation", 257, "completed", "Changelog drafted from 23 merged PRs."),
        w("reviewer", "review", 257, "completed", "Migration 241 is additive. No backfill needed."),
        w("researcher", "research", 257, "completed", "Dependency audit: 2 minor bumps, no advisories."),
        w("coder", "docs", 256, "failed", "The docs link check could not reach the docs site (timeout).", 1),
        w("coder", "docs", 250, "completed", "Docs link check passed after a retry: 311 links, 0 broken.", 2),
        fu(246, "Coder finished the changelog. The lead filed it in the checklist."),
        fu(245, "Reviewer finished. The lead marked the migration check done."),
        fu(244, "Researcher finished. The lead marked the audit done."),
        fu(243, "Coder finished the link check. The lead marked it done."),
        l(242, "completed", "The checklist is green: changelog drafted from 23 PRs, migration 241 is additive, no advisories, and 311 docs links work."),
        h("taras", 238, "also bump the chart version please", "slack"),
        l(237, "completed", "Adding the chart bump to the checklist. Sending it to the Coder, with the Reviewer linting the chart."),
        w("reviewer", "review", 236, "completed", "Chart lint is clean once the version matches the package."),
        w("coder", "implementation", 236, "failed", "The chart version check failed: the OpenAPI spec was stale.", 1),
        w("coder", "implementation", 230, "failed", "Chart lint failed: appVersion did not match package.json.", 2),
        w("coder", "implementation", 220, "completed", "Regenerated the OpenAPI spec and bumped the chart. All checks pass.", 3),
        fu(219, "Reviewer finished. The lead waited for the Coder."),
        fu(218, "Coder finished. The lead checked the chart version."),
        l(217, "completed", "The chart is bumped to 2.5.0 and all checks pass. It took three tries because the OpenAPI spec was stale."),
        h("marco", 200, "can we get release notes for the blog too?", "slack"),
        l(199, "completed", "Sending the highlights to the Researcher and the draft to the Writer, then a review."),
        w("researcher", "research", 198, "completed", "Pulled 5 customer-facing highlights from the changelog."),
        w("writer", "content", 190, "failed", "The draft is 1,900 words. The blog limit is 800.", 1),
        w("writer", "content", 182, "completed", "Release notes drafted: 640 words, 5 highlights, one screenshot slot.", 2),
        w("reviewer", "review", 181, "completed", "Tone and claims check: 1 claim needs a link."),
        fu(180, "Researcher finished. The lead passed the highlights to the Writer."),
        fu(179, "Writer finished. The lead sent the draft to the Reviewer."),
        fu(178, "Reviewer finished. The lead added the missing link."),
        l(177, "completed", "Release notes are ready: 640 words and 5 highlights. I added the missing link."),
        h("marco", 150, "smoke test on staging?", "slack"),
        l(149, "completed", "Running it now. Sending the smoke test to the Coder, with a config check from the Reviewer."),
        w("reviewer", "review", 148, "completed", "Staging config matches production except for two feature flags."),
        w("coder", "test", 148, "failed", "Smoke test timed out: staging was redeploying.", 1),
        w("coder", "test", 135, "failed", "Smoke test timed out again on the login check.", 2),
        w("coder", "test", 120, "completed", "Staging smoke test passed: 42 of 42 checks.", 3),
        fu(119, "Reviewer finished. The lead noted the two flag differences."),
        fu(118, "Coder finished. The lead collected the results."),
        l(117, "completed", "The staging smoke test passed on the third run: 42 of 42 checks. The first two runs timed out while staging redeployed."),
        rp("taras", 100, "Run it again against the release candidate build and post the result here."),
        l(99, "completed", "Running the smoke test against the release candidate. Sending it to the Coder, with a latency check from the Reviewer."),
        w("coder", "test", 98, "completed", "Release candidate smoke test: 42 of 42 checks pass."),
        w("reviewer", "review", 97, "completed", "Latency check: p95 on the sessions list is 4% lower than v2.4.3."),
        fu(57, "Coder finished. The lead collected the results."),
        fu(56, "Reviewer finished. The lead added the latency number."),
        l(55, "completed", "The release candidate passes the smoke test (42 of 42) and p95 latency is 4% lower than v2.4.3. The release is ready."),
      ],
    })],
  });

  // Round 10: one title at the 120-character rename limit, with a long unbroken token (a branch name).
  // It is recent and unread, so it shows in the Inbox by default. Every title surface must truncate it.
  const LONG = "Rebase feature/sessions-v2-long-title-truncation-sidebar-tabs-header-split-palette onto main, then rerun the merge gates";
  D.conversations.push({
    id: "cvL1", key: "shared/northwind/infra/", title: LONG,
    source: "dashboard", owner: "taras",
    sessions: [fit({
      id: "sL1", title: LONG, glyph: "unread", cost: 0.47,
      timeline: [
        h("taras", 14, LONG + "."),
        l(13, "completed", "Sending the rebase to the Coder."),
        w("coder", "implementation", 12, "completed", "Rebased onto main. Two conflicts in the tab strip CSS, both resolved. All merge gates pass."),
        fu(4, "Coder finished. The lead read the result."),
        l(3, "completed", "The branch is rebased onto main. I resolved two conflicts in the tab strip CSS, and every merge gate passes."),
      ],
    })],
  });
})();
