# Autonomous Build Loop

> How to run a long-lived agent that continuously works through FastOwl's TODO list, spawning child Claudes to implement tasks. This is a **read-later design doc**, not a plan to implement tomorrow.

## The idea in one paragraph

A "meta-agent" process runs on a durable compute surface (your laptop in `fastowl-daemon`, a VM, or GitHub Actions on a schedule). Every N hours it wakes up, reads the top of `claude.md`'s priority queue, picks the next unblocked task, spawns a child `claude` (via `--print` for non-interactive or via FastOwl itself for interactive approval), lets it work until it either finishes or hits a guardrail, runs tests + typecheck + lint, and if everything is green opens a PR (or commits to main, per FastOwl's trunk-based workflow). Repeat. You review the PRs (or commit logs) in your inbox in the morning.

There's a pleasant recursion here: **FastOwl already is this system for *you***. The meta-agent that builds FastOwl is a degenerate case of a FastOwl user. Once Phase 17 (automation rules) + Phase 16.3 (PR response auto-trigger) land, you can literally configure FastOwl to build itself.

## Three ways to set this up, in increasing order of fanciness

### Option A — Cron + script (today, simplest)

A shell script + `claude` CLI, invoked by cron/launchd/systemd on a schedule. Minimal moving parts, works today.

```bash
# ~/fastowl-autonomous/run.sh
#!/usr/bin/env bash
set -euo pipefail
cd ~/dev/Gilbert09/fastowl
git pull --rebase

# Non-interactive Claude — reads claude.md, picks next task, does the work
claude --print --permission-mode acceptEdits <<'PROMPT'
Read claude.md. Pick the single next unblocked item from the "Priority Queue".
Implement it. Run `npm run typecheck && npm run lint && npm test`. If any fail,
fix until green. Update claude.md checkboxes. Commit with a descriptive message.
Do NOT push if tests fail. Do NOT start a second item in this run.
PROMPT

# Guardrail: only push if the commit looks safe
if git log -1 --pretty=%B | grep -qi '^\(add\|fix\|update\|refactor\|docs\)'; then
  git push origin main
fi
```

Cron: `0 */6 * * * ~/fastowl-autonomous/run.sh >> ~/fastowl-autonomous/log 2>&1`

Pros: 50 lines, no infra. Cons: no approval gate, no inbox of results, no visibility when it errors.

### Option B — GitHub Actions on a schedule

Move the loop to CI so it's durable + visible + free (for public repos).

`.github/workflows/autonomous.yml`:

```yaml
name: Autonomous Build
on:
  schedule: [{ cron: '0 */4 * * *' }]  # every 4h
  workflow_dispatch: {}                # manual trigger
permissions:
  contents: write
  pull-requests: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - name: Run Claude
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          npx -y @anthropic-ai/claude-cli --print --permission-mode acceptEdits \
            --output-file /tmp/run.log <<'PROMPT'
          <same prompt as Option A>
          PROMPT
      - run: npm run typecheck && npm run lint && npm test
      - name: Open PR
        if: success()
        uses: peter-evans/create-pull-request@v6
        with:
          branch: autonomous/${{ github.run_id }}
          title: "Autonomous: next TODO item"
          body-path: /tmp/run.log
```

The key difference from Option A: **output lands as a PR**, not a main commit. You approve or close it. This is the real value — you still get to say no.

Pros: durable, free, built-in audit log. Cons: slow feedback (cron resolution), no mid-run interaction.

### Option C — FastOwl eats its own dog food (future)

Once Phase 17.1 (automation rules) + Phase 18.3 (hosted server) land, configure an automation rule inside FastOwl itself:

> *When* the "Priority Queue" section of `claude.md` changes (via a file-watch trigger in the daemon)
> *And* fewer than 1 `code_writing` task is in_progress
> *Then* create a `code_writing` task with prompt "Implement the next unblocked item in the priority queue"

Result: FastOwl spawns Claude, Claude does the work, and the task lands in your *own* FastOwl inbox at `awaiting_review`. You approve via the same UI you use for everything else. No new mental model.

This is the goal state. Options A/B are useful stepping stones — they exercise the prompts and guardrails so by the time C is available, you know exactly what rule to write.

## Guardrails (applies to all three options)

- **One task per run.** Long-running Claude sessions drift. Bound each run to a single TODO item and exit.
- **Tests must be green before commit/PR.** Non-negotiable. The meta-agent should refuse to stage work that breaks the build.
- **No pushing to main without approval.** Option A is the only one that does this and only for "safe" commit message patterns; Options B/C route through PR/inbox approval.
- **Scope fence.** Add a rule to the prompt: "Do not modify files outside of the phase you're working on unless they're a direct dependency. Do not rename things. Do not delete code." Drift protection.
- **Budget cap.** Claude runs with `--max-turns N` or an explicit exit condition. If a run goes long, kill it and retry at the next tick.
- **Append a build log to `claude.md`**. Meta-agent runs a session note with date + what it touched. Makes drift visible over time.

## Picking the right option

- Just want to see it work? **Option A**. 30 minutes to set up.
- Want it durable and reviewable? **Option B**. Afternoon.
- Want it to be idiomatic FastOwl? **Wait for Option C** after Phase 17/18.

## Why not spawn Claude Codes instead of CLI?

`claude` CLI + `--print` is cheapest and most predictable. Claude Code (interactive TUI) is optimized for a human in the loop — running it headless works but you get fewer guardrails. The only reason to prefer interactive Claude Code would be to hit MCP servers configured in your user scope; if you need that, mount the same `~/.claude/mcp_servers.json` onto the CI runner and use `claude --print`, which also honors MCPs.

## Open questions (for future-you)

- **Multi-agent parallelism**: can two autonomous runners work on independent phases simultaneously? Phase 14 ("one task per repo per environment") says no — but if they're working on disjoint parts of the tree, maybe. Would need branch-based isolation, not just single-active-task.
- **Failure feedback loops**: if a run fails 3 times in a row on the same task, should the meta-agent skip it and move to the next, or escalate to you? Logging the failure mode is important either way.
- **Self-review**: could a second Claude review the first one's PR before it lands on your inbox? Cheap extra safety layer.
- **Dependency-aware picking**: current "priority queue" is a flat list. Eventually tasks should declare `depends-on` so the meta-agent skips blocked items automatically. Could be as simple as a tag in claude.md, parsed by the runner.

---

This doc is intentionally kept short. When you're ready to set this up, copy Option A or B, tweak the prompt, and run for a week. You'll find the rough edges quickly.
