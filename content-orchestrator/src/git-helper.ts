import { CONFIG } from "./config.js";

/**
 * Pull latest changes from main, stashing any local changes first.
 */
export async function safePull(
  repoPath: string = CONFIG.LANDING_REPO_PATH,
): Promise<boolean> {
  if (CONFIG.DRY_RUN) {
    console.log(`[dry-run] Would git pull in ${repoPath}`);
    return true;
  }

  let didStash = false;
  try {
    // Check if there are changes to stash
    const stashResult = await Bun.$`cd ${repoPath} && git stash`.quiet().text();
    didStash = !stashResult.includes("No local changes");

    await Bun.$`cd ${repoPath} && git pull origin main`.quiet();
    console.log(`[git] Pulled latest in ${repoPath}`);
    return true;
  } catch (e) {
    console.error(`[git] Pull failed: ${e}`);
    return false;
  } finally {
    // Always pop stash if we stashed, even if pull failed
    if (didStash) {
      try {
        await Bun.$`cd ${repoPath} && git stash pop`.quiet();
      } catch {
        console.warn("[git] Failed to pop stash after pull");
      }
    }
  }
}

/**
 * Create a new branch from the current HEAD.
 */
export async function createBranch(
  branchName: string,
  repoPath: string = CONFIG.LANDING_REPO_PATH,
): Promise<void> {
  if (CONFIG.DRY_RUN) {
    console.log(`[dry-run] Would create branch "${branchName}" in ${repoPath}`);
    return;
  }

  await Bun.$`cd ${repoPath} && git checkout -b ${branchName}`.quiet();
  console.log(`[git] Created branch "${branchName}"`);
}

/**
 * Stage files for commit.
 */
export async function addFiles(
  files: string[],
  repoPath: string = CONFIG.LANDING_REPO_PATH,
): Promise<void> {
  if (CONFIG.DRY_RUN) {
    console.log(`[dry-run] Would stage ${files.length} files`);
    return;
  }

  for (const file of files) {
    await Bun.$`cd ${repoPath} && git add ${file}`.quiet();
  }
  console.log(`[git] Staged ${files.length} files`);
}

/**
 * Commit staged changes.
 */
export async function commit(
  message: string,
  repoPath: string = CONFIG.LANDING_REPO_PATH,
): Promise<void> {
  if (CONFIG.DRY_RUN) {
    console.log(`[dry-run] Would commit: "${message}"`);
    return;
  }

  await Bun.$`cd ${repoPath} && git commit -m ${message}`.quiet();
  console.log(`[git] Committed: "${message}"`);
}

/**
 * Push branch to remote with upstream tracking.
 */
export async function push(
  branchName: string,
  repoPath: string = CONFIG.LANDING_REPO_PATH,
): Promise<void> {
  if (CONFIG.DRY_RUN) {
    console.log(`[dry-run] Would push branch "${branchName}"`);
    return;
  }

  await Bun.$`cd ${repoPath} && git push -u origin ${branchName}`.quiet();
  console.log(`[git] Pushed branch "${branchName}"`);
}

/**
 * Create a PR using GitHub CLI and return the PR URL.
 */
export async function createPr(
  opts: {
    title: string;
    body: string;
    baseBranch?: string;
    autoMerge?: boolean;
  },
  repoPath: string = CONFIG.LANDING_REPO_PATH,
): Promise<string> {
  if (CONFIG.DRY_RUN) {
    console.log(`[dry-run] Would create PR: "${opts.title}"`);
    return "https://github.com/dry-run/pr/0";
  }

  const base = opts.baseBranch ?? "main";
  const result =
    await Bun.$`cd ${repoPath} && gh pr create --title ${opts.title} --body ${opts.body} --base ${base}`.text();

  const prUrl = result.trim();
  console.log(`[git] Created PR: ${prUrl}`);

  if (opts.autoMerge) {
    try {
      await Bun.$`cd ${repoPath} && gh pr merge --auto --squash --delete-branch`.quiet();
      console.log("[git] Auto-merge enabled");
    } catch (e) {
      console.warn(`[git] Auto-merge failed: ${e}`);
    }
  }

  return prUrl;
}

/**
 * Switch back to main and delete a local branch.
 */
export async function cleanupBranch(
  branchName: string,
  repoPath: string = CONFIG.LANDING_REPO_PATH,
): Promise<void> {
  if (CONFIG.DRY_RUN) {
    console.log(`[dry-run] Would cleanup branch "${branchName}"`);
    return;
  }

  try {
    await Bun.$`cd ${repoPath} && git checkout main`.quiet();
    await Bun.$`cd ${repoPath} && git branch -D ${branchName}`.quiet();
    console.log(`[git] Cleaned up branch "${branchName}"`);
  } catch (e) {
    console.warn(`[git] Branch cleanup failed: ${e}`);
  }
}
