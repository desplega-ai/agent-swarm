---
date: 2026-07-06
author: Claude
topic: "Memory usefulness — prod baseline snapshot (trend anchor)"
tags: [qa, memory, baseline, usefulness, DES-639]
plan: thoughts/taras/plans/2026-07-02-memory-retrieval-v2-graph-and-measurement.md (Phase 3)
---

# Memory usefulness — prod baseline (2026-07-06)

Trend anchor for the memory-retrieval v2 track. A pure pre-hybrid baseline is not
possible (hybrid + raters went live ~2026-06-27 without a snapshot); this records
state at readout-ship time. Numbers mirror `GET /api/memory/usefulness?days=30`
(`src/be/memory/usefulness-stats.ts`), executed as read-only SQL against the prod
DB because the endpoint ships with PR #894 (not yet deployed at capture time).

## Command

```bash
CUTOFF=2026-06-06T11:17:36.000Z   # date -u -v-30d
sqlite3 -readonly -json <prod DB file> <<SQL
<the five queries from src/be/memory/usefulness-stats.ts, 30d window, threshold 0.6>
SQL
```

(Executed read-only on the prod host; host/DB-path details are kept out of the repo.)

## Raw output

```json
// volume (30d window)
[{"retrievals":36517,"distinctMemories":4498,"retrievalGroups":4503,"searchEvents":35507,"getEvents":1010}]

// per-arm breakdown (30d; citedRetrievals = EXISTS positive implicit-citation on (taskId, memoryId))
[{"retrievalSource":null,"retrievals":24314,"distinctMemories":3735,"citedRetrievals":7796},
 {"retrievalSource":"hybrid","retrievals":6801,"distinctMemories":1332,"citedRetrievals":4484},
 {"retrievalSource":"fts","retrievals":2761,"distinctMemories":604,"citedRetrievals":754},
 {"retrievalSource":"vec","retrievals":2641,"distinctMemories":408,"citedRetrievals":524}]

// citation by memory-source (30d, implicit-citation ratings)
[{"source":"task_completion","ratings":11850,"positive":1987,"avgSignal":-0.6646},
 {"source":"file_index","ratings":10293,"positive":6976,"avgSignal":0.3555},
 {"source":"manual","ratings":142,"positive":116,"avgSignal":0.6338},
 {"source":"session_summary","ratings":97,"positive":93,"avgSignal":0.9175}]

// posterior movement (all-time, threshold 0.6)
[{"totalMemories":12355,"movedFromPrior":2705,"avgPosteriorMean":0.5118,"avgPosteriorMeanMoved":0.5538,"aboveThreshold":885}]

// sanity (all-time)
[{"totalRetrievalRows":69679}]
[{"source":"implicit-citation","count":63369},{"source":"llm","count":14249},{"source":"explicit-self","count":1538}]
```

## Interpretation

- **Raters are flowing at scale**: 63.4k implicit-citation ratings all-time (plus
  14.2k llm, 1.5k explicit-self) over 69.7k retrieval rows. The Automated-QA gate
  (`implicit-citation > 0`) passes by four orders of magnitude.
- **Hybrid is earning its flag**: citation rate per arm — **hybrid 65.9%**
  (4484/6801) vs **fts 27.3%** vs **vec 19.8%** vs legacy-NULL 32.1%. Caveat: arms
  are not randomized (fts/vec rows largely come from degraded modes — no embedding
  or no FTS hit), so this is selection-biased, but the gap is large and the
  direction unambiguous. Keeps `MEMORY_HYBRID_SEARCH=1` firmly justified.
- **NULL arm is 66% of window rows** — provenance (migration 100) only started
  ~06-27; the NULL share will decay to zero in future snapshots. Note: this
  capture's per-arm query also folded the 1,010 `get` events into the NULL arm;
  the shipped endpoint excludes get events from `byArm` (post-review fix), so
  future snapshots will read slightly lower there.
- **Memory-source quality is starkly tiered**: session_summary 95.9% positive and
  manual 81.7% (small n: 97/142 ratings) vs file_index 67.8% vs
  **task_completion 16.8% positive, avgSignal −0.66** — task_completion
  auto-memories dominate rating volume (11.8k) while being mostly uncited noise.
  That's the strongest input yet for the Phase-3 (core/index) go/no-go and for any
  curation/decay policy: the noise is concentrated in one source.
- **Posteriors are moving**: 21.9% of 12,355 memories moved off the Beta(1,1)
  prior; 885 sit above the 0.6 usefulness threshold. Moved-average 0.554 vs the
  0.5 prior — slight positive drift.
- **Graph arm**: absent, as expected — `MEMORY_GRAPH_EXPANSION` ships with PR #894
  (default off). Future snapshots (via the deployed `/api/memory/usefulness`
  endpoint) will show a `graph` arm once the flag is enabled; compare its citation
  rate against hybrid's 65.9% anchor.

## Next snapshot

After PR #894 deploys: `curl -H "Authorization: Bearer $PROD_KEY" https://<prod-api>/api/memory/usefulness?days=30`
(same shape, plus the [0,1] `citationRate` + `avgSignal` split in citationBySource).
