# Dreaming

Nightly self-improvement loop. The `dreaming-daily` schedule triggers it once a day. A manual trigger with `{"dryRun": true}` (optionally `"agentIds": [...]`) runs it read-only and skips Slack.

How a night runs:

- `gather` (script) reads the last day of tasks, agent profiles, skills, memory and workflow changes. It also resolves who runs each step: the `leadAgentId` input, or the swarm's lead when empty. Empty `coderAgentId` and `writerAgentId` leave those tasks in the pool for any worker. `memtax-distill` always runs on the lead: its bullets become `/longterm` text that the lead writes.
- Every active agent writes a short self-report. The lead synthesizes them into approved actions.
- Lanes apply the approved actions: identity and memory ops (`apply`), profile trims (`trim-*`), the lead's heartbeat (`hb-*`), skills, script specs (`scriptify`), and the long-term memory taxonomy (`memtax-*`). Every write is capped, guarded, and logged to KV namespace `dreaming-v2` with its pre-image, so `dreaming-rollback` can undo a run.
- `verify` checks each claim against the real writes. `learn` scores earlier changes. `publish` writes the report, and `slack` posts a short receipt.

Writes that need Lead authority (`apply`, `trim-apply`, `hb-apply`, `memtax-create-apply`) run as agent-tasks on the lead. Each one runs its script with `fromRun: true` and returns a pointer with the result's sha256. The next node returns the stored result only when its hash matches that pointer, as the engine recorded it, so a forged `dreaming-v2` KV entry is refused.

Inputs:

| Input | Default | Effect |
| --- | --- | --- |
| `v3Writes` | `off` | `on` lets the heartbeat lane, the long-term memory lane and the restore runner in `apply` write. `off` keeps them report-only. |
| `leadAgentId` | empty | Empty = the agent with `isLead`. |
| `coderAgentId`, `writerAgentId` | empty | Empty = unassigned pool tasks. |
| `slackChannel` | empty | Empty = no Slack post. |
| `agentFsOrgId`, `agentFsDriveId`, `agentFsLiveUrl` | empty | Empty = the report is returned in the run output and not written to agent-fs. |

Trim backups and heartbeat drafts use the assigned worker's default agent-fs drive when the agent-fs inputs are empty. Without agent-fs, those lanes refuse their writes.

```json
{
  "name": "dreaming",
  "description": "Nightly self-improvement loop. gather -> per-agent self-reports (foreach) -> Lead synthesis -> apply, trim, heartbeat, skills, scriptify and memory lanes -> verify -> learn -> publish -> optional Slack receipt. Writes that need Lead authority run as Lead agent-tasks. Manual trigger {dryRun:true, agentIds?:[...]} runs read-only and skips Slack.",
  "input": {
    "v3Writes": "off",
    "leadAgentId": "",
    "coderAgentId": "",
    "writerAgentId": "",
    "slackChannel": "",
    "agentFsOrgId": "",
    "agentFsDriveId": "",
    "agentFsLiveUrl": ""
  },
  "onNodeFailure": "continue",
  "nodes": [
    {
      "id": "gather",
      "type": "swarm-script",
      "label": "1. Deterministic last-24h gather",
      "config": {
        "scriptName": "dreaming-gather",
        "scope": "global",
        "timeoutMs": 240000,
        "args": {
          "runId": "{{runId}}",
          "days": 1,
          "dryRun": "{{trigger.dryRun}}",
          "onlyAgentIds": "{{trigger.agentIds}}",
          "minTasks": 1,
          "v3Writes": "{{input.v3Writes}}",
          "leadAgentId": "{{input.leadAgentId}}",
          "coderAgentId": "{{input.coderAgentId}}",
          "writerAgentId": "{{input.writerAgentId}}"
        }
      },
      "next": "proceed",
      "inputs": {
        "runId": "run.id"
      }
    },
    {
      "id": "proceed",
      "type": "code-match",
      "label": "2. Any active agents?",
      "config": {
        "code": "(input) => (input.g && input.g.ok && Array.isArray(input.g.agents) && input.g.agents.length > 0) ? 'go' : 'quiet'",
        "outputPorts": [
          "go",
          "quiet"
        ]
      },
      "next": {
        "go": "reports",
        "quiet": "publish"
      },
      "inputs": {
        "g": "gather.result"
      }
    },
    {
      "id": "reports",
      "type": "foreach",
      "label": "3. Per-agent self-report (Lead included)",
      "config": {
        "over": "{{agents}}",
        "itemKey": "id",
        "body": {
          "type": "agent-task",
          "config": {
            "agentId": "{{item.id}}",
            "tags": [
              "dreaming-v2",
              "dreaming-v2-report"
            ],
            "priority": 40,
            "template": "dreaming-v2 run {{runId}}: nightly self-report. DRY RUN = {{dryRun}}.\n\nYou are reporting on YOUR OWN last 24h of work so the swarm can improve itself tonight. This is a short, read-only task: target 10 tool calls or fewer. Do NOT call any write tool (no update-profile, memory-store/edit/delete, skill-*, script-upsert, slack-*, send-task). Proposals only; a separate step applies the approved ones and verifies them.\n\nYour deterministic evidence (task list, failures, skill invocations, memories you wrote, your profile sizes and exact H2 headings):\n{{item.evidence}}\n\nYou may open up to 3 of the listed tasks with get-task-details if a title is not enough. Your SOUL/IDENTITY/CLAUDE files are already in your system prompt; the exact H2 headings are in evidence.h2Anchors.\n\nYour agentId is {{item.id}}. Report on YOUR OWN work only; a report whose agentId is not exactly {{item.id}} is rejected.\n\nReturn ONLY a JSON object with these keys (arrays may be empty; an empty report is a valid, honest report):\n\n- agentId: your agent id.\n- summary: <= 300 chars, what you actually did and what went wrong, in plain words.\n- repeatedProcedures (max 3): a multi-step procedure you did 2+ times in the window, or once but you know it recurs. {what, occurrences, evidence:[taskIds], existingSkill: name of the skill that should have covered it, or \"\" if none, proposal: \"new-skill\" | \"extend-skill\"}.\n- skillFriction (max 3): a skill that was wrong, stale, missing a step, or that you did not find when you needed it. {skill, problem, fix, evidence:[taskIds]}.\n- scriptCandidates (max 2): deterministic steps you performed by hand with tool calls that a script could do (counts, lookups, SQL, API polling). {process, steps, perWeek, evidence:[taskIds]}.\n- identityOps (max 2): cleanup of YOUR OWN profile. Prefer removals and rewrites that make the file SHORTER: stale facts, dead hosts or tools, dated incident narrative, rules superseded by a skill, duplicates. {file: \"CLAUDE\"|\"IDENTITY\"|\"SOUL\"|\"TOOLS\"|\"HEARTBEAT\", op: \"remove-section\"|\"replace-section\"|\"append-under\"|\"replace-exact\", anchor: exact H2 line from evidence.h2Anchors (H2 ops), find: exact text that occurs ONCE in the file, >= 40 chars (replace-exact), content: new text (no \"## \" lines), reason, netChars: estimated size change}. Appends are allowed only on CLAUDE, <= 400 chars, and only for a call-time rule your evidence proves you needed. TOOLS is not in your system prompt; put call-time rules in CLAUDE. HEARTBEAT is Lead-only.\n- memoryOps (max 3): {op: \"store\"|\"edit\"|\"delete\", memoryIds:[...] (edit/delete), name: kebab-case key <= 90 chars, no newlines (store), content, reason, evidence:[taskIds or memoryIds]}. Store only a reusable lesson from tonight's evidence, and check memory-search first so you do not duplicate an existing memory. Delete only a memory you wrote that is now proven wrong.\n\nEvery item needs at least one evidence id from the evidence above or from a lookup you made. Items without evidence are dropped. Do not report other agents' problems unless they blocked your own task. Complete with store-progress status \"completed\" and output set to the JSON string.",
            "outputSchema": {
              "type": "object",
              "required": [
                "agentId",
                "summary",
                "repeatedProcedures",
                "skillFriction",
                "scriptCandidates",
                "identityOps",
                "memoryOps"
              ],
              "properties": {
                "agentId": {
                  "type": "string"
                },
                "summary": {
                  "type": "string"
                },
                "repeatedProcedures": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "what",
                      "evidence",
                      "proposal"
                    ],
                    "properties": {
                      "what": {
                        "type": "string"
                      },
                      "occurrences": {
                        "type": "number"
                      },
                      "evidence": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "existingSkill": {
                        "type": "string"
                      },
                      "proposal": {
                        "type": "string",
                        "enum": [
                          "new-skill",
                          "extend-skill"
                        ]
                      }
                    }
                  }
                },
                "skillFriction": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "skill",
                      "problem",
                      "evidence"
                    ],
                    "properties": {
                      "skill": {
                        "type": "string"
                      },
                      "problem": {
                        "type": "string"
                      },
                      "fix": {
                        "type": "string"
                      },
                      "evidence": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    }
                  }
                },
                "scriptCandidates": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "process",
                      "evidence"
                    ],
                    "properties": {
                      "process": {
                        "type": "string"
                      },
                      "steps": {
                        "type": "string"
                      },
                      "perWeek": {
                        "type": "number"
                      },
                      "evidence": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    }
                  }
                },
                "identityOps": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "file",
                      "op",
                      "reason"
                    ],
                    "properties": {
                      "file": {
                        "type": "string",
                        "enum": [
                          "CLAUDE",
                          "IDENTITY",
                          "SOUL",
                          "TOOLS",
                          "HEARTBEAT"
                        ]
                      },
                      "op": {
                        "type": "string",
                        "enum": [
                          "remove-section",
                          "replace-section",
                          "append-under",
                          "replace-exact"
                        ]
                      },
                      "anchor": {
                        "type": "string"
                      },
                      "find": {
                        "type": "string"
                      },
                      "content": {
                        "type": "string"
                      },
                      "reason": {
                        "type": "string"
                      },
                      "netChars": {
                        "type": "number"
                      }
                    }
                  }
                },
                "memoryOps": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "op",
                      "reason"
                    ],
                    "properties": {
                      "op": {
                        "type": "string",
                        "enum": [
                          "store",
                          "edit",
                          "delete"
                        ]
                      },
                      "memoryIds": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "name": {
                        "type": "string"
                      },
                      "content": {
                        "type": "string"
                      },
                      "reason": {
                        "type": "string"
                      },
                      "evidence": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "next": "reports-check",
      "inputs": {
        "agents": "gather.result.agents",
        "runId": "run.id",
        "dryRun": "gather.result.dryRun"
      }
    },
    {
      "id": "synthesize",
      "type": "agent-task",
      "label": "4. Lead synthesis and critique",
      "config": {
        "agentId": "{{lead}}",
        "tags": [
          "dreaming-v2",
          "dreaming-v2-synthesis"
        ],
        "priority": 50,
        "template": "dreaming-v2 run {{runId}}: synthesis and critique. DRY RUN = {{dryRun}}.\n\nYou are the reviewer, not the writer. Turn tonight's per-agent reports and the deterministic swarm data into an approved, capped action list across five lanes, and record every rejection with a reason. Do NOT call write tools; approved actions are applied by later nodes (skills lane, apply script) and verified by re-reading the rows.\n\nPer-agent reports (foreach results; a child with status \"failed\" or a taskOutput starting \"[FAILED\" means that agent's report is missing, so note it and move on):\n{{reports}}\n\nReports rejected by the slot/schema guard (retried once): {{rejectedReports}}\nStill missing after the retry: {{missing}}\n\nBlocker digest (memory daily-blocker-digest-<today>, read by exact name; state \"missing\"/\"late\" means proceed without it and say so in notes): {{digest}}\n\nDeterministic swarm data (audit results, skill usage, memory candidates):\n{{swarm}}\nAgents skipped for inactivity: {{skipped}}\nGather errors (instrument gaps, NOT findings): {{gatherErrors}}\nCaps for tonight: {{caps}}\n\nLanes:\n a skillify: a new skill, only for a procedure evidenced in 2+ tasks (or 2+ agents) and not covered by an existing skill. Check skill-search first.\n b skill-refactor: fix a stale/wrong skill body or description (from skillFriction or an audit), merge near-duplicates, or propose disabling a skill with 0 invocations in 14 days that a named skill supersedes. systemDefault skills are locked in the DB and out of scope: do not propose edits to them.\n c scriptify: a deterministic process done by hand (scriptCandidates, repeated tool loops). Check script-search / the scripts catalog for an existing script first; if one exists, the action is \"wire it into skill X\", not \"write a new one\". Tier auto: the scriptify lane BUILDS it (agent scope, positive + negative control) up to caps.scriptBuilds; Lead promotes to global.\n d identity: the agents' own identityOps, plus at most 2 of your own from swarm.audits.contextBudget.overBudget (largest overage first) and, for Lead HEARTBEAT, items the blocker digest shows resolved (remove-only).\n e memory: the agents' memoryOps plus swarm.memory candidates: exact duplicates (keep the oldest row, delete the rest), unhelpful rows (edit or delete with a reason), badKeys (memory-rename, target.memoryIds + target.name kebab <= 90), and at most 3 new lessons, one per RESOLVED-STALE item in the digest.\n Profile trims are a separate lane (after apply): do not propose big rewrites here.\n\nLong-term how-to handoff (/longterm is recall only: if it can be a skill or script, it should be one). Lane B runs after you, so you read LAST night's routes. Call kv-get ONCE: namespace \"dreaming-v2\", key \"memtax-create:skill-routes:latest\". Use it only if it exists and its `at` is less than 36h old; otherwise write \"howto handoff: none\" in notes. Each route is {path \"/howto/<slug>\", slug, route, skill, lane, op, scriptExisting, script, scriptLane, memberIds, memberNames}; memberIds are inbox memory ids (memory-get them for the text). Existing skill or script first:\n - lane \"skill-refactor\" (route skill-update): op \"skill-update\" on target.skillName = skill; content = the how-to the members add to that skill (missing steps, limits, gotchas), not a copy of the memories. Counts against the skill-update cap.\n - lane \"skillify\" (route skill-new): run skill-search for the slug first; a covering skill turns it into a skill-refactor update. Otherwise op \"skill-create\", only when the route has 2+ memberIds or tonight's reports evidence the procedure (rule a); else reject \"single-source how-to\".\n - scriptLane \"scriptify\": scriptExisting set -> a scriptify action \"wire script <scriptExisting> into skill <skill or new skill>\"; script true and no scriptExisting -> op \"script-spec\" (or \"script-build\" tier auto within caps.scriptBuilds) after checking the scripts catalog.\n Evidence for every handoff action: \"memory:<id>\" per member plus \"kv:dreaming-v2/memtax-create:skill-routes:latest\". Same caps as every other action; overflow goes to rejected with reason \"cap\". Notes must carry one line: \"howto handoff: <routes read>, <turned into actions>, <rejected>\".\n /longterm is recall only. Never approve a memory-lane action whose content is a how-to (steps, commands, endpoints, API usage) or whose name is under /longterm/facts/services or /longterm/facts/procedures: reject it with reason \"how-to belongs in a skill/script\" and, if it is worth keeping, turn it into a skill-refactor or skillify action instead.\n\nRules for every action:\n1. Keep only evidence-backed items. Re-verify anything with an absence or state claim yourself (one db-query or gh call) before approving; say what you checked in `verified`.\n2. Tier \"auto\" only if it is inside the apply policy: identity ops that are net-negative, or CLAUDE appends <= 400 chars; a net-positive identity op may be auto too, because apply hands it to the trim lane, which writes it only inside a rewrite that leaves that file net-smaller tonight; memory store/edit/delete/rename within caps (a multi-chunk `manual` memory is deleted or renamed as a whole document; never task_completion/session_summary); skill update of a non-systemDefault skill (max 3), skill create (max 1), and scriptify builds (max caps.scriptBuilds). Skill disable stays \"propose\".\n2b. Nothing stays parked: every action has `owner` (agent id). Auto actions are owned by their lane; for a propose action name who must decide it (the target agent for its own file, Lead for memory/skills/promotions, the coding agent for code). The owners node sends each owner one task.\n3. Respect the caps; overflow goes to `rejected` with reason \"cap\".\n4. For H2 ops, copy the anchor verbatim from that agent's h2Anchors. For replace-exact, `find` must be text the agent quoted from its own file; you may shorten `content` but never invent an anchor.\n5. Dedup across agents: two agents proposing the same skill or memory become one action with both in sourceAgents.\n6. Every action gets an id \"A1\", \"A2\", ... that stays stable across all nodes.\n7. memory-edit: `content` is written verbatim as the memory's ENTIRE new body (default `mode: \"replace\"`), so a replace carries the full rewritten text. To add to a memory, set `mode: \"append\"` and put ONLY the new text in `content`; apply writes existing.trimEnd() + \"\\n\" + content. Never put instructions to the writer in `content` (\"APPEND to the end...\", \"keep everything above\", \"REPLACE the existing section...\"): apply refuses them. A replace that leaves under 50% of the old body is refused unless the action sets `allowShrink: \"<reason>\"`.\n\nLearning loop (v3): {{learning}}\n- `recent` = the last 7 learn rows; `candidates` = cuts whose probe showed up in a failed task or a coaching reason in the last 24h; `pins` = text a lane must never cut again.\n- Emit up to 5 `restores: [{cutId, reason, evidence[]}]`, only for a candidate whose evidence shows the cut text was still needed (quote the evidence ids). Apply restores it and pins it.\n- Never propose removing pinned text.\nBudget: {{budget}}. If `overBudget` is true, propose no optional work beyond the caps.\n\nReturn ONLY JSON: {headline, actions[], rejected[], restores[], missingReports[], notes, changelogComment}. The headline is the single change tonight that will still matter next week, <= 140 chars, or \"quiet night\" if nothing qualifies. changelogComment: at most 2 sentences for the workflow changelog: what changed tonight and what to watch tomorrow.",
        "outputSchema": {
          "type": "object",
          "required": [
            "headline",
            "actions",
            "rejected"
          ],
          "properties": {
            "headline": {
              "type": "string"
            },
            "actions": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "id",
                  "lane",
                  "tier",
                  "op",
                  "target",
                  "reason",
                  "evidence"
                ],
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "lane": {
                    "type": "string",
                    "enum": [
                      "skillify",
                      "skill-refactor",
                      "scriptify",
                      "identity",
                      "memory"
                    ]
                  },
                  "tier": {
                    "type": "string",
                    "enum": [
                      "auto",
                      "propose"
                    ]
                  },
                  "op": {
                    "type": "string",
                    "enum": [
                      "skill-create",
                      "skill-update",
                      "skill-disable",
                      "script-spec",
                      "remove-section",
                      "replace-section",
                      "append-under",
                      "replace-exact",
                      "memory-store",
                      "memory-edit",
                      "memory-delete",
                      "memory-rename",
                      "script-build"
                    ]
                  },
                  "target": {
                    "type": "object",
                    "properties": {
                      "agentId": {
                        "type": "string"
                      },
                      "file": {
                        "type": "string"
                      },
                      "anchor": {
                        "type": "string"
                      },
                      "find": {
                        "type": "string"
                      },
                      "memoryIds": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "skillId": {
                        "type": "string"
                      },
                      "skillName": {
                        "type": "string"
                      },
                      "installFor": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "name": {
                        "type": "string"
                      },
                      "systemDefault": {
                        "type": "boolean"
                      }
                    }
                  },
                  "content": {
                    "type": "string"
                  },
                  "reason": {
                    "type": "string"
                  },
                  "verified": {
                    "type": "string"
                  },
                  "evidence": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "sourceAgents": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "owner": {
                    "type": "string"
                  },
                  "mode": {
                    "type": "string",
                    "enum": [
                      "replace",
                      "append"
                    ],
                    "description": "memory-edit only. replace (default): content is the full new body. append: content is only the new text."
                  },
                  "allowShrink": {
                    "type": "string",
                    "description": "memory-edit replace only: the reason a body may shrink below 50%."
                  }
                }
              }
            },
            "rejected": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "from",
                  "item",
                  "reason"
                ],
                "properties": {
                  "from": {
                    "type": "string"
                  },
                  "item": {
                    "type": "string"
                  },
                  "reason": {
                    "type": "string"
                  }
                }
              }
            },
            "missingReports": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "notes": {
              "type": "string"
            },
            "changelogComment": {
              "type": "string"
            },
            "restores": {
              "type": "array",
              "maxItems": 5,
              "items": {
                "type": "object",
                "required": [
                  "cutId",
                  "reason"
                ],
                "properties": {
                  "cutId": {
                    "type": "string"
                  },
                  "reason": {
                    "type": "string"
                  },
                  "evidence": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  }
                }
              }
            }
          }
        }
      },
      "next": "apply-lead",
      "inputs": {
        "reports": "reports-merge.result.reports",
        "swarm": "gather.result.swarm",
        "caps": "gather.result.caps",
        "skipped": "gather.result.skippedAgents",
        "gatherErrors": "gather.result.errors",
        "runId": "run.id",
        "dryRun": "gather.result.dryRun",
        "missing": "reports-merge.result.missing",
        "rejectedReports": "reports-merge.result.rejected",
        "digest": "gather.result.swarm.blockerDigest",
        "learning": "gather.result.learning",
        "budget": "gather.result.budget",
        "lead": "gather.result.leadAgentId"
      },
      "retry": {
        "maxRetries": 1,
        "strategy": "exponential",
        "baseDelayMs": 1000,
        "maxDelayMs": 60000
      }
    },
    {
      "id": "skills-gate",
      "type": "code-match",
      "label": "5. Any auto skill actions?",
      "config": {
        "code": "(input) => { const s = input.s; if (!s || typeof s !== 'object' || !Array.isArray(s.actions)) return 'skip'; return s.actions.some(a => (a.lane === 'skillify' || a.lane === 'skill-refactor') && a.tier === 'auto') ? 'run' : 'skip'; }",
        "outputPorts": [
          "run",
          "skip"
        ]
      },
      "next": {
        "run": "skills",
        "skip": "verify"
      },
      "inputs": {
        "s": "synthesize.taskOutput"
      }
    },
    {
      "id": "skills",
      "type": "agent-task",
      "label": "6. Skills lane (a skillify + b refactor), Lead",
      "config": {
        "agentId": "{{lead}}",
        "tags": [
          "dreaming-v2",
          "dreaming-v2-skills"
        ],
        "priority": 50,
        "template": "dreaming-v2 run {{runId}}: skills lane (a skillify + b skill-refactor). DRY RUN = {{dryRun}}.\n\nApproved actions (use ONLY lane \"skillify\"/\"skill-refactor\" with tier \"auto\"; ignore everything else): {{s}}\n\nFor each action, in id order:\n0. Idempotency: if kv-get namespace \"dreaming-v2\" key \"preimage:{{runId}}:<actionId>\" already exists, this action was already handled by an earlier dispatch of this node. Re-read the skill and report it; do not write again.\n1. skill-update: skill-get the CURRENT full SKILL.md. If systemDefault is true, STOP for this action: status \"refused\", note \"systemDefault locked\". Write the complete revised document (frontmatter + body, not a partial), <= 500 lines, description <= 1024 chars. Before writing, kv-set namespace \"dreaming-v2\" key \"preimage:{{runId}}:<actionId>\" to {skillId, version, content} of the current row.\n2. skill-create: skill-search first; if a skill already covers >= 70% of it, convert to an update of that skill (note it). Otherwise skill-create scope \"swarm\" and skill-install ONLY for the agents in target.installFor. Add the line \"created by dreaming-v2 run {{runId}}, action <id>\" at the end of the body so provenance survives.\n3. After every write, re-read with skill-get and record the version before and after and the sha256 of the re-read content. success:true is NOT proof: a write is \"applied\" only if the version increased (update) or the row exists (create) AND the re-read content contains your change.\nIf DRY RUN is true: do all reads, draft the full content, call NO write tool (including kv-set), and return status \"dry-run\" with the draft's sha256.\n\nReturn ONLY JSON {results:[{actionId, status: \"applied\"|\"refused\"|\"held\"|\"dry-run\", skillId, name, versionBefore, versionAfter, contentSha256, installedFor, preimageKey, note}]}.",
        "outputSchema": {
          "type": "object",
          "required": [
            "results"
          ],
          "properties": {
            "results": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "actionId",
                  "status"
                ],
                "properties": {
                  "actionId": {
                    "type": "string"
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "applied",
                      "refused",
                      "held",
                      "dry-run"
                    ]
                  },
                  "skillId": {
                    "type": "string"
                  },
                  "name": {
                    "type": "string"
                  },
                  "versionBefore": {
                    "type": "number"
                  },
                  "versionAfter": {
                    "type": "number"
                  },
                  "contentSha256": {
                    "type": "string"
                  },
                  "installedFor": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "preimageKey": {
                    "type": "string"
                  },
                  "note": {
                    "type": "string"
                  }
                }
              }
            }
          }
        }
      },
      "next": "verify",
      "inputs": {
        "s": "synthesize.taskOutput",
        "runId": "run.id",
        "dryRun": "gather.result.dryRun",
        "lead": "gather.result.leadAgentId"
      }
    },
    {
      "id": "scriptify-gate",
      "type": "code-match",
      "label": "7. Any scriptify actions?",
      "config": {
        "code": "(input) => { const s = input.s; if (!s || typeof s !== 'object' || !Array.isArray(s.actions)) return 'skip'; return s.actions.some(a => a.lane === 'scriptify') ? 'run' : 'skip'; }",
        "outputPorts": [
          "run",
          "skip"
        ]
      },
      "next": {
        "run": "scriptify",
        "skip": "verify"
      },
      "inputs": {
        "s": "synthesize.taskOutput"
      }
    },
    {
      "id": "scriptify",
      "type": "agent-task",
      "label": "8. Scriptify lane (propose-only), coding agent",
      "config": {
        "agentId": "{{coder}}",
        "tags": [
          "dreaming-v2",
          "dreaming-v2-scriptify"
        ],
        "priority": 40,
        "template": "dreaming-v2 run {{runId}}: scriptify lane. DRY RUN = {{dryRun}}. You BUILD scripts now; specs alone do not count.\n\nActions (use ONLY lane \"scriptify\"; at most caps.scriptBuilds = {{caps.scriptBuilds}} builds, the rest go back as status \"held\"): {{s}}\n\nUse the swarm-scripts skill. For each action, in id order:\n1. Check the catalog first (script-search, and db-query `SELECT name, scope, contentHash FROM scripts WHERE name GLOB '*<noun>*'`). If a script already covers it, status \"exists\": name it and the exact wiring edit; build nothing.\n2. Otherwise write it: kebab name, `export const argsSchema` (zod), `const a = args ?? {}`, never throws, returns a `controls` object. Save with script-upsert scope \"agent\" under a NEW name (never a bare name that exists globally). Global promotion is Lead's; the owners node asks for it.\n3. Prove it: run it twice with script-run scope \"agent\": a positive control that must find a known real row, and a negative control that must return empty or refuse. Record both run ids and whether each behaved as expected. A build whose controls did not both pass is status \"failed\", not \"built\".\nIf DRY RUN is true: do steps 1 and the draft only; call no script-upsert or script-run; status \"dry-run\".\n\nReturn ONLY JSON {built:[{actionId, status: \"built\"|\"exists\"|\"failed\"|\"held\"|\"dry-run\", name, scope, contentHash, positiveRunId, negativeRunId, controlsOk, wireInto, savesPerWeek, note}]}.",
        "outputSchema": {
          "type": "object",
          "required": [
            "built"
          ],
          "properties": {
            "built": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "actionId",
                  "status"
                ],
                "properties": {
                  "actionId": {
                    "type": "string"
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "built",
                      "exists",
                      "failed",
                      "held",
                      "dry-run"
                    ]
                  },
                  "name": {
                    "type": "string"
                  },
                  "scope": {
                    "type": "string"
                  },
                  "contentHash": {
                    "type": "string"
                  },
                  "positiveRunId": {
                    "type": "string"
                  },
                  "negativeRunId": {
                    "type": "string"
                  },
                  "controlsOk": {
                    "type": "boolean"
                  },
                  "wireInto": {
                    "type": "string"
                  },
                  "savesPerWeek": {
                    "type": "number"
                  },
                  "note": {
                    "type": "string"
                  }
                }
              }
            }
          }
        }
      },
      "next": "verify",
      "inputs": {
        "s": "synthesize.taskOutput",
        "runId": "run.id",
        "dryRun": "gather.result.dryRun",
        "caps": "gather.result.caps",
        "coder": "gather.result.coderAgentId"
      }
    },
    {
      "id": "apply-lead",
      "type": "agent-task",
      "label": "9. Apply identity + memory (deterministic) (runs as the lead)",
      "config": {
        "agentId": "{{lead}}",
        "priority": 70,
        "tags": [
          "dreaming-v2",
          "dreaming-lead-write",
          "apply"
        ],
        "template": "dreaming run {{runId}}: Lead write step `apply`. It needs Lead authority, so it runs in your session. Nothing here is owed to a human.\n\nMake exactly one tool call: `script-run` with name `dreaming-apply`, scope `global`, and args `{\"runId\":\"{{runId}}\",\"fromRun\":true}`.\nPass no other args. The script loads its inputs and the dry-run flag from this run's recorded steps, does the writes, stores its full result in KV namespace `dreaming-v2`, and returns a small pointer.\nDo not retry it, do not call any other write tool, and do not edit the script.\n\nReturn ONLY the script's result JSON, unchanged: the next node checks its sha256. If the call itself errors, return {\"ok\":false,\"error\":\"<message>\"}.",
        "outputSchema": {
          "type": "object",
          "required": [
            "ok"
          ],
          "properties": {
            "ok": {
              "type": "boolean"
            }
          }
        }
      },
      "next": "apply",
      "inputs": {
        "runId": "run.id",
        "lead": "gather.result.leadAgentId"
      }
    },
    {
      "id": "apply",
      "type": "swarm-script",
      "label": "9. Apply identity + memory (deterministic): stored result",
      "config": {
        "scriptName": "dreaming-apply",
        "scope": "global",
        "timeoutMs": 60000,
        "args": {
          "runId": "{{runId}}",
          "loadResult": true
        }
      },
      "next": "trim-plan",
      "inputs": {
        "runId": "run.id"
      }
    },
    {
      "id": "verify",
      "type": "swarm-script",
      "label": "10. Verify claims, unclaimed writes, survival, ledger",
      "config": {
        "scriptName": "dreaming-verify",
        "scope": "global",
        "timeoutMs": 180000,
        "args": {
          "runId": "{{runId}}",
          "dryRun": "{{dryRun}}",
          "since": "{{since}}",
          "synth": "{{s}}",
          "apply": "{{ap}}",
          "skills": "{{sk}}",
          "scriptify": "{{sc}}",
          "trim": "{{tr}}",
          "wfSnapshot": "{{ws}}",
          "hb": "{{hba}}",
          "leadAgentId": "{{lead}}"
        }
      },
      "next": "learn",
      "inputs": {
        "runId": "run.id",
        "dryRun": "gather.result.dryRun",
        "since": "gather.result.generatedAt",
        "s": "synthesize.taskOutput",
        "ap": "apply.result",
        "sk": "skills.taskOutput",
        "sc": "scriptify.taskOutput",
        "tr": "trim-apply.result",
        "ws": "gather.result.workflowSnapshot",
        "hba": "hb-apply.result",
        "lead": "gather.result.leadAgentId"
      }
    },
    {
      "id": "publish",
      "type": "agent-task",
      "label": "11. Publish report (agent-fs) + Slack text, writer",
      "config": {
        "agentId": "{{writer}}",
        "tags": [
          "dreaming-v2",
          "dreaming-v2-publish"
        ],
        "priority": 50,
        "template": "dreaming-v2 run {{runId}}: publish the nightly report and the changelog entry. DRY RUN = {{g.dryRun}}.\n\nInputs: gather {{g}} | synthesis {{s}} | verify {{v}} | scriptify {{sc}} | trim plan {{tp}} | trim apply {{tr}} | owners {{ow}} | report guard {{rm}} | reports {{reports}} | learn {{lr}} | apply restores (restores/wouldRestore/restoreRefused in) {{ap}} | heartbeat check {{hbc}} | lead-disk {{ld}} | heartbeat apply {{hba}} | memory taxonomy section {{mtmd}} | memory taxonomy counts {{mtc}} | long-term memories section {{ltmd}} | long-term memories counts {{ltc}}\n(Empty strings mean a quiet night or a failed/skipped node: say which, from gather.)\n\nUNITS: state every size (file, field, profile, heartbeat, draft, prompt, or a size delta) in tokens: tokens = ceil(chars / 4 * ratio), ratio = 1 (uncalibrated). A signed char delta d becomes sign(d) * ceil(|d| / 4 * ratio). Inputs arrive in chars (beforeChars, afterChars, chars, liveChars, draftChars, trimmedChars, netChars, profileChars, heartbeatChars, backlog sizes, identity/memory op deltas): convert when you print and write `<n> tok`. Compute every converted value with one python3 -c or bun -e call over the input numbers, never by hand. Keep a char value only where the limit itself counts chars, in parentheses after the tokens: the claudeMd session cap reads `5000 tok (20,000-char cap)`. Counts that are not sizes stay as they are (pins, tracked items, cuts, memories, chunks, actions, USD, seconds, minutes). The 450-char slackText limit below is a Slack length limit, not a size you report.\n\n1. Report: Markdown at agent-fs `dreaming-v2/runs/<UTC date>.md` (org `{{input.agentFsOrgId}}`, drive `{{input.agentFsDriveId}}`; if either is empty, write nothing to agent-fs: return the report in `markdown` and leave `reportPath` and `reportUrl` empty). DRY RUN: write NOTHING, return it in `markdown`.\n   Sections: Headline; Silent refusals / claim mismatches / unclaimed writes / reverted trims (verify, trim survival) FIRST if non-empty; Applied (verify-confirmed only) per lane with target, one-line why, action id; Trims: one row per field (agent, field, before -> after tokens, backup path, and its one-line revert command from trim apply `revert`), plus refused trims with reasons and the backlog; Owned items (owners: owner, action ids, task id); Scriptify builds (name, controls run ids); Rejected (count + top reasons); Report guard (rejected/retried/missing); Instrument gaps (gather errors, digest state, and the line `Sizes in tokens = ceil(chars / 4 * 1), ratio 1 uncalibrated.`); Cost and runtime per node (verify.metrics).\n   v3 sections: **Learning**: paste `learn.table` (tonight, delta, 7-night mean) verbatim except its char rows: `profileChars` and `heartbeatChars` become `profileTokens` and `heartbeatTokens` with every number converted, then reverted / reintroduced / referenced cuts and new pins (learn.scored, learn.newPins), then restores (apply restores, wouldRestore, restoreRefused). **Heartbeat (lane C)**: hb-check ready + reasons + stats (tokens before -> after, pins before = after, removed), lead-disk mode and shas, hb-apply status (wouldApply while v3Writes is off). **Profiles (lane A)**: learn.metrics.laneA totals, sizes in tokens. **Memory taxonomy (lane B1)**: paste the memory taxonomy section verbatim as its own `##` section (it already has counts per path and the 30 spot-check samples; it states no sizes). If it is empty, write `## Memory taxonomy (lane B1, classify-only)` and `memtax-report did not run`. **Long-term memories (lane B create/validate/tidy)**: paste the long-term memories section verbatim as its own `##` section right after it (it has counts per path, creates/edits/deletes, validate verdicts with stale and duplicate counts, and 20 samples; its sizes are already in tokens). If it is empty, write `## Long-term memories (lane B, create/validate/tidy)` and `memtax-create-apply did not run`. Its \"Routed to skills/scripts, not /longterm\" line and table are tonight's how-to handoff (/longterm is recall only); keep them verbatim. **How-to handoff consumed (synthesis)**: one line from the synthesis notes \"howto handoff: ...\" line, or \"none\".\n   A lane's claim without verify confirmation goes under \"Unverified\".\n2. Changelog: ONE entry appended to agent-fs `dreaming-v2/changelog.md` with `agent-fs append` (never write or overwrite that file; humans comment in it). DRY RUN, or org or drive empty: append nothing, return the entry in `changelogEntry`. Format, exactly:\n   ## <YYYY-MM-DD>: night <gather.night.number>\n   - Run <runId>, <status: green | degraded (why)>, cost so far $<verify.metrics.totalCostSoFarUsd>; previous run full cost $<gather.budget.prevRunUsd> (publish + scriptify included) vs budget $<gather.budgetUsd>, report `dreaming-v2/runs/<date>.md`\n   - Learning: profiles <tokens of learn.trend.profileChars.tonight> tok (Δ <delta in tok>), heartbeat <tokens of learn.trend.heartbeatChars.tonight> tok (Δ <delta in tok>), memory pruned/merged 0/0 (lane B1 classify-only: <memtax counts.classified> of <memtax counts.docsPlanned> docs classified; /longterm: <long-term counts.written> written of <long-term counts.planned> planned, <long-term counts.creates> creates, <long-term counts.edits> edits, <long-term counts.stale> stale), restores <n applied or would-restore>\n   - Long-term how-to -> skills/scripts: <long-term counts.routedToSkills> routed (<long-term counts.routedSkillUpdate> skill updates, <long-term counts.routedSkillNew> new skills, <long-term counts.routedToScripts> script), guard refused <long-term counts.guardRefused> /longterm how-to writes; last night's handoff: <synthesis notes \"howto handoff\" line, or \"none\">\n   - <n> applied, <n> proposed, <n> rejected: <synthesis headline>\n   - Trims: <trimsLine, without the 'Trims:' prefix>\n   - Workflow changes since last run: <gather.workflowChanges: added/removed/config-changed node ids, with its base; \"none\" if all three are empty>\n   - **Lead:** <synthesis changelogComment>\n3. slackText: at most 3 lines, no headers. The Slack node appends `trimsLine` as line 4, so the receipt is at most 4 lines:\n   line 1 \":crescent_moon: Dreaming <date>: <headline> · <n> applied (<per-lane counts, only non-zero>), <n> proposed, <n> rejected · how-to → skills/scripts <long-term counts.routedToSkills>\"; \"<long-term counts.routedToSkills>\" is 0 when the counts are empty, and if guardRefused > 0 append \" (<guardRefused> /longterm how-to writes refused)\"\n   line 2 only if verify found a silent refusal, claim mismatch, unclaimed write, survival.reverted item or reverted trim: \":warning: <one line>\". survival.trimmed and survival.drifted are expected later rewrites: never warn on them.\n   last line: \"<live>/file/~/<org>/<drive>/dreaming-v2/runs/<date>.md · changelog <live>/file/~/<org>/<drive>/dreaming-v2/changelog.md\", where <live> is `{{input.agentFsLiveUrl}}` (or $AGENT_FS_LIVE_URL when empty) and <org>/<drive> are the ids the report was written to. Omit this line when nothing was written to agent-fs\n   Never put a newline inside a line. The trims line is added by the Slack node; do not repeat it. Keep slackText under 450 chars.\n4. trimsLine: trim apply `slackLine` with each `<before>→<after>` char pair rewritten in tokens and ` tok` after it, wording and order otherwise unchanged, e.g. `Lead toolsMd 17263→15903` -> `Lead toolsMd 4316→3976 tok`. Build it with code (regex over slackLine, values from trim apply wouldApply/applied beforeChars/afterChars). One line, no newline; empty string when trim apply is empty.\n\nReturn ONLY JSON {reportPath, reportUrl, slackText, trimsLine, markdown, changelogEntry, changelogAppended}.",
        "outputSchema": {
          "type": "object",
          "required": [
            "slackText"
          ],
          "properties": {
            "reportPath": {
              "type": "string"
            },
            "reportUrl": {
              "type": "string"
            },
            "slackText": {
              "type": "string"
            },
            "trimsLine": {
              "type": "string"
            },
            "markdown": {
              "type": "string"
            },
            "changelogEntry": {
              "type": "string"
            },
            "changelogAppended": {
              "type": "boolean"
            }
          }
        },
        "modelTier": "regular"
      },
      "next": "slack-gate",
      "inputs": {
        "runId": "run.id",
        "g": "gather.result",
        "s": "synthesize.taskOutput",
        "v": "verify.result",
        "sc": "scriptify.taskOutput",
        "reports": "reports.results",
        "tr": "trim-apply.result",
        "tp": "trim-plan.result",
        "ow": "owners.result",
        "rm": "reports-merge.result",
        "lr": "learn.result",
        "ap": "apply.result",
        "hbc": "hb-check.result",
        "hba": "hb-apply.result",
        "ld": "lead-disk.taskOutput",
        "mtmd": "memtax-report.result.markdown",
        "mtc": "memtax-report.result.counts",
        "ltmd": "memtax-create-apply.result.markdown",
        "ltc": "memtax-create-apply.result.counts",
        "writer": "gather.result.writerAgentId"
      }
    },
    {
      "id": "slack-gate",
      "type": "code-match",
      "label": "12. Post to Slack? (never in dryRun or without slackChannel)",
      "config": {
        "code": "(input) => { const d = input.trigger && (input.trigger.dryRun === true || input.trigger.dryRun === 'true'); const p = input.p; const ch = typeof input.ch === 'string' ? input.ch.trim() : ''; return (!d && ch && p && typeof p === 'object' && typeof p.slackText === 'string' && p.slackText.length > 0) ? 'post' : 'skip'; }",
        "outputPorts": [
          "post",
          "skip"
        ]
      },
      "next": {
        "post": "slack",
        "skip": "done"
      },
      "inputs": {
        "p": "publish.taskOutput",
        "ch": "input.slackChannel"
      }
    },
    {
      "id": "slack",
      "type": "notify",
      "label": "13. Slack receipt",
      "config": {
        "channel": "slack",
        "target": "{{input.slackChannel}}",
        "template": "{{p.slackText}}\n{{p.trimsLine}}"
      },
      "inputs": {
        "p": "publish.taskOutput",
        "tr": "trim-apply.result"
      }
    },
    {
      "id": "done",
      "type": "code-match",
      "label": "done (no Slack post)",
      "config": {
        "code": "() => 'done'",
        "outputPorts": [
          "done"
        ]
      }
    },
    {
      "id": "reports-check",
      "type": "swarm-script",
      "label": "3b. Report guard: schema + slot match, pick retries",
      "config": {
        "scriptName": "dreaming-reports-check",
        "scope": "global",
        "timeoutMs": 30000,
        "args": {
          "agents": "{{agents}}",
          "results": "{{r}}"
        }
      },
      "next": "reports-retry",
      "inputs": {
        "agents": "gather.result.agents",
        "r": "reports.results"
      }
    },
    {
      "id": "reports-retry",
      "type": "foreach",
      "label": "3c. Retry failed/mismatched reports once, schema restated",
      "config": {
        "over": "{{retry}}",
        "itemKey": "id",
        "body": {
          "type": "agent-task",
          "config": {
            "agentId": "{{item.id}}",
            "tags": [
              "dreaming-v2",
              "dreaming-v2-report",
              "dreaming-v2-report-retry"
            ],
            "priority": 40,
            "outputSchema": {
              "type": "object",
              "required": [
                "agentId",
                "summary",
                "repeatedProcedures",
                "skillFriction",
                "scriptCandidates",
                "identityOps",
                "memoryOps"
              ],
              "properties": {
                "agentId": {
                  "type": "string"
                },
                "summary": {
                  "type": "string"
                },
                "repeatedProcedures": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "what",
                      "evidence",
                      "proposal"
                    ],
                    "properties": {
                      "what": {
                        "type": "string"
                      },
                      "occurrences": {
                        "type": "number"
                      },
                      "evidence": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "existingSkill": {
                        "type": "string"
                      },
                      "proposal": {
                        "type": "string",
                        "enum": [
                          "new-skill",
                          "extend-skill"
                        ]
                      }
                    }
                  }
                },
                "skillFriction": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "skill",
                      "problem",
                      "evidence"
                    ],
                    "properties": {
                      "skill": {
                        "type": "string"
                      },
                      "problem": {
                        "type": "string"
                      },
                      "fix": {
                        "type": "string"
                      },
                      "evidence": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    }
                  }
                },
                "scriptCandidates": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "process",
                      "evidence"
                    ],
                    "properties": {
                      "process": {
                        "type": "string"
                      },
                      "steps": {
                        "type": "string"
                      },
                      "perWeek": {
                        "type": "number"
                      },
                      "evidence": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    }
                  }
                },
                "identityOps": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "file",
                      "op",
                      "reason"
                    ],
                    "properties": {
                      "file": {
                        "type": "string",
                        "enum": [
                          "CLAUDE",
                          "IDENTITY",
                          "SOUL",
                          "TOOLS",
                          "HEARTBEAT"
                        ]
                      },
                      "op": {
                        "type": "string",
                        "enum": [
                          "remove-section",
                          "replace-section",
                          "append-under",
                          "replace-exact"
                        ]
                      },
                      "anchor": {
                        "type": "string"
                      },
                      "find": {
                        "type": "string"
                      },
                      "content": {
                        "type": "string"
                      },
                      "reason": {
                        "type": "string"
                      },
                      "netChars": {
                        "type": "number"
                      }
                    }
                  }
                },
                "memoryOps": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "op",
                      "reason"
                    ],
                    "properties": {
                      "op": {
                        "type": "string",
                        "enum": [
                          "store",
                          "edit",
                          "delete"
                        ]
                      },
                      "memoryIds": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "name": {
                        "type": "string"
                      },
                      "content": {
                        "type": "string"
                      },
                      "reason": {
                        "type": "string"
                      },
                      "evidence": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    }
                  }
                }
              }
            },
            "template": "dreaming-v2 run {{runId}}: RETRY of your nightly self-report. DRY RUN = {{dryRun}}.\n\nYour first report was rejected: {{item.firstFailure}}\nRead-only task, 8 tool calls or fewer, no write tools. Report on YOUR OWN last 24h only.\n\nYour agentId is {{item.id}}. The report's agentId MUST be exactly {{item.id}}.\nEvidence: {{item.evidence}}\n\nComplete with store-progress status \"completed\" and output set to ONE JSON object, no prose, no code fence, with EXACTLY these keys:\n{\"agentId\": \"{{item.id}}\", \"summary\": \"<= 300 chars\", \"repeatedProcedures\": [], \"skillFriction\": [], \"scriptCandidates\": [], \"identityOps\": [], \"memoryOps\": []}\nEvery key is required; each list key is a JSON array (empty is fine). Item shapes: repeatedProcedures {what, occurrences, evidence:[taskIds], existingSkill, proposal:\"new-skill\"|\"extend-skill\"}; skillFriction {skill, problem, fix, evidence}; scriptCandidates {process, steps, perWeek, evidence}; identityOps {file:\"CLAUDE\"|\"IDENTITY\"|\"SOUL\"|\"TOOLS\", op:\"remove-section\"|\"replace-section\"|\"append-under\"|\"replace-exact\", anchor, find, content, reason, netChars}; memoryOps {op:\"store\"|\"edit\"|\"delete\", memoryIds, name, content, reason, evidence}.\nAn empty report (all lists []) is valid and better than a late or invalid one."
          }
        }
      },
      "next": "reports-merge",
      "inputs": {
        "retry": "reports-check.result.retry",
        "runId": "run.id",
        "dryRun": "gather.result.dryRun"
      }
    },
    {
      "id": "reports-merge",
      "type": "swarm-script",
      "label": "3d. Merge retries; still-invalid slots become missing reports",
      "config": {
        "scriptName": "dreaming-reports-check",
        "scope": "global",
        "timeoutMs": 30000,
        "args": {
          "agents": "{{agents}}",
          "results": "{{r}}",
          "retryResults": "{{rr}}"
        }
      },
      "next": "synthesize",
      "inputs": {
        "agents": "gather.result.agents",
        "r": "reports.results",
        "rr": "reports-retry.results"
      }
    },
    {
      "id": "trim-plan",
      "type": "swarm-script",
      "label": "9b. Trim plan: reverted, deferred edits, over-target, rotation",
      "config": {
        "scriptName": "dreaming-trim",
        "scope": "global",
        "timeoutMs": 60000,
        "args": {
          "mode": "plan",
          "runId": "{{runId}}",
          "dryRun": "{{dryRun}}",
          "deferred": "{{ap}}",
          "maxTrims": 3
        }
      },
      "next": "trim",
      "inputs": {
        "runId": "run.id",
        "dryRun": "gather.result.dryRun",
        "ap": "apply.result"
      }
    },
    {
      "id": "trim",
      "type": "foreach",
      "label": "9c. Draft one trimmed profile field per slot",
      "config": {
        "over": "{{targets}}",
        "itemKey": "slot",
        "body": {
          "type": "agent-task",
          "config": {
            "agentId": "{{coder}}",
            "tags": [
              "dreaming-v2",
              "dreaming-v2-trim"
            ],
            "priority": 40,
            "template": "dreaming-v2 run {{runId}}: trim ONE profile field. DRY RUN = {{dryRun}}. Authority: the operator wants agent files clean and clear and accepts big trims. Nothing here is owed to a human.\n\nTarget: agent {{item.agentName}} ({{item.agentId}}), field {{item.field}} ({{item.file}}), now {{item.chars}} chars, sha256 {{item.sha256}}. Hard target: {{item.targetChars}} chars (null = none; make it clean and clear). Why tonight: {{item.reason}}.\nNet-positive edits approved tonight that you MUST fold in verbatim: {{item.deferredEdits}}\n\n1. Read the field: db-query `SELECT {{item.field}} FROM agents WHERE id = '{{item.agentId}}'` (read it whole; page with substr() if the row is capped).\n2. Live runs only: back it up FIRST, unchanged, with `agent-fs write {{item.backupPath}}` (org `{{input.agentFsOrgId}}`, drive `{{input.agentFsDriveId}}`; if either is empty, use your default agent-fs drive). A trim without a backup is refused.\n3. Rewrite it. Keep: rules that change behaviour, call-time facts (agent ids, routing, hosts, exact commands), and every rule number other text cites (keep \"Rule #N\" labels stable; mark a retired number \"(retired)\" rather than renumbering). Cut: incident narratives, dated live-proof stories, frozen counts, duplicates, and anything a skill or tool description already carries (name the skill in a one-line pointer). A durable lesson you cut goes to movedToMemory (kebab name <= 90, swarm scope if workers need it) and leaves a one-line pointer `Memory <name>`. A 'do NOT trim this file' header on Lead's claudeMd is overridden by this lane's operator policy; you may rewrite it. Keep the H2 structure readable. The result MUST be shorter than {{item.chars}} chars and, when a hard target is set, at most that target if you can do it without losing a behaviour rule.\n4. Write nothing else: no update-profile, no memory-store (the trim-apply script writes the field and the memories after it verifies your draft).\n\nComplete with store-progress status \"completed\" and output = ONE JSON object: {\"agentId\": \"{{item.agentId}}\", \"field\": \"{{item.field}}\", \"trimmed\": \"<the full new text>\", \"backupPath\": \"<path written, or empty in a dry run>\", \"beforeChars\": {{item.chars}}, \"afterChars\": <n>, \"cut\": [\"<one line per removed block>\"], \"movedToMemory\": [{\"name\", \"content\", \"scope\"}], \"deferredApplied\": [\"<action ids>\"], \"notes\": \"\"}",
            "outputSchema": {
              "type": "object",
              "required": [
                "agentId",
                "field",
                "trimmed"
              ],
              "properties": {
                "agentId": {
                  "type": "string"
                },
                "field": {
                  "type": "string"
                },
                "trimmed": {
                  "type": "string"
                },
                "backupPath": {
                  "type": "string"
                },
                "beforeChars": {
                  "type": "number"
                },
                "afterChars": {
                  "type": "number"
                },
                "cut": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "movedToMemory": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "name": {
                        "type": "string"
                      },
                      "content": {
                        "type": "string"
                      },
                      "scope": {
                        "type": "string"
                      }
                    }
                  }
                },
                "deferredApplied": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "notes": {
                  "type": "string"
                }
              }
            }
          }
        }
      },
      "next": "trim-apply-lead",
      "inputs": {
        "targets": "trim-plan.result.targets",
        "runId": "run.id",
        "dryRun": "gather.result.dryRun",
        "coder": "gather.result.coderAgentId"
      }
    },
    {
      "id": "trim-apply-lead",
      "type": "agent-task",
      "label": "9d. Trim apply: net-smaller check, write, re-read, survival (runs as the lead)",
      "config": {
        "agentId": "{{lead}}",
        "priority": 70,
        "tags": [
          "dreaming-v2",
          "dreaming-lead-write",
          "trim-apply"
        ],
        "template": "dreaming run {{runId}}: Lead write step `trim-apply`. It needs Lead authority, so it runs in your session. Nothing here is owed to a human.\n\nMake exactly one tool call: `script-run` with name `dreaming-trim`, scope `global`, and args `{\"mode\":\"apply\",\"runId\":\"{{runId}}\",\"fromRun\":true}`.\nPass no other args. The script loads its inputs and the dry-run flag from this run's recorded steps, does the writes, stores its full result in KV namespace `dreaming-v2`, and returns a small pointer.\nDo not retry it, do not call any other write tool, and do not edit the script.\n\nReturn ONLY the script's result JSON, unchanged: the next node checks its sha256. If the call itself errors, return {\"ok\":false,\"error\":\"<message>\"}.",
        "outputSchema": {
          "type": "object",
          "required": [
            "ok"
          ],
          "properties": {
            "ok": {
              "type": "boolean"
            }
          }
        }
      },
      "next": "trim-apply",
      "inputs": {
        "runId": "run.id",
        "lead": "gather.result.leadAgentId"
      }
    },
    {
      "id": "trim-apply",
      "type": "swarm-script",
      "label": "9d. Trim apply: net-smaller check, write, re-read, survival: stored result",
      "config": {
        "scriptName": "dreaming-trim",
        "scope": "global",
        "timeoutMs": 60000,
        "args": {
          "mode": "apply",
          "runId": "{{runId}}",
          "loadResult": true
        }
      },
      "next": "hb-plan",
      "inputs": {
        "runId": "run.id"
      }
    },
    {
      "id": "owners",
      "type": "swarm-script",
      "label": "10b. Owners: one task per owner for everything no lane closed",
      "config": {
        "scriptName": "dreaming-owners",
        "scope": "global",
        "timeoutMs": 60000,
        "args": {
          "runId": "{{runId}}",
          "dryRun": "{{dryRun}}",
          "synth": "{{s}}",
          "apply": "{{ap}}",
          "skills": "{{sk}}",
          "scriptify": "{{sc}}",
          "trim": "{{tr}}",
          "leadAgentId": "{{lead}}",
          "coderAgentId": "{{coder}}"
        }
      },
      "next": "publish",
      "inputs": {
        "runId": "run.id",
        "dryRun": "gather.result.dryRun",
        "s": "synthesize.taskOutput",
        "ap": "apply.result",
        "sk": "skills.taskOutput",
        "sc": "scriptify.taskOutput",
        "tr": "trim-apply.result",
        "lead": "gather.result.leadAgentId",
        "coder": "gather.result.coderAgentId"
      }
    },
    {
      "id": "hb-plan",
      "type": "swarm-script",
      "label": "Lane C: plan the Lead HEARTBEAT prune",
      "config": {
        "scriptName": "dreaming-heartbeat",
        "scope": "global",
        "timeoutMs": 60000,
        "args": {
          "mode": "plan",
          "runId": "{{runId}}",
          "dryRun": "{{dryRun}}",
          "apply": "{{ap}}",
          "leadAgentId": "{{lead}}"
        }
      },
      "next": "hb-draft-gate",
      "inputs": {
        "runId": "run.id",
        "dryRun": "gather.result.dryRun",
        "ap": "apply.result",
        "lead": "gather.result.leadAgentId"
      }
    },
    {
      "id": "hb-draft-gate",
      "type": "code-match",
      "label": "Lane C: draft tonight?",
      "config": {
        "code": "(input) => (input.hp && input.hp.ok && !(input.b && input.b.overBudget) && (input.hp.chars > input.hp.targets.maxChars || (input.hp.candidates && input.hp.candidates.remove && input.hp.candidates.remove.length > 0) || (input.hp.deferredToHeartbeat || []).length > 0 || (input.hp.mustRestore || []).length > 0 || (input.hp.pinDrain && input.hp.pinDrain.drainable > 0))) ? 'draft' : 'skip'",
        "outputPorts": [
          "draft",
          "skip"
        ]
      },
      "next": {
        "draft": "hb-draft",
        "skip": "hb-apply-lead"
      },
      "inputs": {
        "hp": "hb-plan.result",
        "b": "gather.result.budget"
      }
    },
    {
      "id": "hb-draft",
      "type": "agent-task",
      "label": "Lane C: draft the pruned HEARTBEAT (writes nothing)",
      "config": {
        "agentId": "{{coder}}",
        "priority": 60,
        "tags": [
          "dreaming-v2",
          "lane-c"
        ],
        "template": "dreaming v3 lane C, run {{runId}} ({{hp.mode}}): draft Lead's pruned HEARTBEAT. You write NO profile, heartbeat or memory. Your output is a draft that a script validates and Lead's own session writes. Operator policy: big prunes and rewrites are fine; this is an optimization and learning process.\n\n## 1. Read the live text byte-exact (bash; MCP tool output is truncated, so do not use it for this)\n```\nH=(-s -H \"Authorization: Bearer $API_KEY\" -H \"X-Agent-ID: $AGENT_ID\" -H \"Content-Type: application/json\")\ncurl \"${H[@]}\" -X POST \"$MCP_BASE_URL/api/scripts/run\" -d '{\"name\":\"dreaming-heartbeat\",\"scope\":\"global\",\"args\":{\"mode\":\"text\"}}' > /tmp/hb-{{runId}}.json\njq -j .result.text /tmp/hb-{{runId}}.json > /tmp/hb-live-{{runId}}.md && sha256sum /tmp/hb-live-{{runId}}.md\n```\nThe sha must equal `{{hp.planSha}}`. If it does not, stop and return `{\"error\":\"live changed since plan\"}`.\nLive runs only (mode `live`): back up first with `agent-fs write {{hp.backupPath}} < /tmp/hb-live-{{runId}}.md` and return that path as `backupPath`. Dry runs: `backupPath: null`.\n\n## 2. Plan from hb-plan\n- targets: {{hp.targets}} (hard cap = `maxChars`)\n- sizes: tracked {{hp.tracked}}; standing orders {{hp.standingOrders}}\n- candidates: {{hp.candidates}}\n- pins (must keep verbatim if present): {{hp.pins}}\n- Tracked Items 📌 drain (rule 2a; cap {{hp.pinDrain.cap}} a night, in list order): {{hp.candidates.pins}}\n- restores (re-insert each `line` that is not `present`, with `DELETE MM-DD` ≤14 days out unless it is 📌): {{hp.mustRestore}}\n- deferred removals from apply (must be gone from the draft): {{hp.deferredToHeartbeat}}\n- procedures-skill handshake: {{hp.handshake}}\n\n## 3. Rubric\nA fact lives in one place. The heartbeat keeps what Lead must DO each heartbeat and the live state of open work. Stories, proofs and procedure detail leave.\n1. **Validator rules (the server rejects the whole write otherwise).** Under the last `## Tracked Items` heading, every new or changed line must either keep the exact leading `**title**` of one old line, or be a pure deletion of characters from one old line (no new words), or start with `📌`, or carry `DELETE MM-DD` (≤14 days out). One old line can cover only one new line. Never drop a `DELETE MM-DD` or a `📌` from a line you keep. Keep `## Tracked Items` as the last heading with that text.\n2. **📌 lines stay byte-for-byte**, except Tracked Items pins drained under rule 2a. Every 📌 line outside `## Tracked Items` is locked. So do `Rule #N` labels (or mark one `(retired)` with a reason).\n2a. **Drain Tracked Items 📌 pins into memory.** A pin-drain entry with `locked: false` and `kept: false` is a removal candidate. Keep it byte-for-byte only when the line holds an open next action or the live state of open work (an open-PR list, a pause someone still has to lift), and list its `probe` in `keptPins`. Drain at most `cap` pins, in list order (closed heads first). For each drained pin: (1) read its `memoryHits`, then run `memory-search` with its title; (2) a hit that already covers the same item: when it already holds the text, put its id in `removed[].memory` and add no entry; otherwise add a `movedToMemory` entry with `updateOf: \"<hit id>\"` (apply appends to it); (3) no such hit: add a new `movedToMemory` entry named `hb-pin-<slug>`; (4) entry `content` = one provenance line (\"Drained from Lead HEARTBEAT Tracked Items by dreaming lane C, <date>; byte-exact pre-prune: agent-fs {{hp.backupPath}}.\") then the pin line verbatim without its bullet; (5) the `removed[]` entry: `probe` = the candidate's `probe`, `reason` `closed` (closed head) or `moved-to-memory`, `movedTo: \"memory\"`, `memory` = the entry `name` (or the hit id from step 2). Delete the whole line; never rewrite a pin. `hb-check` refuses a dropped pin without a `memory` that exists or that this draft harvests.\n3. **Tracked Items: ≤{{hp.targets.trackedItemsChars}} chars, each item ≤{{hp.targets.itemChars}} chars.** Remove every `candidates.remove` item. Remove `candidates.review` and `closedUndated` items unless the line holds an open next action. Compress every other item to: `**title**` (exact), status, the next action, one pointer (task id, PR or memory name).\n4. **Standing Orders: ≤{{hp.targets.standingOrdersChars}} chars.** Keep each rule as one or two imperative lines. Delete dated incident stories, \"proven on X\" evidence, repeated rationale and frozen counts; leave `Memory <name>` as the pointer when one exists. Procedure detail (how-to steps) may be cut only when its probe is in `handshake.ready`; otherwise compress it in place and also propose it in `runbookAdds` for the `{{hp.runbookSkill}}` skill (never `heartbeat-runbook`, which is locked).\n5. **Everything else** (header, Governance, Infra watch, Reference): keep the substance, compress the prose.\n6. Text worth keeping that fits nowhere: `movedToMemory` (≤10 new memories plus ≤{{hp.pinDrain.cap}} drained-pin entries, name `^[a-z0-9-]{3,90}$`, self-contained content).\n\n## 4. Write, stage, upload\n1. Write the draft to `/tmp/hb-draft-{{runId}}.md` (your own container; Lead's disk is untouched).\n2. Stage it and check the sha:\n```\njq -n --rawfile t /tmp/hb-draft-{{runId}}.md '{name:\"dreaming-heartbeat\",scope:\"global\",args:{mode:\"stage\",runId:\"{{runId}}\",text:$t}}' | curl \"${H[@]}\" -X POST \"$MCP_BASE_URL/api/scripts/run\" -d @- | jq -c '.result | {ok,draftKey,draftSha,chars}'\nsha256sum /tmp/hb-draft-{{runId}}.md\n```\n3. Pre-check it with the same checks `hb-check` runs (validator port, 📌 set, size, removed coverage). Write your `removed[]` array to `/tmp/hb-removed-{{runId}}.json` and your `movedToMemory[]` array to `/tmp/hb-mtm-{{runId}}.json` first, then:\n```\njq -n --slurpfile r /tmp/hb-removed-{{runId}}.json --slurpfile m /tmp/hb-mtm-{{runId}}.json '{name:\"dreaming-heartbeat\",scope:\"global\",args:{mode:\"check\",dryRun:true,plan:{planSha:\"{{hp.planSha}}\",targets:{maxChars:{{hp.targets.maxChars}}}},draft:{draftKey:\"hb-draft:{{runId}}\",draftPath:\"{{hp.draftPath}}\",removed:$r[0],movedToMemory:$m[0]}}}' | curl \"${H[@]}\" -X POST \"$MCP_BASE_URL/api/scripts/run\" -d @- | jq -c '.result | {ready,reasons,stats}'\n```\n`ready` must be true. Otherwise fix the draft, re-stage, and re-check.\n4. `agent-fs write {{hp.draftPath}} < /tmp/hb-draft-{{runId}}.md`\n\n## 5. Return JSON only\n```\n{\"draftKey\":\"hb-draft:{{runId}}\",\"draftPath\":\"{{hp.draftPath}}\",\"draftSha\":\"<sha256 of the file>\",\"chars\":<n>,\"backupPath\":<path or null>,\n \"removed\":[{\"title\":\"<exact text inside the item's **…**, or null>\",\"probe\":\"<≤80 chars: first 60 chars of the removed line (no bullet), or a distinctive phrase of a removed Standing Orders block>\",\"reason\":\"<due|closed|stale|story|duplicate|moved-to-memory|moved-to-runbook|compressed-away>\",\"movedTo\":\"memory|runbook|none\",\"memory\":\"<drained pins only: movedToMemory name or existing memory id>\"}],\n \"compressed\":[{\"title\":\"…\",\"fromChars\":n,\"toChars\":n}],\n \"movedToMemory\":[{\"name\":\"…\",\"content\":\"…\",\"updateOf\":\"<optional: existing memory id to append to>\"}],\n \"keptPins\":[\"<probe of each drain candidate kept for an open next action>\"],\n \"runbookAdds\":[{\"probe\":\"<≤80-char phrase that will appear in the skill>\",\"text\":\"<procedure text>\",\"fromSection\":\"### …\"}]}\n```\nEvery tracked item that is gone from the draft needs a `removed[]` entry whose `title` (or `probe`) matches it. `hb-check` refuses the draft otherwise.\n",
        "outputSchema": {
          "type": "object",
          "required": [
            "draftKey",
            "draftPath",
            "draftSha",
            "removed"
          ],
          "properties": {
            "draftKey": {
              "type": "string"
            },
            "draftPath": {
              "type": "string"
            },
            "draftSha": {
              "type": "string"
            },
            "chars": {
              "type": "number"
            },
            "backupPath": {
              "type": [
                "string",
                "null"
              ]
            },
            "removed": {
              "type": "array"
            },
            "compressed": {
              "type": "array"
            },
            "movedToMemory": {
              "type": "array"
            },
            "runbookAdds": {
              "type": "array"
            },
            "keptPins": {
              "type": "array"
            }
          }
        }
      },
      "next": "hb-check",
      "inputs": {
        "runId": "run.id",
        "hp": "hb-plan.result",
        "coder": "gather.result.coderAgentId"
      }
    },
    {
      "id": "hb-check",
      "type": "swarm-script",
      "label": "Lane C: validate the draft + quiet window",
      "config": {
        "scriptName": "dreaming-heartbeat",
        "scope": "global",
        "timeoutMs": 300000,
        "args": {
          "mode": "check",
          "runId": "{{runId}}",
          "dryRun": "{{dryRun}}",
          "writes": "{{w}}",
          "plan": "{{hp}}",
          "draft": "{{hd}}",
          "leadAgentId": "{{lead}}"
        }
      },
      "next": "hb-gate",
      "inputs": {
        "runId": "run.id",
        "dryRun": "gather.result.dryRun",
        "w": "gather.result.v3Writes",
        "hp": "hb-plan.result",
        "hd": "hb-draft.taskOutput",
        "lead": "gather.result.leadAgentId"
      }
    },
    {
      "id": "hb-gate",
      "type": "code-match",
      "label": "Lane C: run lead-disk (dry unless v3Writes is on)?",
      "config": {
        "code": "(input) => (input.c && input.c.ready === true) ? 'run' : 'skip'",
        "outputPorts": [
          "run",
          "skip"
        ]
      },
      "next": {
        "run": "lead-disk",
        "skip": "hb-apply-lead"
      },
      "inputs": {
        "c": "hb-check.result"
      }
    },
    {
      "id": "lead-disk",
      "type": "agent-task",
      "label": "Lane C: Lead writes its own disk copy (guarded: quiet + sha re-check + atomic mv; dry: checks only)",
      "config": {
        "agentId": "{{lead}}",
        "priority": 70,
        "tags": [
          "dreaming-v2",
          "lane-c",
          "lead-disk"
        ],
        "template": "dreaming v3 `lead-disk`, run {{runId}}, MODE = {{hc.diskMode}}. You are the only step that touches your own disk copy of a profile field. Tonight's fields: heartbeatMd → `/workspace/HEARTBEAT.md`.\n\nRules: Bash only. Do NOT use Write, Edit or MultiEdit on these files: a Write posts a half state through self_edit. At most 6 bash calls per field. Do not \"fix\" anything you find; report it.\n\nValues: plan sha `{{hp.planSha}}` · draft `{{hp.draftPath}}` · draft sha `{{hc.draftSha}}` · date `{{hp.date}}`.\n\n1. `sha256sum /workspace/HEARTBEAT.md` must equal the plan sha. If it does not: `agent-fs write dreaming-v2/backups/{{hp.date}}/lead/heartbeat-disk-{{runId}}.md < /workspace/HEARTBEAT.md`, stop, and return `stopReason: \"disk-drift\"` with the sha you saw.\n2. `mkdir -p /workspace/personal/heartbeat-backups && cp /workspace/HEARTBEAT.md /workspace/personal/heartbeat-backups/{{runId}}.md && sha256sum /workspace/personal/heartbeat-backups/{{runId}}.md`. The backup sha must equal the plan sha.\n3. `agent-fs download '{{hp.draftPath}}' -o /tmp/hb-{{runId}}.md && sha256sum /tmp/hb-{{runId}}.md`. It must equal the draft sha, else stop with `stopReason: \"draft-sha-mismatch\"`.\n4. Both modes: run this ONE bash call exactly as written. Do not split it, edit it, retry it, or run cp yourself. It asks the swarm whether a Lead heartbeat-checklist task is live (pending or in progress), re-checks the disk sha against the plan sha, and only in MODE live copies the draft through a temp file and mv:\n```\nM={{hc.diskMode}}; H=/workspace/HEARTBEAT.md; T=/workspace/.HEARTBEAT.md.{{runId}}.tmp; Q=$(curl -s -m 30 -X POST \"$MCP_BASE_URL/api/scripts/run\" -H \"Authorization: Bearer ${AGENT_SWARM_API_KEY:-$API_KEY}\" -H \"X-Agent-ID: $AGENT_ID\" -H \"Content-Type: application/json\" -d '{\"name\":\"dreaming-heartbeat\",\"scope\":\"global\",\"args\":{\"mode\":\"quiet\"}}' | jq -r 'if .result.quiet == true then \"quiet\" else \"busy:\" + ((.result.busy // []) | map(.id[0:8] + \"/\" + .status) | join(\",\")) + (.error // \"\" | tostring) end' 2>/dev/null); S=$(sha256sum \"$H\" | cut -d' ' -f1); if [ \"$Q\" != quiet ]; then echo \"STOP heartbeat-busy ${Q:-no-answer} $S\"; elif [ \"$S\" != \"{{hp.planSha}}\" ]; then echo \"STOP disk-drift $S\"; elif [ \"$M\" != live ]; then echo \"WOULD-WRITE $S\"; else cp /tmp/hb-{{runId}}.md \"$T\" && mv -f \"$T\" \"$H\" && echo \"WROTE $(sha256sum \"$H\" | cut -d' ' -f1)\"; fi\n```\n   Its output line goes into `copyGuard` verbatim. `WROTE <sha>`: `diskAfterSha` = that sha, which must equal the draft sha. `WOULD-WRITE <sha>` (dry): `diskAfterSha` null. `STOP heartbeat-busy ...`: stop, `stopReason: \"heartbeat-busy\"`, `diskAfterSha` null. `STOP disk-drift <sha>`: stop, back up the disk as in step 1, `stopReason: \"disk-drift\"`, `diskAfterSha` null.\n\nReturn ONLY JSON:\n{\"mode\":\"dry|live\",\"fields\":[{\"field\":\"heartbeatMd\",\"diskPath\":\"/workspace/HEARTBEAT.md\",\"diskBeforeSha\":\"<step 1>\",\"backupPath\":\"/workspace/personal/heartbeat-backups/{{runId}}.md\",\"backupSha\":\"<step 2>\",\"draftShaOk\":<true|false>,\"copyGuard\":\"<step 4 output line, or null if you stopped before step 4>\",\"diskAfterSha\":<\"<step 4 WROTE sha>\" or null>,\"stopReason\":<null|\"disk-drift\"|\"draft-sha-mismatch\"|\"heartbeat-busy\">}]}\n",
        "outputSchema": {
          "type": "object",
          "required": [
            "mode",
            "fields"
          ],
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "dry",
                "live"
              ]
            },
            "fields": {
              "type": "array"
            }
          }
        }
      },
      "next": "hb-apply-lead",
      "inputs": {
        "runId": "run.id",
        "hp": "hb-plan.result",
        "hc": "hb-check.result",
        "lead": "gather.result.leadAgentId"
      }
    },
    {
      "id": "hb-apply-lead",
      "type": "agent-task",
      "label": "Lane C: DB write after the disk (v3Writes only), else wouldApply (runs as the lead)",
      "config": {
        "agentId": "{{lead}}",
        "priority": 70,
        "tags": [
          "dreaming-v2",
          "dreaming-lead-write",
          "hb-apply"
        ],
        "template": "dreaming run {{runId}}: Lead write step `hb-apply`. It needs Lead authority, so it runs in your session. Nothing here is owed to a human.\n\nMake exactly one tool call: `script-run` with name `dreaming-heartbeat`, scope `global`, and args `{\"mode\":\"apply\",\"runId\":\"{{runId}}\",\"fromRun\":true}`.\nPass no other args. The script loads its inputs and the dry-run flag from this run's recorded steps, does the writes, stores its full result in KV namespace `dreaming-v2`, and returns a small pointer.\nDo not retry it, do not call any other write tool, and do not edit the script.\n\nReturn ONLY the script's result JSON, unchanged: the next node checks its sha256. If the call itself errors, return {\"ok\":false,\"error\":\"<message>\"}.",
        "outputSchema": {
          "type": "object",
          "required": [
            "ok"
          ],
          "properties": {
            "ok": {
              "type": "boolean"
            }
          }
        }
      },
      "next": "hb-apply",
      "inputs": {
        "runId": "run.id",
        "lead": "gather.result.leadAgentId"
      }
    },
    {
      "id": "hb-apply",
      "type": "swarm-script",
      "label": "Lane C: DB write after the disk (v3Writes only), else wouldApply: stored result",
      "config": {
        "scriptName": "dreaming-heartbeat",
        "scope": "global",
        "timeoutMs": 60000,
        "args": {
          "mode": "apply",
          "runId": "{{runId}}",
          "loadResult": true
        }
      },
      "next": [
        "skills-gate",
        "scriptify-gate"
      ],
      "inputs": {
        "runId": "run.id"
      }
    },
    {
      "id": "learn",
      "type": "swarm-script",
      "label": "Learning loop: score cuts, pins, per-lane metrics",
      "config": {
        "scriptName": "dreaming-learn",
        "scope": "global",
        "timeoutMs": 120000,
        "args": {
          "runId": "{{runId}}",
          "dryRun": "{{dryRun}}",
          "trim": "{{tr}}",
          "hb": "{{hba}}",
          "budget": "{{bud}}",
          "leadAgentId": "{{lead}}"
        }
      },
      "next": "memtax-plan",
      "inputs": {
        "runId": "run.id",
        "dryRun": "gather.result.dryRun",
        "tr": "trim-apply.result",
        "hba": "hb-apply.result",
        "bud": "gather.result.budget",
        "lead": "gather.result.leadAgentId"
      }
    },
    {
      "id": "memtax-plan",
      "type": "swarm-script",
      "label": "Lane B1: memtax plan (classify batches, read-only; never throws)",
      "config": {
        "scriptName": "dreaming-memtax",
        "scope": "global",
        "timeoutMs": 60000,
        "args": {
          "mode": "plan",
          "runId": "{{runId}}",
          "dryRun": "{{dryRun}}",
          "generatedAt": "{{gen}}",
          "budget": "{{bud}}",
          "memtax": "{{input.memtax}}"
        }
      },
      "next": "memtax-gate",
      "inputs": {
        "runId": "run.id",
        "dryRun": "gather.result.dryRun",
        "gen": "gather.result.generatedAt",
        "bud": "gather.result.budget"
      }
    },
    {
      "id": "memtax-gate",
      "type": "code-match",
      "label": "Lane B1: any batches? (never throws; skip goes straight to memtax-report)",
      "config": {
        "code": "(input) => { try { const p = input.p; if (!p || typeof p !== 'object' || p.skipReason || !Array.isArray(p.batches) || p.batches.length === 0) return 'skip'; const ids = p.batches.map((b) => (b && typeof b === 'object' ? b.batchId : null)); if (ids.some((x) => typeof x !== 'string' || !x) || new Set(ids).size !== ids.length) return 'skip'; return 'run'; } catch (e) { return 'skip'; } }",
        "outputPorts": [
          "run",
          "skip"
        ]
      },
      "next": {
        "run": "memtax-classify",
        "skip": "memtax-report"
      },
      "inputs": {
        "p": "memtax-plan.result"
      }
    },
    {
      "id": "memtax-classify",
      "type": "foreach",
      "label": "Lane B1: classify one batch per task (cheap tier, read-only)",
      "config": {
        "over": "{{batches}}",
        "itemKey": "batchId",
        "body": {
          "type": "agent-task",
          "config": {
            "agentId": "{{writer}}",
            "modelTier": "smol",
            "tags": [
              "dreaming-v2",
              "dreaming-v2-memtax"
            ],
            "priority": 40,
            "template": "dreaming-v2 run {{runId}}: memory taxonomy lane B1, batch {{item.batchId}} ({{item.kind}}). CLASSIFY ONLY. DRY RUN = {{dryRun}}. Nothing here is owed to a human.\n\nREAD-ONLY. Do not call memory-store, memory-edit, memory-delete, inject-learning, kv-set or any other write tool. Do not search memory or read files: classify from the docs below only. Your whole job is the JSON you hand back through store-progress (see HOW TO RETURN at the end). store-progress is the one tool you must call; it is not a memory write.\n\nFor EVERY doc in the batch return one row: {id, path, entitySlugs, kind, action, reason}.\n\npath: the doc's home (dreaming-v2/memory-taxonomy.md §3.2). Closed enum; anything else is rejected.\nRECALL ONLY: if it can be a skill or script, it should be one. /longterm is the swarm's distilled understanding of who people are and how the company works: a few LIVING docs per subject, rewritten as evidence accrues. Subjects: who people are, our customers, how the company works (company-story sections), the decisions that shaped it, active workstreams. EPISODIC notes (a bug, an incident, a fix, a root cause, an outage, a one-off run or task) are NOT a subject: path /inbox/<id>, action keep (they stay on their TTL). Exception: when an episodic note reveals a durable trait (a person's standing preference, how the company decides, a customer's state), merge-into that subject doc instead. A doc that tells someone HOW to do something (steps, commands, endpoints, auth, headers, limits, API or CLI usage of a service or tool) is not a memory: it goes to /howto/<slug> and becomes a skill or script. When in doubt between a gotcha and a how-to, ask: would an agent follow it as instructions? Then it is /howto.\n- /longterm/company-story/<section> : how the company works, one living doc per section; use it as a merge-into target. section is exactly one of: overview (what the company is, model, identity) | products (what we build and sell, positioning, competitors) | customers (who buys, each customer's state in one line) | team (the humans and the swarm's agents, who owns what) | how-we-work (how work flows, how decisions get made, rhythms, house rules) | priorities (current priorities and bets, what is on hold) | history (milestones and the decisions that shaped the company).\n- /longterm/entities/people/<slug> : one human (a founder, teammate, or stakeholder): who they are, what they care about, how they decide, preferences, standing instructions.\n- /longterm/entities/customers/<slug> : a customer install or prospect: contacts, box access, feedback, contract state.\n- /longterm/decisions/<YYYY-MM-DD>-<slug> : a decision a person made, with who/why/alternatives. Date = when it was decided. A bug, incident, fix or root cause is never a decision.\n- /howto/<slug> : NOT a memory and never written. A how-to, procedure, runbook, or service/API usage note (auth, endpoints, limits, quirks of a database, a social or LLM API, GitHub, a hosting provider, ...). Lane B hands it to the skill and script lanes (existing skill or script first). <slug> = the service or task (clickhouse, linear-comment-formatting); if an enabled skill obviously covers it, use that skill's name. A competitor or market profile is recall, not how-to: merge-into:/longterm/company-story/products.\n- /longterm/workstreams/active/<slug> | /longterm/workstreams/done/<slug> : a multi-day effort: owner, status, open loops.\n- /longterm/timeline/daily/<YYYY-MM-DD> | /longterm/timeline/weekly/<YYYY>-w<ww> : what happened on a day/week (digests, journals, run summaries). Week is lowercase: 2026-w40.\n- /inbox/<id> : fits nowhere above (inbox = not under /longterm/). Use the doc's own id. Say in `reason` which path was missing.\nThere is no /longterm/facts path any more (retired 2026-10-06: services/procedures rows are re-filed to /howto, every other facts row stays in the inbox). There is no agents or repos path: agent profiles and get-repos own them. A gotcha about an agent, a repo or our system is a how-to (/howto/<slug>) or episodic (/inbox/<id>).\nEvery path is lowercase. <slug> is lowercase kebab [a-z0-9-], at most 80 chars, about the SUBJECT (not the date or the author). Reuse the same slug for docs about the same subject so they group.\n\nkind: entity | fact | decision | procedure | workstream | timeline | story | inbox (matches the path root; /howto is procedure, /longterm/company-story/<section> is story).\naction: keep (ONLY when the doc's `key` already equals `path`, or path is /inbox/<id>; a /howto doc is move or merge-into:/howto/<slug>) | move (single doc to a new path; today almost every doc has key `<scope>/manual/<id>` or a file path, so a real path is a move) | merge-into:<path> (2+ docs in this batch, or an obvious existing subject doc, describe the same subject: give the shared target path) | supersede (newer doc contradicts an older one on the same claim) | delete (stale, superseded, empty, or a raw log with no lasting value; say why).\nentitySlugs: people/customers/services the doc is about, as slugs (may be []).\nreason: one line, at most 25 words, citing what in the doc decided it.\n\nSignals per doc: `pre` is a cheap name-based guess (often wrong; \"other\" means no guess), `acc` = times retrieved, `ab` = usefulness alpha/beta, `inLinks` = inbound links, `chunks` = doc length in chunks, `text` = the first 1,500 chars. Name ending in a date is the date it was written.\n\nDocs (JSON): {{item.docs}}\n\nHOW TO RETURN. The workflow reads ONLY the `output` you pass to store-progress. A JSON block in your chat reply is discarded and the whole batch fails.\n1. Build {\"batchId\":\"{{item.batchId}}\",\"classifications\":[{\"id\":\"...\",\"path\":\"/longterm/... or /howto/... or /inbox/...\",\"entitySlugs\":[],\"kind\":\"...\",\"action\":\"...\",\"reason\":\"...\"}]} with exactly one row per doc id above.\n2. Call store-progress with status \"completed\" and output = that object as a compact JSON string: it starts with { and ends with }, with no markdown, no ``` fences and no prose around it. If store-progress is not loaded yet, load it with ToolSearch \"select:store-progress\".\n3. After store-progress succeeds, reply with one short line. If store-progress is impossible, your final reply must be the raw JSON object alone, starting with { and ending with }.\n",
            "outputSchema": {
              "type": "object",
              "required": [
                "batchId",
                "classifications"
              ],
              "properties": {
                "batchId": {
                  "type": "string"
                },
                "classifications": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "id",
                      "path",
                      "kind",
                      "action",
                      "reason"
                    ],
                    "properties": {
                      "id": {
                        "type": "string"
                      },
                      "path": {
                        "type": "string"
                      },
                      "entitySlugs": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "kind": {
                        "type": "string"
                      },
                      "action": {
                        "type": "string"
                      },
                      "reason": {
                        "type": "string"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "next": "memtax-report",
      "inputs": {
        "batches": "memtax-plan.result.batches",
        "runId": "run.id",
        "dryRun": "gather.result.dryRun",
        "writer": "gather.result.writerAgentId"
      }
    },
    {
      "id": "memtax-report",
      "type": "swarm-script",
      "label": "Lane B1: counts per path, 30 samples, cost; KV memtax:class only on live runs (never throws)",
      "config": {
        "scriptName": "dreaming-memtax",
        "scope": "global",
        "timeoutMs": 120000,
        "args": {
          "mode": "report",
          "runId": "{{runId}}",
          "dryRun": "{{dryRun}}",
          "plan": "{{p}}",
          "classify": "{{c}}"
        }
      },
      "next": "memtax-create-plan",
      "inputs": {
        "runId": "run.id",
        "dryRun": "gather.result.dryRun",
        "p": "memtax-plan.result",
        "c": "memtax-classify"
      }
    },
    {
      "id": "memtax-create-plan",
      "type": "swarm-script",
      "label": "Lane B: /longterm plan (ingest, entity records, B1 clusters, validate, tidy; read-only, never throws)",
      "config": {
        "scriptName": "dreaming-memtax-create",
        "scope": "global",
        "timeoutMs": 60000,
        "args": {
          "mode": "plan",
          "runId": "{{runId}}",
          "dryRun": "{{dryRun}}",
          "v3Writes": "{{w}}",
          "generatedAt": "{{gen}}",
          "budget": "{{bud}}",
          "memtax": "{{input.memtax}}",
          "classifyPlan": "{{cp}}",
          "classify": "{{c}}"
        }
      },
      "next": "memtax-distill-gate",
      "inputs": {
        "runId": "run.id",
        "dryRun": "gather.result.dryRun",
        "cp": "memtax-plan.result",
        "c": "memtax-classify",
        "w": "gather.result.v3Writes",
        "gen": "gather.result.generatedAt",
        "bud": "gather.result.budget"
      }
    },
    {
      "id": "memtax-distill-gate",
      "type": "code-match",
      "label": "Lane B: any clusters to distill? (never throws; skip goes straight to apply)",
      "config": {
        "code": "(input) => { try { const p = input.p; if (!p || typeof p !== 'object' || p.skipReason || !Array.isArray(p.jobs) || p.jobs.length === 0) return 'skip'; const ids = p.jobs.map((j) => (j && typeof j === 'object' ? j.jobId : null)); if (ids.some((x) => typeof x !== 'string' || !x) || new Set(ids).size !== ids.length) return 'skip'; return 'run'; } catch (e) { return 'skip'; } }",
        "outputPorts": [
          "run",
          "skip"
        ]
      },
      "next": {
        "run": "memtax-distill",
        "skip": "memtax-create-apply-lead"
      },
      "inputs": {
        "p": "memtax-create-plan.result"
      }
    },
    {
      "id": "memtax-distill",
      "type": "foreach",
      "label": "Lane B: distill one job of B1 clusters per task (cheap tier, read-only)",
      "config": {
        "over": "{{jobs}}",
        "itemKey": "jobId",
        "body": {
          "type": "agent-task",
          "config": {
            "agentId": "{{lead}}",
            "modelTier": "smol",
            "tags": [
              "dreaming-v2",
              "dreaming-v2-memtax-distill"
            ],
            "priority": 40,
            "template": "dreaming-v2 run {{runId}}: long-term memory lane B, distill job {{item.jobId}}. DRY RUN = {{dryRun}}. Nothing here is owed to a human.\n\nREAD-ONLY. Do not call memory-store, memory-edit, memory-delete, inject-learning, kv-set or any other write tool. Do not search memory or read files: work from the docs below only. Your whole job is the JSON you hand back through store-progress (see HOW TO RETURN at the end); a script writes the memories. store-progress is the one tool you must call; it is not a memory write.\n\nEach cluster is a set of inbox memories that the classifier put on the same long-term path (dreaming-v2/memory-taxonomy.md section 3.2). For EACH cluster, distill the durable facts into bullets for that path's doc.\n\nSUBJECT DOCS (taxonomy v5: the swarm's distilled understanding of who people are and how the company works). A /longterm doc is a living, distilled understanding of its subject, not a log of notes.\n- A cluster with `current` already has a doc: REWRITE it. Return the doc's COMPLETE new bullet list with \"rewrite\": true. Keep every still-true current bullet (its claim, stated and src), fold the members' new evidence into it, merge near-duplicates into one bullet citing both, supersede a contradicted bullet as \"now X; was Y until <date>\", and drop a current bullet only when it is episodic, a how-to or wrong. src may cite member ids or ids already on current bullets.\n- Generalize: turn an incident into the trait it reveals (\"Rejects fabricated time estimates\", not \"On 09-02 said 2 days was wrong\").\n- Start each bullet with a short theme label: Role:, Cares about:, Decides:, Prefers:, Standing rule:, Product:, Customer:, Team:, Rhythm:, Priority:, Milestone:.\n- EPISODIC: a cluster whose members are only a bug, incident, fix, root cause or one-off run, with no durable trait, returns {\"clusterId\":\"...\",\"episodic\":true,\"bullets\":[]}. It stays in the inbox.\nBullet rules:\n- One bullet = one still-true claim about the path's subject, at most 180 chars, plain words, no markdown, never the words \"stated\" or \"src:\".\n- `stated` = the date the claim was made (YYYY-MM-DD): the member's `created` date unless the text dates it.\n- `src` = the ids of the members that support it (only ids from that cluster). Every bullet needs at least one.\n- Merge duplicates across members into one bullet citing all of them. When two members contradict, keep the newer claim and say what it replaced (\"now X, was Y until <date>\").\n- Skip run logs, one-off task chatter, secrets, tokens, phone numbers, and anything not about the path's subject.\n- RECALL ONLY: a bullet is something to remember (who, what happened, what was decided and why, how OUR system behaves). Never a how-to: no steps, commands, endpoints, auth/header recipes or API/CLI usage. Drop how-to bullets. If a cluster is mostly how-to, return it with \"howto\": true and \"bullets\": []; lane B hands it to the skill and script lanes instead of writing a memory.\n- `existing` says whether the path already has a doc: for an entity record (people) do NOT restate name, email, role, ids, url or branch; the record already carries them. Give only what a record cannot: who they are, what they care about, how they decide, preferences, standing instructions. Never copy their comms profile (tone, verbosity, delivery format): the record links it.\n- At most 8 bullets for a new doc and 10 for a rewrite; the doc must fit one chunk (about 490 tokens). Fewer is fine. A cluster with nothing durable returns `bullets: []`.\n- `aliases`: up to 4 short lowercase search words for the subject (names, nicknames, product names), no commas.\n\nClusters (JSON): {{item.clusters}}\n\nHOW TO RETURN. The workflow reads ONLY the `output` you pass to store-progress. A JSON block in your chat reply is discarded and the whole job fails.\n1. Build {\"jobId\":\"{{item.jobId}}\",\"clusters\":[{\"clusterId\":\"c1\",\"path\":\"/longterm/...\",\"aliases\":[\"...\"],\"bullets\":[{\"claim\":\"...\",\"stated\":\"YYYY-MM-DD\",\"src\":[\"<member id>\"]}]}]} with one entry per clusterId above. A rewrite adds \"rewrite\":true. A how-to cluster is {\"clusterId\":\"c2\",\"path\":\"/longterm/...\",\"howto\":true,\"bullets\":[]}. An episodic cluster is {\"clusterId\":\"c3\",\"path\":\"/longterm/...\",\"episodic\":true,\"bullets\":[]}.\n2. Call store-progress with status \"completed\" and output = that object as a compact JSON string: it starts with { and ends with }, with no markdown, no ``` fences and no prose around it. If store-progress is not loaded yet, load it with ToolSearch \"select:store-progress\".\n3. After store-progress succeeds, reply with one short line. If store-progress is impossible, your final reply must be the raw JSON object alone, starting with { and ending with }.\n",
            "outputSchema": {
              "type": "object",
              "required": [
                "jobId",
                "clusters"
              ],
              "properties": {
                "jobId": {
                  "type": "string"
                },
                "clusters": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "clusterId",
                      "bullets"
                    ],
                    "properties": {
                      "clusterId": {
                        "type": "string"
                      },
                      "path": {
                        "type": "string"
                      },
                      "aliases": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "bullets": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "claim",
                            "stated",
                            "src"
                          ],
                          "properties": {
                            "claim": {
                              "type": "string"
                            },
                            "stated": {
                              "type": "string"
                            },
                            "src": {
                              "type": "array",
                              "items": {
                                "type": "string"
                              }
                            }
                          }
                        }
                      },
                      "howto": {
                        "type": "boolean"
                      },
                      "rewrite": {
                        "type": "boolean"
                      },
                      "episodic": {
                        "type": "boolean"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "next": "memtax-create-apply-lead",
      "inputs": {
        "jobs": "memtax-create-plan.result.jobs",
        "runId": "run.id",
        "dryRun": "gather.result.dryRun",
        "lead": "gather.result.leadAgentId"
      }
    },
    {
      "id": "memtax-create-apply-lead",
      "type": "agent-task",
      "label": "Lane B: compose + write /longterm docs (v3Writes on and not dryRun only; capped; logged; never throws) (runs as the lead)",
      "config": {
        "agentId": "{{lead}}",
        "priority": 70,
        "tags": [
          "dreaming-v2",
          "dreaming-lead-write",
          "memtax-create-apply"
        ],
        "template": "dreaming run {{runId}}: Lead write step `memtax-create-apply`. It needs Lead authority, so it runs in your session. Nothing here is owed to a human.\n\nMake exactly one tool call: `script-run` with name `dreaming-memtax-create`, scope `global`, and args `{\"mode\":\"apply\",\"runId\":\"{{runId}}\",\"fromRun\":true}`.\nPass no other args. The script loads its inputs and the dry-run flag from this run's recorded steps, does the writes, stores its full result in KV namespace `dreaming-v2`, and returns a small pointer.\nDo not retry it, do not call any other write tool, and do not edit the script.\n\nReturn ONLY the script's result JSON, unchanged: the next node checks its sha256. If the call itself errors, return {\"ok\":false,\"error\":\"<message>\"}.",
        "outputSchema": {
          "type": "object",
          "required": [
            "ok"
          ],
          "properties": {
            "ok": {
              "type": "boolean"
            }
          }
        }
      },
      "next": "memtax-create-apply",
      "inputs": {
        "runId": "run.id",
        "lead": "gather.result.leadAgentId"
      }
    },
    {
      "id": "memtax-create-apply",
      "type": "swarm-script",
      "label": "Lane B: compose + write /longterm docs (v3Writes on and not dryRun only; capped; logged; never throws): stored result",
      "config": {
        "scriptName": "dreaming-memtax-create",
        "scope": "global",
        "timeoutMs": 60000,
        "args": {
          "mode": "apply",
          "runId": "{{runId}}",
          "loadResult": true
        }
      },
      "next": "owners",
      "inputs": {
        "runId": "run.id"
      }
    }
  ]
}
```
