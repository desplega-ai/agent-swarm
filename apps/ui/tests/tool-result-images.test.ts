import { describe, expect, test } from "bun:test";
import { parseSessionLogs } from "../src/logs-parser";
import { resultPayloadText } from "../src/logs-parser/helpers";
import { imageResultPreview } from "../src/logs-parser/result-images";

const data = "iVBORw0KGgo=";
const claude = { type: "image", source: { type: "base64", media_type: "image/png", data } };
const pi = { type: "image", mimeType: "image/png", data };
const file = { type: "file", mime: "image/png", url: `data:image/png;base64,${data}` };

function row(cli: string, event: unknown, lineNumber = 1) {
  return {
    id: String(lineNumber),
    sessionId: "images",
    iteration: 1,
    cli,
    lineNumber,
    createdAt: "2026-09-21T12:00:00Z",
    content: JSON.stringify(event),
  };
}

describe("inline tool result images", () => {
  for (const [name, payload] of [
    ["Claude", [{ type: "text", text: "Read image" }, claude]],
    ["Pi", JSON.stringify({ content: [{ type: "text", text: "Read image" }, pi] })],
    ["Codex MCP", { content: [pi] }],
    ["OpenCode", { output: "Image read successfully", attachments: [file] }],
  ] as const) {
    test(`${name} preserves bytes for raw copy and removes them from the preview`, () => {
      const body = resultPayloadText(payload);
      const preview = imageResultPreview(body);
      expect(body).toContain(data);
      expect(preview?.images).toEqual([{ mimeType: "image/png", data }]);
      expect(preview?.text).toContain("[Image 1]");
      expect(preview?.text).not.toContain(data);
    });
  }

  test("SVG results remain text without preview images", () => {
    const svgData = btoa('<svg xmlns="http://www.w3.org/2000/svg"><text>raw SVG</text></svg>');
    const mimeType = "image/svg+xml";
    for (const block of [
      { type: "image", source: { type: "base64", media_type: mimeType, data: svgData } },
      { type: "image", mimeType, data: svgData },
      { type: "file", mime: mimeType, url: `data:${mimeType};base64,${svgData}` },
    ]) {
      for (const payload of [[block], { content: [block] }, { attachments: [block] }]) {
        const body = resultPayloadText(payload);
        expect(imageResultPreview(body)).toBeUndefined();
        expect(body).toContain(mimeType);
        expect(body).toContain(svgData);
      }
      const mixed = resultPayloadText({ content: [block, pi] });
      const preview = imageResultPreview(mixed);
      expect(preview?.images).toEqual([{ mimeType: "image/png", data }]);
      expect(preview?.text).toContain(mimeType);
      expect(preview?.text).toContain(svgData);
    }
  });

  test("mixed results preserve text, unknown blocks, and multiple images", () => {
    const payload = [{ type: "text", text: "before" }, claude, { custom: 42 }, pi];
    const preview = imageResultPreview(resultPayloadText(payload));
    expect(preview?.images).toHaveLength(2);
    expect(preview?.text).toContain("before");
    expect(preview?.text).toContain('"custom": 42');
    expect(preview?.text).toContain("[Image 2]");
  });

  test("unrecognized, incomplete, and non-image payloads retain the text fallback", () => {
    for (const payload of [
      "plain text",
      "{broken",
      { path: "/tmp/image.png" },
      { type: "image", data, mimeType: "text/html" },
      { type: "image", data: "", mimeType: "image/png" },
      { example: claude },
      { ...file, url: "file:///tmp/image.png" },
      { ...file, url: "javascript:alert(1)" },
    ])
      expect(imageResultPreview(resultPayloadText(payload))).toBeUndefined();
    expect(resultPayloadText({ content: [{ type: "text", text: "hello" }] })).toBe("hello");
  });

  test("prose before an embedded image result is retained", () => {
    const body = resultPayloadText(`Read complete\n${JSON.stringify({ content: [pi] })}`);
    expect(imageResultPreview(body)?.text).toContain("Read complete");
    expect(imageResultPreview(body)?.images).toHaveLength(1);
  });

  test("OpenCode enriches tool_end with persisted attachments", () => {
    const logs = [
      row("opencode", {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part",
            type: "tool",
            tool: "read",
            callID: "call",
            state: {
              status: "completed",
              input: { filePath: "/tmp/test.png" },
              output: "Image read successfully",
              attachments: [file],
            },
          },
        },
      }),
      row("opencode", { type: "tool_start", toolCallId: "call", toolName: "read" }, 2),
      row(
        "opencode",
        { type: "tool_end", toolCallId: "call", result: "Image read successfully" },
        3,
      ),
    ];
    const result = parseSessionLogs(logs)
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result");
    expect(result?.type).toBe("tool_result");
    if (result?.type !== "tool_result") return;
    expect(imageResultPreview(result.content)?.images).toHaveLength(1);
    expect(result.content).toContain("Image read successfully");
  });

  test("Claude and Pi result events survive the entire parser", () => {
    for (const [cli, content] of [
      ["claude", [claude]],
      ["pi", JSON.stringify({ content: [pi] })],
    ] as const) {
      const logs = [
        row(cli, {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "read", content }],
          },
        }),
      ];
      const result = parseSessionLogs(logs)
        .flatMap((message) => message.content)
        .find((block) => block.type === "tool_result");
      expect(
        result?.type === "tool_result" && imageResultPreview(result.content)?.images,
      ).toHaveLength(1);
    }
  });
});
