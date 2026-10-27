#!/bin/bash
# usage: try.sh "<tei args>" ; polls peak mem until ready/died
docker rm -f tei-probe >/dev/null 2>&1
T0=$(date +%s.%N)
docker run -d --name tei-probe --memory=4g -p 127.0.0.1:8081:80 -v tei_probe:/data ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4 --model-id nomic-ai/nomic-embed-text-v1.5 $1 >/dev/null
peak=0
for i in $(seq 1 600); do
  m=$(docker stats --no-stream --format "{{.MemUsage}}" tei-probe 2>/dev/null | awk '{print $1}')
  [ -n "$m" ] && echo "$m" >> /tmp/peak.txt
  if curl -sf localhost:8081/health >/dev/null; then echo "READY after $(echo "$(date +%s.%N)-$T0"|bc)s"; break; fi
  [ "$(docker inspect -f '{{.State.Running}}' tei-probe)" = true ] || { echo "DIED oom=$(docker inspect -f '{{.State.OOMKilled}}' tei-probe)"; break; }
  sleep 0.5
done
docker logs tei-probe 2>&1 | sed -E "s/\x1b\[[0-9;]*m//g" | grep -E "Warming|Ready|Starting HTTP|ERROR" | cut -c1-140 | tail -4
sort -h /tmp/peak.txt | tail -1; rm -f /tmp/peak.txt
