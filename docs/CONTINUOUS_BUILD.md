# Continuous Build

> Point FastOwl at a TODO document, and it works through the list for you.
> Each item becomes its own `code_writing` task with its own git branch.
> You review and approve; FastOwl queues the next one.

## Mental model

Continuous Build is an additional **task source**, not a new task lifecycle.
Alongside the five existing paths (ad-hoc, PR response, PR review, manual,
agent), the scheduler spawns tasks from a **backlog** parsed out of a
markdown file on one of your environments.

```
  backlog source (markdown file)
         │
         ▼   parse → items
  ┌──────────────────┐
  │   backlog_items  │  (pending / blocked / in-flight / done)
  └────────┬─────────┘
           │  scheduler picks next unblocked item
           ▼
      code_writing task  → claude agent → awaiting_review
           │                                       │
           │  user approves → item marked done  ◀──┘
           ▼
      scheduler picks next... (loop)
```

## Turning it on

1. Point the backend at an environment (local works; SSH works per
   [SSH_VM_SETUP.md](./SSH_VM_SETUP.md)).
2. In the desktop app: **Settings → Continuous Build**
3. Toggle **enabled**. Pick `maxConcurrent` (default 1) and decide whether
   to **require approval** between items (default on).
4. **Add source**:
   - File path: absolute path on the environment (e.g. `/home/you/project/TODO.md`)
   - Section: optional — only items under a heading with this title are parsed
   - Environment: the env that can `cat` the file
5. Click the sync icon on the source. Items populate.
6. Click **Run scheduler**. First unblocked item spawns a task.

Each approved task marks its backlog item done. Scheduler fires again on
`task:status` events; nothing extra needed once enabled.

## Backlog file format

Standard GitHub-flavored markdown checklist:

```markdown
## Priority Queue

- [ ] Add retry logic to the API client
  - [ ] Exponential backoff
  - [ ] Jitter
- [ ] Rewrite the installer flow (blocked) — waiting on design
- [x] Wire up the dashboard widget
```

- `- [ ]` → pending
- `- [x]` → already done (skipped)
- Indentation creates parent/child (children inherit being "under" the parent)
- Text containing `(blocked)` or `[blocked]` is flagged as blocked

External IDs are a stable hash of `text + parent`, so reordering items
doesn't churn state, but **editing an item's text creates a new item**.
Claims on the old one are preserved (the task still knows which item it
implemented via `metadata.backlogItemId`), but the scheduler will treat
the new text as a fresh item. This is usually what you want.

## Task-spawns-task (the CLI escape hatch)

A child Claude running inside a task can create follow-up tasks via the
`fastowl` CLI. Agents inherit `FASTOWL_WORKSPACE_ID` (and `FASTOWL_TASK_ID`)
from the parent, so:

```bash
# inside a Claude session on the agent's env:
fastowl task create --type code_writing \
    --prompt "Add tests for the new retry logic"
```

... creates a new `code_writing` task in the same workspace. It gets queued
and processed like any other. Useful when a child agent notices follow-up
work while implementing the current backlog item.

See [packages/cli/README.md](../packages/cli/README.md) for the full CLI
reference.

## Turning it on for FastOwl itself

The meta-case: configure a FastOwl workspace to continuously build the
`Priority Queue` section of the project's own `claude.md`. This is
"FastOwl eats its own dog food" (Option C in
[AUTONOMOUS_BUILD.md](./AUTONOMOUS_BUILD.md)).

Exact steps once your SSH VM is set up (see [SSH_VM_SETUP.md](./SSH_VM_SETUP.md)):

1. Clone the FastOwl repo on the VM and make sure `npm install` succeeds.
2. In the desktop app, create a workspace named `fastowl-self` (or reuse
   an existing workspace).
3. Add your SSH environment to it (Settings → Environments).
4. Add a watched repository pointing at `Gilbert09/owl` (Settings → Workspace).
5. Go to **Settings → Continuous Build**:
   - Toggle **enabled**
   - `maxConcurrent: 1`, `requireApproval: On` — don't let it stampede
   - **Add source**:
     - File path: `/home/<you>/fastowl/claude.md` (absolute, on the VM)
     - Section: `Priority Queue (Next Up)`
     - Environment: your SSH env
6. Sync the source — you should see the numbered priority-queue items show
   up as backlog items.
7. Click **Run scheduler**. A `code_writing` task appears, picks the first
   unblocked item, and starts Claude on it. Review when it hits
   `awaiting_review`. Approve. The next item fires.

Because the tasks run *on the VM* against a checkout of FastOwl, the
review/approve cycle is ~exactly what any external user would see. You're
dog-fooding your own product.

## Limitations today

- **Markdown source only** — GitHub issues and Linear are on the roadmap.
- **Retiring items** — if an item disappears from the source between syncs
  it's marked completed (not deleted). Any claims survive via
  `metadata.backlogItemId` on the task row.
- **No per-source priority** — every item becomes `medium` priority.
  Coming when we add priority inference from source context.
- **Scheduler is workspace-scoped** — a task's completion only nudges its
  own workspace's scheduler. Multi-workspace parallelism works but each
  workspace advances independently.
- **One backlog source typically** — multiple sources are supported but
  the scheduler just iterates them in creation order. Cross-source
  priorities are on the roadmap.
