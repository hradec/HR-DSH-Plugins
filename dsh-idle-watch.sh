#!/usr/bin/env bash
# Background idle-watcher: every 60 s runs the idle gate; on IDLE, marks /tmp/codex/dsh-restart-triggered and restarts the DSH service (pre-authorized by the user, only through this gate).
# ponytail: 60s granularity; dies with its own scope during the restart — which is the point. The schedule watchdog checks the marker to avoid a second restart.
set -u
LOG=/tmp/codex/dsh-idle-watch.log
while true; do
  if [ -f /tmp/codex/dsh-restart-triggered ]; then echo "$(date +%H:%M:%S) marker present — exiting" >>"$LOG"; exit 0; fi
  out=$(bash /BACKUP/home/rhradec/.dsh/custom-plugins/dsh-idle-check.sh 2>&1); rc=$?
  if [ $rc -eq 0 ]; then
    echo "$(date +%H:%M:%S) IDLE -> $out — RESTARTING" >>"$LOG"
    touch /tmp/codex/dsh-restart-triggered
    systemctl --user restart deepseek-harness.service
    echo "$(date +%H:%M:%S) restart command returned" >>"$LOG"
    exit 0
  fi
  sleep 60
done
