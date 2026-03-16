import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, SERIES, STYLE_CATEGORIES } from "./config.js";
import {
  buildDedupContext,
  formatDedupContextForPrompt,
  getRecentPromptsText,
  normalizeMainTopic,
  shouldSkipWorkflow,
  suggestStyleCategory,
} from "./dedup.js";
import { addFiles, commit, createBranch, createPr, push, safePull } from "./git-helper.js";
import { generateMeme, getTemplateMetadataText, parseMemeRequest } from "./imgflip.js";
import { executeWithLitmusTest, loadPrompt } from "./litmus.js";
import { ensureUniqueSlug, extractBlogMetadataFromContent, parseBlogMetadata } from "./slug.js";
import { StateManager } from "./state-manager.js";
import { SwarmClient } from "./swarm-client.js";
import type { FlowResult, MemeRequest, SeriesConfig, SeriesResult } from "./types.js";

/**
 * Run the complete daily blog flow.
 * Processes 4 series sequentially, then creates a single PR with all posts.
 */
export async function runDailyBlogFlow(): Promise<FlowResult> {
  const startedAt = new Date().toISOString();
  const dateStr = new Date().toISOString().split("T")[0]!; // YYYY-MM-DD
  const stateManager = new StateManager();
  const swarmClient = new SwarmClient();
  const seriesResults: SeriesResult[] = [];
  const generatedFiles: string[] = [];

  try {
    // Step 1: Cooldown check
    if (shouldSkipWorkflow(stateManager, "daily_blog")) {
      const result: FlowResult = {
        status: "skipped",
        seriesResults: [],
        startedAt,
        completedAt: new Date().toISOString(),
        error: "Workflow within cooldown period",
      };
      stateManager.recordWorkflowExecution({
        workflowName: "daily_blog",
        startedAt,
        completedAt: result.completedAt,
        status: "skipped",
        metadata: JSON.stringify(result),
      });
      return result;
    }

    // Step 2: Pull latest landing repo
    const blogBasePath = join(CONFIG.LANDING_REPO_PATH, CONFIG.BLOG_BASE_DIR);
    const imageBasePath = join(CONFIG.LANDING_REPO_PATH, CONFIG.IMAGE_BASE_DIR);
    await safePull();

    // Step 3: Process each series
    for (const series of SERIES) {
      console.log(`\n=== Processing series: ${series.name} ===\n`);

      try {
        const result = await processSeries(
          series,
          stateManager,
          swarmClient,
          blogBasePath,
          imageBasePath,
          dateStr,
        );
        seriesResults.push(result);

        if (result.status === "success") {
          if (result.filePath) generatedFiles.push(result.filePath);
          if (result.imagePath) generatedFiles.push(result.imagePath);
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.error(`[orchestrator] Series "${series.name}" failed: ${error}`);
        seriesResults.push({
          series: series.name,
          status: "failed",
          error,
        });
      }
    }

    // Check if any posts were generated
    const successCount = seriesResults.filter((r) => r.status === "success").length;

    if (successCount === 0) {
      const result: FlowResult = {
        status: "failed",
        seriesResults,
        startedAt,
        completedAt: new Date().toISOString(),
        error: "No posts generated across any series",
      };
      stateManager.recordWorkflowExecution({
        workflowName: "daily_blog",
        startedAt,
        completedAt: result.completedAt,
        status: "failed",
        metadata: JSON.stringify(result),
      });
      return result;
    }

    // Step 4: Git operations — branch, commit, push, PR
    let prUrl: string | undefined;
    const branchName = `daily-content/${dateStr}`;
    let gitFailed = false;

    try {
      await createBranch(branchName);
      await addFiles(generatedFiles);
      await commit(
        `feat(blog): add ${successCount} daily blog posts for ${dateStr}`,
      );
      await push(branchName);

      const prBody = buildPrBody(seriesResults, dateStr);
      prUrl = await createPr({
        title: `Daily Blog Content — ${dateStr}`,
        body: prBody,
        autoMerge: false,
      });
    } catch (e) {
      const gitError = e instanceof Error ? e.message : String(e);
      console.error(`[orchestrator] Git/PR operations failed: ${gitError}`);
      gitFailed = true;
    }

    // Step 5: Record workflow execution
    // If git failed, record as failed so cooldown doesn't skip the next run
    const completedAt = new Date().toISOString();
    const workflowStatus = gitFailed ? "failed" : "success";
    const result: FlowResult = {
      status: gitFailed ? "failed" : "success",
      seriesResults,
      prUrl,
      startedAt,
      completedAt,
      error: gitFailed ? "Git/PR operations failed" : undefined,
    };

    stateManager.recordWorkflowExecution({
      workflowName: "daily_blog",
      startedAt,
      completedAt,
      status: workflowStatus,
      metadata: JSON.stringify({
        seriesResults: seriesResults.map((r) => ({
          series: r.series,
          status: r.status,
          slug: r.slug,
        })),
        prUrl,
        postsGenerated: successCount,
        gitFailed,
      }),
    });

    return result;
  } finally {
    stateManager.close();
  }
}

/**
 * Process a single blog series: research → litmus → write → litmus → image → record.
 */
async function processSeries(
  series: SeriesConfig,
  stateManager: StateManager,
  swarmClient: SwarmClient,
  blogBasePath: string,
  imageBasePath: string,
  dateStr: string,
): Promise<SeriesResult> {
  // Build dedup context (Mechanism 2 + 5 + 6)
  const dedupCtx = buildDedupContext(stateManager, "daily_blog", series.name, 90);
  const dedupText = formatDedupContextForPrompt(dedupCtx);

  // === Step 1: Research topic with litmus test (retry up to 2x) ===
  let researchPrompt: string;
  try {
    researchPrompt = loadPrompt("daily_blog_research.md");
  } catch {
    researchPrompt = getDefaultResearchPrompt(series.name);
  }

  const researchResult = await executeWithLitmusTest(
    swarmClient,
    {
      agentId: CONFIG.CONTENT_STRATEGIST_ID,
      buildTaskDescription: (retryCtx) => {
        let desc = `## Task: Research a blog topic for the "${series.name}" series

${researchPrompt}

## Series: ${series.name}
## Date: ${dateStr}

## Content History Context (Dedup)
${dedupText}
`;
        if (retryCtx) {
          desc += `
## RETRY CONTEXT (Attempt ${retryCtx.attemptNumber})
Your previous topic was rejected for the following reasons:
${retryCtx.rejectionReasons.map((r) => `- ${r}`).join("\n")}

Suggestions for improvement:
${retryCtx.improvementSuggestions.map((s) => `- ${s}`).join("\n")}

Previous attempt output:
${retryCtx.previousAttempt.slice(0, 500)}
`;
        }
        desc +=
          "\n\nReturn a JSON object with: topic_title, description, target_audience, key_takeaways, series.";
        return desc;
      },
    },
    {
      promptFile: series.topicLitmusPrompt,
      maxRetries: series.topicMaxRetries,
    },
    { tags: ["daily-blog", "research", series.key] },
  );

  if (researchResult.status !== "approved" || !researchResult.output) {
    return {
      series: series.name,
      status: "failed",
      error: `Topic research ${researchResult.status}`,
    };
  }

  // === Step 2: Write blog post with litmus test (retry up to 1x) ===
  let writerPrompt: string;
  try {
    writerPrompt = loadPrompt("daily_blog_writer.md");
  } catch {
    writerPrompt = getDefaultWriterPrompt(series.name);
  }

  const writeResult = await executeWithLitmusTest(
    swarmClient,
    {
      agentId: CONFIG.CONTENT_WRITER_ID,
      buildTaskDescription: (retryCtx) => {
        let desc = `## Task: Write a blog post for the "${series.name}" series

${writerPrompt}

## Topic Research Output
${researchResult.output}

## Series: ${series.name}
## Date: ${dateStr}

IMPORTANT: Include a METADATA line in your output: METADATA: {"slug": "your-slug-here", "image_filename": "your-slug-here"}
`;
        if (retryCtx) {
          desc += `
## RETRY CONTEXT (Attempt ${retryCtx.attemptNumber})
Your previous content was rejected:
${retryCtx.rejectionReasons.map((r) => `- ${r}`).join("\n")}

Suggestions:
${retryCtx.improvementSuggestions.map((s) => `- ${s}`).join("\n")}
`;
        }
        return desc;
      },
    },
    {
      promptFile: series.contentLitmusPrompt,
      maxRetries: series.contentMaxRetries,
    },
    { tags: ["daily-blog", "write", series.key] },
  );

  if (writeResult.status !== "approved" || !writeResult.output) {
    return {
      series: series.name,
      status: "failed",
      error: `Blog writing ${writeResult.status}`,
    };
  }

  // === Step 3: Parse METADATA and ensure unique slug (Mechanism 3) ===
  const { metadata, cleanedOutput } = parseBlogMetadata(writeResult.output);

  if (!metadata?.slug) {
    return {
      series: series.name,
      status: "failed",
      error: "No METADATA slug found in writer output",
    };
  }

  const slug = ensureUniqueSlug(metadata.slug, blogBasePath);

  // Check content ID uniqueness (Mechanism 4)
  if (stateManager.contentExists("daily_blog", slug)) {
    console.log(`[orchestrator] Content "${slug}" already exists, skipping`);
    return {
      series: series.name,
      status: "skipped",
      slug,
      error: "Content already exists",
    };
  }

  // Write the TSX file
  const blogDir = join(blogBasePath, slug);
  const blogFilePath = join(blogDir, "page.tsx");
  const relativeFilePath = join(CONFIG.BLOG_BASE_DIR, slug, "page.tsx");

  if (!CONFIG.DRY_RUN) {
    mkdirSync(blogDir, { recursive: true });
    await Bun.write(blogFilePath, cleanedOutput);
    console.log(`[orchestrator] Wrote blog to ${blogFilePath}`);
  } else {
    console.log(`[dry-run] Would write blog to ${blogFilePath}`);
  }

  // === Step 4: Record to content_history (Mechanism 4 + 5) ===
  const contentMeta = extractBlogMetadataFromContent(cleanedOutput);
  const mainTopic = contentMeta.mainTopic
    ? normalizeMainTopic(contentMeta.mainTopic)
    : null;

  stateManager.recordContent({
    workflowName: "daily_blog",
    contentType: "blog",
    contentId: slug,
    filePath: relativeFilePath,
    status: "created",
    topic: contentMeta.title ?? undefined,
    mainTopic: mainTopic ?? undefined,
    subjects: JSON.stringify(contentMeta.subjects),
    keywords: JSON.stringify(contentMeta.keywords),
    seriesName: series.name,
  });

  // === Step 5: Extract image prompt (Mechanism 7) ===
  const styleCategory = suggestStyleCategory(stateManager, series.name);
  const recentPrompts = getRecentPromptsText(stateManager, series.name, 10);
  const templateMeta = getTemplateMetadataText();
  const styleInfo = STYLE_CATEGORIES[styleCategory];

  let extractPrompt: string;
  try {
    extractPrompt = loadPrompt("extract_image_prompt.md");
  } catch {
    extractPrompt = getDefaultImagePromptExtraction();
  }

  const imagePromptResult = await swarmClient.sendTaskAndWait(
    CONFIG.CONTENT_WRITER_ID,
    `## Task: Extract a meme image prompt from this blog post

${extractPrompt}

## Blog Content
${cleanedOutput.slice(0, 3000)}

## Style Guidance
Suggested style: ${styleCategory} — ${styleInfo?.name ?? styleCategory}
Description: ${styleInfo?.description ?? ""}
Keywords: ${styleInfo?.keywords ?? ""}

## Available Templates (with box counts)
${templateMeta}

## Recent Prompts (avoid repetition)
${recentPrompts}

Return a JSON object: {"template": "template_name", "text0": "...", "text1": "...", "text2": "...", "text3": "..."}
Empty strings for unused text boxes.`,
    { tags: ["daily-blog", "image-prompt", series.key] },
  );

  // === Step 6: Generate meme via Imgflip ===
  let imagePath: string | undefined;
  if (imagePromptResult.status === "completed" && imagePromptResult.output) {
    const memeRequest = parseMemeRequest(imagePromptResult.output);

    if (memeRequest) {
      const imageOutputPath = join(imageBasePath, `${slug}.png`);
      const relativeImagePath = join(CONFIG.IMAGE_BASE_DIR, `${slug}.png`);

      try {
        await generateMeme(memeRequest, imageOutputPath);
        imagePath = relativeImagePath;

        // Record image prompt (Mechanism 7)
        stateManager.recordImagePrompt({
          prompt: `${memeRequest.template}: ${memeRequest.text0} / ${memeRequest.text1}`,
          series: series.name,
          styleCategory,
          generationDate: new Date().toISOString().split("T")[0]!,
        });
      } catch (e) {
        console.warn(`[orchestrator] Meme generation failed: ${e}`);
      }
    }
  }

  return {
    series: series.name,
    status: "success",
    slug,
    filePath: relativeFilePath,
    imagePath,
  };
}

/** Build PR description body from series results */
function buildPrBody(results: SeriesResult[], dateStr: string): string {
  const lines = [
    `## Daily Blog Content — ${dateStr}`,
    "",
    "### Series Results",
    "",
  ];

  for (const r of results) {
    const icon = r.status === "success" ? "+" : r.status === "skipped" ? "~" : "-";
    lines.push(
      `- [${icon}] **${r.series}**: ${r.status}${r.slug ? ` (${r.slug})` : ""}${r.error ? ` — ${r.error}` : ""}`,
    );
  }

  const successCount = results.filter((r) => r.status === "success").length;
  lines.push("", `**${successCount}/${results.length} series generated.**`);
  lines.push("", "---", "Generated by content-orchestrator");

  return lines.join("\n");
}

/** Fallback research prompt when file not found */
function getDefaultResearchPrompt(seriesName: string): string {
  return `You are an Editor-in-Chief for a QA/testing technology blog.
Research and propose an engaging topic for the "${seriesName}" series.
The topic must be unique, technically deep, and actionable.
Return a JSON object with: topic_title, description, target_audience, key_takeaways, series.`;
}

/** Fallback writer prompt when file not found */
function getDefaultWriterPrompt(seriesName: string): string {
  return `You are a master technical content creator.
Write a comprehensive blog post for the "${seriesName}" series using the TSX BlogArticle component format.
Include production-ready code examples, answer capsules, statistics, and FAQs.
Include a METADATA line: METADATA: {"slug": "your-slug", "image_filename": "your-slug"}`;
}

/** Fallback image prompt extraction */
function getDefaultImagePromptExtraction(): string {
  return `Extract a meme concept from this blog post. Choose a popular meme template and write funny, relevant text for each box.
Return JSON: {"template": "template_name", "text0": "...", "text1": "...", "text2": "", "text3": ""}`;
}
