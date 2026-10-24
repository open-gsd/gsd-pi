#!/bin/bash
OLD=362699
CTX=/home/openclaw/.openclaw/projects/gsd-pi/context
for i in $(seq 1 150); do
  P=$(systemctl --user show openclaw-gateway -p MainPID --value 2>/dev/null)
  if [ -n "$P" ] && [ "$P" != "$OLD" ] && [ "$P" != "0" ]; then break; fi
  sleep 10
done
sleep 90
{
  echo "=== observed at $(date -u +%FT%TZ) ==="
  echo "MainPID: $(systemctl --user show openclaw-gateway -p MainPID --value)"
  echo "active: $(systemctl --user is-active openclaw-gateway)"
  echo "=== restart2 unit ==="
  systemctl --user status gsd-plugin-restart2.service --no-pager 2>&1 | head -6
  echo "=== gateway log tail (journal) ==="
  journalctl --user -u openclaw-gateway --since '-4 min' --no-pager 2>/dev/null | tail -80
  echo "=== openclaw log tail ==="
  tail -40 "$HOME/.openclaw/logs/gateway.log" 2>/dev/null
  echo "=== projects.list ==="
  timeout 30 openclaw gateway call projects.list 2>&1 | head -40
  echo "=== workboard.cards.list (attempt) ==="
  timeout 30 openclaw gateway call workboard.cards.list 2>&1 | head -20
} > "$CTX/post-restart-verify.txt" 2>&1
echo done >> "$CTX/post-restart-verify.txt"
