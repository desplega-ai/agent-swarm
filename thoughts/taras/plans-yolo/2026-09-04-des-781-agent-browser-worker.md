---
date: 2026-09-04T16:05:00Z
topic: "DES-781: replace qa-use with agent-browser in the worker image and the seeded qa skill"
status: done
---

# DES-781: replace qa-use with agent-browser in the worker image and the seeded qa skill

## Goal

Swarm workers on the full image drive browsers with `agent-browser` instead of `qa-use`, share screenshots through agent-fs, and the seeded `qa` skill plus a new seeded `agent-browser` skill tell them how. The slim image stays browser-free and the skill degrades to manual QA there. Docs no longer claim the full image ships qa-use. A sibling PR rewrites the ai-toolbox qa skill the same way.

## Decisions

- Pin `agent-browser` at 0.31.1, not the current npm latest 0.36.0. Matches the version on Taras's Mac, the local skill was modelled on it, and its bundled `skills get core` guide is the one the seeded skill points at. Flagged in the PR as a follow-up bump. (assumed)
- Keep Playwright's Chromium as the only browser. Add `playwright` 1.58.0 (the exact version qa-use 2.19.0 pulled) as a direct dep of `/opt/global-deps-full`, keep `playwright install chromium` plus the existing ldd and launch checks, and point `AGENT_BROWSER_EXECUTABLE_PATH` at a stable `/opt/playwright/chromium` symlink. Probe in the baseline image confirmed agent-browser 0.31.1 opens, screenshots, and closes through that binary as `worker`, headless, on Node 22, with no extra Chrome flags. (verified)
- Prune the non-Linux agent-browser binaries (darwin, win32, musl) from `node_modules/agent-browser/bin` in the same RUN. The launcher only looks for the exact platform binary. Both linux-x64 and linux-arm64 stay because CI builds both arches. (assumed)
- Launch Chromium with `AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage` (image ENV). The first build failed the smoke test with "No usable sandbox!" because BuildKit RUN steps and Docker's default seccomp profile block user namespaces. Both flags are Playwright's own defaults (chromiumSandbox: false, disable-dev-shm-usage), so this is parity, not a new relaxation. (verified)
- Wipe `/home/worker/.agent-browser` after the build-time smoke test. The daemon leaves `default.pid` and `default.sock` behind and a stale pid file would confuse the runtime daemon lookup. (verified in the probe)
- Seeded `agent-browser` skill is `systemDefault: true`, like the `qa` skill that references it and like the baked qa-use skill it replaces, which every full-image agent had. (assumed)
- Also rewrite the worker-facing qa-use instructions outside the listed doc sweep: the `daily-hn-briefing` schedule template and the `ux-principles` official profile templates. They tell agents to run qa-use commands that no longer exist in the image. Called out in the PR. (assumed)
- `templates/skills/qa/` and `templates/skills/script-builder/` are vendored ai-toolbox copies, SHA-pinned in `templates/ai-toolbox.manifest.json` and gated by `bun run check:ai-toolbox-skills` in CI. Hand edits fail the gate (the Spec reviewer caught this). The qa rewrite therefore lives in ai-toolbox PR #34 and is vendored back with `bun run sync:ai-toolbox-skills --ref fc072f6486025a9b0556f8451d877476f8046650` (the PR head). Merge order: ai-toolbox #34 first, then re-sync to the merged sha, then this PR. The seeded copy says "if an `agent-browser` skill is installed (the swarm seeds one), follow it. Otherwise: ..." so one text serves both the plugin and the swarm. (verified)
- Prune agent-browser to the single `TARGETARCH` binary with a `test -x` assert in front of it, instead of deleting the non-Linux ones and keeping both Linux ones (Standards reviewer). Image is now 4,300,367,177 B, slightly under main. (verified)
- Leave `src/http/pages.ts:296` and `src/tests/use-dismissible-card.test.ts:17` alone. They cite historical qa-use sessions, not the image contents. (assumed)

## Todo

- [x] Dockerfile.worker: heredoc swap (agent-browser 0.31.1 + playwright 1.58.0, drop qa-use), install RUN (`playwright install chromium`, symlink, prune), `ENV AGENT_BROWSER_EXECUTABLE_PATH`, worker-user smoke RUN, remove qa-use skill bake, fix header comments
- [x] Build `worker-full` locally, record before and after sizes
- [x] Seeded skill `templates/skills/agent-browser/{config.json,content.md}` + registration in `src/be/seed-skills/index.ts`
- [x] Rewrite `templates/skills/qa/content.md` qa-use branches, bump version
- [x] Doc sweep: runbooks/docker-images.md, runbooks/skills.md, DEPLOYMENT.md, LOCAL_TESTING.md, swarm-local-e2e SKILL.md, published-artifacts.mdx, deployment.mdx, docker-and-deploy.yml comment, check-skill-sources.ts comment, script-builder content, hn-briefing schedule, ux-principles templates
- [x] CHANGELOG entry under Unreleased
- [x] Proof: full image worker takes an example.com screenshot with agent-browser, uploads to agent-fs, signed URL in store-progress (task 70597cf8); slim image degrades to manual fallback (task be5f8062). Evidence: thoughts/taras/qa/2026-09-04-des-781-agent-browser-worker.md
- [x] ai-toolbox PR for `cc-plugin/base/skills/qa/SKILL.md`
- [x] Code review (Standards + Spec, both Opus): Critical vendoring drift fixed via re-sync; Important TARGETARCH prune fixed; CHANGELOG clause added. Minor left as noted: em dashes carried in three re-flowed pre-existing lines; docs-site playbooks (`ux-command-center.mdx`, `self-documenting-release-reports.mdx`) and `README.md:109` still describe qa-use, per the instruction to leave playbooks; `.wts-setup.ts` / `.gitignore` still know `.qa-use-tests.json`.
- [ ] Commit, PR, DES-781 comment

## Verification

- `bun run check:skill-sources && bun run check:skill-md && bun run check:seed-skill-files && bun run check:ai-toolbox-skills`
- `bun run test:root -- src/tests/seed-skills-bundled-files.test.ts src/tests/system-default-skills.test.ts`
- `bun run lint` (known local Biome crash: use the sandbox recipe if it aborts) and `bun run tsc:check`
- `bun run docker:build:worker` then `docker history agent-swarm-worker:latest --format "{{.Size}}\t{{.CreatedBy}}" | sort -h -r | head -10`
- `docker run --rm --entrypoint bash -u worker agent-swarm-worker:latest -c 'command -v agent-browser && ! command -v qa-use && agent-browser --version && ls -la /opt/playwright/chromium'`
- swarm-local-e2e task on full and slim images (see Proof section of the PR)
