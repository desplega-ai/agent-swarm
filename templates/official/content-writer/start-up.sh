#!/bin/bash
# === Common setup ===

# Fix npm cache permissions (root-owned files from previous npm versions)
if [ -d "/home/worker/.npm" ]; then
  sudo chown -R 1001:1001 "/home/worker/.npm" 2>/dev/null || true
fi

# AgentMail MCP server — add to .mcp.json via jq
if [ -f /workspace/.mcp.json ] && [ -n "$AGENTMAIL_API_KEY" ]; then
  jq --arg key "$AGENTMAIL_API_KEY" '.mcpServers.AgentMail = {
    "command": "npx",
    "args": ["-y", "agentmail-mcp"],
    "env": { "AGENTMAIL_API_KEY": $key }
  }' /workspace/.mcp.json > /tmp/.mcp.json.tmp && mv /tmp/.mcp.json.tmp /workspace/.mcp.json
fi

# Pre-install agentmail-mcp globally (avoid npx download every session)
npm list -g agentmail-mcp &>/dev/null || sudo npm install -g agentmail-mcp &>/dev/null

# === Agent-managed setup (add your customizations below) ===

# === Agent-managed setup ===
