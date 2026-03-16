import type { SeriesConfig, StyleCategory } from "./types.js";

export const CONFIG = {
  // State DB path
  STATE_DB_PATH: process.env.STATE_DB_PATH ?? "/workspace/shared/downloads/slack/state.db",

  // Landing repo for blog output
  LANDING_REPO_PATH: process.env.LANDING_REPO_PATH ?? "/workspace/repos/desplega-ai-landing",

  // Swarm REST API
  SWARM_API_URL: process.env.MCP_BASE_URL ?? "http://localhost:3013",
  API_KEY: process.env.API_KEY ?? "123123",

  // Content agent IDs
  CONTENT_STRATEGIST_ID: "7f95f57e-fff6-42fd-8e5b-cc345feab985",
  CONTENT_WRITER_ID: "322999d8-a1d0-4ae1-a6a0-5ba292d85720",
  CONTENT_REVIEWER_ID: "fc637423-24db-418a-ad03-a64e17c7b10a",

  // Imgflip credentials
  IMGFLIP_USERNAME: process.env.IMGFLIP_USERNAME ?? "",
  IMGFLIP_PASSWORD: process.env.IMGFLIP_PASSWORD ?? "",

  // Timeouts
  LLM_TASK_TIMEOUT_MS: 15 * 60 * 1000,
  LITMUS_TASK_TIMEOUT_MS: 5 * 60 * 1000,
  POLL_INITIAL_MS: 10_000,
  POLL_MAX_MS: 120_000,
  POLL_BACKOFF_FACTOR: 2,

  // Cooldown periods in hours
  COOLDOWNS: {
    daily_blog: 12,
    release_notes: 144,
    competitor_blog: 23,
    how_to_guide: 312,
    content_refresh: 15,
    local_seo: 696,
  } as Record<string, number>,

  // Prompts directory
  PROMPTS_PATH: process.env.PROMPTS_PATH ?? new URL("../prompts", import.meta.url).pathname,

  // Dry run mode
  DRY_RUN: process.env.DRY_RUN === "true",

  // Blog base path within landing repo
  BLOG_BASE_DIR: "app/blog",
  IMAGE_BASE_DIR: "public/images",
} as const;

/** Series definitions for the daily blog */
export const SERIES: SeriesConfig[] = [
  {
    name: "Foundation",
    key: "foundation",
    topicLitmusPrompt: "litmus_test_topic_foundation.md",
    contentLitmusPrompt: "litmus_test_content_foundation.md",
    topicMaxRetries: 2,
    contentMaxRetries: 1,
  },
  {
    name: "Test Wars",
    key: "test_wars",
    topicLitmusPrompt: "litmus_test_topic_test_wars.md",
    contentLitmusPrompt: "litmus_test_content_test_wars.md",
    topicMaxRetries: 2,
    contentMaxRetries: 1,
  },
  {
    name: "Vibe",
    key: "vibe",
    topicLitmusPrompt: "litmus_test_topic_vibe.md",
    contentLitmusPrompt: "litmus_test_content_vibe.md",
    topicMaxRetries: 2,
    contentMaxRetries: 1,
  },
  {
    name: "Level Up",
    key: "level_up",
    topicLitmusPrompt: "litmus_test_topic_level_up.md",
    contentLitmusPrompt: "litmus_test_content_level_up.md",
    topicMaxRetries: 2,
    contentMaxRetries: 1,
  },
];

/** 10 meme style categories for variety rotation */
export const STYLE_CATEGORIES: Record<string, StyleCategory> = {
  comparison_memes: {
    name: "Comparison Memes",
    description: "Memes showing choice between two or more options",
    keywords:
      "Drake Hotline Bling, Distracted Boyfriend, Two Buttons, Left Exit 12 Off Ramp",
  },
  reaction_memes: {
    name: "Reaction Memes",
    description: "Memes expressing emotional reactions or responses",
    keywords:
      "This is Fine, Hide the Pain Harold, Woman Yelling at Cat, Surprised Pikachu, Success Kid",
  },
  escalation_memes: {
    name: "Escalation Memes",
    description: "Memes showing progression or increasing intensity",
    keywords:
      "Expanding Brain, Brain Size, Levels of Understanding, Gru's Plan",
  },
  struggle_memes: {
    name: "Struggle Memes",
    description: "Memes depicting difficulty, failure, or challenges",
    keywords:
      "Sweating Guy, Daily Struggle, Bicycle Fall, Spider-Man Pointing",
  },
  success_memes: {
    name: "Success Memes",
    description: "Memes celebrating achievement or winning",
    keywords:
      "Stonks, Panik/Kalm, Buff Doge vs Cheems, Achievement Unlocked",
  },
  wisdom_memes: {
    name: "Wisdom Memes",
    description: "Memes teaching or explaining concepts",
    keywords: "Change My Mind, Ancient Wisdom, Roll Safe, Big Brain Time",
  },
  absurd_memes: {
    name: "Absurd Memes",
    description: "Memes with unexpected or chaotic situations",
    keywords:
      "Disaster Girl, Evil Kermit, Monkey Puppet, Awkward Look Monkey",
  },
  character_memes: {
    name: "Character Memes",
    description: "Memes featuring specific recognizable characters",
    keywords: "Pepe, Wojak, Doge, Kermit, SpongeBob",
  },
  format_memes: {
    name: "Format Memes",
    description: "Memes with specific visual layouts or structures",
    keywords: "4-panel comics, Before/After, Top Text Bottom Text, Label memes",
  },
  wholesome_memes: {
    name: "Wholesome Memes",
    description: "Positive, encouraging, or heartwarming memes",
    keywords:
      "Wholesome seal, You guys are getting paid, Bob Ross, Keanu",
  },
};

/** All style category keys */
export const ALL_STYLES = Object.keys(STYLE_CATEGORIES);

/** Common tools tracked for Level Up frequency analysis */
export const COMMON_TOOLS = [
  "bolt.new",
  "bolt",
  "lovable",
  "replit",
  "v0",
  "windsurf",
  "builder.io",
  "webflow",
  "framer",
];
