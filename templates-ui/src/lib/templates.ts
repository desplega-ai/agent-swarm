import fs from "node:fs";
import path from "node:path";
import type {
  AgentAssetConfig,
  AgentAssetResponse,
  AgentAssetCategory,
  TemplateConfig,
  TemplateResponse,
} from "../../../templates/schema";
import { ASSET_CATEGORIES } from "../../../templates/schema";

/** Rejects path components that aren't strictly alphanumeric/hyphen/underscore. */
function sanitizePathComponent(component: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(component)) {
    throw new Error(`Invalid path component: ${component}`);
  }
  return component;
}

// Check both paths: local dev (../templates) and Vercel build (src/data/templates)
function getTemplatesDir(): string {
  const localPath = path.join(process.cwd(), "..", "templates");
  const buildPath = path.join(process.cwd(), "src", "data", "templates");

  if (fs.existsSync(buildPath)) return buildPath;
  if (fs.existsSync(localPath)) return localPath;

  throw new Error("Templates directory not found. Expected at ../templates or src/data/templates");
}

export function isAssetCategory(category: string): category is AgentAssetCategory {
  return (ASSET_CATEGORIES as string[]).includes(category);
}

export function getCategories(): string[] {
  const dir = getTemplatesDir();
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "community" && !isAssetCategory(d.name))
    .map((d) => d.name);
}

export function getTemplateNames(category: string): string[] {
  const dir = path.join(getTemplatesDir(), sanitizePathComponent(category));
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

export function getTemplateConfig(category: string, name: string): TemplateConfig {
  const configPath = path.join(
    getTemplatesDir(),
    sanitizePathComponent(category),
    sanitizePathComponent(name),
    "config.json",
  );
  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as TemplateConfig;
}

function readFileOrEmpty(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf-8");
}

export function getTemplateFiles(category: string, name: string): TemplateResponse["files"] {
  const config = getTemplateConfig(category, name);
  const dir = path.join(
    getTemplatesDir(),
    sanitizePathComponent(category),
    sanitizePathComponent(name),
  );

  return {
    claudeMd: config.files.claudeMd ? readFileOrEmpty(path.join(dir, config.files.claudeMd)) : "",
    soulMd: config.files.soulMd ? readFileOrEmpty(path.join(dir, config.files.soulMd)) : "",
    identityMd: config.files.identityMd
      ? readFileOrEmpty(path.join(dir, config.files.identityMd))
      : "",
    toolsMd: config.files.toolsMd ? readFileOrEmpty(path.join(dir, config.files.toolsMd)) : "",
    heartbeatMd: config.files.heartbeatMd ? readFileOrEmpty(path.join(dir, config.files.heartbeatMd)) : "",
    setupScript: config.files.setupScript
      ? readFileOrEmpty(path.join(dir, config.files.setupScript))
      : "",
  };
}

export function getTemplate(category: string, name: string): TemplateResponse {
  return {
    config: getTemplateConfig(category, name),
    files: getTemplateFiles(category, name),
  };
}

export function getAllTemplates(): Array<TemplateConfig & { category: string }> {
  const templates: Array<TemplateConfig & { category: string }> = [];

  for (const category of getCategories()) {
    for (const name of getTemplateNames(category)) {
      try {
        const config = getTemplateConfig(category, name);
        templates.push({ ...config, category: category as TemplateConfig["category"] });
      } catch {
        // Skip invalid templates
      }
    }
  }

  return templates;
}

export function parseTemplateId(templateId: string): {
  category: string;
  name: string;
  version?: string;
} {
  // Format: "category/name@version" or "category/name"
  const atIndex = templateId.indexOf("@");
  const pathPart = atIndex >= 0 ? templateId.slice(0, atIndex) : templateId;
  const version = atIndex >= 0 ? templateId.slice(atIndex + 1) : undefined;

  const slashIndex = pathPart.indexOf("/");
  if (slashIndex < 0) {
    return { category: "official", name: pathPart, version };
  }

  return {
    category: pathPart.slice(0, slashIndex),
    name: pathPart.slice(slashIndex + 1),
    version,
  };
}

// ── Asset templates (skills / schedules / workflows) ──────────────────────────

export function getAssetNames(category: AgentAssetCategory): string[] {
  const dir = path.join(getTemplatesDir(), sanitizePathComponent(category));
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

export function getAssetConfig(category: AgentAssetCategory, name: string): AgentAssetConfig {
  const configPath = path.join(
    getTemplatesDir(),
    sanitizePathComponent(category),
    sanitizePathComponent(name),
    "config.json",
  );
  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as AgentAssetConfig;
}

export function getAssetContent(category: AgentAssetCategory, name: string): string {
  const contentPath = path.join(
    getTemplatesDir(),
    sanitizePathComponent(category),
    sanitizePathComponent(name),
    "content.md",
  );
  return readFileOrEmpty(contentPath);
}

export function getAsset(category: AgentAssetCategory, name: string): AgentAssetResponse {
  return {
    config: getAssetConfig(category, name),
    body: getAssetContent(category, name),
  };
}

export function getAllAssets(): Array<AgentAssetConfig> {
  const assets: Array<AgentAssetConfig> = [];

  for (const category of ASSET_CATEGORIES) {
    for (const name of getAssetNames(category)) {
      try {
        const config = getAssetConfig(category, name);
        assets.push(config);
      } catch {
        // Skip invalid assets
      }
    }
  }

  return assets;
}
