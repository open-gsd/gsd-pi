# Multi-Session Orchestration

How to run and monitor multiple concurrent GSD sessions.

## Architecture

GSD uses no sockets or ports. Worker status is a JSON file in `.gsd/parallel/`. Worker commands are `command_queue` rows in the project database (`.gsd/gsd.db`).

```
.gsd/parallel/
├── M001.status.json    # Worker heartbeat + state
├── M002.status.json
├── M003.status.json
└── ...
```

## Worker Isolation

Each worker gets:

1. **`GSD_MILESTONE_LOCK=M00X`** — state derivation only sees this milestone
2. **`GSD_PARALLEL_WORKER=1`** — prevents nested parallel spawns
3. **Own git worktree** at `.gsd/worktrees/M00X/` — branch `milestone/M00X`

Workers cannot interfere with each other. Each has its own filesystem and git branch.

## Status File Schema

Written atomically (`.tmp` + rename) by each worker at `.gsd/parallel/<milestoneId>.status.json`:

```json
{
  "milestoneId": "M001",
  "pid": 12345,
  "state": "running",
  "currentUnit": {
    "type": "task",
    "id": "T03",
    "startedAt": 1710000000000
  },
  "completedUnits": 7,
  "cost": 1.23,
  "lastHeartbeat": 1710000015000,
  "startedAt": 1710000000000,
  "worktreePath": ".gsd/worktrees/M001"
}
```

**States:** `running`, `paused`, `stopped`, `error`

## Worker Commands

`pause`, `resume` and `stop` are `command_queue` rows in the project database, targeted at the worker's milestone. The coordinator writes them (`/gsd parallel pause|resume|stop`) and the worker takes the oldest pending row between units.

An external orchestrator stops a worker with `SIGTERM`.

**Deprecated:** a signal file `.gsd/parallel/<milestoneId>.signal.json` with `{"signal":"pause"}` (or `resume`, `stop`) is still accepted for compatibility. Between units, the worker writes its command as a `command_queue` row, removes the file, and logs a deprecation warning. The file is input only; the worker acts on the row.

## Spawning Workers

```bash
# Spawn worker in its worktree
GSD_MILESTONE_LOCK=M001 \
GSD_PARALLEL_WORKER=1 \
  gsd headless --json auto 2>logs/M001.log &
WORKER_PID=$!
```

Workers emit JSONL events on stdout when `--json` is set.

## Monitoring All Workers

```bash
# Dashboard: enumerate all status files
for f in .gsd/parallel/*.status.json; do
  [ -f "$f" ] || continue
  jq -r '[.milestoneId, .state, (.currentUnit.id // "idle"), "\(.cost | tostring)$"] | join("\t")' "$f"
done

# Liveness check
for f in .gsd/parallel/*.status.json; do
  PID=$(jq -r '.pid' "$f")
  MID=$(jq -r '.milestoneId' "$f")
  if kill -0 "$PID" 2>/dev/null; then
    echo "$MID: alive (pid=$PID)"
  else
    echo "$MID: DEAD (pid=$PID) — cleanup needed"
    rm "$f"
  fi
done
```

## Sending Commands

Pause and resume are coordinator commands: use `/gsd parallel pause [MID]` and `/gsd parallel resume [MID]`. To stop a worker from an external orchestrator, send `SIGTERM` to its process:

```bash
# Stop a worker you spawned
kill -TERM "$WORKER_PID"
```

## Budget Enforcement

Use `gsd headless query` for instant aggregate cost:

```bash
TOTAL=$(gsd headless query | jq -r '.cost.total')
CEILING=50.00
if (( $(echo "$TOTAL > $CEILING" | bc -l) )); then
  echo "Budget exceeded ($TOTAL > $CEILING) — stopping all"
  for f in .gsd/parallel/*.status.json; do
    kill -TERM "$(jq -r '.pid' "$f")"
  done
fi
```

## Stale Session Cleanup

A session is stale when:

- PID is dead (`kill -0 $pid` fails), OR
- `lastHeartbeat` is older than 30 seconds

```bash
NOW=$(date +%s000)
STALE_THRESHOLD=30000
for f in .gsd/parallel/*.status.json; do
  PID=$(jq -r '.pid' "$f")
  HB=$(jq -r '.lastHeartbeat' "$f")
  AGE=$((NOW - HB))
  if ! kill -0 "$PID" 2>/dev/null || [ "$AGE" -gt "$STALE_THRESHOLD" ]; then
    echo "Stale: $(jq -r '.milestoneId' "$f") — removing"
    rm "$f"
  fi
done
```

## Multi-Project Orchestration

Within one project, milestones are tracked automatically in `.gsd/parallel/`. For orchestrating across **multiple projects**, maintain an external registry:

```json
{
  "sessions": [
    { "project": "/path/to/project-a", "milestoneId": "M001" },
    { "project": "/path/to/project-b", "milestoneId": "M001" },
    { "project": "/path/to/project-b", "milestoneId": "M002" }
  ]
}
```

Then poll each project's `.gsd/parallel/` directory. GSD has no cross-project awareness — the orchestrator must bridge this gap.

## Built-in Parallel Commands

Inside an interactive GSD session, these commands manage the parallel orchestrator:

| Command | Description |
|---------|-------------|
| `/gsd parallel start` | Analyze eligibility, spawn workers |
| `/gsd parallel status` | Show all workers, costs, progress |
| `/gsd parallel stop [MID]` | Stop one or all workers |
| `/gsd parallel pause [MID]` | Pause without killing |
| `/gsd parallel resume [MID]` | Resume paused worker |
| `/gsd parallel merge [MID]` | Merge completed milestone branch |
