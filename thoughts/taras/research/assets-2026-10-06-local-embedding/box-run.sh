#!/bin/bash
# Runs on the x64 scratch box.
set -u
IMG=ghcr.io/desplega-ai/agent-swarm:latest
until [ -f /root/cloud-init-done ]; do sleep 3; done
echo "== host"; lscpu | grep -E "Model name|^CPU\(s\)|Thread|Flags" | sed 's/Flags:.*\(avx2\).*/Flags: has avx2/' | cut -c1-120; grep -o -w -E "avx512f|avx2|avx|fma|f16c" /proc/cpuinfo | sort | uniq -c | tr '\n' ' '; echo; free -m | sed -n 2p
docker pull -q $IMG; docker image inspect $IMG --format 'image arch={{.Architecture}} size={{.Size}} rev={{index .Config.Labels "org.opencontainers.image.revision"}}'
mkdir -p /spike/models /spike/full /spike/slim
echo "== model download"
START=$(date +%s)
curl -sL -o /spike/models/nomic.gguf "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q8_0.gguf"
echo "download_s $(( $(date +%s) - START )) bytes $(stat -c %s /spike/models/nomic.gguf) sha256 $(sha256sum /spike/models/nomic.gguf | cut -d' ' -f1)"
echo "== full install (default optional deps)"
docker run --rm --entrypoint sh -v /spike/full:/spike -v /spike-app:/spike-app:ro $IMG /spike-app/install.sh 2>&1 | tail -14
echo "== slim install (cpu prebuilt only)"
docker run --rm --entrypoint sh -v /spike/slim:/spike $IMG -c 'mkdir -p /spike/runtime && cd /spike/runtime && echo "{\"name\":\"local-embed-runtime\",\"private\":true}" > package.json && bun add --linker=hoisted --omit=optional node-llama-cpp@3.22.1 2>&1 | tail -3 && bun add --linker=hoisted --omit=optional @node-llama-cpp/linux-x64@3.22.1 2>&1 | tail -2; du -sh node_modules node_modules/node-llama-cpp node_modules/@node-llama-cpp/* ; ls node_modules/@node-llama-cpp/; cd /spike && tar czf /tmp/rt.tgz runtime && ls -la /tmp/rt.tgz | awk "{print \"runtime_tgz_bytes\", \$5}"'
run() { # label cpus threads cmd
docker run --rm ${2:+--cpus $2} --memory 1g --entrypoint sh -w /spike/runtime -e MODE="x64-$1" ${3:+-e THREADS=$3} -e MODEL_PATH=/models/nomic.gguf -e LLAMA_PKG_ABS=/spike/runtime/node_modules/node-llama-cpp/dist/index.js -v /spike/slim:/spike -v /spike-app:/spike-app:ro -v /spike/models:/models:ro $IMG -c "cp /spike-app/probe.ts ./probe.ts && $4" 2>&1 | grep "^RESULT\|rror\|llegal" | tail -3; }
echo "== probes"
run "bun-runtime-nolimit-2thr" "" 2 'bun probe.ts'
run "be-bun-nolimit-2thr" "" 2 'BUN_BE_BUN=1 /usr/local/bin/agent-swarm-api run ./probe.ts'
run "bun-runtime-nolimit-default-threads" "" "" 'bun probe.ts'
run "bun-runtime-1cpu-1thr" 1 1 'bun probe.ts'
run "compiled-inproc-nolimit-2thr" "" 2 'bun build ./probe.ts --compile --outfile /tmp/probe-bin >/dev/null 2>&1 && cd / && LLAMA_PKG=$LLAMA_PKG_ABS /tmp/probe-bin'
echo "== done"
