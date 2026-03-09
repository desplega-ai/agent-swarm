import { NextResponse } from "next/server";
import { getAllTemplates } from "@/lib/templates";

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
  return NextResponse.json(templates, { headers: corsHeaders });
}
