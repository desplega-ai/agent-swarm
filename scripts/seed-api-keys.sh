#!/usr/bin/env bash
# Seed API key status data for dashboard demo / E2E testing.
# Usage: ./scripts/seed-api-keys.sh [API_URL] [API_KEY]

API_URL="${1:-http://localhost:3013}"
API_KEY="${2:-123123}"
AUTH="Authorization: Bearer $API_KEY"
CT="Content-Type: application/json"

echo "Seeding API key status data to $API_URL..."

# Helper: report usage for a key
report_usage() {
  curl -s -X POST "$API_URL/api/keys/report-usage" \
    -H "$AUTH" -H "$CT" \
    -d "{\"keyType\":\"$1\",\"keySuffix\":\"$2\",\"keyIndex\":$3}" > /dev/null
}

# Helper: report rate limit for a key
report_rate_limit() {
  curl -s -X POST "$API_URL/api/keys/report-rate-limit" \
    -H "$AUTH" -H "$CT" \
    -d "{\"keyType\":\"$1\",\"keySuffix\":\"$2\",\"keyIndex\":$3,\"rateLimitedUntil\":\"$4\"}" > /dev/null
}

# --- OAuth tokens (3 keys) ---

# Key 0: heavily used, currently available
for i in $(seq 1 42); do
  report_usage "CLAUDE_CODE_OAUTH_TOKEN" "xK9mZ" 0
done
echo "  [OK] OAuth key 0 (xK9mZ) — 42 uses, available"

# Key 1: moderate use, rate limited (expires in 3 minutes)
EXPIRY_SOON=$(date -u -d "+3 minutes" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -v+3M '+%Y-%m-%dT%H:%M:%SZ')
for i in $(seq 1 18); do
  report_usage "CLAUDE_CODE_OAUTH_TOKEN" "bR4pQ" 1
done
report_rate_limit "CLAUDE_CODE_OAUTH_TOKEN" "bR4pQ" 1 "$EXPIRY_SOON"
echo "  [OK] OAuth key 1 (bR4pQ) — 18 uses, rate limited (3 min)"

# Key 2: light use, available
for i in $(seq 1 5); do
  report_usage "CLAUDE_CODE_OAUTH_TOKEN" "nW7eF" 2
done
echo "  [OK] OAuth key 2 (nW7eF) — 5 uses, available"

# --- Anthropic API keys (4 keys) ---

# Key 0: heavy use, available
for i in $(seq 1 87); do
  report_usage "ANTHROPIC_API_KEY" "aT3kL" 0
done
echo "  [OK] Anthropic key 0 (aT3kL) — 87 uses, available"

# Key 1: moderate use, rate limited (expires in 8 minutes)
EXPIRY_LATER=$(date -u -d "+8 minutes" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -v+8M '+%Y-%m-%dT%H:%M:%SZ')
for i in $(seq 1 31); do
  report_usage "ANTHROPIC_API_KEY" "vJ2nP" 1
done
report_rate_limit "ANTHROPIC_API_KEY" "vJ2nP" 1 "$EXPIRY_LATER"
echo "  [OK] Anthropic key 1 (vJ2nP) — 31 uses, rate limited (8 min)"

# Key 2: very heavy use, rate limited (expires in 1 minute — nearly clear)
EXPIRY_NEAR=$(date -u -d "+1 minute" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -v+1M '+%Y-%m-%dT%H:%M:%SZ')
for i in $(seq 1 120); do
  report_usage "ANTHROPIC_API_KEY" "mH8cD" 2
done
report_rate_limit "ANTHROPIC_API_KEY" "mH8cD" 2 "$EXPIRY_NEAR"
echo "  [OK] Anthropic key 2 (mH8cD) — 120 uses, rate limited (1 min)"

# Key 3: fresh key, barely used, available
for i in $(seq 1 2); do
  report_usage "ANTHROPIC_API_KEY" "qE5wY" 3
done
echo "  [OK] Anthropic key 3 (qE5wY) — 2 uses, available"

# --- OpenRouter keys (2 keys) ---

# Key 0: moderate use, available
for i in $(seq 1 15); do
  report_usage "OPENROUTER_API_KEY" "tR9sA" 0
done
echo "  [OK] OpenRouter key 0 (tR9sA) — 15 uses, available"

# Key 1: light use, rate limited (expires in 5 minutes)
EXPIRY_MID=$(date -u -d "+5 minutes" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -v+5M '+%Y-%m-%dT%H:%M:%SZ')
for i in $(seq 1 8); do
  report_usage "OPENROUTER_API_KEY" "gN4hU" 1
done
report_rate_limit "OPENROUTER_API_KEY" "gN4hU" 1 "$EXPIRY_MID"
echo "  [OK] OpenRouter key 1 (gN4hU) — 8 uses, rate limited (5 min)"

echo ""
echo "Done! Seeded 9 API keys (5 available, 4 rate-limited)."
echo "View at: http://localhost:5274/api-keys"
