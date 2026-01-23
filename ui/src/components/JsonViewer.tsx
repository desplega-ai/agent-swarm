import Box from "@mui/joy/Box";
import IconButton from "@mui/joy/IconButton";
import { useColorScheme } from "@mui/joy/styles";
import Tooltip from "@mui/joy/Tooltip";
import Typography from "@mui/joy/Typography";
import { useMemo, useState } from "react";

interface JsonViewerProps {
  content: string | object;
  maxHeight?: string;
  defaultCollapsed?: boolean;
}

export default function JsonViewer({
  content,
  maxHeight,
  defaultCollapsed = false,
}: JsonViewerProps) {
  const { mode } = useColorScheme();
  const isDark = mode === "dark";
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [copied, setCopied] = useState(false);

  const colors = {
    key: isDark ? "#D4A574" : "#6B4510",
    string: isDark ? "#98C379" : "#0D8028",
    number: isDark ? "#61AFEF" : "#0047AB",
    boolean: isDark ? "#C678DD" : "#6B46C1",
    null: isDark ? "#E06C75" : "#C41E3A",
    bg: isDark ? "rgba(30, 30, 30, 0.5)" : "rgba(250, 250, 250, 0.95)",
    border: isDark ? "rgba(100, 100, 100, 0.3)" : "rgba(120, 120, 120, 0.5)",
    text: isDark ? "inherit" : "#2D2D2D",
  };

  const jsonString = useMemo(() => {
    try {
      const obj = typeof content === "string" ? JSON.parse(content) : content;
      return JSON.stringify(obj, null, 2);
    } catch {
      return typeof content === "string" ? content : JSON.stringify(content, null, 2);
    }
  }, [content]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(jsonString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const syntaxHighlight = (json: string): React.ReactNode => {
    const lines = json.split("\n");
    return lines.map((line, idx) => {
      let highlightedLine = line;

      // Highlight keys (property names)
      highlightedLine = highlightedLine.replace(
        /"([^"]+)":/g,
        `<span style="color:${colors.key};font-weight:600">"$1"</span>:`,
      );

      // Highlight string values
      highlightedLine = highlightedLine.replace(
        /: "([^"]*)"/g,
        `: <span style="color:${colors.string}">"$1"</span>`,
      );

      // Highlight numbers (only valid JSON numbers)
      highlightedLine = highlightedLine.replace(
        /: (-?\d+\.?\d*)([,\s\]}])/g,
        `: <span style="color:${colors.number}">$1</span>$2`,
      );

      // Highlight booleans
      highlightedLine = highlightedLine.replace(
        /: (true|false)([,\s\]}])/g,
        `: <span style="color:${colors.boolean}">$1</span>$2`,
      );

      // Highlight null
      highlightedLine = highlightedLine.replace(
        /: (null)([,\s\]}])/g,
        `: <span style="color:${colors.null}">$1</span>$2`,
      );

      return (
        <Box
          key={idx}
          component="div"
          dangerouslySetInnerHTML={{ __html: highlightedLine }}
          sx={{
            fontFamily: "code",
            fontSize: "0.7rem",
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            overflowWrap: "anywhere",
          }}
        />
      );
    });
  };

  const preview = useMemo(() => {
    const lines = jsonString.split("\n");
    if (lines.length <= 3) return null;
    return lines.slice(0, 3).join("\n") + "\n  ...";
  }, [jsonString]);

  return (
    <Box
      sx={{
        bgcolor: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: 1,
        p: 1,
        position: "relative",
        maxHeight: maxHeight || "none",
        overflow: "auto",
        maxWidth: "100%",
        mx: 0, // Ensure no horizontal margin
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
        <Typography sx={{ fontFamily: "code", fontSize: "0.65rem", color: colors.text }}>
          JSON
        </Typography>
        <Box sx={{ display: "flex", gap: 0.5 }}>
          {preview && (
            <Tooltip title={collapsed ? "Expand" : "Collapse"} placement="top">
              <IconButton
                size="sm"
                variant="plain"
                onClick={() => setCollapsed(!collapsed)}
                sx={{
                  fontSize: "0.7rem",
                  minWidth: "auto",
                  minHeight: "auto",
                  color: "text.tertiary",
                  "&:hover": { color: "text.primary" },
                }}
              >
                {collapsed ? "▶" : "▼"}
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title={copied ? "Copied!" : "Copy JSON"} placement="top">
            <IconButton
              size="sm"
              variant="plain"
              onClick={handleCopy}
              sx={{
                fontSize: "0.7rem",
                minWidth: "auto",
                minHeight: "auto",
                color: copied ? colors.key : "text.tertiary",
                "&:hover": { color: "text.primary" },
              }}
            >
              {copied ? "✓" : "⧉"}
            </IconButton>
          </Tooltip>
        </Box>
      </Box>
      <Box>{collapsed && preview ? syntaxHighlight(preview) : syntaxHighlight(jsonString)}</Box>
    </Box>
  );
}
