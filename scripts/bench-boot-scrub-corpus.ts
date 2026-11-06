/**
 * Synthetic session_logs corpus for benchmarking the boot re-scrub sweep.
 *
 * Lines are JSONL shaped like worker session logs (assistant text, tool_use,
 * tool_result carrying file or doc text, usage blocks), built from this repo's
 * own source and docs so the text is realistic. A few lines per thousand carry
 * a planted secret. Deterministic for a given seed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function* walk(dir: string, exts: string[], depth = 0): Generator<string> {
  if (depth > 6) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p, exts, depth + 1);
    else if (exts.some((e) => name.endsWith(e)) && st.size < 200_000) yield p;
  }
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pool of distinct session-log lines (a few thousand). */
export function buildLinePool(repoRoot: string, seed = 1): string[] {
  const rand = rng(seed);
  const files = [
    ...walk(join(repoRoot, "src"), [".ts", ".tsx"]),
    ...walk(join(repoRoot, "docs-site"), [".mdx", ".md"]),
    ...walk(join(repoRoot, "runbooks"), [".md"]),
  ];
  const pickChunk = (min: number, max: number): string => {
    const text = readFileSync(files[Math.floor(rand() * files.length)]!, "utf8");
    const len = Math.min(text.length, Math.floor(min + rand() * (max - min)));
    const start = Math.floor(rand() * Math.max(1, text.length - len));
    return text.slice(start, start + len);
  };
  const uuid = () => crypto.randomUUID();
  const usage = () =>
    `"usage":{"input_tokens":${Math.floor(rand() * 5000)},"cache_creation_input_tokens":${Math.floor(rand() * 9000)},"cache_read_input_tokens":${Math.floor(rand() * 90000)},"output_tokens":${Math.floor(rand() * 900)}}`;
  const pool: string[] = [];
  for (let i = 0; i < 4000; i++) {
    const kind = rand();
    if (kind < 0.12) {
      pool.push(
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: pickChunk(80, 1800) }],
          },
          session_id: uuid(),
        }).replace(/\}$/, `,${usage()}}`),
      );
    } else if (kind < 0.3) {
      pool.push(
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: `toolu_${uuid().replaceAll("-", "")}`,
                name: ["Bash", "Read", "Edit", "Grep"][Math.floor(rand() * 4)],
                input: { command: pickChunk(20, 300), description: "run a step" },
              },
            ],
          },
          session_id: uuid(),
        }),
      );
    } else if (kind < 0.9) {
      pool.push(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: `toolu_${uuid().replaceAll("-", "")}`,
                content: pickChunk(200, rand() < 0.15 ? 24000 : 5000),
              },
            ],
          },
          session_id: uuid(),
        }),
      );
    } else {
      pool.push(
        JSON.stringify({
          type: "system",
          subtype: "init",
          cwd: "/workspace/personal/repos/agent-swarm",
          session_id: uuid(),
          tools: ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "Agent", "Skill"],
          model: "claude-sonnet-5-5",
          mcp_servers: [{ name: "agent-swarm", status: "connected" }],
        }),
      );
    }
  }
  return pool;
}
