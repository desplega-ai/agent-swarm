import { CONFIG } from "./config.js";
import type { MemeRequest } from "./types.js";

const IMGFLIP_API_URL = "https://api.imgflip.com/caption_image";

/** Static template ID mappings (from Python imgflip_meme_runner.py) */
const POPULAR_TEMPLATES: Record<string, string> = {
  // Comparison
  drake: "181913649",
  drake_hotline_bling: "181913649",
  distracted_boyfriend: "112126428",
  two_buttons: "87743020",
  left_exit: "124822590",
  // Reaction
  this_is_fine: "55311130",
  hide_the_pain_harold: "27813981",
  woman_yelling_at_cat: "188390779",
  surprised_pikachu: "155067746",
  success_kid: "61544",
  // Escalation
  expanding_brain: "93895088",
  galaxy_brain: "93895088",
  gru_plan: "131940431",
  // Struggle
  sweating_guy: "87743020",
  daily_struggle: "87743020",
  bike_fall: "100777631",
  bicycle_fall: "100777631",
  // Success
  stonks: "178591752",
  panik_kalm: "132769734",
  buff_doge: "247375501",
  // Wisdom
  change_my_mind: "129242436",
  roll_safe: "89370399",
  // Absurd
  disaster_girl: "97984",
  evil_kermit: "84341851",
  monkey_puppet: "148909805",
  // Character
  doge: "8072285",
  bad_luck_brian: "61585",
  third_world_success: "101287",
  // Format
  boardroom_meeting: "112126428",
  ancient_aliens: "101470",
  // Wholesome
  wholesome: "91998305",
  keanu: "91545132",
};

/** Known box counts per template */
const KNOWN_BOX_COUNTS: Record<string, number> = {
  drake: 2,
  distracted_boyfriend: 3,
  two_buttons: 2,
  this_is_fine: 1,
  expanding_brain: 4,
  gru_plan: 4,
  woman_yelling_at_cat: 2,
  surprised_pikachu: 2,
  success_kid: 1,
  hide_the_pain_harold: 1,
  left_exit: 3,
  panik_kalm: 3,
  buff_doge: 2,
  stonks: 1,
  bicycle_fall: 3,
  boardroom_meeting: 5,
  change_my_mind: 1,
  evil_kermit: 2,
  disaster_girl: 1,
  monkey_puppet: 1,
  roll_safe: 1,
  ancient_aliens: 2,
  bad_luck_brian: 2,
  doge: 1,
  third_world_success: 2,
  wholesome: 1,
  keanu: 1,
};

/** Normalize template name to lookup key */
function normalizeTemplateKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s-]/g, "_")
    .replace(/'/g, "")
    .replace(/[^a-z0-9_]/g, "");
}

/** Find the Imgflip template ID for a given name */
function findTemplateId(templateName: string): string {
  const key = normalizeTemplateKey(templateName);

  // Direct lookup
  if (POPULAR_TEMPLATES[key]) return POPULAR_TEMPLATES[key];

  // Partial match
  for (const [k, id] of Object.entries(POPULAR_TEMPLATES)) {
    if (k.includes(key) || key.includes(k)) return id;
  }

  throw new Error(`Unknown meme template: "${templateName}" (key: "${key}")`);
}

/**
 * Generate a meme using the Imgflip API and save to disk.
 * Returns the local file path.
 */
export async function generateMeme(
  meme: MemeRequest,
  outputPath: string,
): Promise<string> {
  if (CONFIG.DRY_RUN) {
    console.log(
      `[dry-run] Would generate meme: ${meme.template} -> ${outputPath}`,
    );
    return outputPath;
  }

  const templateId = findTemplateId(meme.template);

  // Build form data
  const params = new URLSearchParams();
  params.set("template_id", templateId);
  params.set("username", CONFIG.IMGFLIP_USERNAME);
  params.set("password", CONFIG.IMGFLIP_PASSWORD);

  // Collect all text fields
  const texts = [meme.text0, meme.text1, meme.text2, meme.text3].filter(
    (t): t is string => t !== undefined && t !== "",
  );

  if (texts.length <= 2) {
    // Simple 2-box format
    params.set("text0", texts[0] ?? "");
    params.set("text1", texts[1] ?? "");
  } else {
    // Multi-box format using boxes[N][text] params
    for (let i = 0; i < texts.length; i++) {
      params.set(`boxes[${i}][text]`, texts[i]!);
    }
  }

  const resp = await fetch(IMGFLIP_API_URL, {
    method: "POST",
    body: params,
  });

  if (!resp.ok) {
    throw new Error(`Imgflip API error: ${resp.status}`);
  }

  const data = (await resp.json()) as {
    success: boolean;
    data?: { url: string };
    error_message?: string;
  };

  if (!data.success || !data.data?.url) {
    throw new Error(`Imgflip API failed: ${data.error_message ?? "unknown"}`);
  }

  // Download the image
  const imageResp = await fetch(data.data.url);
  if (!imageResp.ok) {
    throw new Error(`Failed to download meme image: ${imageResp.status}`);
  }

  const imageBuffer = await imageResp.arrayBuffer();
  await Bun.write(outputPath, imageBuffer);

  console.log(`[imgflip] Meme saved to ${outputPath}`);
  return outputPath;
}

/**
 * Get template metadata for context injection.
 * Returns formatted string: "template_key (N boxes)" for each known template.
 */
export function getTemplateMetadataText(): string {
  return Object.entries(KNOWN_BOX_COUNTS)
    .map(([key, boxes]) => `${key} (${boxes} boxes)`)
    .join(", ");
}

/**
 * Parse meme request JSON from the image prompt extraction output.
 */
export function parseMemeRequest(output: string): MemeRequest | null {
  // Try direct JSON parse
  try {
    const parsed = JSON.parse(output.trim());
    if (parsed.template) return parsed as MemeRequest;
  } catch {
    // continue
  }

  // Try extracting from code block
  const codeBlockMatch = output.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]!);
      if (parsed.template) return parsed as MemeRequest;
    } catch {
      // continue
    }
  }

  // Try finding JSON with "template" key
  const jsonMatch = output.match(/\{[^{}]*"template"\s*:\s*"[^"]+"/);
  if (jsonMatch) {
    // Find the closing brace
    const start = output.indexOf(jsonMatch[0]);
    let depth = 0;
    for (let i = start; i < output.length; i++) {
      if (output[i] === "{") depth++;
      if (output[i] === "}") depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(output.slice(start, i + 1));
          if (parsed.template) return parsed as MemeRequest;
        } catch {
          break;
        }
      }
    }
  }

  console.log("[imgflip] Failed to parse meme request from output");
  return null;
}
