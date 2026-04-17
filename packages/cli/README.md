# @fastowl/cli

Command-line client for the FastOwl backend. Lets you (or a child Claude
running inside a FastOwl task) create tasks, inspect the backlog, and kick
the Continuous Build scheduler without touching the UI.

## Install

From a checkout of the FastOwl monorepo:

```bash
npm install        # from the repo root
npm run build -w @fastowl/cli
npm link -w @fastowl/cli
# now `fastowl` is on your PATH
```

## Environment

The CLI reads two env vars that agents spawned by FastOwl get automatically:

- `FASTOWL_API_URL` — defaults to `http://localhost:4747`
- `FASTOWL_WORKSPACE_ID` — default workspace for commands that need one
- `FASTOWL_TASK_ID` — current task id (used by `task ready`)

When Claude is running inside a FastOwl task, all three are already set, so
most commands work without flags.

## Commands

```bash
fastowl ping                             # health check

fastowl task list                        # list tasks in current workspace
fastowl task create --prompt "Add foo"   # spawn a new code_writing task
fastowl task create --type manual \
    --title "Merge PR #42"               # non-agent task
fastowl task ready                       # mark current task awaiting_review

fastowl backlog sources                  # list backlog sources
fastowl backlog sync <sourceId>          # re-read the source file
fastowl backlog items                    # list items in current workspace
fastowl backlog schedule                 # kick the Continuous Build scheduler
```

Add `--json` to most read commands to get machine-readable output.
