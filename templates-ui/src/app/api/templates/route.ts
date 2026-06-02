import { NextResponse } from "next/server";
import { getAllTemplates, getAllAssets } from "@/lib/templates";

// Intentional: public registry API, consumed by agent-swarm workers and external tools
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET() {
  const templates = getAllTemplates();
  const assets = getAllAssets();
  return NextResponse.json({ templates, assets }, { headers: corsHeaders });
}
