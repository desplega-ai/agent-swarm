import { ImageResponse } from "next/og";
import { type NextRequest } from "next/server";

export const runtime = "edge";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const title = searchParams.get("title") ?? "Agent Swarm";
  const subtitle = searchParams.get("subtitle") ?? "";
  const type = searchParams.get("type") ?? "page"; // "article" | "page"

  return new ImageResponse(
    (
      <div
        style={{
          width: "1200px",
          height: "630px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#ffffff",
          padding: "72px 80px",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        {/* Top bar */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div
            style={{
              width: "36px",
              height: "36px",
              borderRadius: "8px",
              backgroundColor: "#b45309",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                width: "18px",
                height: "18px",
                borderRadius: "50%",
                backgroundColor: "#ffffff",
                display: "flex",
              }}
            />
          </div>
          <span
            style={{
              fontSize: "22px",
              fontWeight: 700,
              color: "#b45309",
              letterSpacing: "-0.02em",
            }}
          >
            Agent Swarm
          </span>
          {type === "article" && (
            <span
              style={{
                fontSize: "13px",
                fontWeight: 500,
                color: "#71717a",
                backgroundColor: "#f4f4f5",
                padding: "4px 12px",
                borderRadius: "999px",
                marginLeft: "8px",
              }}
            >
              Blog
            </span>
          )}
        </div>

        {/* Main content */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "20px",
            flex: 1,
            justifyContent: "center",
          }}
        >
          <div
            style={{
              fontSize: title.length > 60 ? "42px" : "52px",
              fontWeight: 800,
              color: "#18181b",
              lineHeight: 1.15,
              letterSpacing: "-0.03em",
              maxWidth: "960px",
            }}
          >
            {title}
          </div>
          {subtitle && (
            <div
              style={{
                fontSize: "22px",
                color: "#71717a",
                lineHeight: 1.5,
                maxWidth: "800px",
              }}
            >
              {subtitle.length > 120 ? subtitle.slice(0, 120) + "…" : subtitle}
            </div>
          )}
        </div>

        {/* Bottom bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: "18px", color: "#a1a1aa", fontWeight: 500 }}>
            agent-swarm.dev
          </span>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "16px",
              color: "#b45309",
              fontWeight: 600,
            }}
          >
            Multi-Agent Orchestration
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}
