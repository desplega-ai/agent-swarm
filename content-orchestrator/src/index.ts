import { CONFIG } from "./config.js";
import { runDailyBlogFlow } from "./orchestrator.js";

async function main() {
  console.log("=== Content Orchestrator ===");
  console.log(`Mode: ${CONFIG.DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`State DB: ${CONFIG.STATE_DB_PATH}`);
  console.log(`Landing repo: ${CONFIG.LANDING_REPO_PATH}`);
  console.log(`Swarm API: ${CONFIG.SWARM_API_URL}`);
  console.log(`Prompts: ${CONFIG.PROMPTS_PATH}`);
  console.log("");

  const result = await runDailyBlogFlow();

  console.log("\n=== Flow Result ===");
  console.log(JSON.stringify(result, null, 2));

  process.exit(result.status === "success" ? 0 : result.status === "skipped" ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
