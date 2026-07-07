#!/bin/bash
# Enforce the RBAC authorization boundary (DES-445 slice 1).
#
# All authorization DECISIONS in API-side code must go through `can()` from
# src/rbac/ — no inline `isLead` authz conditionals in src/tools/ or src/http/.
# The Phase-1 gate inventory (plan 2026-07-07-des-445-rbac-slice1-can-audit.md,
# Appendix A) migrated every HARD gate; this check keeps them migrated and
# fails any NEW inline `isLead` authz check with a pointer to src/rbac.
#
# HONEST LIMITS of this check:
#   - It enforces "no inline isLead authz conditional", NOT "every new tool
#     calls can()". A tool added without any permission check passes silently.
#     Enforcement-by-construction (a required `permissions` field on
#     ToolConfig / route()) is increment 5 of DES-445.
#   - Lines where `isLead` appears only as an object/type PROPERTY KEY are
#     allowed wholesale (principal construction feeding can(), zod schemas,
#     createAgent registration pass-through, memory visibility pins). The
#     filter is line-granular: a conditional sharing a line with a property
#     key slips through — don't write those.
#
# Allowed `isLead` usage (everything else is a violation):
#   1. Property-key / shorthand-property lines (see above).
#   2. SOFT memory read-visibility scoping — memory RBAC parallel track:
#        src/tools/memory-search.ts
#   3. NON-AUTHZ sites (Appendix A):
#        src/tools/slack-reply.ts   — cosmetic icon_emoji pick
#        src/tools/join-swarm.ts    — registration-time lead assignment
#                                     (increment-4 hardening surface)
#        src/tools/send-task.ts     — target-shape guard (task TO lead)
#        src/http/poll.ts           — lead-vs-worker trigger routing
#   4. Principal-construction plumbing:
#        src/http/kv.ts             — buildAuthCtx isLead local feeding can()

set -euo pipefail

CHECK_PATHS=(
  src/tools
  src/http
)

# Allowed bare `isLead` reads, as "<file>|<line-content regex>" pairs — a hit
# passes only when BOTH match, so a NEW isLead conditional added to one of
# these files still fails the check (SOFT scoping, NON-AUTHZ, and
# principal-construction plumbing — see header for the classification).
ALLOWED_PATTERNS=(
  'src/tools/memory-search.ts|const isLead = agent\?\.isLead \?\? false'
  'src/tools/slack-reply.ts|icon_emoji: agent\.isLead'
  'src/tools/join-swarm.ts|agents\.find\(\(agent\) => agent\.isLead\)'
  'src/tools/join-swarm.ts|agent\.isLead \? "Lead" : "Worker"'
  'src/tools/send-task.ts|if \(agent\.isLead\) \{'
  'src/http/poll.ts|if \(agent\??\.isLead\) \{'
  'src/http/kv.ts|let isLead = false;'
  'src/http/kv.ts|isLead = agent\?\.isLead === true;'
)

HITS=$(grep -rn --include='*.ts' --include='*.tsx' 'isLead' "${CHECK_PATHS[@]}" 2>/dev/null || true)

# Allow lines where isLead is used as a property key (`isLead:` / `isLead?:`)
# or a shorthand object property (`isLead,` / `isLead }`) — construction, not
# a decision. Member accesses like `agent.isLead` in a conditional never match
# either pattern (they are preceded by `.` / followed by `)` or `;`).
FILTERED=$(echo "$HITS" \
  | grep -vE '(^|[^.?[:alnum:]])isLead\??[[:space:]]*:' \
  | grep -vE '[^.?[:alnum:]]isLead[[:space:]]*[,}]' \
  || true)

VIOLATIONS=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  file="${line%%:*}"
  content="${line#*:*:}"
  allowed=false
  for entry in "${ALLOWED_PATTERNS[@]}"; do
    allowed_file="${entry%%|*}"
    pattern="${entry#*|}"
    if [ "$file" = "$allowed_file" ] && echo "$content" | grep -qE "$pattern"; then
      allowed=true
      break
    fi
  done
  if [ "$allowed" = false ]; then
    VIOLATIONS="${VIOLATIONS}${line}\n"
  fi
done <<< "$FILTERED"

if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: RBAC authorization boundary violation detected!"
  echo ""
  echo "Authorization decisions in src/tools/ and src/http/ must go through"
  echo "can() from src/rbac/ — inline isLead authz checks are not allowed."
  echo ""
  echo "Violations:"
  echo -e "$VIOLATIONS"
  echo ""
  echo "Fix: build an RbacPrincipal and call can({principal, verb, resource, source})"
  echo "(see src/tools/kv/kv-write-auth.ts for the pattern). If this is a genuinely"
  echo "non-authorization use of isLead, add a 'file|line-regex' entry to"
  echo "ALLOWED_PATTERNS in scripts/check-rbac-boundary.sh with a one-line reason"
  echo "in the header."
  exit 1
fi

echo "RBAC authorization boundary check passed."
