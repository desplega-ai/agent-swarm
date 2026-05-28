import { NextResponse } from "next/server";
import {
  getAllTemplates,
  getAllAssets,
  getTemplate,
  getAsset,
  parseTemplateId,
  isAssetCategory,
} from "@/lib/templates";

// Intentional: public registry API, consumed by agent-swarm workers and external tools
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;

  // GET /api/templates -> list all templates
  if (!slug || slug.length === 0) {
    const templates = getAllTemplates();
    const assets = getAllAssets();
    return NextResponse.json({ templates, assets }, { headers: corsHeaders });
  }

  // Reconstruct the template ID from slug segments
  // e.g. ["official", "coder"] or ["skills", "agentmail-sending"]
  const templateId = slug.join("/");
  const parsed = parseTemplateId(templateId);

  if (isAssetCategory(parsed.category)) {
    try {
      const asset = getAsset(parsed.category, parsed.name);
      return NextResponse.json(asset, { headers: corsHeaders });
    } catch {
      return NextResponse.json(
        { error: `Asset template "${templateId}" not found` },
        { status: 404, headers: corsHeaders },
      );
    }
  }

  try {
    const template = getTemplate(parsed.category, parsed.name);

    // Validate version if specified
    if (parsed.version && template.config.version !== parsed.version) {
      return NextResponse.json(
        {
          error: `Version ${parsed.version} not found. Available: ${template.config.version}`,
        },
        { status: 404, headers: corsHeaders },
      );
    }

    return NextResponse.json(template, { headers: corsHeaders });
  } catch {
    return NextResponse.json(
      { error: `Template "${templateId}" not found` },
      { status: 404, headers: corsHeaders },
    );
  }
}
