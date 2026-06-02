#!/bin/bash
# Ensure mutable DB tables retain user-attribution audit columns.

set -euo pipefail

bun scripts/check-audit-columns.ts
