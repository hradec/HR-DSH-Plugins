#!/usr/bin/env bash
# DSH idle gate for pending plugin restarts: restart ONLY when every Comfy box has an empty queue AND no GPU compute process AND another dsh-subprocess scope (an agent tool call) is running.
# The script's OWN subprocess scope is excluded, otherwise the watchdog could never report IDLE.
# ponytail: hard-codes the two known Comfy hosts (settings comfyBaseUrl/comfyTryUrls); unreachable hosts are skipped — live agent work is still caught by the scope count. Update this list when hosts change.
set -u
MY=$(sed -n 's#.*\(dsh-subprocess-[^/.]*\)\.scope.*#\1#p' /proc/self/cgroup | head -1)
Q=0
for host in 240.0.0.242 240.1.0.100; do
  n=$(curl -sf -m 5 "http://$host:8188/prompt" | sed -n 's/.*"queue_remaining": *\([0-9]*\).*/\1/p')
  [ -n "$n" ] && Q=$((Q+n))
done
# GPU: only count DSH-relevant compute — llama-swap/Comfy/torch, or anything holding >=500MiB. The Filmcraft AppImage sits on ~44MiB forever and would block the gate forever.
G=0
while IFS=, read -r pid mem; do
  pid=$(echo "$pid"|tr -d ' '); mem=$(echo "$mem"|sed -n 's/[^0-9]//gp')
  cmd=$(ps -o cmd= -p "$pid" 2>/dev/null)
  if [ "${mem:-0}" -ge 500 ] || echo "$cmd" | grep -qiE "llama|vllm|comfy|torch"; then G=$((G+1)); fi
done < <(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader 2>/dev/null)
S=$(systemctl --user list-units --type=scope --state=running --no-legend 'dsh-subprocess-*' 2>/dev/null | grep -v "$MY" | wc -l)
if [ "$Q" -eq 0 ] && [ "$G" -eq 0 ] && [ "$S" -eq 0 ]; then echo "IDLE comfy-queued=$Q gpu-procs=$G other-scopes=$S"; exit 0; fi
echo "BUSY comfy-queued=$Q gpu-procs=$G other-scopes=$S"; exit 1
