#!/bin/sh
# Flat (hoisted) install of the runtime, as a "baked runtime" layer would hold it.
set -e
mkdir -p /spike/runtime && cd /spike/runtime
[ -f package.json ] || echo '{"name":"local-embed-runtime","private":true}' > package.json
START=$(date +%s)
bun add --linker=hoisted node-llama-cpp@3.22.1 2>&1 | tail -6
echo "install_s $(( $(date +%s) - START ))"
du -sh node_modules | sed 's/^/total /'
du -sh node_modules/node-llama-cpp node_modules/@node-llama-cpp/* 2>/dev/null
ls node_modules | wc -l | sed 's/^/top_level_pkgs /'
ls node_modules/@node-llama-cpp/
