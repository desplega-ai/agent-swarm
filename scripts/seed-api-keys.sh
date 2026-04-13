#!/usr/bin/env bash
# Seed API key status data for dashboard demo/E2E testing.
# Usage: ./scripts/seed-api-keys.sh [BASE_URL] [API_KEY]

BASE_URL="${1:-http://localhost:3013}"
API_KEY="${2:-123123}"
AUTH="Authorization: Bearer $API_KEY"

echo "Seeding API key status data to $BASE_URL..."

# Helper: report usage for a key
report_usage() {
  local keyType="$1" keySuffix="$2" keyIndex="$3" taskId="$4"
  curl -s -X POST "$BASE_URL/api/keys/report-usage" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"keyType\":\"$keyType\",\"keySuffix\":\"$keySuffix\",\"keyIndex\":$keyIndex${taskId:+,\"taskId\":\"$taskId\"}}" \
    > /dev/null
}

# Helper: report rate limit for a key
report_rate_limit() {
  local keyType="$1" keySuffix="$2" keyIndex="$3" rateLimitedUntil="$4"
  curl -s -X POST "$BASE_URL/api/keys/report-rate-limit" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"keyType\":\"$keyType\",\"keySuffix\":\"$keySuffix\",\"keyIndex\":$keyIndex,\"rateLimitedUntil\":\"$rateLimitedUntil\"}" \
    > /dev/null
}

# ── Anthropic API Keys (pool of 4) ──────────────────────────────────────────

echo "  Seeding Anthropic API keys..."

# Key 0: Heavy usage, currently available
for i in $(seq 1 42); do report_usage "ANTHROPIC_API_KEY" "xK9mN" 0; done

# Key 1: Moderate usage, currently rate-limited (expires in 3 minutes)
EXPIRY=$(date -u -d "+3 minutes" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -v+3M +%Y-%m-%dT%H:%M:%S.000Z)
for i in $(seq 1 18); do report_usage "ANTHROPIC_API_KEY" "pQ3rT" 1; done
report_rate_limit "ANTHROPIC_API_KEY" "pQ3rT" 1 "$EXPIRY"

# Key 2: Light usage, available
for i in $(seq 1 7); do report_usage "ANTHROPIC_API_KEY" "vW5yZ" 2; done

# Key 3: Medium usage, rate-limited (expires in 1 minute)
EXPIRY=$(date -u -d "+1 minute" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -v+1M +%Y-%m-%dT%H:%M:%S.000Z)
for i in $(seq 1 25); do report_usage "ANTHROPIC_API_KEY" "aB2cD" 3; done
report_rate_limit "ANTHROPIC_API_KEY" "aB2cD" 3 "$EXPIRY"

# ── OAuth Tokens (pool of 3) ────────────────────────────────────────────────

echo "  Seeding OAuth tokens..."

# Token 0: Available, moderate usage
for i in $(seq 1 31); do report_usage "CLAUDE_CODE_OAUTH_TOKEN" "Jh7kL" 0; done

# Token 1: Available, light usage
for i in $(seq 1 5); do report_usage "CLAUDE_CODE_OAUTH_TOKEN" "mN9pQ" 1; done

# Token 2: Rate-limited (expires in 4.5 minutes)
EXPIRY=$(date -u -d "+270 seconds" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -v+270S +%Y-%m-%dT%H:%M:%S.000Z)
for i in $(seq 1 15); do report_usage "CLAUDE_CODE_OAUTH_TOKEN" "rS1tU" 2; done
report_rate_limit "CLAUDE_CODE_OAUTH_TOKEN" "rS1tU" 2 "$EXPIRY"

# ── OpenRouter Key (single) ─────────────────────────────────────────────────

echo "  Seeding OpenRouter key..."
for i in $(seq 1 12); do report_usage "OPENROUTER_API_KEY" "eF4gH" 0; done

echo ""
echo "Done! Seeded 8 API keys (3 rate-limited, 5 available)."
echo "View at: $BASE_URL -> API Keys page, or GET $BASE_URL/api/keys/status"
