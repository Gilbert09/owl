# FastOwl Session Notes

Chronological notes from development sessions. Most recent first. See [`CLAUDE.md`](../CLAUDE.md) for the project context and [`ROADMAP.md`](./ROADMAP.md) for the phased TODO.

## Session 86 — Stop ejecting PRs from trunk's merge queue (2026-08-19)

Talyn could read every state trunk publishes and still walk into the one thing trunk punishes: a push. A PR sitting in the queue would get a cloud fix run dispatched at it, the run's fix would land as a commit, and trunk would answer `🚫 This pull request was removed from the merge queue because it was pushed to by @x`. Talyn parsed that sentence perfectly — it just had no rule against causing it. The cost is a whole test cycle (~40 minutes at PostHog) plus the paid run that bought the ejection.

- **The trigger was the ordinary shape of a reviewed PR, not an edge case.** R5b let a "settled blocker" through the `awaiting_external` short-circuit on the theory that the provider would otherwise hold a broken PR forever. `prNeedsFollowup` counts an unresolved review thread, and bot reviewers leave those on nearly every PR, so the escape hatch was the common path. The premise was also wrong for trunk, which ejects a PR it cannot merge on its own (`waiting to become mergeable for too long … Submit it again once it's ready`) — and THAT is the moment remediation is both safe and useful. Hands off now while the provider is holding the PR, on `not_ready`/`queued`/`testing`/`passed` alike.
- **The stand-down is on OBSERVED holding, never on our own submission record.** With no answer from the provider, nothing says a queue is testing the PR, and parking on our own bookkeeping would strand a PR whose provider never comments. `stillSubmitted` keeps deciding that case exactly as before.
- **R5b only ever covered PRs TALYN submitted.** Every other route into the queue — the author commenting `/trunk merge`, a PR queued in Talyn after it was already submitted, a submit from the desktop merge button — left the entry in `queued` while trunk had the PR, and it walked straight into the rules that push and merge. **R5d** now states the rule on the provider's state instead of ours: if the queue is holding the PR, the entry belongs in `awaiting_external` whatever it currently says. It skips `blocked_manual` (which emits no actions anyway, and is meant to be sticky) and holds rather than parks while one of our own runs is mid-flight, since that run's push is already coming and R8's accounting lives below the rule.
- **Gated bases only, because trunk's labels outlive it.** `externalQueueOf` falls back to labels, and PostHog carries stale `trunk-testing` on PRs that merged hours ago; parking on one in a repo where trunk was switched off would wedge every entry with nothing left to un-wedge it. The executor's `externalStateMaxAge` now returns the 10-minute backstop for any entry on a gated base rather than `null` — R5d needs the comment channel's answer for entries that never submitted, and on a gated repo trunk comments on every PR, so the webhook feed almost always has it already.
- **The keep-mergeable watcher knew nothing about any of this.** It stood down on `mergeQueued`, which is TALYN's queue — a PR the author submitted to trunk themselves is not in it, so the watcher kept ticking every 60s and firing the same pushing run. It now checks the gate (cheap, cached, and what keeps every ordinary repo off the second call) and then the queue state, standing down only on the holding states. A read that fails answers "no": a queue we cannot see must never wedge the watcher.
- **A queue failure cost a whole extra queue cycle before Talyn did anything.** The ejection path only escalated to a fix run once the SAME ejection had been seen twice, so the first one resubmitted the identical commit. That is not one PR's CI: trunk batches, so a resubmit buys a batch re-test, a bisection to find this PR at fault again, another ejection, and every PR batched alongside it waiting through all of it. A `failed` state means the queue RAN the tests and this commit lost, so it is acted on the first time now. The other ejected states are untouched, because a "pushed to by @x" or a "waiting to become mergeable for too long" taught us nothing about the code. The flake is what this trades against and it is the cheaper side: a wasted cloud run is minutes, and `queueFailureRule` already tells the run to report that it found nothing rather than push a guess.
- **The run was told "it failed tests" and had to rediscover which check broke.** Trunk names the failing checks in a markdown table under the status sentence, or inside a link in the single-check shape, and `statusEvidence` keeps only the sentence — so both were parsed and dropped. `ExternalQueueStatus.failedChecks` carries them now, into the queue-failure prompt ("Start with those specific ones") and into `queueSignature`, where the same check failing twice is a dead end and a different check is progress.
- **The resubmit loop was unbounded in both of its bounds.** `queueSignature` hashed trunk's verbatim sentence, and trunk interpolates the pusher and the batch PR into exactly the two reasons that repeat (`pushed to by @dmarchuk`, `PR #84396 was used for testing`) — so two identical ejections read as two different reasons and the recurrence guard never once fired. Signatures now compare `externalQueueReason`, which strips `@handle` and `#nnn` and keeps the check name, since a different failing check IS a different problem. Behind it, `submitAttempts` had been counted since the day it shipped and never read: the `external_queue_rejected` doc promises a block "more times than the per-head budget allows" and the desktop renders `submits: n/3`, and neither had anything behind it. It is enforced now, and self-heals on a real push like every other per-head budget.

**Worth knowing.** The failure mode this trades into is a PR that parks in `awaiting_external` when no queue actually holds it, and that is the right direction — waiting costs latency, while pushing costs a test cycle and a paid run to destroy it. Every path into it is bounded: a holding reading needs positive evidence from the provider, the gate itself decays (Session 77), and the comment channel overrides a stale label the moment trunk speaks.

## Session 85 — Merge stack: drain a chain of dependent PRs (2026-08-19)

Landing a stack meant merging the bottom PR, waiting, retargeting the next one by hand, waiting for CI, merging, and repeating. The queue could not help, and the reason was structural: its serialization unit is `(repositoryId, baseBranch)`, and every PR in a stack targets a different base by definition. So each member was a group of one, each was simultaneously `isHead`, and nothing ordered them — a stack member merged into its parent's branch whenever it went green.

- **The gate is an unconditional decide rule (R4b), between the draft rule and the auto-merge rule.** It has to be, because the group walk gives no protection here: parent and child live in different groups, are walked by two independent (possibly cross-replica) evaluations, and `decideCleanPath` never reads `ctx.isHead`. Ordering within `decide` is load-bearing in both directions — below R0/R1/R3 so a child that merged, closed, or crashed mid-merge terminates rather than parks; above R5..R11 so a parked child never arms auto-merge, is submitted to trunk (which refuses stacks outright), fires a fix run, updates its branch, or merges. `awaiting_stack` also joins the auto-merge disarm invariant, and that is the case that actually bites: a parked child holding a Talyn arm gets merged by GitHub into its PARENT'S branch the moment checks pass.
- **The parent edge is derived, never persisted.** One query per group walk, because the group key IS the base branch, so every entry in a walk shares the answer (`services/mergeQueue/stack.ts`). A `parent_pull_request_id` column would have been the same class of unmaintained denormalization that let `base_branch` rot. Hop 1 is deliberately state-agnostic — a *merged* parent is exactly what triggers the retarget — while every hop above it follows open parents only, matching `linkStack`.
- **`base_branch` was rotting, and the feature depends on it.** It was written only at enqueue; nothing maintained it, despite a schema comment claiming the evaluator did. A retargeted PR was stranded in a group nothing walked, and its signing / external-gate probes ran against a base it no longer targeted. Every evaluation now reconciles it and BAILS — the whole decision context belongs to the base just left. Shipped first, on its own.
- **A successful retarget aborts the evaluation rather than redeciding.** `requiresSignedCommits`, `getExternalMergeGate` and `getAutoMergeCapability` were all probed against the old base, which is an unprotected feature branch; the base it moves TO is the real base, where those rules actually live. The retarget also writes the new base into the PR row's summary in the same breath — otherwise the entry and the row disagree until `refreshPr` lands, and the next evaluation's reconcile flips the entry straight back, a ping-pong that burns the retarget budget until the entry blocks.
- **Nothing scheduled a parked stack.** Every trigger a parked child has keys on the base it is parked on, which is the parent's HEAD branch, and the parent's own events are about a different `(repo, base)` pair. The snapshot event now carries `headBranch`, and a terminal snapshot schedules the group named by it.
- **`POST /:id/merge-queue/stack`** resolves the chain server-side from any member (a stale client can never enqueue an unrelated PR), root-first. Dequeue always cascades UPWARD — every descendant is parked on this PR. The free-plan gate is all-or-nothing under one advisory lock: a partial stack is not a degraded success, because the retarget of rung 4 only happens *because* rung 4 is in the queue, so it would stop halfway with nothing to say why.
- **Stack linking moved to `@talyn/shared`** (`linkStack`/`ancestorsOf`/`descendantsOf`), structurally typed so `shared` stays free of client types. It had lived only in the renderer, derived per render; a second copy in the backend would have diverged into "the UI says these are stacked but the queue doesn't". `buildStackedRows` keeps its own sorting and depth — that part is presentation — and its existing tests passing unchanged is the guard.
- **The wire addition is three things**: `awaiting_stack`, `stackParentNumber`, and `setMergeQueueStack`. Everything else a stack UI needs is derivable from the open rows the client already holds. The one thing derivation cannot give is the parent of a PR that has ALREADY been retargeted — its branch link is gone by definition — which is exactly what `stackParentNumber` is for.
- **The Merge Queue page groups by where a PR LANDS**, not by its own base. Only stacks care, and only because every member targets a different base: grouped naively a five-PR stack rendered as five sticky headers, each holding one row, each labelled `#1`. Extracted to a pure `queueGroups` module so that is a test rather than a bug report.

**Two things to know.** Default merge method is `squash`, so when a stack's root squash-lands the base gets one new commit while the child's branch still carries the parent's originals — `update_branch` then conflicts, or worse succeeds and re-shows the parent's changes in the child's diff. Talyn has no checkout and cannot rebase; the existing conflict → cloud-fix-run path can, and now gets an explicit rebase hint naming the parent and the new base. Defaulting stack enqueue to `method: 'merge'` would sidestep it entirely and is still open. Second: an N-deep stack pays N serial CI cycles by construction — on a repo with a ~40 minute cycle a four-deep stack is hours, which the queue header says out loud so it is not filed as a bug.

## Session 84 — Editable prompts: Settings → Instructions (2026-08-17)

A customer using auto-keep-mergeable reported that the run applied every bot review comment without pushback. Two things were true: the default prompt said "if the feedback is correct or reasonable, implement it" (an agent will almost never "disagree" unless told that is an expected outcome, and nothing distinguished Greptile from a human reviewer), and there was no way for a workspace to change any prompt Talyn builds.

- **Every prompt is now a template.** `packages/shared/src/promptTemplates.ts` holds the shipped defaults (`mergeable`, `skill`), the variable catalogue with legend text, a ten-line `{{name}}` renderer, and `validatePromptTemplate`. The dynamic and provider-specific pieces are variables (`{{gitRules}}`, `{{baseUpdateFlow}}`, `{{loopRules}}`, `{{issues}}`, `{{resignRule}}`, ...), so ONE template serves PostHog Code and Claude Code; `buildMergeablePrompt` / `buildSkillPrompt` just pick the variables per provider and render. Values are inserted once and never re-scanned, so a SKILL.md full of mustache renders untouched. Empty blocks (`resignRule` when nothing needs signing) vanish with their blank lines.
- **A workspace can replace a prompt wholesale.** `workspaces.settings.prompts.<kind> = { template, basedOnHash, updatedAt }`, no migration. The PATCH merges that key one level deeper (save or reset one kind without resending the others; `null` resets) and the merge runs in SQL (`settings || patch`, `jsonb_set` + `jsonb_strip_nulls` for the prompts level) so two overlapping PATCHes cannot clobber each other's keys, which the old read-then-write did. It validates on save (unknown variables, missing required ones such as `{{gitRules}}` and `{{pr.url}}`, size cap) and 400s. `basedOnHash` is the FNV hash of the default the user forked from: when the shipped default later changes, the UI says so instead of silently keeping them on stale text. Backend call sites (`startPrMergeableRun`, the auto-keep watcher, both merge-queue executors) read it via `services/promptTemplates.ts`; the desktop and web fix/skill buttons read it from the workspace already in the store.
- **Settings → Instructions** (desktop + web fork): a card per prompt with Default/Customized state and Reset, and an editor dialog with Edit / Preview / Default tabs. The variable legend is clickable and inserts at the caret (blocks land on their own line, `lib/promptEditor.ts`), shows which variables are in use, and marks required ones red when missing. Preview renders the template against a real tracked PR for either provider. "Copy into editor" on the Default tab is the "start from source" path.
- **The default step 1 changed too.** Bot and automated reviewers are advisory: verify the claim against the code, apply only real defects / security / correctness / clear convention violations, push back with a reason otherwise, never widen scope on a bot's say-so. Human reviewer feedback keeps priority.

Tests: `promptTemplates.test.ts` (renderer, validation, hash, overrides through both builders, the bot policy), `routes/workspaces.test.ts` (PATCH validation matrix, overlapping PATCHes), the override reaching the created task from every backend caller (`prAutoMergeWatcher.test.ts`, `prCloudFix.test.ts`, `mergeQueue/evaluator.test.ts`, `mergeQueueProcessor.test.ts`) and both front-end fix/skill buttons (`useGitHubActionsConnect.test.tsx`, `useGitHubActionsPrompts.test.tsx`), `InstructionsSettings.test.tsx` + `promptEditor.test.ts` in both front ends.

## Session 83 — Label watched PRs (2026-08-17)

Some orgs run a bot that reviews and stamps a PR once it carries a label. Talyn now adds a workspace-configured set of GitHub labels to every PR the auto-keep-mergeable watcher is watching, so that bot picks up exactly the PRs Talyn is driving. Setting: `workspace.settings.autoKeepMergeableLabels` (a `string[]`; the Settings card takes a comma-separated field under "Auto-keep new PRs mergeable" in both renderers, parsed by the shared `parseAutoKeepMergeableLabels`, deduped case-insensitively since GitHub label names are).

The labels are applied inside the watcher tick (`prAutoMergeWatcher.ts` `ensureLabels`), not at arm time. One place covers every way a PR becomes watched (the toggle route, the workspace default on first sighting) and it also backfills PRs that were already watched when the setting was filled in, and picks up a label added to the list later. The watcher records what it has applied in `autoMergeState.appliedLabels` and adds only the diff (compared ignoring case, since GitHub label names are), so a label the user removes from the setting stays on the PR: Talyn never removes labels, since the bot may already have acted on them. Cost is one settings read per workspace per tick and one `addPullRequestLabels` per PR that is missing something.

Failure is best-effort and bounded: a refused write (typically the App lacking `issues: write`) is logged, nothing is recorded, and that repo is skipped for 15 minutes so a permission problem doesn't cost a GitHub call per watched PR per minute. Re-arming a PR resets its state and re-applies the labels, which is idempotent on GitHub's side.

Tests: `prAutoMergeWatcher.test.ts` ("watch labels": the diff matrix incl. partial application and casing changes, labelling while a run is in flight, backoff on refusal and its expiry, per-workspace lists in one tick, malformed stored state), `autoKeepMergeableLabels.test.ts` (the parser and the stored-value normalizer) and `autoKeepMergeableLabelsField.test.tsx` in both renderers (commit on blur/Enter, no-op when unchanged, clear sends `[]`, failed save toasts and resets).

## Session 82 — Mermaid diagrams in PR descriptions (2026-08-13)

GitHub renders a ```` ```mermaid ```` fence as a diagram. Our PR detail sheet showed the source as a code block, so any PR that explains itself with a picture arrived as unreadable text. The fix is in `lib/markdown.tsx` (both forks), so the agent transcript and the review bodies get it too.

Three decisions worth keeping:

- **The swap happens at the `<pre>`, not the `<code>`.** react-markdown gives a fence as `<pre><code class="language-mermaid">`. If you intercept the inner `<code>`, the diagram stays trapped in a monospace, pre-wrapped box. `mermaidSourceFromPre` reads the child element's class and returns the source, or null for every other fence. The class test is anchored (`(^|\s)language-mermaid(\s|$)`), so `language-mermaidish` is still a code block.
- **mermaid is loaded on demand.** It is megabytes of JavaScript, and most PR bodies hold no diagram. `lib/mermaid.tsx` imports it dynamically and caches the module promise. Verified in both builds: the Vite entry chunk contains no reference to mermaid, and the webpack renderer keeps it in split chunks. It also loads under the app CSP (`script-src 'self'`, no `unsafe-eval`) — checked in a real browser, because jsdom cannot run mermaid at all (no `getBBox`).
- **`securityLevel: 'strict'` is what replaces the sanitizer.** Diagram source is untrusted: anyone who can open a PR against a watched repo controls the string. The SVG goes in with `dangerouslySetInnerHTML`, which walks straight past the `rehypeSanitize` pass that `markdownSanitize.test.tsx` pins. Strict mode runs mermaid's own DOMPurify over the output and turns off HTML labels and `click` directives. mermaid's `secure` list stops a `%%{init: …}%%` directive in the source from lowering it. Both test suites assert the setting, so a later "the diagram would look nicer with `loose`" has to argue with a red test.

Failures are shown, not swallowed. A diagram that does not parse renders the reason and its source, so the body still reads the way it does on GitHub minus the picture. `suppressErrorRendering` stops mermaid appending its own error SVG to `<body>`, outside React's tree, where nothing would ever clean it up. The theme follows the app: a `MutationObserver` on the `dark` class re-renders on a theme flip, and the always-dark agent feed pins the dark mermaid theme whatever the app theme is.

Tests: `apps/desktop/src/__tests__/mermaid.test.tsx` (18 cases, mermaid stubbed — it is ESM and jest transforms to CommonJS) and `apps/web/src/__tests__/markdownMermaid.test.tsx` (5 cases through the real markdown pipeline).

## Session 81 — Connect with PostHog: OAuth alongside the pasted API key (2026-08-06)

Connecting PostHog Code asked the user for two things they shouldn't have to handle: a **personal API key**, pasted into our window, and a **project (team) id** they had to go and find. PostHog has been a full OAuth2/OIDC authorization server for a while, its tasks API accepts `pha_` bearer tokens with exactly the same scope and per-team enforcement as a personal key (`posthog/permissions.py` branches on neither), and it supports **CIMD** — so the `client_id` is a document we host at `https://www.talyn.dev/oauth-client` and there is nothing to register and no client secret to obtain. Talyn is a public client; PKCE is the protection, which PostHog requires of every client anyway.

**Nobody is migrated.** An existing install is on `authMethod: 'personal_api_key'` — or has no `authMethod` at all, which reads as the same thing, and that's the shape every pre-OAuth row has — and keeps its card, its Edit button, and its key. New connections lead with OAuth, with "use a personal API key" one click away, and it stays the only option on a deployment without `POSTHOG_OAUTH_*` set (self-hosted, local dev). The pair is all-or-nothing, the `POLAR_*` pattern: absent means the flow isn't offered anywhere, which is also the kill switch.

**The project id stops being a form field.** `required_access_level=project` makes PostHog's consent screen render its single-project picker, and self-introspection (RFC 7662 — allowed with no `introspection` scope when a token introspects itself) reports the choice back as `scoped_teams`. So the project is a property of the grant. A grant covering a whole organization, or several projects, is **refused at connect time with a message** rather than resolved by picking the first one: filing every future task into the wrong project silently is worse than one clear error, and the scope ask stays at `openid task:read task:write` as a result.

**The real work was the token lifecycle, not the flow.** PostHog issues 1-hour access tokens and 30-day refresh tokens, rotates the refresh token on every use, and enforces reuse protection with a 120-second grace — after which presenting a spent refresh token revokes *the whole token family*. Talyn calls this API from a poll loop, a streamer and the dispatcher, across two instances during every deploy. So the naive version doesn't fail a request; it logs a workspace out of a connection nobody touched. Refreshes are single-flighted twice: an in-process promise map collapses the many-callers-one-instance case with no round-trip, and a **blocking** advisory lock (`posthog-oauth-refresh:<ws>`) covers the deploy overlap — blocking rather than try-lock because the loser must *wait and re-read the rotated pair*, not skip and reuse a spent one. `invalid_grant` is terminal and sets `oauth.reauthRequiredAt` on the row so every surface says "Reconnect needed" and nothing retries a grant that can't come back; a 5xx explicitly does not set it, or a PostHog blip would tell every workspace to reconnect.

**PKCE states live in Postgres** (migration `0040`), not in the process-local Map the older GitHub App flow uses. A lost GitHub state costs a re-click; a lost state here loses the `code_verifier`, which is the thing that makes the returned code redeemable — and a callback landing on the instance that didn't mint it is not hypothetical, it's every deploy. Single-use by construction: the lookup is a `DELETE … RETURNING`, so a replay finds nothing.

Two smaller things worth remembering:

- **The web app must navigate the current tab, not open one.** `lib/openExternal`'s own docs say it: `window.open` is granted only while user activation is live, and awaiting the authorize URL spends it, so a popup would be silently blocked on the Settings screen. The desktop opens the system browser (the user's PostHog session is there) and picks the result up on window focus — which meant `useSystemStatus` had to start re-checking PostHog on focus at all, since until now those credentials could only change from inside the app.
- Switching auth methods **drops the other method's stored credential**. Connecting via OAuth clears `apiKeyEnc`, and saving a key clears the tokens. A leftover encrypted key that a revoked OAuth grant could silently fall back to is a credential the user believes they replaced.

Tests: `posthogOauth.test.ts` (30 cases — PKCE derivation, single-use state, the exchange body, project resolution and its two refusals, the refresh path, the concurrent-refresh collapse, terminal-vs-transient failure, and both legacy row shapes resolving as personal-API-key). See [`docs/CLOUD_PROVIDERS.md`](./CLOUD_PROVIDERS.md) for the module map and [`docs/SETUP.md`](./SETUP.md) §6b for the env pair and the three ways to misconfigure it.

## Session 80 — admin.talyn.dev: the operator console (2026-08-04)

The Debug panel was streaming backend internals **across every account** from inside both customer-facing apps, behind a Settings toggle, maintained in two byte-identical copies. Meanwhile the fleet — hosts, microVMs, goldens — was invisible from the product: `fleetd` binds loopback and is only reachable over the tailnet, and the one endpoint we exposed (`GET /fleet/hosts`) was rendered by nothing. Both problems have the same answer, which is a third browser app that is not the product.

`apps/admin` is a fork of `apps/web`, deployed to **admin.talyn.dev**, gated on the `is_admin` boolean that already existed. It holds fleet operations, cross-tenant product admin, the audit trail, and the Debug panel — which was **moved, not copied**: a zero-diff `git mv`, because its three relative imports resolve unchanged at the destination and a pure rename is reviewable as a move.

**The read surface degrades; the write surface does not.** This is the one decision everything else follows from. The fleet page is the page you open *because* a host is misbehaving, so every read goes through a `probe()` that cannot throw — an unreachable box renders as a row with a reason, and one dead host never takes out a healthy one. Mutations are the deliberate exception: an unreachable drain is a 502, because "the drain probably worked" is how a box stays live through an incident somebody believes they drained. A **stale host is never dialled at all** — registration does not imply reachability, so there is no point burning the timeout to learn what the registry already said.

**The recurring failure mode this console had to design against is an unknown value rendered as a definite one.** A host that never reported a memory budget must not read as 100% full, because the response to that is draining a healthy box. `runsMax: 0` is unknown, not zero-capacity. A Go zero-value timestamp is "never", not 01/01/0001. An empty table and a failed request must never look the same — "no hosts have reported" is a fact about the fleet, "we couldn't reach the backend" is a fact about us, and an operator may go and restart something on the strength of confusing them. That is `offlineBanner.test.tsx`'s lesson with much higher stakes, and it recurs at three layers: the access gate, the query hook, and every table.

**Mutations are a stack of small specific refusals, not a permission model.** There is one operator, so a roles table would be a model nobody administers. Instead: a reason (persisted verbatim — a gate that drops the value is theatre), a self-mutation guard, confirm-by-typing-the-target's-email, a last-admin check inside the transaction, and `TALYN_ADMIN_GRANT_ENABLED` defaulting to **off** so a stolen operator session can read and comp — bad, but auditable and reversible — and cannot mint a second operator. Guard *order* is load-bearing and tested: exists → not-self → deploy-permits → confirm, because checking confirm first lets someone probe for accounts by watching which error came back.

The audit log (`admin_audit_log`, migration 0039) has two write shapes because the two side effects have different rollback stories. A remote call cannot be rolled back, so the row is written as `pending` **before** dialling and settled after — if the backend dies mid-call the trail still says "we were about to drain hetzner-64", which is the only question anyone asks afterwards. A local mutation commits with its audit row or not at all. No FK on `actor_id` and a denormalised `actor_email`, so the trail outlives an account wipe and still names a person.

**One read is audited**: fetching another tenant's task transcript, which is behind a click rather than loaded with the page. Auto-fetching would fill the log with accesses nobody chose to make and bury the ones somebody did.

Two things surfaced that nothing had ever shown before. **Orphan runs** — a microVM live on a host with no task behind it — are invisible from either side alone, because the fleet's run store is in-memory and dies with the process while a task row cannot see a run we never recorded. And `FleetClient` had been recording **nothing** to the debug bus, a gap only visible once something made fleet calls per pageview.

Also fixed in passing: `routes/debug.ts`'s category allowlist omitted `db` and `webhook` while the panel had chips for both, so clicking either silently returned the *unfiltered* stream.

Left deliberately undone: `fleet_hosts` holds one snapshot per host, not a time series, so the incidents page reports counters cumulative since each host's last `fleetd` start rather than a rate. The page says so. A real trend needs either Prometheus scraping `/metrics` over the tailnet or an append-only samples table, and neither is worth it for one box.

## Session 79 — The self-hosted fleet becomes reachable (2026-07-31)

The `selfhosted` provider merged in #22 was **dead code**: `packages/backend/src/index.ts` registered only PostHog Code and Claude Code, so `getCloudProvider('selfhosted')` returned null and no dispatch path could reach it. It is now registered behind `FLEET_ENABLED`.

**Unregistered is a stronger off than a runtime branch.** With the flag unset the provider is absent from the registry entirely — nothing behaves differently from before, and the failure mode of forgetting the flag is "the feature is missing", not "a task went somewhere unexpected". A workspace also needs fleet credentials configured before the provider accepts anything, so the flag alone changes nothing for any existing workspace. `fleetRegistration.test.ts` pins the gate, which is otherwise a single `if` in boot code that nothing covers — exactly the shape that gets dropped in a refactor and noticed in production.

**The GitHub token wiring was already done** — #22 fetches it fresh per dispatch via `githubService.getAccessToken` and sends it in the run payload. It goes backend → fleetd only; the fleet's credential proxy injects it host-side and it never enters the microVM. Checked that `getAccessToken` is synchronous, because an un-awaited promise there would have serialized as `{}` and failed as an auth error rather than a type error.

On the fleet side (`Gilbert09/talyn-fleet`), the credential proxy's `/ghapi` route had been attaching that token to **any** `api.github.com` path. Per-run socket isolation meant an agent could not reach another run's credentials, but it could spend its own on merging a PR, dispatching a workflow, editing repo settings, or installing a webhook or deploy key. It is now bounded twice — an allowlist of the endpoints the three task types need, and the repo the run was dispatched for — both checked before the credential is attached, so a refused call never spends the token.

That is the sixth bug this project has had of one shape: **a check that passed every time anyone looked at it and was wrong anyway.** Teardown that could not detect a leaked VM, wedge detection that killed healthy runs, a deploy check verifying a previous generation's image. `talyn-fleet/docs/HANDOFF.md` now leads with that pattern, because the instruction it implies — write the test that proves your check can *fail* — is the most transferable thing the project has produced.

## Session 78 — The web app ships, and the analytics that were lying about it (2026-07-31)

`apps/web` went from the Session 76 placeholder to **live at app.talyn.dev**: panels ported, Vercel project created, `deploy-app.yml` green. The Vercel secrets were renamed along the way — `*_WEB` is the marketing site, `*_APP` is the application — because the two had been sharing `VERCEL_PROJECT_ID` and a mis-sequenced rename would have deployed the app over www.talyn.dev.

Most of the session's bugs were things that compiled, typechecked, and passed tests while being **wrong in a browser**, which is the failure mode a fork invites:

- **`usePanelUrlSync` raced itself.** Two effects, one commit, the same stale snapshot — clicking Merge Queue landed you on My PRs. Rewritten as a single effect that compares against `last.current` to decide *which side* changed. (The mutation test for this hung vitest in an infinite loop, which is its own kind of proof.)
- **`window.open` after an `await` is a popup block.** The GitHub App install flow now opens the tab synchronously and assigns `location.href` once the URL resolves.
- **`??` doesn't fall through on empty strings**, so a blank env var shipped `app_version: "web/"`. Build SHA resolution now filters on non-blank.
- **Dev CSP was missing `127.0.0.1`** (it had `localhost`), so the app hung on the boot screen behind an opaque "Failed to fetch".
- **The nightly was broken by the `@talyn/client` split** — `nightly.yml` and `publish.yml` built `@talyn/shared` but not the new package. The nightly caught it; the next stable release would have hit the same wall.

**PostHog identity needed web-specific handling, twice.** The desktop detects a fresh login by watching `userId` go null → set, which works because its OAuth runs in the system browser and the app never reloads. On web the redirect is a full page navigation that destroys exactly that transition, so `logged_in` was never captured at all — now a `talyn:pending-login` sessionStorage marker survives the hop. Separately, the identify effect also runs before auth resolves; treating "not known yet" as "signed out" meant `posthog.reset()` on **every page load**, churning the anonymous `distinct_id` and starting a fresh replay session each time.

**"We can't reach the backend" was being reported as "GitHub OAuth isn't configured."** `useGithubConnection` caught every failure — including *there is no network* — and recorded `{ configured: false }`, which the banner renders as an alarming, actionable-looking, and entirely wrong instruction to go set `GITHUB_CLIENT_ID`. A transport failure means we never got an answer; it is not an answer. `ApiNetworkError` now short-circuits to an offline banner and the GitHub rows are suppressed rather than shown stale. Fixed on both clients.

**The merge queue never told analytics it merged anything.** Chasing "the PR merged tile shows nothing merged, which isn't true" found the tile was reporting its event honestly — `pr_merged` fired *only* from the desktop/web merge button, so every merge the queue performed, the product's headline feature, was invisible. 19 events in 30 days, most days literally `0`. The executor now captures it, both paths carry a `source` property (`merge_queue` | `manual`), and the tile that hid the remaining signal under a shared linear axis (merges 1–8/day against fix runs up to 99/day) got dual Y axes. Desktop events also now carry `client: 'desktop'` to match the web app's `client: 'web'` — without it a client breakdown reads "web vs blank" and every desktop event stays unattributed.

## Session 77 — The external merge gate decays instead of needing a restart (2026-07-30)

trunk.io was switched off for `posthog/posthog` and the queue kept submitting PRs to a merge system that no longer existed. The cause was one line of ranking in `repoMergeGate.ts`: `if (cached?.confirmed) return 'confirmed'` sat *above* the TTL check, so a gate learned from an observed 405/403 was sticky for the life of the process. `clearExternalMergeGate()` existed for exactly this case but was unreachable — it only fires after a **successful direct merge**, and a confirmed gate never attempts one (`decideCleanPath` routes straight to `submit_external`). The only cure was a Railway redeploy.

**Every reading now expires and must re-earn itself from a fresh probe**, decaying one confidence level at a time: `confirmed` → (probe finds no rule) → `suspected` → (probe finds no rule) → `null`, with any observed refusal jumping straight back to `confirmed`. `PROBE_TTL_MS` / `CONFIRMED_TTL_MS` are 5min (down from a 1h TTL that `confirmed` ignored anyway); the submit-label cache keeps its own 1h constant, since repo labels are not what goes stale here.

The step down to `suspected` rather than straight to `null` is load-bearing. The probe hits `/repos/{o}/{r}/rules/branches/{b}`, which reports **rulesets only** — a classic protected branch, or a repo whose rulesets the App can't read, gates merges while probing clean. Dropping to `null` on that evidence would resume doomed merges every window. `suspected` is the right landing spot: it lets the queue try exactly one direct merge, which either lands the PR (firing the clear path that was previously unreachable) or re-confirms the gate. A probe that *throws* never decays anything — a failed call is not evidence.

Worst case is now ~10min to fully un-gate a branch with no restart, and usually faster: the first `suspected` evaluation merges and clears it outright.

**Still manual after the gate clears**: entries already parked in `awaiting_external` via the `comment` door land in `blocked_manual` ("the external merge queue never picked up the submit command") once the pickup grace expires, and R5c only un-sticks an `external_gate` block when the provider is seen *actively holding* the PR — which a switched-off queue never will. Those need a re-queue (`SELECT * FROM merge_queue_entries WHERE status='awaiting_external' OR blocked_code='external_gate'`). **Related sharp edge, not fixed here**: door 1 of the submit ladder is the provider's instruction comment *on the PR*, and those comments outlive the queue — so a `suspected` gate on a repo with stale trunk comments can still post a dead `/trunk merge` instead of falling through to the merge.

Tests: `externalMergeQueue.test.ts` gains a `gate decay` block on fake timers covering the full ladder, the still-gated hold, mid-decay re-confirmation, suspected→null on its own, and the failed-probe hold.

## Session 76 — Groundwork for a browser app (app.talyn.dev) + cross-platform desktop (2026-07-29)

Scoping "what would it take to run Talyn in a browser" turned up a stronger reason to do it than the browser itself: **`publish.yml` ran on `macos-latest` only**, and marketing's download button resolved a `.dmg` and nothing else — so Windows and Linux users could not use Talyn at all. Four preparatory pushes; the `apps/web` fork itself is not started.

**The paywall was opt-in and nobody knew.** `routes/tasks.ts` keyed its exemption off a *missing* `X-Talyn-Client-Version` ("legacy client, can't render the upgrade flow"). The desktop renderer is the only sender in the repo, so `packages/cli`, `packages/mcp-server`, and plain `curl` bypassed both the 3-active-task limit and the 3-PR merge-queue cap. Silently: no error, no log, no metric, and no `UpgradeModal`, so the funnel read as "these users just don't convert". `POST /pull-requests/:id/merge-queue` was worse — its `else` branch called `armQueue()` with no gate at all, uncapping a subsystem that spends cloud-provider tokens per fix attempt. New `services/billing/clientGate.ts` is **fail-closed**: exempt only for a bare `X.Y.Z` below that gate's floor (`0.2.3` tasks / `0.2.9` merge queue — the releases that shipped each paywall UI, so a v0.2.5 build correctly renders a task 402 but not a merge-queue one). Missing, `dev`, junk, and the namespaced `web/<sha>` form all enforce. Every exemption fires a `billing_paywall_bypassed` PostHog event, so the "remove once clients have aged out" note is finally measurable. **The CLI and MCP server are now enforced** — they surface the 402's human-readable message.

**Windows + Linux desktop builds.** `electron-builder` had declared `win: [nsis]` and `linux: [AppImage]` all along. Both `publish.yml` and `nightly.yml` now share one job shape: a `version` job resolves the version ONCE and fans it out (three legs each computing "next patch above the latest release" would race), then the **macOS leg runs alone** because it creates the Release and the tag, and only then does a `windows-latest`/`ubuntu-latest` matrix upload into it. The chaining is load-bearing — parallel races three electron-builder processes to create the same release, and `needs:` means a Windows failure can't take down a macOS release that already published. Nightly gets the other platforms too: the channel picker maps to `allowPrerelease`, so a nightly-channel Windows user with no Windows asset gets a *broken* updater, not a skipped one. **Windows ships unsigned** (SmartScreen warns) pending an EV cert. Marketing's `DownloadButton` sniffs the OS after mount — never during render, the server has no `navigator` — and CTA copy carries a `{platform}` token so the voice stays in `lib/content.ts` while the OS name stays a runtime fact.

**`packages/client`.** `lib/api.ts` was 1,132 lines of backend contract living inside the Electron app; a second front end would have forked it, and two copies drift. Moved to `@talyn/client`, with hosts calling `configureApiClient({ baseUrl, clientVersion, getAccessToken, recoverSession })` — the refresh-stampede dedupe stays in the package (transport concern), the "is this session really dead?" judgement stays with the host (only it knows its auth provider). The desktop's `lib/api.ts` is now ~50 lines of glue plus `export * from '@talyn/client'`, so all ~40 importers were untouched and git scored it as a rename. Also fixed the WS for backgrounded tabs, which a minimised desktop window needs too: `bindLifecycle` gained `visibilitychange` + `pageshow`, and waking on an apparently-`OPEN` socket now pings instead of returning early (after a freeze, "open" is exactly what a half-open socket looks like). Browsers throttle hidden-tab `setInterval` to ~1/min and freeze it for a bfcached page, so the 25s heartbeat *cannot* keep a background socket honest — accept the drop, make the return fast.

**Browser-origin surface** (inert until `app.talyn.dev` exists). `services/originPolicy.ts` extracts the CORS/WS allowlist out of `index.ts` so it's testable without booting the server — **exact string match, never a pattern**, since a prefix rule is how `https://app.talyn.dev.evil.com` gets in. A rejected origin now denies by omitting the header (`cb(null, false)`) rather than throwing a **500** that read as "the backend is broken"; `credentials: false` (Bearer-only API — makes CSRF-immunity structural); `maxAge: 86400`, because the non-safelisted client-version header preflights *every* request. The `null`-origin concession for the packaged renderer's `file://` handshake is forgeable by any page via a sandboxed iframe — harmless while WS auth is a first-frame Bearer JWT, a live cross-site hijack the day anything moves to cookies — so it now sits behind `TALYN_ALLOW_NULL_ORIGIN_WS`. `services/webApp.ts` owns `WEB_APP_URL` (env-only, boot-validated, https-or-localhost); `webAppUrl()` refuses any path that isn't single-slash-relative, because it is the GitHub App callback's redirect target and an open redirect there turns a login flow into a phishing hop. That callback now ends per-client — browser → 302 to `/settings?github=…`, desktop → the close-this-tab page — decided by the Origin recorded server-side when the state was minted, never by a request parameter.

**Also added a per-USER rate limit** after `requireAuth`. IP-keying alone gets both directions wrong once a browser client exists: an office behind one NAT egress shares a bucket it didn't individually fill, while a runaway user on a home connection never touches it. The per-IP ceiling was deliberately **not** raised — it bounds unauthenticated work, and the expensive path it guards is the legacy HS256 branch in `verifyTokenAndGetUser`, which makes an outbound Supabase call per attempt.

**The spike, and what it changed.** Before forking anything, a throwaway Vite app ran the **real** `@talyn/client` (aliased to its source) in Chrome against the local stack. Three results, two of which contradicted the plan:

- **OAuth without a popup: PASS.** Full-page `signInWithOAuth` (no `skipBrowserRedirect`) + `detectSessionInUrl: true` → `provider: github`, PKCE verifier in localStorage, `window.opener === null`, `?code=` consumed and stripped. The desktop's `openExternal(data.url)` fires after two `await`s, so its `window.open` fallback has lost user activation and is popup-blocked — silently, on the sign-in screen.
- **`define` of `process.env.*` does NOT work in Vite dev.** Vite's entries are *"defined as globals during dev and statically replaced during build"*, so the plan's "mirror webpack's EnvironmentPlugin" approach serves the dev browser an unsubstituted expression that throws on the missing `process`. `apps/web` uses `import.meta.env.VITE_*`.
- **Background-tab WebSocket: PASS, ~13 minutes hidden, zero drops**, client and server agreeing (no reconnect logged, backend's last WS event is `connected`, one `ESTABLISHED` socket throughout). The feared false-positive — a throttled heartbeat tripping `awaitingPong` and forcing reconnect churn — did not occur; a throttled tick still sends its ping and still clears on the pong. The recovery-on-wake path added to `packages/client` was therefore **not exercised**; it stays in as defence for sleep/bfcache but is unproven.

**`apps/web` scaffolded.** Workspace member (unlike `apps/marketing`), Vite + React 19, BrowserRouter with real panel URLs, browser PKCE `AuthProvider`, `/login` + `/auth/callback`, CSP as a `vercel.json` response header, `deploy-web.yml` (guarded to skip until `VERCEL_PROJECT_ID_WEB` exists — a **different** Vercel project from marketing's, or a push would overwrite www.talyn.dev). `routes/Shell.tsx` is a placeholder proving session → REST → WS end-to-end; the panels themselves are still to be ported. Per Tom's call this is a deliberate **fork** of the desktop renderer — features get built twice — but the backend contract is not forked: both import `@talyn/client`.

`packages/client` now ships **dual-format**. Rollup can't statically see the re-exports `tsc`'s CJS output emits as `Object.defineProperty(exports, …)` getters (Vite: *"configureApiClient is not exported"*), while the desktop's jest suite still needs CJS — so `dist/cjs` + `dist/esm` behind an `exports` map, with a one-key `package.json` in each so Node doesn't misparse the ESM output.

**Still open**: porting the panels (~18k LOC), and creating the Vercel project. See [`docs/ROADMAP.md`](./ROADMAP.md).

## Session 75 — Read trunk's state off its COMMENT, not its labels (2026-07-29)

Same day as Session 74, from live use: seven PostHog PRs sat in the merge queue reading **"Needs you — Talyn posted the merge queue's own submit command and the queue never picked it up"**, while trunk was demonstrably testing every one of them (#74552's `/trunk merge` from `talyn-app[bot]` even carried a 👍 from trunk).

**Root cause: the label channel is not the signal.** Session 74 read trunk's state exclusively from labels (`trunk-queued` / `trunk-testing` / …), which are optional in trunk's configuration. On posthog/posthog:

- #74552 ran a full trunk test cycle with **no queue label ever applied** (its whole `labeled` timeline is one `stamphog`), and 6 sibling PRs were the same.
- PRs merged hours earlier still carried a stale `trunk-testing`.

So "no label" was read as "trunk ignored our comment", and `decide` blocked the entry (`blocked_manual`/`external_gate`) after the 10-minute grace window — sticky until a push or a requeue.

**The reliable channel is trunk's own PR comment**, which it keeps as ONE comment and **edits in place** through the lifecycle. Captured verbatim off 100 recent PRs: instruction + submit checkbox → `✨ Submitted to Merge by @x` → `⏳ Waiting to start tests` → `🧪 Running tests on this pull request (testing on PR #x)` → `👍 will be merged soon because tests have passed` → `😎 Merged successfully`, with `🚫 removed from the merge queue because it was pushed to by @x`, `❌ could not start testing because there was a merge conflict`, and `⚠️ The required check … has failed` for the failure paths. Crucially, every edit is an `issue_comment` webhook — an event Talyn already processes — so the state arrives **free and in real time**.

- **Parser** — `packages/shared/src/externalMergeQueue.ts`: `externalQueueStatusFromComment(s)` maps those bodies to `ExternalQueueState`, with the submit checkbox (`- [x]` / `- [ ]` between trunk's `Start/End PR Submit Checkbox` markers) as the fallback when there's no status line. Two new states: **`not_submitted`** (the box is untouched — trunk genuinely does NOT have the PR, the only honest basis for the "never picked it up" block) and **`rejected`** (trunk says it *cannot* merge this PR — e.g. a stacked PR — which no fix run or resubmit can move, so it blocks manually). `ExternalQueueStatus.label` became `source` + `evidence`, so a tooltip can quote trunk's own sentence. Identification is deliberately narrow: trunk's *other* comment (Test Analytics) is by the same bot, on the same host, and full of the word "failed" — only the `/merge-queue/` link path and the markers tell them apart.
- **State cache** — `services/externalQueueState.ts`: webhook-fed (`webhookWorker` hands every `issue_comment` body to it) with a REST backstop for a cold cache. The merge-queue executor asks for it only when a gate exists AND the entry's fate depends on the answer, with a staleness bound matched to how fast the answer can change (`externalStateMaxAge`): 60s while waiting for trunk to say anything at all, 10min once it IS working the PR (that's purely a missed-delivery backstop). In practice this costs ~0 extra GitHub calls.
- **`decide`** — the comment channel now outranks labels everywhere (`externalQueueOf(pr, ctx)`). "Not picked up" requires the provider *saying* so past the grace window, rather than the absence of a label. New **R5c**: an entry blocked on the external queue that is now *observed* being held by it (`isExternalQueueHolding`) goes straight back to `awaiting_external` — which is what un-stuck the seven live PRs on deploy, with no requeue.
- **Persisted state** — `merge_queue_entries.external_state` / `external_state_at` (migration `0037`), written whenever the provider's state MOVES. Drives the entry timeline, survives a restart, and reaches the desktop as `mergeQueue.external.state` so the queue cell renders "Queue: testing" on a PR with no labels at all. `PRStatusPill` and `isReadyToMerge` prefer it over labels too.
- **Latent bug found by the same corpus**: `externalQueueInstructionFromComments` required trunk's `<!-- Trunk Merge -->` marker, which trunk DROPS once it rewrites the comment — including in the post-ejection body that re-offers `/trunk merge`. Door 1 was therefore unavailable on exactly the resubmit path the queue exists for; it now identifies the comment structurally.

Tests: 40 new cases pinned to the verbatim trunk bodies (`externalMergeQueue.test.ts`), `externalQueueState.test.ts` (cache/backstop/staleness policy), 11 new `decide.test.ts` cases for the comment channel + self-heal, and a `webhookWorker.test.ts` case proving a comment edit populates the cache with no GitHub call.

## Session 74 — External merge queues: submit to trunk.io instead of failing (2026-07-29)

posthog/posthog moved `master` behind **Trunk Merge Queue**. A repo-level ruleset ("Trunk merge", active since 2026-07-22, enforcement flipped 07-28) adds `update`/`creation`/`deletion`/`non_fast_forward` rules to the default branch and exempts **only three GitHub Apps** (trunk-io is 120106); `current_user_can_bypass: never`. So Talyn's merge PUT 405s with "Cannot update this protected ref" — for every PR, forever.

Session 71's `external_gate` terminal block (added a week earlier) stopped the doomed retry loop but left every queued PostHog PR parked in `blocked_manual`. This session makes the queue **do the valuable half**: get the PR green, then hand it to the system that owns the branch, track it there, and take it back if it's ejected.

**How PostHog's PRs actually reach trunk** (verified off PR #74353's timeline): the author enables GitHub's native **auto-merge**, and ~30s later `trunk-io[bot]` labels the PR `trunk-not-ready` → `trunk-queued` → `trunk-testing` → `trunk-tests-passed` → merges it (42 min end to end). Labels are the *only* channel trunk reports on; there is no API.

- **Detect the gate** — `services/repoMergeGate.ts`. `'suspected'` from a cheap REST branch-rules probe (`GET /repos/{o}/{r}/rules/branches/{b}`, no admin scope, no GraphQL points, cached 1h): it sees an `update` rule but *not* bypass actors, so it can't tell "gated" from "we're exempt". `'confirmed'` is learned from an observed 405 and is sticky for the process (peer of `repoSigning.ts`'s `markSigningRequired`). Only a confirmed gate skips the direct merge; a suspected one still tries it once and lets the answer settle it. A merge that succeeds clears the mark.
- **Submit instead of merge** — `services/externalQueueSubmit.ts`, shared by the pipeline and the desktop Merge button. Door 1: arm GitHub auto-merge (what PostHog humans do; no new App permission). Door 2: apply the repo's submit label (`trunk-merge-queue-submit` / `trunk-merge`, only if the repo defines it). Door 2 is **not optional** — GitHub refuses to arm auto-merge on a PR that is already immediately mergeable ("clean status"), which is exactly the state a gated PR reaches once its checks pass, so without it the readiest PRs would be the unsubmittable ones. Needs the App's `issues: write`.
- **Track + recover** — new entry status `awaiting_external` (+ `submit_attempts` / `external_submit_via` columns, migration `0035`). `decide` R5b waits while trunk reports a live state, still remediates a settled blocker underneath it (trunk holds a conflicting PR at "not ready" forever), and on **ejection** (`trunk-failed` / `trunk-pending-failure`) requeues → fixes → resubmits, bounded by a per-head submit budget that self-heals on a new push. `trunk-cancelled` is deliberately terminal (`blocked/external_queue_rejected`) — someone pulled the PR out on purpose. A Talyn-armed auto-merge is always disarmed on the way into a blocked state, so a rejected PR can't quietly re-enter the queue.
- **No double queueing** — a gated (repo, base) group is always evaluated **eagerly**, whatever the workspace's `mergeQueueMode`: trunk batches and orders merges itself, so serializing behind our own head would add its whole ~40min cycle to every PR in the group.
- **Labels are now tracked** — added to the PR GraphQL selection, `PRMergeableSummary`, and `summaryToJsonb`; the `pull_request.labeled/unlabeled` webhook patches them straight from the payload (no GitHub fetch) and emits `pr:snapshot`, which is what drives the queue's reactivity. Shared vocabulary + mapping live in `packages/shared/src/externalMergeQueue.ts`.
- **Desktop** — the Merge button submits and toasts "Submitted … to the merge queue" (the route answers `{ merged: false, submitted: true }`); the queue cell renders "Queue: testing" etc.; `PRStatusPill` shows the provider's state on any PR carrying its labels, ranked above every open-state verdict ("Ready" is a lie on a branch only trunk can merge).

Tests: `externalMergeQueue.test.ts` (label vocabulary incl. `(bisection)` variants, gate probe, submit ladder), 30 new `decide.test.ts` cases, 8 pipeline cases in `mergeQueue/evaluator.test.ts`, rewritten webhook label cases. **Not** ported to the dormant v1 processor — it stays the rollback target as-is, so a `settings.merge_queue_engine = 'v1'` rollback also reverts to "can't merge PostHog PRs".

**Two corrections the same day, both from live use:**

1. **A gated branch reports `BLOCKED` for every PR.** Queueing a fully-ready PostHog PR started a cloud fix run instead of submitting it. GitHub reports `mergeStateStatus = BLOCKED` for *every* PR on a branch whose ruleset forbids ref updates — all 20 most-recently-updated open PRs on posthog/posthog came back MERGEABLE + BLOCKED, approved ones included — and `queueBlocked()` counted that as a fixable blocker, so decide never reached the submit path. `decide` now uses a gate-aware `queueBlockedFor(pr, ctx)`: with a gate, a bare BLOCKED *is* the gate. Same root cause hid the desktop Merge button and emptied the "Ready to merge" bucket on that repo; both now accept "held only by branch protection".

2. **Auto-merge is NOT trunk's submit door** (the original design's primary). The inference came from #74353's timeline — auto-merge armed at 20:45:35, `trunk-not-ready` 30s later — but trunk's *own* comment on every PR says: "To merge this pull request, check the box to the left or comment `/trunk merge` below." Comment **edits** don't appear in a timeline, so what actually happened is the author ticked trunk's checkbox; the auto-merge correlation was coincidence. Confirmed live on #74354: Talyn armed auto-merge, trunk ignored it entirely. The submit ladder is now **comment → label → auto-merge**: door 1 reads the provider's own instruction comment off the PR (`<!-- Trunk Merge -->` + the offered command) and posts that command; auto-merge drops to last, where it still serves GitHub's *native* queue. Since a posted command leaves nothing re-readable on GitHub, `external_submitted_at` (migration `0036`) + a 10-minute grace window distinguishes "trunk hasn't labelled it yet" from "trunk ignored us" — the latter blocks with an actionable reason rather than re-posting the command. **Open question**: whether trunk accepts `/trunk merge` from a GitHub App at all; if it doesn't, the block reason says so and a human ticks the box.

## Session 73 — Revive idle-finalized cloud tasks when their remote run resumes (2026-07-22)

A PostHog Code run that goes idle waiting on CI/review sits in `in_progress` on PostHog's side forever, so `maybeFinalizeIdle` (`services/posthogCode/poller.ts`) optimistically completes the local task after `IDLE_FINALIZE_MS` of no `updated_at` movement. But when the wait clears the run resumes — and the local task was already `Done`, never to be re-polled (the generic cloud poller only loads `in_progress`).

Fix: an **idle-finalized task is now a revival candidate**.
- `maybeFinalizeIdle` stamps a generic `metadata.reviveEligible: true` when it optimistically completes an idle (remote-still-`in_progress`) run.
- The generic cloud poller (`cloudProviders/poller.ts`) now loads `in_progress` tasks **plus** `completed` tasks carrying `reviveEligible` whose `completedAt` is within a 24h `REVIVE_WINDOW_MS` (ceiling for a legitimate suspension; past that the remote sandbox is abandoned). The jsonb-containment flag keeps this set tiny — genuinely-completed tasks (remote reached a terminal state) never carry it. `CloudTaskRow` gained `status` + `completedAt`.
- PostHog `reconcile` gained a `maybeRevive` branch (throttled to `IDLE_RECHECK_MS` per task): if the remote run is non-terminal **and** its `updated_at` has advanced past `completedAt` (idle keepalives don't bump `updated_at`, so a still-idle run never trips it → no revive/finalize ping-pong), the task is flipped back to `in_progress` (clearing `result`/`completedAt`/`reviveEligible`) and falls through to normal reconcile. Once the remote run is genuinely terminal, the flag is cleared so it stops being a candidate.

Claude Code needs none of this — its `pause_turn` is already kept non-terminal, so a paused session stays `in_progress`. Tests: `posthogCodePollerRevive.test.ts` (revive/idle/terminal/throttle) + a revival-candidate WHERE-clause case in `cloudPollerEgress.test.ts`.

## Session 72 — Merge queue v2 runaway: thousands of duplicate fix runs (2026-07-17)

Live incident: the queue dispatched thousands of duplicate "Get `<ref>` mergeable (merge queue)" `pr_response` runs against `posthog/posthog` (e.g. #71167 got runs at 1h → 3× at 44m → 24m). Two compounding bugs in v2:

- **Bug 1 — the fix budget reset on the queue's OWN commits (the re-fire loop).** A "get mergeable" fix run *pushes commits*, changing the head SHA. `decide` **R2** treated any head-SHA change as "fresh external code → fresh budgets" and zeroed `fixAttempts` (Session 71 item A's "reset on every push" self-healing mechanic). So for any PR the agent can't actually land (needs review, unfixable CI), `MAX_ATTEMPTS` could never bite: fix → push → new head → reset → fix … forever. **Fix**: R2 now distinguishes head changes authored by an in-flight, unaccounted fix run (`fixTaskId !== null && !fixTaskAccounted`) from genuine external pushes. Our own pushes take the new `adopt_head` action (advance the head pointer, keep the budget so R8 still accounts the attempt); only external pushes `reset_budgets`. The cap bites after `MAX_ATTEMPTS` real runs; a human push after that still self-heals.
- **Bug 2 — the task was created BEFORE the entry was claimed (the concurrent burst).** `fireFixRun` called `createCloudTask` then did the CAS that sets `fixTaskId`; the only dedup guard is `fixTaskId`, unset until after the task exists. With no per-group lock (removed for pool-starvation reasons — `evaluator.ts` comment), a webhook burst / cross-replica overlap ran N evaluations that all read `fixTaskId=null`, all dispatched, and only one won the CAS — the rest were live orphans (the 3-at-44m). The evaluator comment claiming "fix-run dispatch dedupes via the shared task guards" was false. **Fix**: on `casLost`, `fireFixRun` now cancels its just-created task via `cancelUndispatchedFixTask` (marks `cancelled` while still `queued`/`pending`). Since `createCloudTask` inserts `queued` and the scheduler dispatches async on its next tick, the loser's cancel lands before dispatch → the vendor run never starts. Net: exactly one active fix run per fire, regardless of concurrency.

- **Containment (ops)**: `packages/backend/scripts/cancel-runaway-merge-tasks.ts` — dry-run by default (`EXECUTE=1` to mutate), scopes strictly to active `pr_response` tasks titled `Get … mergeable (merge queue)`, cancels each like `POST /tasks/:id/stop` (best-effort remote PostHog cancel + mark cancelled). Emptying the v2 queue (`UPDATE merge_queue_entries SET status='removed' WHERE status NOT IN ('merged','removed')`) stops all firing on its own — entries are authoritative; `pull_requests.merge_queued` is only a downstream mirror. Rolling `merge_queue_engine` back to `v1` is NOT a safe stop (v1 has its own fire-forever history; there's no "off" value).
- **Tests**: `decide.test.ts` — new "a head pushed by our OWN fix run does NOT reset budgets" block (adopt-while-active, account-at-cap, still-reset-on-external-push). All 130 mergeQueue tests green.

**Follow-up — Bug 2 upgraded to claim-first (middle-ground).** `fireFixRun` now CLAIMS the entry via CAS (`status→fixing`, `fixTaskId=null`, event `fix_run_claimed`) **before** creating the cloud task, then creates and LINKS it in a second CAS (`fix_run_fired`). N concurrent cross-replica evaluations racing at the same entry `version` collapse to exactly one claim — the losers bail before `createCloudTask`, so no duplicate is created (vs the previous create-then-cancel). A `TaskLimitError` rolls the claim back to `queued` (burns nothing). A crash between claim and link leaves the entry `fixing`+null; the existing 120s reconciler sweep re-evaluates it and `decide` (unchanged — reads null `fixTaskId` as no active run) re-fires — natural recovery, no wedge, no migration. `cancelUndispatchedFixTask` is retained as the backstop for the rare sub-second late-eval that re-claims between our claim and link. Chosen over "full" claim-first (a `decide` hold on the claimed-but-unlinked window) because that needs a new timestamp column — `touchEvaluated` resets `lastEvaluatedAt` on held evals — and has a worse failure mode. Tests: `evaluator.test.ts` — claim-before-create ordering, task-limit revert, half-claimed crash recovery (133 mergeQueue tests green).

## Session 71 — Merge queue v2: event-driven rebuild (cutover LIVE; v1 kept as rollback)

Full rebuild of the merge queue, replacing the 10s-poll processor (a 1,217-line incident-hardened state machine deciding off up-to-90s-stale cached summaries, with terminal `blocked` states and a jsonb state blob) with an event-driven, self-healing pipeline. Shipped as six deploys (A–F below); the audit + design that drove it started from the pain map in the git history (rate-limit freezes d4f7f898/9530633228, the June wedge 120bbbda9c, fix-run churn revert 034c3dbb, draft jam 52ba5dc9).

- **A — pure decision core** (`services/mergeQueue/{types,decide}.ts` + 84-case decision table): every `processHead` branch is an explicit rule over `(entry, PR snapshot, ctx) → actions + verdict`, zero I/O. New semantics: per-headSha budgets that **reset on every push** (the self-healing mechanic; safe from the old cap-evasion trap because a sha change is monotonic), `blocked_manual` reserved for App-permission refusals, `awaiting_review` instead of doomed fix runs for review-gated PRs, `update_branch` (one REST call) before a paid fix run for BEHIND heads.
- **B — schema** (migration `0031`): `merge_queue_entries` (typed columns, CAS `version`, partial-unique active entry per PR, terminal rows kept 30 days) + `merge_queue_events` (per-entry audit timeline) + `settings.merge_queue_engine` flag + backfill from the blobs; route dual-writes membership.
- **C — pipeline** (`mergeQueue/{store,executor,evaluator,triggers,reconciler,legacy}.ts`): new `pr:snapshot`/`pr:checks` domain events from prCache upserts + the check-count fast lane (+ `task:status`) trigger per-(repo,base) group evaluations — trigger-coalesced, per-group advisory lock, 45s timeout, **no global tick/lock/TickGuard** (a hung call stalls one group, never the queue). Executor: verify-live-then-merge, verify-merged recovery, per-head-memoized signing probe, bounded check re-runs, TaskLimit defers burn nothing, legacy WS/blob mirroring for old desktop builds.
- **D — cutover** (migration `0032`): re-syncs entries from the blobs, flips the flag to `v2`; the old processor re-reads it per tick and stands down within ~10s. **v1 code stays in place as the rollback target** (`UPDATE settings SET value='"v1"' WHERE key='merge_queue_engine'`).
- **E — GitHub native auto-merge hybrid** (`githubAutoMerge.ts`): the group head, clean-but-awaiting-CI, gets `enablePullRequestAutoMerge` (expectedHeadOid-pinned; capability probed per repo, 1h cache + sticky learn-from-refusal) — GitHub merges the instant checks pass. Invariants: at most one armed entry per (repo,base); any transition into blocked disarms a Talyn-armed auto-merge first; dequeue disarms synchronously with a `pendingDisarm` reconciler retry; user-armed auto-merges are adopted, never disarmed. Plus `githubService.updatePullRequestBranch` for BEHIND heads.
- **F — desktop**: QueueCell v2 vocabulary (Auto-merge armed / Waiting for CI / Waiting for review / Fixing n/3 / Blocked-self-healing vs Needs-you), detail-sheet "Merge queue" section (budgets scoped to head, Requeue button, audit timeline via `GET /pull-requests/:id/merge-queue/timeline`), REST list decorated with the v2 payload.
- **Deferred — Push G (cleanup, after soak)**: delete `mergeQueueProcessor.ts` + `mergeQueueBroadcast.ts` + the legacy suite, drop `merge_queue_state` (then `merge_queued*`) columns in `0033`, remove the engine flag, switch `countQueuedPrsQuery` to the entries table, update CLAUDE.md's egress examples. **Verify during soak** (flagged live-API behaviors implemented defensively): the exact `expectedHeadOid`-mismatch and "clean status" error strings, `auto_merge_disabled` payload contents, arm survival across bot-authored fix-run pushes, behavior on GitHub-merge-queue-protected branches, update-branch commits vs required-signatures rulesets. Watch the Debug panel's `merge_queue_reconcile` poller + `merge_queue` event stream and the `merge_queue_events` table.

## Session 70 — Free plan: merge queue capped at 3 queued PRs

- **Rule**: free owners can hold at most **3 PRs in the merge queue** at once (counted like the task limit: across every workspace they own; only `state='open'` rows with `mergeQueued=true`). Unlimited/comped owners uncapped. Enforcement obeys the same `POLAR_*` kill switch and the same legacy-client bypass (no `X-Talyn-Client-Version` header → not enforced).
- **Backend** (`services/billing/entitlements.ts`): the task-gate lock choreography was factored into a shared `withFreePlanGate` (per-owner `pg_advisory_xact_lock`, ownerScope-transaction vs pool-mutex vs pglite-skip — unchanged semantics) now backing both `withTaskLimitGate` and the new `withMergeQueueLimitGate`. `countQueuedPrsQuery` is exported unexecuted for the egress guard (pure count, never ships `lastSummary`). Gate wired into `POST /pull-requests/:id/merge-queue` (enable only; dequeues and re-arms of an already-queued PR are exempt via `excludePrId`). `MergeQueueLimitError` → **402 `code:'merge_queue_limit_reached'`** in the shared `apiErrorHandler`. `GET /billing/status` gained `queuedPrs` + `mergeQueueLimit`. Tests: `routes/mergeQueueLimit.test.ts`, `billingEgress.test.ts`.
- **Desktop**: `maybeHandleTaskLimit` → `maybeHandleBillingLimit` (both 402 codes → UpgradeModal); the merge-queue toggle rolls back its optimistic patch and opens the modal instead of a raw error toast; UpgradeModal pitch now names whichever cap was hit; Settings → Billing shows two free-plan usage meters (Active tasks, Merge queue) via the extracted `UsageMeter`.
- **Marketing**: pricing tiers + FAQ on talyn.dev now say "3 running tasks and 3 queued PRs" / "Unlimited PRs in the merge queue".

## Session 69 — Prod incident: mass logout (auth outage read as invalid tokens) → local JWT verification

- **Incident (2026-07-07 19:33–21:37 UTC)**: every active desktop user was force-logged-out. Chain: Supabase's `/auth/v1/user` hung (~19.5s) → `requireAuth`'s `supabase.auth.getUser(token)` failed → backend answered **401 "Invalid or expired token"** for perfectly valid sessions → desktop `request()` treated any 401 as "session unrecoverable" and ran `signOut({scope:'local'})`. Evidence: Railway HTTP logs (22×401 across 5 IPs/app versions, half taking 19.4–19.8s — a 401 should take ms) lined up to the second with PostHog `logged_out` events. No deploy in the window, no 5xx, no Supabase status-page incident (their Jul 6 "Americas 500s" major incident likely explains the previous day's logouts). A separate overnight logout (Jul 7 02:35, no backend 401s at all) points at the refresh-token rotation race on app restart — mitigated but not fully solved here.
- **Backend — local JWT verification** (`middleware/auth.ts`): access tokens are now verified locally with `jose` against the project's public **ES256 JWKS** (`/auth/v1/.well-known/jwks.json`, cached in memory by `createRemoteJWKSet`) — zero per-request network dependency on Supabase, and a whole class of incident gone. Legacy HS256 tokens still round-trip to `getUser`, but with a 5s timeout. NOTE: `jose` is pinned to **v5** — v6 is ESM-only + needs global WebCrypto (Node 20+); v5 ships CJS builds and works on Node 18 dev machines.
- **Backend — 401 vs 503**: `AuthError` gained an `'unavailable'` code. "Couldn't check the token" (JWKS fetch failure/timeout, Supabase network error/5xx/hang) now maps to **503 + `code:'auth_unavailable'`** (loudly logged — this path was invisible during the incident); only an actual token rejection 401s. The WS handshake closes with 1013 (try again later) instead of 4401 when verification is unavailable. Tests: `authMiddleware.test.ts` (ES256 valid/expired/wrong-key/wrong-claims, JWKS-down→503, HS256 4xx→401 vs network/5xx/hang→503).
- **Desktop — 401 no longer nukes the session** (`lib/api.ts`): on a 401, `request()` runs a **deduped** `refreshSession()` and replays the request once with the fresh token. Sign-out happens ONLY when the auth server explicitly rejects the refresh token (4xx); network failures/5xx keep the session and surface the request error. Tests: `api401Recovery.test.ts`.
- **Desktop — `logged_out` reason instrumentation** (`lib/logoutReason.ts`): the incident's `logged_out` events carried no properties, so forced vs manual logouts were indistinguishable. Sign-out call sites now tag a reason (`manual`, `account_wiped`, `api_401_refresh_rejected`; untagged = `supabase_auto`, i.e. the Supabase client cleared the session itself — the signature of the refresh-rotation race) which `Analytics` attaches to the event.
- **Follow-up candidates**: persist rotated refresh tokens more aggressively around app quit/update-restart (the `supabase_auto` reason will now show how often that race actually fires); desktop toast/banner for `auth_unavailable` 503s.

## Session 68 — Pricing model: free 3-active-task limit, $15/mo Unlimited via Polar

- **Model**: free plan = max **3 active tasks** (`pending|queued|in_progress`) per owner across ALL their workspaces; **Unlimited** = $15/mo or $150/yr. Provider is **Polar.sh** (merchant of record — handles global VAT; chosen over Paddle for DX/instant signup, accepting seed-stage risk). Comping = `plan_override` column set via SQL (`UPDATE users SET plan_override='unlimited' WHERE email='…'`) — never touched by webhooks, wins over the webhook-driven `plan`.
- **Entitlement seam** (`services/billing/entitlements.ts`): `resolveEntitlement` (override → plan), `countActiveTasks` (pure count, egress-guarded by `billingEgress.test.ts`), `withTaskLimitGate` — per-owner `pg_advisory_xact_lock` on the free path only; on routes it rides the `ownerScope` transaction so the lock holds until the insert commits; watchers use `withBlockingAdvisoryLock`; pglite skips the lock (`guardCrossReplica` precedent). Gate lives in `createCloudTask` (all creation paths incl. watchers + `/pull-requests/:id/fix`), plus `assertCanActivateTask` on retry/start/**PATCH-to-active** (the PATCH status path was previously an ungated re-activation hole). `TaskLimitError` → **402 + `code:'task_limit_reached'`** in the now-exported `apiErrorHandler`. Merge queue holds (`waiting`, no attempt burned, no blocked badge); auto-keep skips its tick.
- **Polar module** (`services/billing/polar.ts` + `webhook.ts`): checkout via `externalCustomerId=userId` (comes back on every webhook as `customer.external_id`), hosted customer portal, best-effort revoke on `DELETE /users/me`. Webhook at `/api/v1/webhooks/polar` (raw-body, pre-`express.json`): idempotent via `billing_events` PK insert, order-safe via the `webhook-timestamp` watermark per subscription id, grants on `active|trialing|past_due`, revokes on `subscription.revoked`/terminal statuses, then `emitSubscriptionUpdated` (per-user WS). Schema: migration `0030_billing.sql` (users billing columns + `billing_events`, RLS enabled/no grant).
- **Config**: all-or-nothing `POLAR_*` env group in `validateEnv` (`POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_ENVIRONMENT`, `POLAR_PRODUCT_ID_MONTHLY/ANNUAL`; optional `POLAR_SUCCESS_URL`). **Env absent → enforcement OFF** (loud boot warning; deliberate — a paywall nobody can pay would brick dev/self-hosted; doubles as the prod kill switch). Everything shipped dark; flip = config only.
- **Desktop**: typed `ApiError` (status+code) from `request()`; `stores/billing.ts` (status snapshot refreshed on mount/focus/reconnect/WS push + a 3s×2min post-checkout poll burst; `maybeHandleTaskLimit` opens the global `UpgradeModal` on the 402); Settings → **Billing** section (free usage meter n/3, comped/past_due/cancel-at-period-end states, portal button); PR-row task button gets an at-limit tooltip but stays enabled (server is the authority).
- **Flip checklist (config only, AFTER a desktop release ships so old clients don't see raw 402 text)**: Polar production org + $15/mo + $150/yr products, Railway `POLAR_*` vars, register `https://prod.talyn.dev/api/v1/webhooks/polar` (subscription.* events), optional talyn.dev success page. Verify on the Polar sandbox first (checkout → webhook → WS). Tests: `billingEntitlements`, `billingEgress`, `billingWebhook`, `routes/billing`, `routes/tasksCreateLimit`, + merge-queue/auto-keep limit cases.

## Session 67 — Prod incident: Supavisor pool exhaustion → "Talyn can't reach its server"

- **Incident (2026-07-06 08:43–08:57 UTC, repeat of 2026-07-04 13:45–14:06)**: desktop users hit the "Talyn can't reach its server" screen. Root cause chain: `ownerScope` holds an open transaction for the life of every authenticated request → handlers awaiting GitHub calls sit **idle-in-transaction**, pinning Supavisor (transaction-pooler) backend connections → pool exhausts under webhook-hour load (~15 GitHub webhooks/s) → every query queues into `ECHECKOUTTIMEOUT` after 60s FATALs → WS auth timeouts, poll ticks wedged 5–6 min, `/health` DB probe (3s bound) 503s continuously. `statement_timeout` never fired — no statement was running. Recovery required a **manual Railway restart** (dropping the process's connections freed the pinned backends): Railway's `healthcheckTimeout` only gates deploy cutover; it does NOT healthcheck running deploys.
- **Fixes**: (1) `idle_in_transaction_session_timeout: 30_000` beside `statement_timeout` in `db/client.ts` — kills the pinned sessions instead of wedging the service; (2) new `services/dbWatchdog.ts` — bounded `select 1` every 15s, after 8 consecutive failures (~2 min) `process.exit(1)` so Railway's ON_FAILURE policy restarts us (registered on the debugBus poller registry; tests in `dbWatchdog.test.ts`); (3) `restartPolicyMaxRetries` 5 → 25 (watchdog exits are deliberate and the retry budget is per-deployment-lifetime).
- **Ops follow-ups**: `WEBHOOK_TRACE=1` was live in prod and blowing Railway's 500 logs/s cap (logs dropped mid-incident) — flip to 0. Pin the same idle-in-transaction timeout role-level in Supabase (`ALTER ROLE`) as defense-in-depth (startup params may not survive the pooler), and review pooler `pool_size` vs the client `max: 20`. Still open from S66: uptime alerting on `/health`.

## Session 66 — Launch prep: repo rename, release channels, v0.2.0, docs purge

- **Repo renamed** `Gilbert09/owl` → `Gilbert09/talyn` (GitHub App unaffected; 301 redirects keep old clones + shipped auto-updaters working — never reuse the `owl` name). All references, workflow guards, and the electron-builder publish target updated the same push.
- **Stable/nightly update channels**: nightlies stay pre-releases; tagged builds are full releases. New in-app picker (Settings → About, persisted in userData, default **stable**); the marketing DownloadButton prefers `/releases/latest`. Fixed publish.yml to bake the tag version into the build (was shipping the static 0.1.0 regardless of tag) and added `workflow_dispatch` so a stable release is one click in Actions (version optional — auto-next-patch above the highest release). **v0.2.0 shipped** as the first stable release (dual-arch, notarized, verified on the feed).
- **README launch pass** (download pointer, live providers, GitHub App, skills; task-types + daemon/SSH history removed) and **docs purge**: deleted AUTONOMOUS_BUILD / CONTINUOUS_BUILD(-ROADMAP) / DAEMON_EVERYWHERE / SUPACODE_COMPARISON / bootstrap-vm.sh; ARCHITECTURE.md rewritten for the cloud-only system (old decisions kept, marked superseded).
- **Contact email removed** site-wide + desktop (Help → "Report an Issue", crash dialog) — support channel is GitHub issues. Site email capture remains only as non-Mac "get notified".
- Merge-queue follow-ups: fix button enabled for failing non-required checks (`prHasFixableIssues`, manual-only — auto paths unchanged); WS disconnects only reach error tracking after 3 failed reconnects; PR-row actions cleared of the scrollbar; Copy list indents stacked PRs (nested markdown/HTML).
- Notable: signups were **always open** (`TALYN_ALLOWED_EMAILS` is an unset optional gate; `TALYN_ADMIN_EMAILS` only grants admin). `EnvironmentType` in shared types flagged stale (`claude_code` missing, dead `local`/`remote` members) — cleanup candidate. Still open: uptime alerting on `/health`.

## Session 65 — Pre-launch audit + hardening sweep (marketing, desktop, backend)

Full launch-readiness audit (5 parallel audit agents: security, backend scaling, desktop UX, marketing site, docs/gaps), then 24 fix commits landed across three parallel streams. Highlights:

- **Marketing** (6 commits): baked the publishable PostHog key into `lib/analytics.ts` — the Vercel env never had `NEXT_PUBLIC_POSTHOG_KEY`, so `waitlist_signup` events were silently dropped in prod; removed the visible "Template notice" banners from privacy/terms and set governing law to England and Wales; canonical host fixed to `www.talyn.dev` + `robots.ts`/`sitemap.ts`/canonicals; footer Support mailto; PNG/apple-touch favicon fallbacks; FinalCta copy into `content.ts`.
- **Desktop** (8 commits): de-boilerplated the menu (was "About ElectronReact"; Help now talyn.dev + support mailto + Check for Updates); backend-unreachable screen auto-retries with backoff (dev-only `npm run dev` hint); top-level `ErrorBoundary` + `render-process-gone` reload with crash-loop guard; `will-navigate`/`will-redirect` guards + http(s)-only `openExternalGuarded` on all external-URL paths; **analytics/session-replay opt-out toggle** (Settings → Account → Privacy; replay respects it at init); "Get a key ↗" links + scope notes on PostHog/Anthropic credential forms (onboarding + Settings); account-wipe tool gated to dev builds; ipc-example boilerplate deleted end-to-end.
- **Backend** (10 commits): process-level `unhandledRejection`/`uncaughtException` handlers, arity-4 error middleware (was dead code), `asyncHandler`/`wrapAsyncRoutes` on every router; `httpTimeout.ts` fetchWithTimeout on both cloud clients + 120s SSE idle timeout + `TickGuard` on taskQueue; WS-aware graceful shutdown, real `SELECT 1` `/health` (503 while draining), `validateEnv.ts` boot validation (prod requires ≥32-byte base64 `TALYN_TOKEN_KEY` — prod key verified compliant before deploy); **xact-scoped pg advisory locks** (`advisoryLock.ts`) on taskQueue/mergeQueue/autoMergeWatcher/cloudPoller/reconcileSweep ticks + blocking lock on the migrator (xact-scoped because session locks break through Supabase's transaction pooler; pglite passes through — documented); bounded dispatch retries (metadata attempt counter, 10s→10min backoff, terminal fail at 40 ≈ 6h) + per-task try/catch; `trust proxy` + per-IP limits on `/mcp` (300/min) and the API surface (1000/min); **boot sweep re-encrypting legacy plaintext credentials** then deleted the plaintext read fallbacks; environment WS events owner-scoped via new `broadcastToUser` (was a cross-tenant broadcast); `requireEnvironmentAccess` on PATCH, CLI 401 hint fixed, CLI/MCP refuse bearer tokens over http to non-loopback.
- Backend suite 998 green; desktop 154 green; marketing typecheck/lint/build green.
- **Follow-up (same session): merge-queue infinite 403 loop on PostHog/posthog#67815.** Root cause (empirically pinned by contrast with #67814, which `talyn-app[bot]` merged onto the same `master` 8 min earlier): **GitHub refuses App tokens — installation AND `ghu_` user-to-server alike, both "the integration" — from merging a PR whose head has ANY failing check, even an "optional, does not block merge" one a human can merge straight past**; the refusal is `403 Resource not accessible by integration`. #67815's head had exactly one failing optional check; #67814's was fully green. (Ruled out along the way: App/installation permissions — both have `contents:write` + `pull_requests:write`; ruleset bypass — not needed when the head is green; the PR itself — approved and human-mergeable. Also learned: the June 23 user-token fallback only ever helped while the stored token was a legacy classic-OAuth `gho_`; post App-only cutover the `ghu_` retry is refused identically, so the fallback is dead weight except for un-rotated legacy rows.) The queue treated the 403 as a stale-summary rejection and looped `waiting → refetch → clean → re-merge` every tick, forever (a failing *optional* check isn't a queue blocker, so the summary always read clean). Fix: `MergeNotPermittedForAppError` from `mergePullRequest` when every token flavour gets the integration-403; the merge queue lands it as `blocked` with `mergeForbidden: 'failing-checks' | 'hard'` — `failing-checks` (head had a red check) **self-heals**: the 4b gate holds while `summary.checks.failed > 0` and auto-retries the merge once the summary goes green (rerun passed / new head); `hard` (no red check to blame) stays blocked until dequeue/requeue. One-shot `notifyBlocked` with the actionable reason either way. User remedy on such PRs: re-run the failing optional check (queue then merges itself) or merge manually. **Iteration 2 (July 3):** the queue now re-runs the failing checks itself before blocking — `githubService.rerequestFailedCheckRuns` (REST `POST /check-runs/{id}/rerequest`, the API twin of the UI "Re-run" button; routes to whichever app created the check — GitHub Actions, Depot, …) with its own `rerunAttempts` budget capped at `MAX_ATTEMPTS` (3), status `waiting` while the rerun is in flight (step 2b holds on in-flight CI), self-heal merge when green; blocks only on budget exhaustion, no-permission, or no failing check to blame. **Requires the Talyn App `checks: write` permission (currently read-only)** — until granted, the rerequest 403s and the block reason says to grant "Checks: Read & write"; permission investigation confirmed no permission lets an App merge past a failing check directly (the only GitHub-side lever is the ruleset bypass list, which exempts ALL rules — too broad).
- **Still open (owner decisions, from the audit)**: access model for launch (allowlist vs invites vs open signup — no invite flow exists); public repo `Gilbert09/owl` exposure via marketing GitHub links (rename vs drop links); stable vs prerelease update channel (+ Intel-arch nightly gap); `docs/SETUP.md` rewrite (predates cloud-only refactor); error-tracking/uptime alerting on the backend (handlers now log but nothing pages); reconcile-sweep serialization at ~50 workspaces + shared-org GraphQL dedupe; transcript retention; prod PostgREST grant check on the 3 RLS-off tables.

## Session 64 — Run agent skills on a PR via cloud tasks

Users can now run an agent skill (a `SKILL.md`) against a PR with a cloud task, from three sources: the PR's repo (`.claude/skills/*/SKILL.md`, discovered via the GitHub contents API), the user's machine (`~/.claude/skills`, read by Electron main over new `skills:list-local` IPC), and skills saved to the Talyn platform (new workspace-scoped `skills` table, migration `0029` + RLS).

- **Injection point is the prompt** — neither PostHog Code nor Claude Managed Agents accepts skills/file mounts, so the skill content is inlined into `tasks.prompt` by a provider-aware `buildSkillPrompt` (`packages/shared/src/skillPrompt.ts`). The NON-NEGOTIABLE git-rules blocks were lifted out of `prMergeable.ts` into exported `postHogCodeGitRules`/`claudeCodeGitRules` so the mergeable + skill prompt families share them verbatim. Skill content is fenced with an adaptive `~~~~` fence and **never truncated** — one 256KB `SKILL_MAX_BYTES` guard; over it a skill is listed but refused ("too large to run").
- **Backend**: `GitHubService.getDirectoryListing`/`getFileContent` (contents API on `apiRequest` — rate gate + debugBus for free); `services/skills.ts` (repo discovery w/ 10-min in-memory cache + stale-on-error, `bumpSkillUsage` upsert); `routes/skills.ts` (list w/ `SKILL_LIST_COLUMNS` projection — `content` never ships on list reads, `octet_length` for size); `CreateTaskRequest.skill` → `metadata.skill` + fire-and-forget usage bump in `taskCreate`. New `skill_usage` table (workspaceId+skillKey → count/lastUsedAt) drives the picker's "frequently used" ordering. `parseRepoUrl` extracted to `services/repoIdentity.ts` (prMonitor now uses it).
- **Desktop**: Wand2 button on every open-PR row (all three GitHub tabs incl. Reviews — review skills on review-requested PRs are the headline case) → `SkillPickerModal` (hand-rolled search list: frequently-used top, grouped by source, keyboard nav, provider step when the default is "Ask every time") → `runSkillTask` in `useGitHubActions` (mirrors `createPostHogTask`; resolves content by source and links the task to the PR). New Settings → Skills section (`SkillsSettings.tsx`): platform CRUD, local list + "Save to Talyn", per-repo discovered skills w/ refresh. Task detail shows a `Skill: <name>` badge from `metadata.skill`.
- **Tests**: `skillPrompt.test.ts` (frontmatter parser edge cases, fencing, git-rules sharing), `skillsService.test.ts` (discovery/cache/stale/oversize), `routes/skillsRoutes.test.ts` (CRUD + 409 + no-content-in-list projection guard), `taskCreate` skill metadata + usage bump, RLS cross-owner probes on `skills`/`skill_usage`, desktop `skillsLib`/`SkillPickerModal` suites.
- **Immediately available** (follow-up in the same session): skills are prefetched — `lib/skillsData.ts` holds a renderer-side snapshot cache (stale-while-revalidate; a failed refresh never blanks a warm cache), `prefetchSkills` warms local + every watched repo's discovery on workspace load (`useInitialDataLoad`), and `useSkills` renders straight from the cache so the picker opens instantly populated. Prefetch also warms the backend's 10-min repo cache.
- Deferred: PRDetailSheet launch button, `skill:*` WS events, ETag-conditional fetches, PR-head-branch discovery, supporting files for local/platform skills (repo skills get them via the checkout path pointer).

## Session 63 — Webhook-outage postmortem + REST-only close-out backstop

**Incident (July 2, ~08:50–08:58 UTC):** a merged PR (PostHog/posthog#67377) stayed "open" in the UI until a manual refresh. Root cause was NOT the fan-out dedup shipped the day before: Railway logs show a **total inbound-webhook gap** — received-webhook counts per 2-min window went ~1,100 → 327 → 0 ×4 → ~1,050 — while the backend stayed healthy (pollers, SSE, outbound all fine). Nine posthog PRs merged in the gap; none of their `pull_request/closed` deliveries ever arrived (GitHub doesn't auto-redeliver). The safety net (reconcile sweep) didn't catch it because the tick can be **deferred wholesale** when the account's GraphQL budget is in reserve — and the window had rate-limit pressure (inst 140693949's REST search budget exhausted at the same minute).

**Landed — REST-only close-out for deferred sweeps:**
- `prMonitor.sweepClosedViaRest(workspaceId, cache)` — diffs tracked-open rows against the repo's REST open-PR list (`githubService.listOpenPullRequestNumbers`, paginated `/pulls?state=open`), then confirms each candidate with a direct per-PR REST fetch before closing (authoritative state + `merged_at`; guards list-pagination races). Never closes on missing data (failed list/lookup → skip, retry next tick). Spends core REST budget only — zero GraphQL points, which is the whole point: it runs exactly when the GraphQL budget is in reserve.
- `prReconcileSweep` deferred branch now runs it instead of skipping outright; a tick-scoped `RestSweepCache` dedupes across workspaces (N workspaces watching one repo → ONE list call, ONE lookup per closed PR — same principle as `refreshPrAcrossWorkspaces`).
- Extracted `closeTrackedRow` (shared by `sweepClosed` + the REST pass): state/mergedAt/queue-reset write + `pull_request:updated` emit. Egress win while there: the bulk tracked-open select no longer ships `lastSummary` (~2KB × every open row × every sweep); the blob is fetched per actually-closed row (usually 0).
- Debug: deferred-event + pollerTick summaries report REST close-out counts; the REST calls ride the existing `apiRequest` recordHttp funnel.
- Tests: `prMonitorRestSweep.test.ts` (8) — merged/closed writes + broadcast, queue reset, never-close-on-failure (list fail, lookup fail, lookup-says-open), cross-workspace cache dedup, no-op fast paths.

**Known limitation:** a *hard* rate gate (`githubRateGate` engaged by an actual RATE_LIMITED response) blocks REST too via `apiRequest`, so the pass covers the budget-*reserve* deferral (the chronic state), not a hard gate. Also shipped: task-history pagination (`e9c944b`, separate commit — active statuses fetched in full, finished history cursor-paginated 30/page with infinite scroll).

## Session 62 — GitHub App + webhooks (replace polling) + Redis cross-replica backbone

Began the migration from GitHub-API polling to **GitHub-App webhooks**, with **Redis** as the cross-replica backbone. Built additively so the whole suite stays green and nothing is observable until the App + `REDIS_URL` are configured; the destructive parts (removing OAuth-only paths, deleting the now-redundant pollers) are explicit follow-ups gated on the live App. Plan: `~/.claude/plans/could-you-spec-out-harmonic-cookie.md`.

**Landed:**
- **Redis layer** (`services/redis.ts`) — lazy shared client + dedicated-connection factory; no-op when `REDIS_URL` unset. `docker-compose.yml` + `npm run dev:redis`.
- **Cross-replica WS fan-out** (`services/wsBus.ts`) — `broadcast`/`broadcastToWorkspace` now deliver locally **and** publish to a Redis Pub/Sub channel; each replica re-delivers to its own clients, deduped by a per-process `REPLICA_ID`. WS event contract unchanged → no desktop changes.
- **GitHub App auth** (`services/githubApp.ts`) — RS256 App-JWT signing, installation-token mint/cache/refresh/coalesce, user-code exchange, install-URL builder, suspension handling.
- **Hybrid auth seam in `github.ts`** — App workspaces (those with an `installationId` on the integration config) use a fresh **installation token** for data-plane reads and the **user token** for viewer-identity endpoints (`/user`, `/user/teams`, `/user/repos`, notifications); rate-key by installation; installation-token 401s clear the mint cache instead of nuking the user integration. Legacy OAuth workspaces are completely unchanged (all existing tests green).
- **Install flow** — `POST /github/app/install-url` + public `GET /github/app/callback` (exchange user code, upsert `github_installations`, store integration w/ installationId, bulk-refresh). Migration `0026_github_app.sql` adds the global `github_installations` table.
- **Webhook pipeline** — public `POST /api/v1/webhooks/github` (raw-body HMAC verify → ownership filter → XADD → 202, mounted before `express.json`); `services/webhookWorker.ts` (Redis Stream consumer group, competing consumers, event→`refreshPr` fan-out across every watching workspace, 750ms coalescing); `services/webhookIndex.ts` (full-name→workspaces index for the filter + fan-out); `services/prReconcileSweep.ts` (15-min jittered safety-net re-poll).
- **Debug panel** — new `webhook` category + `debugBus.recordWebhook` (signature, drop-reason, fan-out, enqueue→process latency); `redis`/`github_webhooks` in `SERVICE_INFO`.

**Tests added:** wsBus fan-out (8), githubApp (12), hybrid-auth routing (2), webhook receiver HMAC (5), webhook worker classify/fan-out/coalesce (14), migration table assertion, debugBus webhook recorder (4). Full backend suite green.

**Cutover completed (same session):** went App-only. Deleted the notifications poller, the 30s Search poll + 10s fast-CI loop, and the token-health poller. `refreshPr` (the webhook per-PR trigger) now derives the Mine/Review bucket flags from the fetched summary + viewer identity (`relationshipFlags`) — so buckets stay realtime without Search — and only materializes PRs the viewer relates to. The reconcile sweep (15 min, full `pollWorkspace`) is the bucket/closed-PR backstop. Removed the OAuth connect flow end-to-end (routes + `getAuthorizationUrl`/`exchangeCodeForToken` + `api.github.connect`); every desktop connect entry point now runs the App install flow. Added expiring-user-token rotation (`refreshUserToken` + in-band refresh in `resolveAuth`) since the App has "Expire user authorization tokens" on. Full backend suite green (752, run sequentially — parallel runs flake on pglite contention only).

**Remaining follow-ups:** event-driven merge-queue/auto-merge nudges; `status`-event PR mapping (commit-scoped — caught by the sweep); per-installation pause-on-inactivity at the receiver; dedicated stream-depth (XLEN) tile; repositories.ts install-allowlist gating.

## Session 61 — Claude Code as a 2nd cloud provider (Anthropic Managed Agents); Codex deferred

Added **Claude Code** as the second `CloudTaskProvider`, with feature parity to PostHog Code.

**Phase 0 (spike-first gate).** Web research + a throwaway exploratory spike (`scripts/spikes/spike-claude.ts`, git-ignored) settled the two API choices against real accounts:
- **Codex Cloud → deferred.** OpenAI exposes no server-to-server cloud-task API — only the `codex cloud` CLI (needs a self-hosted runner + opaque env ids, unstable JSON) or `@codex` GitHub mentions. Building on it would reverse the cloud-only refactor, so it's parked behind the same provider seam.
- **Claude → Anthropic Managed Agents API** (not Routines: Routines are subscription-billed but fire-and-forget / no transcript / no cancel). The spike confirmed the full contract by opening a real PR on `owl` (#8): `POST /v1/agents` (prebuilt toolset + GitHub MCP `always_allow`) → `/v1/environments` → `/v1/vaults` + `/credentials` (static_bearer bound to the MCP URL) → `/v1/sessions` (`agent` + `environment_id` + `vault_ids` + `github_repository` resource) → post the prompt as a `user.message` event. Transcript is **poll-based** (`GET /sessions/{id}/events`; `/events/stream` only replays then closes); terminal = `session.status_idle` + `stop_reason.end_turn`; the PR URL surfaces in the `create_pull_request` `agent.mcp_tool_result`; cancel = `user.interrupt` + `DELETE`. Plan B (agent uses `git`/`gh`) is dead — `gh` isn't installed and the mounted-repo token isn't exposed to the shell; the GitHub **MCP + vault** is the only PR path. Billing: standard API credits (no subscription option on Managed Agents); a self-hosted Modal-style sandbox on a Max subscription is prohibited by Anthropic ToS and enforced.

**Implementation.** `services/claudeCode/{converter,client,credentials,executor,poller}.ts` + `cloudProviders/claude/provider.ts` (type `claude_code`, displayName "Claude Code"), registered in `index.ts`. The lifecycle mirrors PostHog; the converter is simpler (complete polled events, no chunk coalescing). Agent + environment are created once per workspace and cached on the integration `config`; the vault (GitHub credential) is minted fresh per dispatch and deleted on finalize/cancel. DebugPanel `SERVICE_INFO` gains `claude_managed_agents`. Desktop: a generic `CloudProviderCard` (driven by the `/cloud-providers` routes) renders the Claude connect form (Anthropic key only — GitHub access reuses the workspace's existing connection via `githubService.getAccessToken`); `useGitHubActions` resolves a generic "active cloud env" (prefer PostHog, else Claude). Tests: `claudeCodeConverter.test.ts` + `claudeCodeProvider.test.ts` (18 cases); tsc + eslint clean across backend/shared/desktop. (Provider type was renamed `claude_routine`→`claude_code` — we use Managed Agents, not Routines.)

**Follow-ups:** per-task provider picker (both-connected case); `checkout` object shape for `pr_response`/`pr_review` head-branch mounting; executor/poller DB-mocked reconcile tests; reuse the workspace GitHub connection instead of a separate PAT; migrate the bespoke PostHog Settings card onto `CloudProviderCard`.

## Session 60 — "Ready to merge" filter + merge queue skips blocked PRs

Two PR-management quality-of-life changes:

- **"Ready to merge" toggle on My PRs** (`MyPRsPanel.tsx`): a green chip next to "Needs review" with a live count. The predicate (`isReadyToMerge` in `prTableShared.tsx`) requires: non-draft, `blockingReason` ∈ {`mergeable`, `checks_failed_optional`} (same verdict as the backend's became-merge-ready notification), zero in-progress checks, and no outstanding review request (`effectiveReviewDecision` so unprotected repos work). Parameterized coverage in `prAwaitingReview.test.ts`.
- **Merge queue: blocked PRs no longer gate the queue** (`mergeQueueProcessor.ts`): the tick now walks each (workspace, repo, base) group from the head, skipping past PRs that can't make progress — hard-blocked after MAX_ATTEMPTS, or no longer queued — until one takes an action. `processHead` returns a `HeadVerdict` (`'hold'` = consumed the group's turn: merge/fix-run/in-flight run/waiting-no-env; `'advance'` = skip to the next queued PR). One-merge-per-group-per-tick serialization is preserved (first `hold` breaks the walk); a blocked head that reads clean still re-arms and consumes the turn; `fixing` heads still hold the group. WS badge echoes now carry the acted-on PR's real group position instead of a hardcoded 1. Nine new tests in `mergeQueueProcessor.test.ts` (skip-to-next, multi-skip, single-merge-per-tick, fix-run-behind-blocked, re-arm precedence, hard-cap same-tick skip, just-blocked same-tick advance + single notification, fixing holds, position echo).

## Session 59 — GitHub token autopsy round 2: GitHub is revoking the tokens; check-token health poller

Second investigation into the recurring "GitHub isn't connected" banner, now with Session 58's forensic logging (`token:stored`/`token:removed` fingerprints) in prod. Railway log archaeology across every deployment since Jun 8 produced a clean timeline and **exonerated FastOwl's own storage**: each incident shows the same fingerprint stored → loaded across restarts → rejected by GitHub with an authentic `401 Bad credentials` (request-id logged). GitHub is revoking the tokens server-side.

Incidents: Jun 8 18:53Z, Jun 10 15:05Z (token lived ~29.5h), Jun 11 05:57Z (~12.5h), Jun 11 ~19:34Z (~11h, captured by the new REMOVING log: `401 on POST /graphql`, fp:e396c488, age 11h). Hypotheses killed by the data: fixed 8h GitHub-App-style expiry (29.5h survivor), cross-workspace revoke-on-reconnect (the 05:57Z death had no connect within 12h; GitHub docs say re-auth doesn't revoke), 10-token-cap churn (only ~4 mints in 3 days; local dev uses a separate OAuth app + local DB per SETUP §0), token leak (history of the public repo is clean; the GitHub token never leaves the backend — not sent to cloud providers), full grant revocation (the second workspace's token survived the Jun 11 19:34 death). Remaining suspects are GitHub-side per-token revocations (secret-scanning-style or risk-based) — distinguishable only with exact death times and GitHub's own metadata.

**Instrumentation added (the next trap):**
- `exchangeCodeForToken` now parses `expires_in`/`refresh_token`/`refresh_token_expires_in` and logs + `debugBus`-records (`token:expiring-grant`) if GitHub ever returns an expiring grant — would prove the OAuth app has token expiration enabled.
- New `githubService.checkTokenHealth(workspaceId)`: app-authenticated `POST /applications/{client_id}/token` (free, no user budget) returning validity, owning `login`, `created_at`, and any scheduled `expires_at` per stored token.
- New `services/tokenHealthPoller.ts` (5-min cadence, `TickGuard`, registered as `token_health` in the Debug panel): logs each token's GitHub-side identity once (`token:health-first-check` — immediately answers "which GitHub login is each workspace using" and "is an expiry scheduled"), and pins a revocation to a 5-minute window (`token:health-died`) instead of whenever a budgeted call next 401s — the detection lag that made this autopsy ambiguous. Pure observer; removal stays with the 401 path.
- Tests: `tokenHealthPoller.test.ts` (10 cases over the pure `TokenHealthTracker`: first-sighting, expiry surfacing, steady-state silence, died transition, dead-at-first-check, replacement fingerprint, per-workspace independence).

Next time the banner appears: grep Railway for `token:health-died` for the death window, then check github.com/settings/security-log (`action:oauth_access.destroy`) and email for GitHub revocation notices at that timestamp.

## Session 58 — Merge-queue stall audit: bounded body reads, verify-merged recovery, watchdogs everywhere

Post-mortem of the prod merge-queue freeze (3 queued PRs; the head — PostHog/posthog#62654 — merged on GitHub at 19:13:50Z but the UI showed "QUEUED #1 · MERGING" forever and the siblings never advanced; Tom merged them by hand at 19:19). Railway logs had the smoking gun: `[mergeQueueProcessor] previous tick wedged for 304973ms — force-releasing the lock`. Root cause chain:

1. **`fetchWithTimeout` only bounded the headers.** It cleared its abort timer the moment `fetch` resolved, so every `response.json()`/`text()` after it was unbounded — the merge PUT's response body stalled and the tick hung *after GitHub had already merged*, so the `state='merged'` DB write never ran. (The 30s timeout was added for exactly this wedge class and only half-fixed it.)
2. **The PR monitor had no wedge watchdog** (bare `if (isPolling) return`), so the rescue path — `sweepClosed` flipping rows that fell out of the open search — was wedged alongside (no monitor logs after 18:57). The watchdog added to the merge processor after the first prod wedge was never propagated to the other six loops.
3. **Nothing ever asked GitHub "is this PR actually merged?"** — post-watchdog ticks re-attempted the merge, got 405, set `waiting`, and looped.
4. **`sweepClosed` leaked queue bookkeeping** — it flipped `state` but left `mergeQueued`/`mergeQueuedAt`/`mergeQueueState` set (unlike `reconcileTerminalState`), and never rebroadcast positions.

**Fixes:**
- `github.ts`: `fetchWithTimeout` now consumes the body inside the abort window and returns a `TimedResponse` (`status`/`headers`/`bodyText`); all REST + GraphQL body reads go through it (`parseJsonBody` helper). `listNotifications` and the OAuth token exchange — previously plain `fetch` with NO timeout — converted too. `describeApiError` folded into `describeApiErrorFromText`.
- New `services/tickGuard.ts` (`TickGuard`: `tryBegin`/`end`/`active`, force-release past 5 min) adopted by all seven loops: mergeQueueProcessor (replacing its inline watchdog), prMonitor poll + fastPoll, prAutoMergeWatcher, notificationsPoller, rateLimitPoller, cloudProviders/poller.
- `mergeQueueProcessor`: new `verifyMerged()` (REST `merged_at`, canonical) + `recordMerged()` (single success path). Runs on entry when the row reads `status='merging'` (a tick died mid-merge), on `merged:false`, and on a thrown merge — so a lost response, a redeploy mid-merge, or an external merge all converge to the success path instead of a doomed retry loop. Plus a last-moment re-read of `state`+`mergeQueued` before the merge call (a force-released wedged tick can resume minutes later on a stale snapshot), and a per-tick self-heal that clears queue flags on any non-open row (`+ rebroadcast`) as the catch-all.
- `QUEUE_RESET_COLUMNS` shared from `mergeQueueBroadcast.ts`; applied in `sweepClosed` (same write as the state flip, `mergeQueued:false` in its WS emit, positions rebroadcast when a queued row is swept), the processor, and `reconcileTerminalState`.
- Deliberately NOT changed: `prCache.upsertRow` doesn't clear queue flags — if the refresh path cleared them, the processor's `dequeue()` (which owns the position rebroadcast) would never fire; the self-heal covers stragglers within one tick.
- Tests (+16): `githubFetchTimeout.test.ts` (incl. the stalled-body-after-headers prod case via signal-wired mock streams), `tickGuard.test.ts`, processor verify-merged recovery (5 cases incl. queue advancement after a 405-recovery), self-heal, stale-tick guard (driving `processHead` with a stale snapshot), and the sweep clearing flags + promoting the surviving sibling #2 → #1.

Observed-but-not-fixed: the PostHog Code SSE tail loop re-reads ~5.5k frames every ~10s per watched run (Session 57's leftover, confirmed flooding the prod logs), and a GraphQL primary-rate-limit exhaustion at 17:25 set the degraded stage for the incident.

## Session 57 — View-gated cloud log streaming + time-debounced transcript persists

Diagnosed a Railway network spike (~40MB/bucket for ~40 min, flat CPU/memory): every in-progress PostHog Code task streamed its SSE log 24/7 (token-level ACP deltas — single tasks delivered 12k+ events in a 2-minute window) and the streamer persisted the **full transcript jsonb** to Supabase every 25 events (`PERSIST_EVERY`) — ~500 full-blob UPDATEs per task per 2 minutes during bursts, quadratic over a run's life. Nothing functional needed the always-on stream: status/PR/finalisation all come from the poller's `getTask()` REST poll + bounded `getSessionLogs` tail fetches, and terminal-with-empty-transcript runs already get a one-shot durable S3 backfill. The stream's only job is the live transcript view.

**Fix — stream only while someone's looking, write on a clock not a counter:**
- New `services/cloudProviders/taskWatch.ts` (mirrors `prFocus`): in-memory `markWatched`/`isWatched`/`clearWatched`, 90s TTL, lazy expiry. `CloudTaskRow` gains `watched` (stamped by the generic poller from the registry; no query change).
- `posthogCode/poller.ts` gate rewritten: terminal+empty-transcript → one-shot backfill (unchanged, unconditional); running+watched → live stream; otherwise tear down via new `streamer.isActive()` (stop persists buffered events). `finalize()` clears the watch.
- `streamer.ts`: `PERSIST_EVERY = 25` → `PERSIST_INTERVAL_MS = 10s` debounce (check-on-append; stream-end tail + `flushNow` cover the rest). Worst case on hard crash: ≤10s of mid-run snapshot, and finished runs stay durable via the terminal backfill.
- Routes: `refresh-logs` marks watched *before* the remote call (so the run-not-started 409 still arms the poller); new lightweight `POST /tasks/:id/watch` heartbeat (no remote call, no row read beyond access check); stop/delete clear the watch. `executor.ts` no longer opens a stream on dispatch — the task screen's refresh-logs starts it instantly for a viewer, SSE replays from the start for late viewers.
- Desktop: `api.tasks.watch()` + a 30s heartbeat effect in `TaskTerminal` while a cloud task is mounted and `in_progress`. Deliberately no unwatch-on-unmount (two windows viewing the same task would race); the TTL lapse costs ≤90s of tail.
- Tests (+15): `taskWatch.test.ts` (fake-timer TTL semantics), `posthogCodePollerGating.test.ts` (parameterized over the four gate arms + watch-cleared-on-finalize; gotcha: `finalize`'s void-ed `captureOutcome` DB read races pglite teardown — settle before `cleanup()` or the WASM wedges the worker), streamer debounce test (30-event burst stays buffered; old count trigger would have flushed at 25) + `isActive()` lifecycle.

Net effect: an unwatched fleet of cloud runs (the exact spike scenario — pr-followup batches) costs only the 10s status poll; transcript bytes flow only for the task on screen, at ≤1 full-blob write per 10s. Known leftover (pre-existing, now bounded to watched tasks): the SSE edge kills streams every ~2 min and `Last-Event-ID` resume sometimes re-replays history — worth chasing separately if watched-task traffic still looks fat.

## Session 56 — Refactor-debris sweep: dead client code, doc drift, silent catches, missing tests, README

A "what have we overlooked?" audit of the cloud-only refactor's leftovers, worked through as five focused commits. (Started in one Claude session, finished in another after API errors killed the first mid-edit.)

1. **Dead desktop client code removed** (−822 lines). The Session 52 audit cleaned the task-screen buttons but missed the API layer: `api.ts` still exported full `agents` + `backlog` API objects and daemon `pairing-token`/`updateDaemon` calls — all 404 against the cloud-only backend. Stripped those plus `useAgents`, agent state in the workspace store, the interactive permission flow in `AgentConversation` (Approve/Deny/Allow-always buttons + `respondToPermission`; permission cards remain as a read-only historical record), and the matching shared types (`Agent`, `AgentStatus`, `Backlog*`, permission/WS event interfaces) + backend WS emitters (`agent:*`, `task:output`, `task:agent_status`). Also deleted the `packages/daemon/` husk (dist + node_modules; source was already gone).
2. **Docs pruned.** `ROADMAP.md`'s priority queue / backlog / known gaps described the local-execution app; rewritten around the actual current work (cloud provider Phases 0+3–5, desktop generalisation, advisory locks, auth polish, desktop tests), with obsoleted items struck through and Phases 1–20 bannered as pre-refactor history. Marked resolved gaps: credential encryption (landed as `tokenCrypto.ts`), backend bundling/release packaging (hosted on Railway). `QUALITY_PARITY.md`'s unread-dots item now notes its `inbox_items` data source was dropped in Session 43.
3. **Silent error swallowing fixed.** Eight `.catch(() => {})` hot-path sites now log with context: pr_monitor tick crashes (previously reported `ok:true` to the debugBus while the rejection vanished), best-effort `refreshPr` calls in notificationsPoller / mergeQueueProcessor (freshness + post-merge-failure refetch) / prAutoMergeWatcher, analytics capture, and the PostHog streamer's last-resort backfill. Deliberately left: control-flow null fallbacks (WS auth, rate-limit login lookup) and `taskMetadataMutex`'s chain de-poisoning (the error still propagates to the caller).
4. **Tests for the untested newer services** (33 new): `prCloudFix` (owner-scoped env resolution, linked-task status), `taskCreate` (defaults, metadata overrides, PR pointer stash + reverse-link incl. cross-workspace rejection and link-failure tolerance, `task:created` broadcast), and `taskMetadataMutex` — the concurrency edge it exists for: concurrent patches serialize instead of tearing, a throwing patch doesn't poison the chain.
5. **README updated** for the PR-management + self-fixing pitch: removed the stale "prioritized inbox" framing (Inbox died in Session 43) in favour of the GitHub panel's needs-attention buckets, and added the self-fixing story (merge queue + keep-mergeable flag → automatic cloud fix runs when a PR falls behind / conflicts / fails CI).

## Session 55 — Prod GitHub token mystery solved; local dev gets its own Supabase stack

Diagnosed why the prod `integrations` row (GitHub token) kept vanishing, forcing reconnects. The chain: (1) any single GitHub 401 hard-deletes the row — `githubService.removeToken()` is called from `apiRequest`, `listNotifications`, and `executeGraphql`; (2) local dev shared *everything* with prod — same Supabase DB, same `TALYN_TOKEN_KEY`, same classic GitHub OAuth app — so a laptop `tsx watch` backend polled GitHub against the shared row; (3) connects never revoke old tokens at GitHub, so they pile up toward GitHub's **10-tokens-per-user/app/scope cap**, after which every reconnect silently revokes the oldest token — whichever running backend still cached it in memory then 401s and deletes the shared row (wiping the *new* token), forcing another reconnect → another minted token → self-sustaining loop. Confirmed in Railway logs: single GraphQL 401 at 15:05:57Z, next tick every repo "not connected".

**Fix landed this session — environment separation:**
- `supabase init` at repo root + local stack via `npm run dev:db` / `dev:db:stop` (excludes storage/realtime/functions/etc; db on `:54322`, API/auth on `:54321`, Studio on `:54323`). `supabase` CLI added as root devDependency (brew blocked on outdated Xcode CLT).
- `supabase/config.toml`: GitHub login provider enabled via `env()` from gitignored `supabase/.env`; `fastowl://auth-callback` added to `additional_redirect_urls`.
- `packages/backend/.env` + `apps/desktop/.env` rewired to the local stack with a freshly generated dev-only `TALYN_TOKEN_KEY`; prod credentials removed from the laptop entirely (they live only in Railway variables now). Backend boots clean against local: all 24 migrations apply on startup, 8 tables created.
- `docs/SETUP.md` §0 documents the new local-dev flow + the two **dev-only** OAuth apps Tom still needs to create in the browser (login app → callback `http://127.0.0.1:54321/auth/v1/callback`; integration app → callback `http://localhost:4747/api/v1/github/callback`).

**Still open (backend hardening, not started):** don't hard-delete the integration on a single 401 — re-read the row first (another process may have rotated the token), mark `invalid` instead of deleting, and revoke the old token at GitHub (`DELETE /applications/{client_id}/token`) on disconnect/reconnect so tokens stop accumulating toward the cap.

**Follow-up — fresh-DB renderer bugs the switch exposed** (first dev login landed on an empty MainLayout with a misleading "OAuth isn't configured" banner + "workspace not found"): (1) `useInitialDataLoad` now runs the *inverse* onboarding migration — server has zero workspaces but localStorage says onboarded → re-show the wizard (previously the user was stranded with no way to create a workspace); (2) a persisted `currentWorkspaceId` that no longer exists is cleared when there's no fallback workspace, instead of being left to 404 every per-workspace fetch; (3) `SettingsPanel.refreshGitHubStatus` no longer fabricates `{configured: false}` on any fetch error (that's what painted the global "OAuth isn't configured" banner when the stale workspace id 404'd) — failure now leaves status unknown (`null`), and the "Not Configured" badge requires an explicit `configured === false`.

## Session 54 — Frameless macOS window: hidden title bar, inset traffic lights

Dropped the native macOS title bar (`titleBarStyle: 'hiddenInset'` on the BrowserWindow, darwin-only; other platforms keep their frame) so the close/minimize/zoom buttons float flush over the app UI. The renderer reserves drag regions for them:

- Preload exposes `platform`; new `isMacDesktop` helper in `lib/utils.ts` + `.app-region-drag`/`.app-region-no-drag` CSS utilities in `App.css`.
- **MainLayout**: the Sidebar reserves an in-flow 36px drag strip above the workspace switcher (the traffic lights sit in it; double-click-to-zoom works natively). `SystemStatusBanner` moved from above-the-sidebar into the main column so the sidebar always reaches the window top and the banner can't sit under the lights.
- **Chrome-less screens** (boot spinner, login, onboarding, backend-unreachable) render a fixed full-width `MacDragOverlay` strip instead — safe there because their content is centered; MainLayout deliberately doesn't use it since it would swallow clicks on panel-header controls near the top edge.
- **Follow-up**: every page's top header bar (GitHubPageShell, Task Queue list + both task-detail headers, Settings, Debug) is itself an `app-region-drag` handle, with buttons/selects/PR controls opting out via `app-region-no-drag` — so the area around the page title drags the window everywhere. Sidebar strip tightened 36px → 24px so the workspace picker hugs the traffic lights.

## Session 53 — Analytics audit + instrumentation: data-quality fixes, business events, server-side task lifecycle

Audited FastOwl's PostHog project (459813): only `app_opened` + `panel_viewed` existed, the `app_version` super property never landed on any event (registered async after an IPC round-trip, silently failing), all 77 `$exception`s were one string (`WebSocket error: [object Event]` — `capture_console_errors` × the reconnect loop), autocapture had no `data-attr`s to target, and none of the product's real actions emitted events. Fixed all of it:

1. **Data quality.** `TALYN_APP_VERSION` is now baked at webpack build time from `release/app/package.json` (CI stamps it pre-build, so it matches `app.getVersion()`) and registered *synchronously* with a new `environment` (development/production) super property; IPC fallback only if the bake is missing. The WS `onerror` handler now logs socket URL + readyState + attempt count, and only the FIRST failure of an outage uses `console.error` (→ one `$exception` per outage, not per retry); later attempts downgrade to `console.warn`. The active `workspace_id` is registered as a super property; `panel_viewed` gained `previous_panel`.
2. **Renderer business events** (all via `trackEvent`): `pr_merged` {repo, pr_number, blocking_reason}, `merge_queue_toggled`, `pr_fix_task_started`, `pr_detail_opened`, `github_connect_started`, `cloud_provider_connected`, `task_created` {task_type, model, runtime_adapter, from_pr}, `task_aborted` / `task_retried` / `task_cancelled` / `task_started_manually` / `task_deleted`, `logged_in` / `logged_out` (transition-gated so session restore doesn't fire it), `onboarding_completed` {github_connected, repos_watched}. Plus `data-attr`s on the key controls (sidebar nav, PR-row merge/queue/fix/copy, task Add/Start/Abort/Retry/Delete/Cancel, composer submit) so autocapture stops being Tailwind class soup.
3. **Server-side task lifecycle** — new `packages/backend/src/services/analytics.ts`: a deliberate non-SDK, single-`fetch` PostHog capture client (keeps the call inside the debugBus outbound-HTTP funnel; no flag/batch machinery needed at this volume), env-gated on `TALYN_POSTHOG_KEY`/`TALYN_POSTHOG_HOST`, attributing events to the workspace owner (same Supabase user id the renderer identifies, so one person profile). `taskQueue` emits `task_dispatched` {provider, task_type, priority, duration_queued_ms} + stamps `metadata.dispatchedAt`, and `task_dispatch_failed` {reason}; the posthog poller's `finalize` emits `task_completed`/`task_failed` {opened_pr, duration_total_ms, duration_run_ms, error_reason} via a projected read (never the transcript). DebugPanel `SERVICE_INFO` got the `posthog_analytics` entry. New `analytics.test.ts` (7 tests: env-gating, payload shape, host override, owner resolution, unknown-workspace drop, failure swallowing).

Note: the renderer compiles the whole analytics path out when no key is baked (Terser proves `!KEY`), so local keyless builds ship zero analytics code. **Backend events need `TALYN_POSTHOG_KEY` set on the Railway service** — not done this session (Railway MCP unauthorized). Typecheck + lint clean, 559 tests green.

## Session 52 — Task-screen action audit: dead review-flow buttons removed, Abort cancels the cloud run

Audited every button on the task screens (queued / in-progress / completed) against the cloud-only architecture, then removed what the refactor had orphaned and fixed what half-worked.

**Dead UI removed** (all of it called endpoints deleted in the cloud-only refactor, or was unreachable):
- **Finish** (TaskTerminal) → `POST /tasks/:id/ready-for-review` (404). The whole `awaiting_review` concept is gone: removed the status from `TaskStatus` in shared, the "AWAITING REVIEW" list section, the **Create PR** (`/approve`, 404) and **Reject & Requeue** (`/reject`, 404) buttons, the auto-commit banners (their `metadata.autoCommit` is never written by cloud runs), the CLI `fastowl task ready` command, the MCP status-filter doc, and the `taskAwaitingReview` badge state in `prTableShared.tsx`. Pruned the legacy `findTaskHoldingEnvRepoSlot` helper (`taskQueue.ts`) that was the last backend reference.
- **Queue / Unqueue** (queued↔pending) — misleading: the scheduler dispatches *both* `pending` and `queued`, so "Unqueue" paused nothing, and tasks are created `queued` so `pending` was only ever reachable via the button itself. (`pending` stays in `TaskStatus` — it's the DB column default and legacy rows may carry it.)
- **"PR failed → Retry"** strip + `POST /tasks/:id/retry-pr` + `services/taskPullRequest.ts` — the stub could only ever 502 ("provider opens its own PR"). A bare `pullRequestError` now renders as a "No PR linked" tooltip note.
- **The whole non-cloud rendering branch**: Terminal/Files/Git tabs, `TaskFilesPanel`, `TaskGitPanel`, `TerminalHistory`, `useTaskFiles`, `useTaskGitLog`, the `+NN -MM` diff stats in the task list, and their `api.ts` client methods (`getDiff`/`getChangedFiles`/`getFileDiff`/`getGitLog`/`getTerminal`) — the backend routes no longer exist, and the branch was reachable for tasks with a missing/malformed env row. Both task-detail views now always render the TaskTerminal transcript.

**Abort actually cancels now.** `POST /tasks/:id/stop` used to just drop the log stream and mark the task `failed` while the PostHog Code run kept executing (and could open a PR FastOwl would never link, since the poller only reconciles `in_progress`). Added the optional `cancel?(task)` seam to `CloudTaskProvider`; the PostHog provider implements it via `PATCH /tasks/:id/runs/:runId/ {status: cancelled}` (PostHog has no dedicated cancel action — the PATCH signals the Temporal workflow; verified against `products/tasks/backend/api.py`). Stop now: remote cancel (best-effort, failure noted in the result as "may still finish") → `stopStreaming` → task lands in **`cancelled`** (not `failed`) with "Cancelled by user". New `routes/tasksStop.test.ts` (8 tests) covers the happy path, failed remote cancel, providerless task, and the 400 non-running guard.

**Smaller fixes along the way:** `PATCH /tasks/:id` now emits `task:status` on a status change (Cancel previously only updated the calling client); cloud-task detection unified on the shared `readCloudTaskMeta`/`readCloudTaskProvider` helpers (was three different hardcoded-PostHog checks across TaskTerminal/TaskDetail/TaskListItem — a second provider would have broken all of them); the cloud-run banner + PR-status-pill sheet now also work on the in-progress view (the `PRDetailSheet` was only mounted in the non-running return).

Typecheck + lint clean, 552 tests green across the workspaces (backend 545 incl. the 8 new).

## Session 51 — Updater channel-stranding diagnosis, PR-page loading state, reconnect catch-up audit

1. **Diagnosed prod auto-update not finding v0.1.2.** electron-updater's GitHub provider derives an update *channel* from the running version's prerelease identifier — a client on `0.1.1-nightly.…` only matches releases whose tag also carries the `nightly` channel (stable tags are excluded; only `alpha`/`beta` get cross-channel promotion). Confirmed live: the client's log resolved "latest version: 0.1.1-nightly.202606091540" hours after v0.1.2 published. Since the new plain-patch nightly versioning (d105c9) means no future release will ever carry the `nightly` channel again, **every installed `*-nightly.*` client is permanently stranded** and needs one manual reinstall (v0.1.2+); after that the channel inference returns null and `allowPrerelease` picks the newest release regardless. No code change needed.

2. **Desktop polish:** removed the CLI/MCP token copy card from Settings → Account. Added a centered loading state to `GitHubPageShell` (covers My PRs / Reviews / Merge Queue) while the initial open-PR fetch is in flight; the PR store now boots `loading: true` so the empty state can't flash before the first fetch effect runs (`usePullRequestSync` clears it when no workspace is selected).

3. **Reconnect catch-up audit + fixes.** Audited every WS-fed renderer surface for staleness across a socket outage (broadcasts are fire-and-forget). Already-correct: task reconcile, open-PR re-list, WS-client subscription/debug-filter replay, view-cohort re-announce, Debug-panel snapshot polling. Fixed the gaps: new `hooks/useOnReconnect.ts` centralises the genuine-reconnect pattern (existing task/PR reconciles refactored onto it); `TaskTerminal` re-runs transcript hydration on reconnect (missed `task:event`s were otherwise unrecoverable — the list payload drops `transcript` for egress and `reconcileTasks` re-attaches the local copy; merge dedups on seq so re-hydration is idempotent); `PRDetailSheet` refetches the open PR's detail (its local state only updated via its own WS subscription and never re-read the store); environment list + sidebar cloud-provider status refetch on reconnect. Consciously accepted: missed one-shot notifications (`merge_queue:blocked`, awaiting-review) — state recovers via the re-lists, only the toast is lost. Desktop tests green (56), tsc + lint clean.

4. **Get-mergeable prompt realigned to PostHog Code's signed-git tools (PostHog/code#2574).** The sandbox blocks raw `git commit`/`git push`; publishing goes through `git_signed_commit` (now refuses mid-merge — publishing a local merge linearized it, attributing every base-branch change to the PR), `git_signed_rewrite` (refuses ranges containing merge commits), and the new `git_signed_merge` (server-side two-parent Verified base merge, the "Update branch" machinery; 409 → rebase path). Our prompt's old rules — real local merge, never rebase, never force-push — were unfollowable there, which is why they "weren't being listened to". Rewrote `buildPostHogPrompt` (`packages/shared/src/prMergeable.ts`, shared by the desktop button + auto-keep watcher + merge queue) around the sanctioned paths: `git_signed_merge` first for base updates; conflicts via the only sanctioned rebase (`rebase origin/<base>` → resolve → `rebase --continue`, NOT `git commit` → `git_signed_rewrite`); tool refusals are authoritative (follow their recovery text, no workarounds); kept the before/after file-set leak guard, the path-agnostic ancestor/behind-by assertions, and the single-parent-imitation ban. `buildPostHogPrompt.test.ts` rewritten to lock the new contract (9 tests); backend green (543).

## Session 50 — Merge queue wedged in prod: a hung GitHub request froze the tick loop

Reported: prod merge queue had 15 mergeable `PostHog/posthog.com` PRs and nothing was merging. Pulled Railway deploy logs + queried the prod DB (Supabase). The queue had drained the group fine from 10:54–11:08, then went **dead silent** — 15 PRs frozen at the pristine `{status:"waiting", attempts:0}` the toggle route writes (no `lastError`, no `fix_task`), all `CLEAN`/`MERGEABLE`, freshly polled by the independent `prMonitor` loop. No `[mergeQueueProcessor]` log lines (log search verified reliable).

**Root cause.** `MergeQueueProcessor.tick()` sets `this.ticking = true` and only clears it in `finally`; every tick first does `if (this.ticking) return;`. Every awaited GitHub call in `processHead` went through `github.ts` `apiRequest`/`executeGraphql`, which used Node's global `fetch` (undici) with **no timeout / AbortController** — so a stalled socket (one merge request ~11:08) hung indefinitely, leaving `ticking === true` forever. Every subsequent 10s tick no-op'd: no merges, no fix dispatches, no errors. Other pollers (`prMonitor`) kept running, which is why the rows looked healthy but never merged.

**Fix (two layers).** (1) `fetchWithTimeout` helper in `github.ts` wraps every GitHub `fetch` in a 30s `AbortController` timeout, surfacing a descriptive throw instead of a hang; `apiRequest` rethrows it (already records to debugBus), `executeGraphql` records + retries it like a transient 5xx. (2) A watchdog in `tick()`: if `ticking` is still held past `MAX_TICK_MS` (5 min) the next tick force-releases the lock (logs `previous tick wedged for …`) so the loop self-recovers even if a non-HTTP await (DB / cloud-dispatch) stalls. New tests: request-timeout abort + graphql network-error retry (`githubService.test.ts`), wedge-recovery (`mergeQueueProcessor.test.ts`). Backend green (114 in the touched suites), tsc + lint clean.

Note: a redeploy of `fastowl-backend` is what clears the *current* in-memory wedge (a fresh process starts with `ticking=false` and drains the 15); the code fix prevents recurrence.

## Session 49 — Fix-prompt: guard against base-branch files leaking into the PR

Reported real-world failure: when a merge-queue / auto-keep-mergeable cloud fix run merges the base branch in to clear conflicts, base-only file changes occasionally leaked into the PR's diff. The "make this PR mergeable" prompt (`buildPostHogPrompt` in `packages/shared/src/prMergeable.ts`) already told the agent to merge (not rebase) the base in and do a one-line stray-change check; strengthened that into an explicit before/after file-set guard: capture `git diff --name-only origin/<base>...HEAD` BEFORE the merge and again AFTER resolving conflicts, require the two sets to be identical, per-file review the remaining hunks, and `git merge --abort` + redo (taking the base side for untouched files) on any leak — never push until the sets match. New `buildPostHogPrompt.test.ts` locks the guard's intent (before/after file-set check, base branch threaded into the commands, no-force-push/no-rebase rules retained) without over-asserting wording. Backend green (488).

**Root-cause follow-up (same session).** Diagnosed the actual failure on PostHog/posthog#61657 (786 files, +54.8k/−11.9k on a ~10-file Pendo PR). The "Merge branch 'master'" commit was a **single-parent** commit — a squash-merge of the base, not a real merge. Because master never became an ancestor (`behind_by: 160`, merge-base frozen at the original branch point), the three-dot PR diff attributed all 160 commits of master's churn to the branch. Hardened the prompt against exactly this: (1) the non-negotiable rules now forbid `git merge --squash` and equivalents (read-tree / `checkout base -- .` / apply) and require a true TWO-parent merge commit, with the no-rewrite rule scoped to *pushed* history plus a carve-out for undoing a local unpushed botched merge (`git reset --hard ORIG_HEAD`); (2) condition 3 adds a deterministic post-merge assertion — `git merge-base --is-ancestor origin/<base> HEAD` must pass, `git rev-list --count HEAD..origin/<base>` must be 0, and the merge commit must have two parents, else reset and redo. Two new test cases assert both guards. Backend green (490).

## Session 48 — Database egress, round 2: list endpoint + PR-loop projections

Follow-up sweep for other wasteful reads after the Session 47 transcript-poller fix. Verified findings (several of an earlier audit's "criticals" didn't hold up — `taskQueue.getQueuedTasks` only selects `pending`/`queued` tasks whose transcript is null, and `prMonitor` is already fully column-projected):

1. **`GET /tasks` list pulled every transcript, then discarded it.** `routes/tasks.ts` selected `{ task: tasksTable }` (all columns incl. the MB-scale `transcript`) but `rowToTask` drops the transcript without `includeTranscript` — so the blob left Postgres only to be thrown away in the serializer. Load-triggered (app launch / workspace switch / WS reconnect), so it never showed as a steady ramp but could be tens of MB per call for transcript-heavy users. Fix: a `taskColumnsNoTranscript` projection in `services/taskSerialize.ts` (co-located with `rowToTask`, which now accepts a transcript-optional row); the list selects that. Single-task `GET /:id` still selects the full row (transcript intentional). New `routes/tasksList.test.ts` pins both behaviours.

2. **`mergeQueueProcessor` (10s) + `prAutoMergeWatcher` (60s) bare `select()` of `pull_requests` rows.** Small today (~2 KB rows; only `lastSummary` is sizable and it's used) — done mainly as defense so a future large column on `pull_requests` can't silently leak. Each now selects a `QUEUE_COLUMNS` / `WATCH_COLUMNS` projection, and `PRRow` is narrowed to `Pick<…, keyof projection>` so the **compiler enforces completeness** — read a column not in the projection and tsc fails. Both the live and the freshness-reread selects are covered.

- Backend green (485), tsc + lint clean. The list fix is the meaningful one; the PR-loop changes are hygiene/defense.

## Session 47 — Database egress: observability + the transcript-poller fix

A single user's Supabase egress hit ~8 GB in one billing period (5 GB free + 2.92 GB overage), ramping from ~0 to 2.1 GB/day. Two parts:

1. **Debug-panel DB metering (observability).** Wrapped the postgres-js client's `unsafe()` — the single choke point every Drizzle query funnels through (see `drizzle-orm/postgres-js` session) — in `db/client.ts` to estimate the bytes each result pulls back and the query count. New `'db'` `DebugCategory`, a `debugBus.recordDbQuery` recorder with cumulative `dbStats` (egressBytes + requests, reset on Clear), and two snapshot-bar tiles ("DB egress" / "DB queries") plus the stream rows. Measurement is skipped while the panel isn't recording, so the serialize cost is only paid when watching. `isRecording()` exposed for that gate. Tests: `dbEgress.test.ts` (proxy mechanics — await vs chained `.values()`, count-once, recording-off-still-executes, rejection, BigInt) + `recordDbQuery` cases in `debugBus.test.ts`.

2. **Root-cause fix.** `cloudProviders/poller.ts` ran `db.select()` (all columns) over every `in_progress` task every 10s **only to compute one boolean** — including `transcript`, the cloud-run conversation log (often MBs). At 8,640 ticks/day a single stuck-in-progress task with a ~250 KB transcript ≈ 2.1 GB/day, matching the ramp. Narrowed the SELECT to the columns the scheduler needs and compute emptiness server-side via `CASE WHEN jsonb_typeof(transcript) = 'array' THEN jsonb_array_length(transcript) = 0 ELSE true END` (the `CASE` both guards `jsonb_array_length` from throwing on non-arrays and — unlike the first `NOT(... )` draft — never returns `NULL` for a null transcript, which a test caught: `null` would have read falsy and suppressed the terminal-run backfill stream). The streamer keeps its transcript in memory and overwrites on flush, so it never reads the column back — narrowing can't break streaming. Also removed the dead `tick()`/`init()`/`shutdown()` loop in `posthogCode/poller.ts` (never scheduled — only `reconcileTask` is used via the provider) that carried the same `select()`-all leak. Tests: `cloudPollerEgress.test.ts` pins the SQL to the old JS semantics across null / `[]` / populated-array / non-array-object via real pglite.

- Backend green (483), tsc + lint clean. Per-tick payload drops from MBs to bytes; 10s cadence left as-is.

## Session 46 — Merge-queue badge consistency + backend-created tasks sync to the desktop

Two reported inconsistencies on the GitHub panel:

1. **Badge swap.** The merge-queue indicator was a single if/else, so "Queued #N" was *replaced* by "Fixing"/"Merging"/"Blocked" — you lost the queue-membership info while a run was active. Now the "Queued #N" badge stays visible the whole time the PR is queued, with the activity badge (Fixing / Merging / Blocked) rendered alongside it.

2. **Backend-created tasks were invisible.** Merge-queue (and auto-keep-mergeable) fix runs are created via `createCloudTask` on the backend, which broadcast nothing — so they never entered the desktop task store. Result: they didn't appear in the Tasks screen, and the PR's task badge (rendered off `row.taskId`) deep-linked to a task that wasn't there → "Task not found". Fix:
   - New `task:created` WS event (`TaskCreatedEvent`) emitted from `createCloudTask` — covers the route, the merge queue, and the watcher in one place. Extracted `rowToTask` into `services/taskSerialize.ts` so the route and `taskCreate` serialize identically without a route↔service cycle.
   - Desktop `useApiConnection` adds a `task:created` handler that adds the task (deduped by id, so the optimistic add from the desktop's own create is unaffected). `addTask` is now idempotent (skip-if-present) so no source can double it or clobber richer local state.
   - Deep-link hardening: clicking a PR's task badge for a task not in the store now fetches it on demand (`api.tasks.get`) before navigating, so the link always resolves even if the broadcast was missed (client connected after the run started).

- Tests: merge-queue fire path now asserts `task:created` is broadcast; new desktop `addTask` idempotency suite. Backend green (460), desktop (38), tsc + lint clean.

## Session 45 — Merge queue: stop firing more than MAX_ATTEMPTS fix runs per PR

A queued PR was spawning far more than the 3-attempt budget of cloud fix runs (one PR had 7). Two compounding in-process bugs in `mergeQueueProcessor`:

1. **Counter reset by a transient clean reading.** Right after a fix run pushes commits, GitHub recomputes mergeability async, so the cached summary briefly reads `MERGEABLE`/`UNKNOWN`. Both `attempts = 0` resets (the accounting `else` branch and the step-4 re-arm) fired on that transient lie, so the cap never tripped and the queue fired runs forever. Fix: `attempts` is now monotonic — only ever incremented; a genuinely-fixed PR leaves the queue via a successful merge (the only trustworthy "fixed" signal), so no reset is needed. Added a **hard cap at the fire site** as an absolute backstop (never fire when `attempts >= MAX_ATTEMPTS`, even if a failed-merge flap downgraded the status).
2. **Active-run guard keyed on `row.taskId`.** `attachTaskToPullRequestRow` (called by *any* task created against the PR — a manual task, the auto-keep watcher) reassigns `pull_requests.taskId`, so the guard could check the wrong task and fire a duplicate while the queue's own run was in flight. Fix: guard on the queue's own `state.lastFixTaskId` (plus any other run still pointed to by `row.taskId`).

- 3 regression tests (no-reset-on-transient-clean / hard-cap-after-flap / no-duplicate-while-own-run-active). Backend green (460), tsc + lint clean.
- **Known twin:** `prAutoMergeWatcher` shares the same two patterns (transient-clean resets + `row.taskId` guard). It already has a fire-site hard cap so it's less exposed, and its re-arm-on-genuine-clean is intended (long-lived watcher) — so left untouched pending a decision on distinguishing transient vs genuine clean.
- Deployment note: the in-process serialization + own-run guard make this correct at 1 replica (current). A multi-replica backend would still need a DB-level claim (atomic compare-and-set) before firing.

## Session 44 — Notify when a merge-queue PR becomes blocked

When the merge queue exhausts its retry budget (3 failed cloud fix runs) a PR flips to `blocked` and waits for a human — good, but silently. Added a notification on that transition, plus the *reason*.

- **Backend**: `mergeQueueProcessor` now detects the *transition* into `blocked` (fire-once, not every 10s tick), captures a human reason via a new shared `mergeBlockerReason()` helper (conflicts / changes requested / unresolved threads / failing CI, with "behind its base" special-cased off `mergeStateStatus`), stores it on the queue state, and emits a dedicated `merge_queue:blocked` WS event (`emitMergeQueueBlocked`). A dedicated event — not the idempotent `pull_request:updated`, which replays on reconnect — guarantees exactly-once. The reason also rides the badge state (`publicState` + the list route's `publicMergeQueueState`) so a freshly-loaded blocked PR explains itself.
- **Desktop**: a top-level (panel-independent) `merge_queue:blocked` handler fires both an OS notification (resurrected the Electron `Notification` bridge) and an in-app `toast.error`, gated by a re-added Settings → Appearance → **Notifications** toggle (`fastowl:notify:mergeBlocked`, default on; OS path also needs granted permission, requested lazily). Clicking the OS notification focuses the app and jumps to the GitHub panel. The blocked badge tooltip now shows the reason.
- Kept the manual-intervention model (no auto-dequeue; auto-re-arm on a clean observation) unchanged.
- Tests: 9 `mergeBlockerReason` cases + 3 processor cases (notifies once with reason / no re-notify while blocked / reason persisted) + 2 desktop pref-helper cases. Backend green (457), desktop (36), tsc + lint clean.

## Session 43 — Remove the Inbox feature

Ripped out the standalone Inbox end-to-end. The prioritized "items needing attention" queue (new reviews/comments/CI failures/merge-ready) and the per-PR "unread updates" badges it powered are gone; PRs needing attention surface directly in the GitHub panel's Needs-attention / Mine / Review buckets.

- **Backend**: deleted `routes/inbox.ts` + its tests; dropped the `inbox_items` table (`schema.ts` + new migration `0023_drop_inbox.sql`); removed `requireInboxAccess` (`middleware/auth.ts`), `emitInboxNew`/`emitInboxUpdate` (`websocket.ts`), and the whole inbox-emission tail of `prCache.ts` (`emitDeltaInboxItems`/`createInboxItem`/bot-comment suppression). `prCache` still computes deltas + advances the PR-event cursors on `pull_requests` — that machinery just no longer materializes inbox rows. `pullRequests.ts` lost the unread-count join, the `unreadCount` field, and `POST /:id/seen`.
- **Shared**: removed `InboxItem*` / `InboxAction` / `InboxItemSource` types, the `inbox:new|update|remove` WS event types, and their `WSEventType` union members.
- **Desktop**: deleted `InboxPanel.tsx`; stripped inbox nav (sidebar Inbox entry + Active/Archive sub-views), store state/actions, `api.inbox`, `pullRequests.markSeen`, the `inbox:new`/`inbox:update` WS handlers, `useInboxActions`, and the GitHub-panel unread dots. Default panel is now **GitHub**.
- Backend suite green (445), desktop (34), tsc + lint clean.

## Session 42 — Admin-only, per-user debug panel

The debug bus exposed ALL backend traffic to any authenticated user (Session-question finding: a single global ring buffer, unscoped `/debug` routes, and a `broadcast()`-to-everyone `debug:event` sink). Locked it down and made it multi-tenant-aware so it can run in production limited to operators.

- **Admin gate**: new `users.is_admin` column (migration `0022`), surfaced on `AuthUser.isAdmin`. Granted via a `TALYN_ADMIN_EMAILS` bootstrap at login (promotes on token verify; never demotes) so no manual SQL is needed. New `requireAdmin` middleware guards every `/debug` route except `GET /debug/access` (which just reports `{admin}` so the desktop can hide the panel). The daemon internal-proxy identity is always non-admin.
- **Per-user attribution**: `DebugEvent` / `DebugRateLimitState` gain `ownerId`/`ownerLabel`. The github service registers `workspaceId → {ownerId, label}` (email or `@github`) at token load/connect; `recordHttp` / `recordRateLimit` pass `workspaceId` and the bus stamps the owner. `snapshot()` returns the `owners` list for the filter dropdown.
- **Filtering**: `getEvents`/`snapshot` take an owner filter (`<id>` | `system` | all); `/debug/events|snapshot?owner=` plumb it.
- **Optimised live stream**: the `debug:event` sink no longer `broadcast()`s to everyone — a dedicated fan-out sends only to **admin** clients, and only those whose per-client `debug:filter` matches the event's owner. So a non-admin gets nothing and an admin watching one user isn't fed everyone else's traffic over the wire. New `debug:filter` WS message + `ws.setDebugFilter()` (re-sent on reconnect).
- **Desktop**: DebugPanel gains a user-filter dropdown (All / System / per-account), re-fetches backfill + snapshot on change, pushes the WS filter, and shows an "admin-only" state when `/debug/access` says no.
- **To enable for yourself**: set `TALYN_ADMIN_EMAILS=<your login email>` in the backend `.env` and re-login.
- 14 new tests (debug bus attribution/filter + `matchesOwnerFilter`; WS admin-gating + owner-filter streaming). Full backend suite green (472), desktop (34).

## Session 41 — Global "core functionality missing" banner

Added an app-wide warning banner (full-width, top of `MainLayout`, above the sidebar) that surfaces when core functionality is unavailable — currently a disconnected GitHub, which silently pauses PR tracking, reviews, and the merge queue. Follows the silent-failure theme of Sessions 39–40: make the broken state loud instead of leaving the user to discover dead pollers.

- **`components/layout/SystemStatusBanner.tsx`**: renders a warning row per missing service (extensible array). For GitHub: distinguishes "configured but disconnected" (amber banner + **Connect GitHub** action that opens OAuth, plus a settings shortcut) from "OAuth not configured on the backend" (info, no action). Renders nothing while healthy or before the first status check (no flash).
- **`stores/workspace.ts`**: new `githubStatus` field + `setGitHubStatus` so the banner reacts app-wide without prop drilling.
- **`hooks/useSystemStatus.ts`**: mounts once in `MainLayout`, reuses `useGithubConnection` (fetch + on-focus re-check) and mirrors status into the store — so reconnecting via the browser clears the banner automatically.
- **`SettingsPanel.tsx`**: GitHub connect/disconnect now also writes the store, so an in-app disconnect surfaces the banner instantly (no focus event needed).
- 5 renderer tests (`SystemStatusBanner.test.tsx`) covering the show/hide matrix. Desktop suite green (34), tsc + lint clean.

## Session 40 — Surface GitHub token-load failures

Debugging a "no HTTP requests / no rate-limit tiles / pollers show 0 workspaces" report: the cause class is the backend loading **0 GitHub tokens** at startup, so `getConnectedWorkspaces()` is empty and every GitHub poller no-ops (0ms, no HTTP). The token-load failure was silent (only a `console.error` in `readAccessToken` on a decrypt failure — typically a `TALYN_TOKEN_KEY` mismatch vs. when the token was saved). Confirmed it's **not** a regression: no recent commit touched token loading / `getConnectedWorkspaces` / the integrations table (only the `workflow` scope constant changed).

- **`github.ts` `loadStoredTokens`**: now records a `tokens:loaded` debug event with `{loaded, failed, rows}` and an `ok:false` `tokens:load-failed` event on a hard failure, plus a clearer console summary (`Loaded N token(s) from M row(s) — K could not be read (likely a TALYN_TOKEN_KEY mismatch; reconnect GitHub to re-save)`). Makes the silent killer visible in the Debug panel's Events/Errors right after a restart, and distinguishes "no integration row" (need to connect) from "row present but undecryptable" (key mismatch → reconnect).

## Session 39 — Rate-limit tiles survive being rate-limited

Fixed the Debug panel's rate-limit cards vanishing after the account got rate-limited + the backend restarted. Root cause: `rateLimitPoller.tick()` called `getViewerLogin()` (a budgeted `/user` REST call) *first* and skipped the whole account if it failed — so when the account was rate-limited (or a restart wiped the in-memory login cache), the **free** `GET /rate_limit` was never fetched and the cards never repopulated. The cards live in an unpruned in-memory map, so they only clear on restart and then never came back.

- **`rateLimitPoller.ts`**: fetch `/rate_limit` unconditionally; the login is now a best-effort *label* only, falling back to `workspace <id8>` when it can't be resolved, so cards show even mid-rate-limit.
- **`debugBus.ts`**: prune rate-limit cards not re-observed within 3 min (≫ the 30s poll cadence). Makes cards honest if the poller/account goes away, and stops a relabelled fallback card lingering as a stale duplicate once the real login resolves.
- Note: cards are delivered via the 3s snapshot re-pull (`recordRateLimit` doesn't emit a live `debug:event`), so after enabling they populate within one poll tick.
- 4 new tests (2 poller tick label-resolution incl. the rate-limited fallback, 2 debugBus staleness pruning). Full backend suite green (461).

## Session 38 — Live merge-queue position badges

Fixed the `Queued #N` badge going stale: positions only ever updated on a manual list refresh because the live `pull_request:updated` events carried a placeholder position (the toggle route emitted `position: 0`, the processor `position: 1`), and nothing recomputed the *sibling* PRs' positions when the group's membership changed (enqueue, dequeue, merge).

- **`services/mergeQueueBroadcast.ts`** (new): single source of truth for queue position math — `computeQueuePositions(rows)` (1-based per `(repo, base)` group, FIFO by `mergeQueuedAt`) plus `broadcastMergeQueuePositions(workspaceId)`, which reloads the workspace's queued open PRs, recomputes, and emits a `pull_request:updated` per PR with its real position.
- **Wired the rebroadcast into every membership change**: the merge-queue toggle route (after enqueue/dequeue — dequeue also emits the toggled PR's cleared badge), the processor's merge-success path (survivors shift #2→#1), and the processor's `dequeue` (PR merged/closed upstream).
- **De-duped** the position logic: `routes/pullRequests.ts` now imports the shared `computeQueuePositions` for its GET list instead of a local copy, so the badge order can't drift from the order PRs actually merge.
- Also reduced the merge-queue poll interval 60s → 10s, and added the `workflow` OAuth scope so merges in large repos (PostHog/posthog) stop 403-ing on GitHub's workflow gate-check timeout (requires reconnecting GitHub).
- 5 new tests (2 broadcast integration via emit-spy, 3 parameterised `computeQueuePositions`). Full backend suite green.

## Session 37 — "Copy list" of filtered PRs

Added a **Copy list** button to the GitHub page header that copies the currently filtered PRs to the clipboard for pasting into Slack to request approvals. Writes a rich `text/html` bullet list of hyperlinks (Slack/Notion/docs paste as clickable links) plus a plain-text markdown fallback (`- [title](url)`) via a single `ClipboardItem`; falls back to `writeText(markdown)` where `ClipboardItem` isn't available. Respects every active filter (relationship/repo/search/needs-attention) since it copies off `filtered`. Toast reports the count. `GitHubPanel.tsx` only.

## Session 36 — First-run onboarding wizard

Replaced the (non-existent) onboarding with a guided, full-screen first-run wizard, fixing the dead first run the cloud-only/PR pivot left behind. Previously the app silently auto-created a "Default Workspace" on first load, dropped the user on the empty Inbox, and buried every real setup step (connect GitHub, watch repos, connect a cloud provider) in Settings.

- **Wizard** (`apps/desktop/src/renderer/components/onboarding/`): `OnboardingWizard.tsx` owns step state + a step indicator + Back/Next/Skip/Finish footer; four step components — `WorkspaceNameStep` (creates + selects the first workspace, replacing the silent default), `ConnectGitHubStep` (required; OAuth in browser, detected on focus), `WatchReposStep` (skippable-with-hint), `ConnectPostHogStep` (optional cloud agent).
- **Gate** (`App.tsx`): `AuthedApp` renders `<OnboardingWizard/>` vs `<MainLayout/>` off a new persisted `onboardingComplete` flag, waiting on a `loaded` signal from `useInitialDataLoad` so returning users never flash the wizard.
- **Store** (`stores/workspace.ts`): `onboardingComplete` flag + `setOnboardingComplete` setter, hand-rolled localStorage (`fastowl-onboarding-complete`) like the theme/debug flags.
- **Data load** (`hooks/useApi.ts`): removed the silent "Default Workspace" auto-create; added a first-load-only migration (ref-guarded so the wizard's own workspace doesn't trip it) that marks existing users onboarded; exposed `loaded`.
- **Reuse**: extracted the repo-list cache helpers into `lib/repoCache.ts` (shared key with the Settings card) and the GitHub status/focus-recheck loop into `hooks/useGithubConnection.ts`. Workspace typechecks + lints clean.

## Session 35 — Merge queue

Added a FastOwl-orchestrated **merge queue**: queue up a stack of PRs and they merge one-by-one, serialized per `(repo, base branch)`, with conflicts/behind-branches auto-fixed by the same cloud run the auto-keep-mergeable watcher uses. Solves the base-branch race — merging from the app no longer means hand-merging one PR, waiting for the base to settle, then merging the next.

- **Shared helpers** (`services/prCloudFix.ts`): extracted `resolvePostHogEnvId` + `linkedTaskStatus` + `ACTIVE_STATUSES` out of `prAutoMergeWatcher` so both background services share one copy.
- **Processor** (`services/mergeQueueProcessor.ts`): 60 s poller, mirrors the watcher. Each tick loads queued open PRs FIFO by `merge_queued_at`, groups by `(workspace, repo, base)`, and acts only on each group's head — one head per group + the single-threaded `ticking` guard + a synchronous awaited merge means two same-base PRs never both merge in a tick, while distinct bases/repos proceed in parallel. Per head: refresh stale state → merge if clean (`githubService.mergePullRequest`, drop off the queue, promote the next) → else fire the shared `buildPostHogPrompt` cloud run (which merges the base in, curing both conflicts and `BEHIND`), wait via the active-task guard, retry, blocked after 3 attempts. `merged:false` / thrown merge → stay queued and record the error.
- **The race fix**: `prNeedsFollowup` misses `BEHIND`/`BLOCKED` (exactly the post-merge state of every sibling PR), so a `needsUpdate` check funnels those into the same fix path.
- **API + DB**: migration `0021_pr_merge_queue` (`merge_queued` bool, `merge_queued_at` for FIFO order, `merge_method`, `merge_queue_state` jsonb, partial index). New `POST /pull-requests/:id/merge-queue` toggle; list endpoint computes 1-based per-group `position`; `reconcileTerminalState` drops closed/merged PRs off the queue. Queue state flows through PR payloads + the `pull_request:updated` WS event.
- **Desktop**: "Add to merge queue" toggle + status indicator on the PR detail-sheet header and a row action/badge (`Queued #N` / `Merging` / `Fixing` / `Blocked`) on the GitHub list.
- 13 new parameterised processor tests (real pglite DB, `mergePullRequest` spied) covering clean-merge, conflict→fix, BEHIND→fix, serialization, different-base parallelism, attempt cap, re-arm, `merged:false`, thrown merge, no-env, and ignore-non-queued. Full backend suite green (412 tests). Workspace typechecks + lints clean.

## Session 34 — Per-PR "auto-keep mergeable" watcher

Added an opt-in, per-PR toggle that keeps a PR mergeable unattended and indefinitely: a background watcher repeatedly fires the existing "take this PR to a clean, mergeable state" cloud run whenever the PR has a blocker (conflicts / failing required CI / changes-requested / unresolved review threads), never two at once, and keeps watching after the PR is clean so a conflict that appears days later is auto-fixed too.

- **Shared helpers** (`packages/shared/src/prMergeable.ts`): moved `prNeedsFollowup` / `buildIssuesSummary` / `buildPostHogPrompt` out of `GitHubPanel.tsx` so the manual button and the watcher build the *identical* task. The prompt builder is now parameterised (`{ owner, repo, number, summary }`).
- **Watcher** (`services/prAutoMergeWatcher.ts`): 60 s poller over `pull_requests WHERE auto_keep_mergeable AND state='open'`. Per PR: refresh stale summaries (`prMonitor.refreshPr`), skip if a linked run is active, fold the last auto-run's outcome into an attempt counter, re-arm on a mergeable observation, then fire via the shared `createCloudTask` helper. Runaway guard: pause after 3 consecutive un-mergeable auto-runs; reaching mergeable resets the counter (chosen over digest-based re-arm because the agent's own pushes change the digest).
- **Task creation** factored into `services/taskCreate.ts` (`createCloudTask`), shared by `POST /tasks` and the watcher.
- **API + DB**: migration `0020_pr_auto_keep_mergeable` (boolean `auto_keep_mergeable` + `auto_merge_state` jsonb + partial index). New `POST /pull-requests/:id/auto-keep-mergeable`; flag + compact watcher state flow through PR payloads and the `pull_request:updated` WS event.
- **Desktop**: toggle in the PR detail-sheet header (gated on PostHog Code connected) + "Watching"/"Paused" badge on the PR list row.
- 8 new parameterised watcher tests (real pglite DB) covering the decision matrix; full backend suite green (407 tests). Workspace typechecks + lints clean.

## Session 33 — Cloud-only pivot: strip local execution, build the CloudTaskProvider seam

Refocused FastOwl as a **PR-management app that delegates to cloud coding agents**. Ripped out the entire local-execution layer and folded PostHog Code into a pluggable provider abstraction. Landed as a series of small commits:

1. **Provider seam + cloud-only task queue.** New `services/cloudProviders/` (`types`, `registry`, generic `poller`). PostHog Code wrapped as `cloudProviders/posthog/provider.ts` (delegates to the existing `posthogCode/*` executor/streamer/poller — no rewrite). `taskQueue` lost the idle-agent/(env,repo)-slot/git-prep machinery; it now resolves a task's cloud-marker env → provider → `dispatch`. Neutral `CloudTaskMetadata` + `readCloudTaskMeta`/`readCloudTaskProvider` helpers in shared (legacy `posthog*` fields read through them).
2. **Generic `/api/v1/cloud-providers` route** + reusable `ensureCloudEnvironment` helper. `/posthog` kept as a back-compat alias for the existing Settings card.
3. **Strip.** Deleted the daemon services (registry/ws/proxy/auto-update) + `/daemon-ws`, agent/agentStructured/claudeCli/ai (local Claude spawning), permission service/hook/inbox, backlog + continuousBuild, git/gitContext/gitLogService/taskCommitSnapshot/taskFileWatcher, and the agents/permission/backlog/daemon routes. Slimmed `routes/tasks.ts` to the cloud surface and `routes/environments.ts` to list+delete. `taskPullRequest` → dormant stub. Deleted `packages/daemon`, the shared `daemonProtocol`, and the daemon CI. Desktop: removed the local-daemon lifecycle (main IPC/menu/preload), `useLocalDaemon`, `AddEnvironmentModal`, and the Settings Environments/Continuous-Build sections.
4. **Schema collapse** (migration `0017_cloud_only`): wiped tasks, dropped `agents`/`backlog_*` tables, slimmed `environments` to a secret-free marker, dropped `tasks.assigned_agent_id`/`terminal_output`.
5. **CLI/MCP**: dropped backlog commands/tools + `mark_ready_for_review`.

Full workspace typechecks; 365 backend tests pass. Design + remaining work (Codex Cloud, Claude Routines) in [`CLOUD_PROVIDERS.md`](./CLOUD_PROVIDERS.md). Note: the daemon-everywhere / continuous-build roadmaps are now superseded.

## Session 32 — Link PR-fix tasks to their PR row + live in-progress indicator

Starting a task from a PR row ("Get PR mergeable" / "Address PR") now **associates the task with that `pull_requests` row**, and the GitHub list shows a status-aware badge on the row that deep-links to the task.

- **Linking.** `CreateTaskRequest` gains optional `pullRequestId`. New `attachTaskToPullRequestRow()` in `prCache.ts` sets `task_id` by row id (workspace-scoped; **overwrites** any prior link so the row tracks the *active* fix task — the reverse of `linkTaskToPullRequest`, which is sticky for PRs a task *opens*) and emits `pull_request:updated`. The tasks `POST` route links best-effort (fire-and-forget) after insert.
- **Indicator.** `PRTableRow` reads the linked task's live status from the workspace store (`task:status` keeps it current). Shows **"Working"** (spinner) while `pending/queued/in_progress`, **"Review"** (amber) while `awaiting_review`, and **nothing** once `completed/failed/cancelled` — matching "indicator while running, gone when complete". Unknown/unloaded status falls back to a plain "Task" badge so the link isn't lost. Clicking opens the task (`selectTask` + Queue panel).
- **Button gating.** The start-task buttons suppress while a task is active on the row (create-task hidden via `!taskActive`; "Get PR mergeable" disabled with a clearer tooltip) so you can't double-launch. Both create handlers pass `pullRequestId` and optimistically set the row's `taskId` so the badge appears instantly. The `pull_request:updated` handler now patches `taskId`.
- **Tests.** 4 new `attachTaskToPullRequestRow` cases (set+emit, overwrite, unknown-id no-op, cross-workspace refusal). prCache suite green (32 tests); typecheck + lint clean across shared/backend/desktop.

## Session 31 — Instant PR panel switching (seed-from-cache) + Esc to close

Switching PRs felt laggy because `PRDetailSheet` blocked on a full `GET /pull-requests/:id` round-trip every time. Now the list passes the already-loaded row (`seedRow`) into the panel; the panel renders that cached summary **instantly** (title, branch, status pill, check rollup) and refreshes the live detail (reviews/files/check rows/body) in place.

- **`view` selection** (`useMemo`): the fetched `data` once it matches the current `pullRequestId`, else the `seedRow` while the fetch is in flight. An id guard stops the previous PR's detail flashing during a switch (and the `pull_request:updated` WS patch now also guards `prev.row.id === p.id`).
- **Minimal spinner**: a small `Loader2` next to the title while `detailPending` (current PR's detail fetch unresolved), instead of a full-panel "Loading…". Threaded into `OverviewTab` ("Loading description…") and `ChecksTab` ("Loading checks…") so they show a spinner rather than the empty/"unavailable"/GitHub-fallback states while loading. The "Detail fetch unavailable" note only shows once the fetch resolves empty.
- **Esc closes the panel** (`keydown` listener, both layouts). QueuePanel's overlay usage passes no `seedRow`, so it keeps the original full-loading behaviour — unchanged except it now also closes on Esc.

## Session 30 — Fix: switching the open PR detail panel from the list

The Session 28 "shift the list left" margin hack didn't actually fix switching — `marginRight: min(42rem, 100%)` collapses the list to zero width on any content area ≤ 42rem (common at typical window sizes), so rows still weren't clickable and the panel never switched. Replaced it with a real split layout: on the GitHub page the `PRDetailSheet` now renders as an **in-flow flex sibling** beside the list (new `layout="inline"` prop) instead of a `fixed` overlay, so the list keeps `flex-1` width and stays clickable; clicking another PR changes `selectedId` and the already-mounted sheet refetches. `QueuePanel` keeps the default `layout="overlay"` (unchanged). The sheet's container class switches between `h-full shrink-0` (inline) and the original `fixed inset-y-0 right-0 z-40 shadow-2xl` (overlay).

## Session 29 — Replace hand-rolled markdown with react-markdown

Ripped out the bespoke `renderMarkdownish` parser (`apps/desktop/src/renderer/lib/markdown.tsx`) and rebuilt it on **react-markdown + remark-gfm + rehype-raw + rehype-sanitize**. The hand-rolled parser kept hitting gaps on real PR/review content (tables, then `<details>` — patched twice); the library handles GFM (tables, task lists, strikethrough, autolinks) and raw HTML for free, sanitized.

- **Same public API.** `renderMarkdownish(text, variant)` is now a thin shim over a new `<Markdown text variant />` component, so all four call sites (`AgentConversation` feed, `PRDetailSheet` surface ×3) are unchanged. The `feed`/`surface` palette split is preserved via a per-variant `components` map (links, code/pre, headings, lists, blockquote, hr, tables, details/summary, img).
- **Safety.** `rehype-raw` → `rehype-sanitize` (extended `defaultSchema` to allow `<details>`/`<summary open>`) so untrusted GitHub HTML renders without XSS.
- **Jest + ESM.** react-markdown's plugin tree is pure ESM and breaks ts-jest's CommonJS transform — followed the repo's existing pattern (the `@pierre/diffs/react` mock) and stubbed `react-markdown` / `remark-gfm` / `rehype-raw` / `rehype-sanitize` via `moduleNameMapper` + `.erb/mocks/*`. Markdown-rendering correctness now relies on react-markdown's upstream tests; our jest test is a wrapper smoke test (the old DOM-level table/details tests were removed since the renderer is mocked). Verified the real bundle with a production `build:renderer` (webpack resolves the ESM cleanly).

## Session 28 — PR detail panel polish (checks filter, reviews experience, panel switching)

Four UX improvements to the PR detail side-panel (`PRDetailSheet`) and the GitHub list:

- **Checks tab — tile filters.** The Passed/Failed/Running/Skipped rollup tiles are now toggle buttons (`CheckCountTile` → `<button>` with `aria-pressed` + ring highlight). Clicking one filters the per-check list to that state; clicking again clears. Tiles with a zero count are disabled.
- **Checks tab — failed first.** The per-check list is sorted by a fixed state rank (`failure → in_progress → pending → success → skipped`, unknown states last) so anything needing attention sits at the top.
- **Reviews tab — full GitHub-like experience.** New backend endpoint `GET /pull-requests/:id/reviews` (`fetchPRReviewDetail` / `decodeReviewDetail` in `githubGraphql.ts`) does one GraphQL round-trip for every submitted review (with body), every inline review thread (grouped, with diff hunk + resolved/outdated state), and the top-level conversation comments — all with author avatars and markdown bodies. The tab fetches this on open and renders Reviews / Inline comments (unresolved-first, with an unresolved count) / Conversation sections. Replaced the old terse `ActivityList` link-outs.
- **PR list — switch the open panel.** The detail panel overlays the right edge; the GitHub list now shifts left (`marginRight: min(42rem, 100%)`) while a PR is selected, so every row stays visible and clicking another PR switches the panel.

New renderer API types: `PRReviewDetail` / `PRReviewThread` / `PRReviewThreadComment` / `PRReviewDetailReview` / `PRConversationComment` + `pullRequests.reviews(id)`. Five new `decodeReviewDetail` tests (filtering, sort order, diff-hunk extraction). Typecheck + lint clean, backend suite green.

## Session 27 — "Get PR mergeable" follow-up button + unresolved-comment count

Added a one-click way to dispatch a **PostHog Code** cloud run that takes a PR to a clean, mergeable state (resolve every review comment, get CI green, resolve conflicts — looping until all three hold). Modelled on the `task-script/pr_review_followup/create_pr_tasks.py` prompt.

- **Unresolved review thread count surfaced in the GitHub list.** Extended the batched GraphQL fetch (`services/githubGraphql.ts`) with an aliased `unresolvedThreads: reviewThreads(first: 100) { nodes { isResolved } }`, counting unresolved into a new `PRSummary.unresolvedReviewThreads`. Persisted through `prCache` (`summaryToJsonb` / `rowToSummary` / placeholder) and exposed on the renderer `PRSummaryShape` (optional, for rows cached before the field existed). Rendered as an amber `MessageSquare N` badge next to the Status pill in `GitHubPanel`.
- **The button** sits in the row action cluster, immediately left of the copy-branch button. Only rendered when PostHog Code is connected for the workspace *and* the PR is open; disabled (greyed) unless the PR actually has something to fix — `prNeedsFollowup()` = merge conflicts ∥ changes-requested ∥ failing checks ∥ `unresolvedReviewThreads > 0`.
- **Dispatch path:** builds the full follow-up prompt (`buildPostHogPrompt`) and creates a `pr_response` task with `assignedEnvironmentId` = the auto-provisioned `posthog_code` env, which the task queue already routes to `dispatchTaskToPostHogCode`. Then jumps to the new task. PostHog status is fetched via `api.posthog.getStatus`; the cloud env id comes from the workspace store.
- **Tests:** two new decode cases in `githubGraphql.test.ts` (counts unresolved; defaults to 0 when absent); updated the three `PRSummary` test builders. Full backend suite green (117).

## Session 26 — PostHog Code: cloud execution provider

Added **PostHog Code** as a new way to run tasks — a `posthog_code` environment type that delegates the entire agent loop to PostHog's sandboxed cloud runners instead of driving Claude locally over a daemon. Landed in two commits (backend, then desktop UI).

**The key insight:** PostHog Code is a *delegation* provider, not a daemon transport. FastOwl's existing model drives the agent itself (spawns `claude -p`, parses JSONL, branches git, auto-commits → `awaiting_review`). PostHog Code instead owns the whole loop on its own machine (clones repo, runs agent, commits, pushes, opens a PR). So FastOwl's role becomes **create → poll → ingest the PR**. It's a new execution provider at the task-queue level, *not* a new entry in the daemon `stream_spawn`/`git` wire protocol.

**API used** (`{host}/api/projects/{projectId}`, `Authorization: Bearer <personal key>`): `POST /tasks/` (create), `POST /tasks/{id}/run/` (`{mode:'background', runtime_adapter, model}`), `GET /tasks/{id}/` → `latest_run.{status, branch, output, error_message, log_url}`. Run status enum `not_started|queued|in_progress|completed|failed|cancelled`. PostHog auto-detects the opened PR URL and attaches it to the task, so we scan the task/run JSON for the first `github.com/.../pull/N`.

- **Backend** (`services/posthogCode/`): `client.ts` (typed REST), `credentials.ts` (per-workspace key stored encrypted on the existing `posthog` integration row, reusing `tokenCrypto`), `executor.ts` (create remote task + start run, stash `posthogTaskId/posthogRunId` on `task.metadata`, idempotent), `poller.ts` (10s reconcile of in-flight runs → `awaiting_review` when a PR opened, else `completed`; `failed`/`cancelled` → `failed`; links the PR via `linkTaskToPullRequest` so it flows into the existing PR monitor + inbox).
- **Task queue fork:** `posthog_code` tasks bypass the idle-agent / `(env,repo)` slot / concurrency machinery entirely (no working-tree contention in the cloud — concurrency control dropped by design) and are excluded from stuck-recovery (they have no FastOwl agent). Cloud envs are opt-in: excluded from the "any connected env" default pick.
- **Auth model:** key + project id live **per workspace** (the `posthog` integration row); the env is a secret-free marker. Created/booted as `connected` with no pairing.
- **Routes:** `/posthog` workspace-credential CRUD — key is write-only over the API and validated (`ping`) before persist.
- **Desktop:** Add-Environment "PostHog Code (cloud)" option; Settings → Integrations PostHog Code card; Create-Task runtime/model overrides when a cloud env is picked; a cloud-run banner (status + log link) in the task detail. PR pill renders from `metadata.pullRequest` once the poller links it.

**Open follow-ups:** confirm the exact PR-URL field against a live response (currently regex-scans the whole task/run JSON); optional live transcript via the `GET …/runs/{id}/stream/` SSE endpoint (left a clean seam, not built — decision was status+final-result only).

**Test note:** full backend suite shows ~22 `PGlite is closed` cleanup failures under the parallel run (pre-existing infra flakiness); all touched files pass clean in isolation (taskQueueProcess 9/9, environments+tasks+environmentService 65/65).

## Session 25 — GitHub page: bug fixes, row actions, unread dots, review-requested PRs

Continuation of the Conductor-parity work, focused on the GitHub page (`GitHubPanel.tsx`) after a full assessment of its bugs/gaps (#1–#9). Landed in four commits:

- **Quick fixes + table polish (#1 #2 #3 #9).** Refresh now triggers a real GitHub force-poll (`repositories.forcePoll()`) then re-reads the cache — previously it only re-read the local DB, so "Refresh" never actually hit GitHub. Added a "Connect GitHub" empty state (via `github.getStatus`) so a disconnected workspace no longer shows the same misleading "no PRs match" message as a connected-but-empty one. Sortable Updated column, live counts on the Open / Needs-attention pills, keyboard-navigable rows, a Task badge that deep-links to its task, and fixed the stale tabs doc comment.
- **Row actions (#8).** Each PR row reveals on hover a squash-merge action (confirm-gated, shown only when GitHub reports the PR mergeable, reusing `pullRequests.merge`) and a create-task action that spins up a `pr_response` task for the PR and jumps to it.
- **Unread indicators (#7).** A blue dot + count on PRs with unread activity. Derived with **zero schema change** from unread `inbox_items` linked to a PR via the existing `data->>'prUrl'` jsonb key (there's no inbox→PR FK). The list route (`GET /pull-requests`) now returns `unreadCount` per row via one grouped query; opening a PR clears the dot and flips its inbox items to read via new `POST /pull-requests/:id/seen`; an `inbox:new` WS event bumps the dot live. +4 route tests.
- **Review-requested PRs (#4).** The monitor previously watched only PRs authored by the connected user. It now also watches PRs where the user is a requested reviewer (`requested_reviewers` from the REST list), persisting a new `review_requested` boolean column (migration `0014`). `pollRepo` widens the filter and threads the flag through `upsertFromBatchResult` → `upsertRow`. `sweepClosed` gained a guard: a review-requested PR drops off the watch list the moment the user reviews it but stays OPEN on GitHub, so we no longer wrongly mark still-open PRs closed. The list route gained a `relationship=authored|review_requested|all` filter, the page a Mine/Review/All pill group, and review-requested rows a purple "Review" badge. +6 tests (3 monitor, 1 route filter, plus sweep-guard + flag assertions).

**Migration note:** `drizzle-kit generate` is currently broken by a pre-existing snapshot collision in `meta/`, unrelated to this change — `0014_pr_review_requested.sql` + the `_journal.json` entry were hand-written to match convention (the runtime postgres migrator only reads the journal + `.sql` files).

**Recovered session:** this work resumed a prior session (`03099785…`) that crashed mid-research on a `thinking`-block API error before writing any code.

## Session 24 — Conductor-parity polish (feed perf, PR diffs, merge, markdown)

Kicked off after comparing the task view against Conductor (conductor.build). Goal: close the "feels buggy / lower quality" gap. Full assessment + remaining backlog in [`docs/QUALITY_PARITY.md`](./QUALITY_PARITY.md). Landed in four commits:

- **Feed performance (the main "sluggish" cause).** Every stream-json `task:event` did an O(n) dedup + O(n log n) re-sort of the whole transcript AND triggered a full React re-render — dozens of times a second during a turn. Now: `task:event` is buffered per task in `useApi.ts` and flushed once per frame (`setTimeout(40ms)` so it survives backgrounding); append is the hot path, re-sort only on a detected out-of-order seq; drains on teardown. `BlockView` in `AgentConversation.tsx` is now `React.memo`'d with a cheap render-affecting signature (`blockSignature`) so a transcript update only re-renders the live streaming tail + any mutating permission card, not every settled block.
- **PR file diffs in-app.** `GET /pull-requests/:id/files` exposes the previously-dead `githubService.getPRFiles`. The `PRDetailSheet` Files tab now fetches the list, shows a changed-files summary (count + total +/-), and renders each file's diff inline via `@pierre/diffs` `PatchDiff` (the same viewer the task Files tab uses) in an expandable accordion. GitHub's hunks-only `patch` is wrapped in a synthesised `diff --git`/`---`/`+++` header (`toUnifiedDiff`) so added/removed files render as pure inserts/deletes. +4 route tests.
- **In-app merge + per-check breakdown.** `POST /pull-requests/:id/merge` (squash default) wraps `githubService.mergePullRequest` and force-refetches so the row flips to merged immediately. The sheet shows a green Merge button only for an open, mergeable PR, behind a two-step confirm. **This deliberately reverses the Phase-7 decision** to make all PR writes deep-links — merge is now the one in-app write path; review/comment composition still deep-links out. Per-check rows (`checkContexts`: name, normalized state, link) are now exposed on the live `PRSummary` detail fetch (data was already normalized for the rollup counts; not persisted to the cached summary, so no DB bloat) and rendered as individual rows in the Checks tab. +1 graphql decode assertion.
- **Richer markdown in the feed.** `renderMarkdownish` (still dependency-free) now covers headings, bullet/numbered lists, blockquotes, horizontal rules, and an inline parser for `**bold**`, `*italic*`, `[links](url)`, and `` `code` ``. Unrecognised input still falls through as a plain paragraph.

**Already-fixed-in-code backlog items** confirmed during the sweep: the "duplicate Stop button" (QueuePanel intentionally renders none — TaskTerminal owns Finish/Abort) and the "non-functional inbox 3-dot menu" (fully wires markRead/archive/delete) were both already resolved.

**Deferred** (need backend contract work — see QUALITY_PARITY.md): composer model picker + attachments (adding non-functional UI would reintroduce the placeholder feeling we're removing), a true simultaneous 3-pane layout (the PR sheet overlay already gives task→PR continuity), and desktop component/E2E test coverage.

## Session 23 — PR / CI tracking rebuild (Phases 1–7)

Replaces the per-PR-REST-fan-out poller + the lone PRListWidget with a batched-GraphQL DB-as-cache pipeline plus a real GitHub page and a task-screen status pill. Inspired by supacode's `batchPullRequests` + `statusCheckRollup` design (see `docs/SUPACODE_COMPARISON.md`).

- **Phase 1 — schema + GraphQL helper.** `pull_requests` table (DB-as-cache: minimal jsonb summary + cursors, no per-check rows, no raw payload). `services/githubGraphql.ts` with `batchPullRequests` (chunks of 25, up to 3 concurrent queries), `normalizeCheckState` (collapses GitHub's three-axis status/conclusion/state into one verdict), `computeBlockingReason` (mergeable + mergeStateStatus + reviewDecision + checks.failed → mergeable | merge_conflicts | changes_requested | checks_failed | blocked | unknown), `computeCheckDigest` (hash of head_sha + sorted check states for cheap "checks changed?" detection).
- **Phase 2 — prCache + cursor deltas.** `services/prCache.ts` with `getOrFetchPRSummary` (TTL hit / GraphQL fetch on miss), `forceFetchAndUpsert` (always GraphQL), `upsertFromBatchResult` (caller already has summary), and pure `computePRDeltas` (walks freshest-first arrays up to the persisted cursor; avoids re-emitting CI-failure on a still-failing PR via digest scan). Rewrote `services/prMonitor.ts`: removed the in-memory state map (lost on every restart, the source of "unread events vanishing on deploy"), per-tick REST list of user-authored open PRs filtered by `currentUserLogin`, batch-fetch stale ones via GraphQL, sweep-closed for rows that disappear from the open list. Same four inbox types preserved.
- **Phase 3 — read routes + WS.** Four `/api/v1/pull-requests` endpoints (list / get / refresh / focus). New `pull_request:updated` WS event fires on every upsert. Detail endpoint returns the persisted row + a fresh GraphQL fetch for recentReviews/comments (cache fallback when GraphQL is down).
- **Phase 4 — task-screen pill.** `widgets/PRStatusPill.tsx` (blocking-reason variants + 5-segment check rollup bar), `widgets/PRDetailSheet.tsx` (slide-in side panel — skeleton in this phase, tabs in Phase 5). Wired into `QueuePanel` task header. `prCache.linkTaskToPullRequest` seeds the row at PR-open time with task_id (race-safe), so the pill resolves the linked PR via `task.metadata.pullRequest.id`.
- **Phase 5 — GitHub page rebuild.** Replaces `PRListWidget` (deleted in Phase 7) with a real table + filter bar (state pills / repo dropdown / needs-attention / search). Side-sheet got Overview / Checks / Reviews / Files tabs. WS-driven row patching (no full refetch on every event).
- **Phase 6 — adaptive polling.** `services/prFocus.ts` — in-memory focus + 5s post-refresh cooldown registry. `prMonitor.filterStale` consults `ttlFor` per row (30s focused / 60s unfocused / Number.MAX_SAFE_INTEGER while in cooldown). Poll tick dropped to 30s. Desktop declares focus from both surfaces (task screen pill + GitHub-page detail sheet).
- **Phase 7 — cleanup.** Deleted `PRListWidget` + `PRDetailModal` + every `api.github.*` PR-management method (list/get/files/checks/create/merge/review/comment) + the matching backend routes. `githubService.createPullRequest` stays (used by `openPullRequestForTask`). Aligned `InboxItemType` with what the backend emits (`pr_review`, `pr_comment`, `ci_failure`, `pr_ready`) — was previously `pr_ci_failure` / `pr_ready_to_merge` and missing `pr_comment` entirely. Added the missing `pr_comment` icon to InboxPanel.

**Tests**: 147 across the new surface (38 GraphQL helpers, 22 prCache + 3 linkTaskToPullRequest, 8 prFocus, 18 prMonitor poll, 18 routes, 6 schema, plus 12 repo CRUD + 12 taskPullRequest + 10 routes/github survivors).

## Session 22 — Hardened auto-commit; refuse to advance silently

Re-litigates the "task hits awaiting_review with uncommitted files in the working tree" symptom. Forensic on the prod DB found two real shapes: (a) `metadata.autoCommit` getting silently overwritten when the commit DID happen — `autoCommitAndSnapshot`'s persist racing with the fire-and-forget `void recordGitCommand` writes from inner `gitService` calls, both doing un-serialized `SELECT metadata → modify → UPDATE`, last writer wins; (b) `commitAll` reporting `no-changes` even on a dirty working tree, with no signal in the UI and the task auto-advancing to `awaiting_review` where Reject would discard the work.

- **Per-task metadata mutex** (`services/taskMetadataMutex.ts`, new): `patchTaskMetadata(taskId, patch)` serializes every metadata RMW per-task. `gitLogService.recordGitCommand`, `taskCommitSnapshot.persistAutoCommitStatus`, `writeFinalFilesSnapshot`, `taskPullRequest.openPullRequestForTask` (success + error paths), and `taskQueue` rollback's `lastScheduleError` writer all route through the same chain. Atomic SQL `||` jsonb merges (agent.ts session_id_captured + runtime tag) stay as-is — they're already safe.

- **Hardened `autoCommitAndSnapshot`** (`services/taskCommitSnapshot.ts`): pre-flight `getPorcelainStatus` snapshot, post-commit verification, branch-ahead check via new `gitService.commitsAhead`. Result type grows an `advanceOk: boolean` contract — callers MUST honour it. New failure modes: `dirty-after-commit` (loud red banner, working tree still dirty after `add -A` + `commit`; most likely cause is wrong cwd or daemon misroute), `no-changes-no-commits` (clean tree but branch has 0 commits ahead of base — the agent didn't actually do anything), `wrong-branch` (couldn't switch HEAD onto the task branch). `no-changes` split into `no-changes-prior-commits` (advanceOk: true — Claude already committed) vs `no-changes-no-commits` (advanceOk: false). Every outcome persists a structured `metadata.autoCommit` record with reason, error message, and a porcelain preview.

- **Block the awaiting_review transition on hard failure**: `agent.handleStructuredExit`, `agent.maybeAutoFinishAgentTask`, and `POST /tasks/:id/ready-for-review` all check `result.advanceOk`. On false they leave the task in `in_progress` (not failed — failed exposes Reject which destroys the dirty tree) and emit `task:status` so the desktop re-renders. The route returns 409 with the reason instead of silently flipping to awaiting_review.

- **UI surface** (`QueuePanel.tsx`): three new banners above the tabs. Loud red on `in_progress + advanceOk=false` with a "Retry auto-commit" button (re-runs `/ready-for-review`, the same code path); subtle green on `awaiting_review + committed` showing sha + message; subtle amber on `awaiting_review + no-changes-prior-commits` ("branch already had commits — nothing new to add"). Hooks up to existing `useTaskActions().readyForReview`.

- **Tests**: `helperServices` autoCommit suite rewritten for the new shape — `advanceOk`, the four new failure modes (dirty-after-commit, no-changes-no-commits, wrong-branch, error), separate prior-commits-vs-no-commits assertions for the no-changes split. `tasksLifecycle` adds the 409 path on `advanceOk=false` and asserts the task stays `in_progress`. `agentLifecycle` mocks updated to the new result shape. All 572 backend tests pass; typecheck + lint clean.

## Session 21 — Split commit off approve; cache diffs on the transition

Moves the auto-commit + file-diff snapshot from `/approve` to the `in_progress → awaiting_review` transition. Motivation: the Files tab used to go blank once the env disconnected (because `getChangedFiles` is a live git query), and the working tree stayed dirty until the user approved, blocking back-to-back tasks on the same repo. With the snapshot persisted on the transition, the Files tab survives env offline, and the approve button shifts role — it's now "Create PR", the terminal step.

- **`autoCommitAndSnapshot(taskId)`** (`services/taskCommitSnapshot.ts`, new): checks out the task branch, regenerates the commit message via `generateCommitMessage`, runs `commitAll`, then persists a `{files[], perFileDiffs}` snapshot on `task.metadata.finalFiles` (per-file diff capped at 50 k chars). Same shape the old approve path wrote; overwrites on each call so follow-up rounds produce a fresh cumulative snapshot. Non-fatal on empty-changeset, env offline, or any git error — callers always transition.

- **Wired into all three `in_progress → awaiting_review` sites**: `POST /tasks/:id/ready-for-review`, `AgentService.handleStructuredExit` (one-shot clean exit), and `AgentService.maybeAutoFinishAgentTask` (interactive turn-complete auto-finish). Replaced the old `prefetchCommitMessage` fire-and-forget at each site; `services/commitMessagePrefetch.ts` and the `GET /tasks/:id/proposed-commit-message` route are gone.

- **`/approve` slimmed to push + PR + completed** (`routes/tasks.ts`): drops commit/snapshot logic (done earlier on the transition). Still calls `autoCommitAndSnapshot` as a safety net on entry — covers pre-refactor tasks, env-was-offline-at-transition tasks, and manual tweaks made in `awaiting_review`. Dirty-tree check remains as a post-push guard.

- **State-aware Files-tab routes** (`GET /tasks/:id/diff/files`, `/diff/file`): `completed` → snapshot only. `awaiting_review` → try live git, fall back to `metadata.finalFiles` if the env's offline or git throws. Everything else (in_progress etc.) → live only (no fallback, to avoid showing stale snapshots from a previous round). New `source: 'live' | 'cache'` field on the response; `useTaskFiles` surfaces it so the UI can indicate offline state later.

- **UI**: `QueuePanel.tsx` "Commit & push" button → "Create PR" (one-click, uses `GitPullRequest` icon). `ApproveTaskModal.tsx` deleted — commit message isn't user-editable anymore since the commit already happened. `api.tasks.approve` drops its `commitMessage` param; `proposeCommitMessage` is gone.

- **Tests**: helperServices — new `autoCommitAndSnapshot` suite covering all five `reason` branches, cumulative-snapshot overwrite on re-run, and non-throwing error surface. routes/tasks — new awaiting_review cache-fallback test, in_progress-doesn't-fall-back-to-stale-cache test, `source: 'live'` assertion on the live path. routes/tasksLifecycle — approve tests rewritten for push+PR semantics (no more commit exit-code scripting), new ready-for-review assertion that autoCommit fires, empty-changeset still transitions. All 564 backend + 98 daemon tests pass.

## Session 20 — Git-centric task flow (Phase 14.2–14.5)

Closes the loop on Phase 14: tasks now own their branch end-to-end, from a synced base at start through commit + push on approve. Landed together so each piece makes sense alongside the next — a partial slice here would leave tasks in a worse state than before.

- **`prepareTaskBranch` with base sync** (`gitService.ts`): one entry point for "start a task on this repo" — fetches the default branch, fast-forwards to origin, then creates `fastowl/<id>-<slug>` off it. Refuses to proceed if the tree is dirty (the slot guard should have prevented it) or if the base has diverged from origin (fails loud rather than branching off stale state). Wired into both `POST /tasks/:id/start` and `taskQueue.processQueue` — previously the scheduler's auto-pick path skipped branch setup entirely and edited whatever happened to be checked out.

- **(env, repo) single-slot guard** (`findTaskHoldingEnvRepoSlot` in `taskQueue.ts`): an `in_progress` or `awaiting_review` task holds the working tree for its `(assignedEnvironmentId, repositoryId)` pair. Scheduler skips queued tasks whose pair is held; `/start` returns 409. Awaiting-review keeps the slot because the working tree is still dirty with its work — approve or reject frees it.

- **`/approve` → commit + push** (`routes/tasks.ts`): new `gitService.commitAll` (staged via base64→stdin for arbitrary messages, no shell-escape concerns) + `pushBranch` + `getDiffStat`. Default commit message comes from `generateCommitMessage` in `services/ai.ts` — Claude Haiku 4.5, same pattern as `generateTaskTitle`, with the diff truncated to 6k chars. User can override via the approve modal's textarea or POST a `commitMessage` field. On push success, check out base and `git branch -D <task branch>` so the slot is free for the next task; remote branch stays.

- **`ApproveTaskModal`** (`components/modals/`): opens on Approve click; fetches the proposed message from `GET /tasks/:id/proposed-commit-message`, shows it in an editable textarea, submits `commitMessage` with the approve call. Shift-click bypasses the modal for users who trust the LLM.

- **`/reject` → stash to backup + reset tree**: new `gitService.stashToBackupRef` captures the current working tree (via `git stash create` + `update-ref`) into `refs/fastowl/rejected/<taskId>`, then `resetToBase` does `checkout -f` / `reset --hard origin/<base>` / `clean -fd`. The task goes back to `queued` with `branch` cleared so retry gets a fresh `prepareTaskBranch`. Rejected work is recoverable with `git checkout -b <name> refs/fastowl/rejected/<taskId>`.

- **Live file-change view** (Files tab). New `taskFileWatcher` service subscribes to `agentStructuredService`'s `event` stream, watches for `tool_use` blocks in `{Edit, Write, MultiEdit, NotebookEdit, Bash}`, debounces 500ms, runs `git diff --numstat` + `ls-files --others` on the task's env, and broadcasts a new `task:files_changed` WS event. New endpoints `GET /:id/diff/files` and `/diff/file?path=...` back the desktop UI. Terminal/Files tabs in the running-task view; Files tab replaces the inline diff in awaiting_review. Per-file diff viewer includes an in-flight-write pulse dot derived from unmatched `tool_use` events, and caps rendering at 2k lines. Old `TaskDiff.tsx` removed — `TaskFilesPanel` supersedes it.

Explicitly deferred: git worktrees (would drop the single-slot constraint but each worktree needs its own `node_modules` — monorepo pain), PR creation button, resume-task-on-different-env. See Phase 14.6/14.7 in ROADMAP.

## Session 19 — Daemon everywhere (Phase 18.5)

One-session refactor that collapses `local`/`ssh`/`daemon`/`coder` env types into `local | remote` with a single transport: every environment is backed by a `@talyn/daemon` process dialling the backend over WebSocket. The immediate trigger: backend restart was SIGPIPE-killing local tasks because the child's stdin was piped directly to the backend process. The daemon now owns those pipes, so backend deploys don't take down in-flight work.

Eight slices, each a landable git push to `main`. Design doc: [`DAEMON_EVERYWHERE.md`](./DAEMON_EVERYWHERE.md) — kept as the live task list throughout.

- **Slice 1 — single-file daemon binary** (`8b26059`): `packages/daemon/scripts/build-binary.sh` + `.github/workflows/build-daemon-binaries.yml` cross-compile `bun build --compile` to five targets (darwin-arm64/x64, linux-x64/arm64, windows-x64) on one Ubuntu runner. `ws` + workspace imports work under `bun --compile`, verified by the smoke test that runs the linux binary with no args and checks the config-resolution error message.

- **Slice 2 — bundle binary in the Electron `.app`** (`4518746`): platform-specific `extraResources` entries in `apps/desktop/package.json` using `${arch}` macros; each packaged build pulls the matching binary from `packages/daemon/dist/fastowl-daemon-*` and drops it at `Contents/Resources/daemon/fastowl-daemon`. Root `npm run package` runs `build:binary:all -w @talyn/daemon` before invoking electron-builder. `publish.yml` gains a `setup-bun` step.

- **Slice 3 — localDaemon install module** (`81bfb4a`): new `apps/desktop/src/main/localDaemon.ts`. macOS writes `~/Library/LaunchAgents/com.fastowl.daemon.plist` (`KeepAlive=true`, `RunAtLoad=true`, logs to `~/Library/Logs/FastOwl/`) and calls `launchctl bootstrap gui/<uid>` — `bootout` first so re-install is idempotent. Linux writes `~/.config/systemd/user/fastowl-daemon.service` with `Restart=always` and runs `systemctl --user daemon-reload && enable --now`. Windows deferred. Dev mode spawns `tsx packages/daemon/src/index.ts` under Electron's lifetime for fast iteration.

- **Slice 4 — auto-pair on first launch** (`806bfef` + fixes): IPC handlers (`daemon:is-paired`, `daemon:host-label`, `daemon:configure-and-start`, `daemon:ensure-running`) in `main.ts`; preload bridge; renderer `useLocalDaemon()` hook in `AuthedApp`. Flow: after login, the hook creates a "This Mac (<hostname>)" env, mints a pairing token, hands it to main, main writes `~/.fastowl/daemon.json` + spawns/installs the daemon. Follow-ups landed same session: (a) daemon accepts `pairingToken` from the config file as a fallback (`141ccd3`); (b) `wss`/`daemonWss` routing fixed — the `{server, path: '/ws'}` auto-handler was aborting every non-`/ws` upgrade with 400, so the local daemon could never connect. Both WSS's are now `noServer: true`, dispatched by path in one handler. (c) `useLocalDaemon` looks up an existing "This Mac" env before creating, so failed pairs don't accumulate orphans (`6677b00`). (d) Local daemon env defaults to `autonomousBypassPermissions: false` (the override is for remote VMs) (`ad4ed76`).

- **Slice 5 — collapse env types** (`7907b35`): `EnvironmentType = 'local' | 'remote'`. Migration `0009_daemon_everywhere.sql` rewrites existing `daemon`-with-"This Mac" name → `local`, other `daemon` → `remote`, deletes stale `ssh`/`coder` rows. `services/environment.ts` rewritten ~200 LOC shorter — no switch on `env.type`, everything routes through `daemonRegistry`. Deleted: `services/ssh.ts`, `services/daemonInstaller.ts`, the SSH auto-install route, `docs/SSH_VM_SETUP.md`, `ssh2` + `@types/ssh2` deps. `AddEnvironmentModal` simplified from 626 → 210 LOC (one flow: name → pair → poll). SettingsPanel branches on `local`/`remote`. Dockerfile drops its `npm rebuild ssh2` step — backend now has zero native deps.

- **Slice 6 — session survival across backend restart** (`0cb795a`): the payoff. Daemon hello now carries `activeSessions: [{sessionId, pid, startedAt}]`. Backend `daemonRegistry` stores `liveSessionIds` per connected daemon, exposes `isSessionLive()` + `connectedEnvironmentIds()`, emits `daemon:connected`. `agent.cleanupStaleAgents` rewritten from "blanket-fail on boot" to a 60s-grace reconcile sweep with a fast path: once every expected env's daemon has dialled in, sweep immediately. Follow-up (`f93267e`): `agentStructuredService.resumeRun()` rehydrates per-run state from `tasks.transcript` + re-subscribes to session events, so surviving agents produce live UI events — not just stay alive. Final polish (`36fcc04`): `permission_token` column on agents + `permissionService.rehydrateRun()`; a child mid-PreToolUse at restart continues to authenticate.

- **Slice 7 — lifecycle surface + uninstall flow** (`02c1b5c`): Settings → Environments "This Mac" card shows launchd install + PID status, refreshes every 5s, has a Restart button. App menu → Daemon submenu with Restart + "Uninstall FastOwl daemon and quit…" (confirm dialog + full wipe). `scripts/fastowl-uninstall.sh` bundled via extraResources — usable from the `.app` or the repo for users who deleted the app before uninstalling.

- **Slice 8 — tests + docs**: new `agentReconcile.test.ts` covering the Slice 6 sweep (survivor kept / non-survivor failed / `isSessionLive` round-trip). Existing `daemonRegistry.test.ts` fixture updated for the new `liveSessionIds` required field. `ARCHITECTURE.md` and `CLAUDE.md` Core Concepts rewritten around the two-type, one-transport model. `ROADMAP.md` marks Phase 18.5 done; SSH + Coder types struck from Phase 1.2's env-type list.

**What this buys**:
- Backend restart / deploy no longer kills running tasks. Verified manually (`pkill -9` on the dev backend; task stays in_progress; output resumes). Single biggest day-to-day reliability win.
- One execution path. Every `env.type === '…'` switch across backend/desktop/cli/mcp is gone. New features touch one surface.
- Backend has zero native deps. `ssh2` + `node-pty` both retired — Dockerfile is lighter; CI stops hitting native-build flakiness.
- Local-daemon UX: zero-click pairing, OS-service lifetime, restart + uninstall from the menu.

**Known limits**: session output during the disconnect window is still dropped (no ring buffer yet — tracked in `DAEMON_EVERYWHERE.md` as a Slice 6 gap). Daemon-process crash still kills its children (Electron crash → local-daemon crash → task dies); rarer than backend deploys, handled by launchd's `KeepAlive=true` auto-restart.

## Session 18 (structured-renderer Slice 4 — daemon/SSH support + PTY deletion)
The big cleanup pass. Structured renderer now covers every env type — local (in-process spawn), daemon (new `stream_spawn` wire op), SSH (ssh2 exec channel with `pty: false`) — and the PTY path is gone. Landed as three commits (4a daemon, 4b SSH, 4c deletion) so each step was revertable on its own.

- **Slice 4a — daemon streaming** (`22a4759`): new `stream_spawn` + `close_stream_input` ops + `session.stderr` event in the daemon wire protocol. `packages/daemon/src/executor.ts` gains a non-PTY `streamSpawn` that `child_process.spawn`s the binary with plain pipes; stdout flows back as `session.data`, stderr as `session.stderr`, exit as `session.close`. `environmentService` grows `spawnStreaming` + `closeStreamInput` that route to local (in-process) or daemon (wire op) based on env type. `agentStructured` refactored to go through env service as the transport — no more direct `child_process.spawn`; start() is now async and takes `environmentId`. Dispatcher drops the local-only gate.

- **Slice 4b — SSH streaming** (`7161994`): `sshService` gains `execStream` / `writeToStream` / `closeStreamInput` / `killStream` / `hasStream`. Uses ssh2's exec channel with `pty: false` so stream-json output isn't wrapped in TTY escapes. Env service forwards `stream:*` events under the same `session:*` names. Dispatcher drops the env-type gate entirely — structured now works on `local`, `daemon`, and `ssh`. Environment routes drop the "local only" guard.

- **Slice 4c — PTY deletion**:
  - **agent.ts** collapsed to a single structured path. Removed: `STATUS_PATTERNS`, `detectStatusFromOutput`, `analyzeOutput` (regex-based PTY output scanning), `handleSessionData` + `handleSessionClose` (PTY-only DB writers for `agents.terminal_output` / `tasks.terminal_output`), `buildFastOwlEnvPrefix` + `shellQuote` (PTY-only shell-quote helpers), the whole PTY dispatcher branch in `startAgent`. `startAgent` is now a thin wrapper over the structured path; no more `startStructuredAgent` split.
  - **environment.ts**: removed `spawnInteractive` + `spawnLocalInteractive` + `localPTYs` map + `node-pty` import. Only `localStreams` + `localProcesses` survive.
  - **ssh.ts**: removed `createPTY` / `writeToPTY` / `closePTY` / `resizePTY` / `PTYSession` / `ptySessions` / `pty:data` + `pty:close` events. Streaming-exec is the only path.
  - **daemon/executor.ts**: removed `spawnInteractive`, `ptySessions`, and the `node-pty` dep.
  - **daemon/wsClient.ts**: dropped the `spawn_interactive` case from dispatch.
  - **shared/daemonProtocol.ts**: removed `SpawnInteractiveRequest` from the request union.
  - **Desktop**: removed `XTerm.tsx`, `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` deps, `.erb/mocks/xtermMock.js` + matching Jest moduleNameMapper. `TaskTerminal.tsx` always renders `AgentConversation`; the `isStructuredTask` check is gone. `TerminalHistory.tsx` still falls back to a plain `<pre>` for historical `terminal_output` rows that pre-date the structured renderer — those can't be back-filled, so they stay readable as legacy data.
  - **Tests**: deleted `agent.envPrefix.test.ts` + `agent.statusDetection.test.ts` (tested functions that no longer exist). `fakeEnvironment.ts` rewritten to patch `spawnStreaming` + `closeStreamInput` instead of `spawnInteractive`. `gitService` refactored from the PTY-session-event-listener pattern to `environmentService.exec()` (one-shot). Full suite: **94 tests** passing in ~40s.
  - **git.ts**: `executeGitCommand` simplified — dropped the `spawnInteractive` + session-event-listener + 5s timeout dance, now just calls `environmentService.exec()` and returns stdout.
  - **Schema / migration**: `0008_default_structured_renderer.sql` flips the default + back-fills existing rows from `'pty'` to `'structured'`. The column is kept (not dropped) so rollback stays possible — but no code path reads `'pty'` anymore.
  - **Infra**: Dockerfile + `scripts/install-daemon.sh` no longer install `build-essential` / `python3` for node-pty's native build. `ssh2` is the last remaining native dep; its prebuilds cover linux-x64 cleanly.

- **What this buys us**:
  - Single code path for every env type. No more "does this task use PTY or structured?" branches scattered across agent.ts, environment.ts, tasks routes, desktop components.
  - One storage format going forward (`tasks.transcript`). `tasks.terminal_output` is kept read-only for historical rows.
  - Lighter Electron bundle — one fewer native dep (node-pty) + ~3 xterm.js packages gone. Notable on Windows where node-pty was a recurring build-nightmare.
  - Any new agent feature touches one surface (structured) — no parity-between-paths work.

- **Deferred follow-ups**: backend-restart reliability (task #6 — designing keep-alive-across-restarts; not in Slice 4's scope). Optionally dropping `tasks.terminal_output` + `agents.terminal_output` + the `environments.renderer` column once we're confident no rollback is needed.

- **Files**: `packages/shared/src/daemonProtocol.ts`, `packages/backend/src/services/agent.ts`, `agentStructured.ts`, `environment.ts`, `ssh.ts`, `git.ts`, `packages/backend/src/routes/tasks.ts`, `routes/environments.ts`, `packages/backend/src/__tests__/helpers/fakeEnvironment.ts`, `packages/backend/src/__tests__/agent.envPrefix.test.ts` (deleted), `agent.statusDetection.test.ts` (deleted), `packages/backend/src/db/migrations/0008_default_structured_renderer.sql` (new), `packages/backend/src/db/migrations/meta/0008_snapshot.json` (new), `packages/backend/src/db/schema.ts`, `packages/backend/package.json`, `packages/daemon/src/executor.ts`, `wsClient.ts`, `packages/daemon/package.json`, `apps/desktop/package.json`, `apps/desktop/src/renderer/components/panels/TaskTerminal.tsx`, `TerminalHistory.tsx`, `apps/desktop/src/renderer/components/terminal/XTerm.tsx` (deleted), `apps/desktop/.erb/mocks/xtermMock.js` (deleted), `Dockerfile`, `scripts/install-daemon.sh`, `package-lock.json`.

## Session 18 (structured-renderer Slice 3 — interactive multi-turn + reliability polish)
Interactive structured tasks: user-initiated tasks on a structured local env now run against a long-lived `claude -p --input-format stream-json --output-format stream-json` child. User types, child processes a turn, emits a `result` event, we flip status to `idle`, user can type again. Same strict-permission machinery as Slice 2 still applies — hook fires on every tool, UI shows Approve/Deny inline. Plus a batch of reliability / UX polish:

- **Streaming-input mode** in `agentStructured.ts`: new `interactive: boolean` option on `StructuredRunOptions`. When true, args include `--input-format stream-json`, the seed prompt is wrapped as a stream-json `{type:"user", message:...}` envelope, and stdin stays open. New methods:
  - `sendMessage(sessionKey, text)` — writes a user-message JSONL envelope to the child's stdin. Throws if the run is one-shot or stdin is already closed.
  - `closeInput(sessionKey)` — graceful end of conversation. Child finalises current turn, exits with code 0, task → `awaiting_review`.
  - `stop(sessionKey)` unchanged — hard SIGTERM for aborts.
- **Turn-complete signalling**: new `turn_complete` event emitted on each `result`. `agentService` listens and flips agent status back to `idle` for interactive runs so the desktop re-enables the input box.
- **Dispatcher change** (`agent.ts`): dropped the `autonomous && prompt` gate. A structured local env now drives **all** tasks through the structured path — autonomous ones as one-shot, user-initiated ones as interactive. `sendInput(agentId, text)` routes to `agentStructuredService.sendMessage()` for structured sessions, existing `writeToSession()` for PTY.
- **No more timeout on permission prompts**: removed `DECISION_TIMEOUT_MS` + setTimeout from `permissionService`. Pending requests now wait indefinitely. Rationale: matches the "inbox item sits until you look at it" mental model; backend-restart case was already handled by SIGPIPE-on-closed-pipe killing the child regardless; cheapens a queued prompt to a setImmediate-level wait instead of a live-timer.
- **Inbox coalescer for pending prompts** (`packages/backend/src/services/permissionInbox.ts`, ~140 LOC): subscribes to `permissionService` events at backend init. First pending prompt on a task inserts one `agent_question` inbox item. Subsequent prompts bump a counter + swap the summary in place (no new items). Last pending resolved → `status: 'actioned'` + `actionedAt` stamp. Had to add an `insertReady` promise to the tracked entry so concurrent update requests await the initial INSERT — otherwise UPDATEs could silently hit 0 rows against a not-yet-persisted `id`.
- **Boot-time orphan cleanup** (`agent.ts` `cleanupStaleAgents`): extended to also flip the orphaned tasks themselves from `in_progress` → `failed` with `result.error = 'backend restart orphaned the agent'`. Previously `cleanupStaleAgents` only dropped agent rows; tasks would ghost for up to 20 min until `recoverStuckTasks` caught them. Now the post-deploy ghost window is seconds. (Deeper reliability work — keeping children alive across restarts — is queued as a follow-up; not in scope for Slice 3.)
- **Desktop input bar upgrade** (`TaskTerminal.tsx`): old single-line `<input>` replaced with an auto-growing `<textarea>` (1–8 rows). Enter sends; Shift+Enter inserts a newline. Structured tasks: send disabled while the agent is `working` / `tool_use`; placeholder reflects state ("Claude is working…", "Type your response…", etc.). PTY tasks: behaviour unchanged (always enabled — answering TUI prompts needs immediate writes).
- **Deferred to follow-ups** (not in Slice 3 despite being on the original plan):
  - Session resume across process restarts (needs `--session-id` + dropping `--no-session-persistence`). The `handleStructuredExit` path currently writes `failed` on non-zero exit — resuming would require a different lifecycle.
  - Slash-command palette UI (Cmd+K). Not needed: the child's own parser handles `/clear`, `/model`, `/compact`, etc. when we pass the text through as a user message.
  - `@file` refs, image paste, `!shell`. Parity polish; independent from this plumbing.
- **Tests** (+5 inbox, +3 agentStructured): `permissionInbox.test.ts` covers first-request creates item, coalescing with counter, last-resolved auto-actions, per-task separation. `agentStructured.test.ts` extended with `buildClaudeArgs` assertions for interactive flag + strict-mode + interactive combined. Full suite: **109 tests** passing in ~41s.

- **Files**: `packages/backend/src/services/agentStructured.ts`, `packages/backend/src/services/agent.ts`, `packages/backend/src/services/permissionService.ts`, `packages/backend/src/services/permissionInbox.ts` (new), `packages/backend/src/index.ts`, `packages/backend/src/__tests__/permissionInbox.test.ts` (new), `packages/backend/src/__tests__/permissionService.test.ts`, `packages/backend/src/__tests__/agentStructured.test.ts`, `apps/desktop/src/renderer/components/panels/TaskTerminal.tsx`.

## Session 18 (structured-renderer Slice 2 — AgentConversation + per-tool permission UX)
Builds on Slice 1's plumbing. Strict-mode autonomous tasks now run through a `PreToolUse` hook that blocks the CLI on every tool call until the user clicks Approve / Deny in the desktop. "Allow always" persists onto an env-scoped tool allowlist so repeated approvals stop pestering you. The conversation UI replaces Slice 1's interim event dump with a proper block view.

- **Hook mechanism** (`packages/backend/src/services/permissionHook.ts`): a dependency-free CJS script written to `/tmp/fastowl-hook-<random>/permission.cjs` at first strict-mode run. Reads the PreToolUse JSON on stdin, POSTs to the backend with `x-fastowl-permission-token`, writes the `{hookSpecificOutput:{permissionDecision}}` decision to stdout. Defaults to `deny` on any error — a broken backend never silently grants a tool. Script lives for the backend process lifetime; idempotent writer.

- **Permission service** (`packages/backend/src/services/permissionService.ts`, ~200 LOC): in-process state machine. `registerRun()` mints a per-run token (random 24 bytes, hex) the child needs to present for any permission call; `verifyRunToken` is timing-safe. `requestDecision()` short-circuits to `allow` if the tool is on `environments.tool_allowlist`, else registers a pending entry and emits a `request` event, awaiting `respond()`. 10-minute auto-deny timeout. `unregisterRun()` on agent exit denies any still-pending requests so a killed child never leaves the CLI wedged.

- **Routes** (`packages/backend/src/routes/permission.ts`): `POST /api/v1/permission-hook` (unauth'd by JWT, token-auth'd via header) is what the child hook hits. `POST /api/v1/tasks/:id/permission` (JWT-auth'd) is what the desktop hits when the user clicks a button — ownership checked via `tasks → environments.owner_id`. `GET /api/v1/tasks/:id/permission/pending` replays open prompts for reconnect.

- **Schema**: `0007_env_tool_allowlist.sql` adds `environments.tool_allowlist jsonb default '[]'`. Populated by the "Allow always" button. Scoped per-env (not per-task) — one approval sticks for every future task on that machine.

- **Wire protocol**: two new WS event types, `agent:permission_request` and `agent:permission_response`. We *also* inject synthetic `fastowl_permission_request` / `fastowl_permission_response` / `fastowl_permission_auto_allowed` events into the transcript so the renderer has a single ordered stream; the dedicated WS types are kept for future standalone notification patterns. Force-persist on any fastowl-synthetic event so a reconnect mid-prompt sees the pending card (can't wait for the usual every-25-events sample).

- **Dispatcher change** (`packages/backend/src/services/agent.ts`): structured runs now respect `env.autonomousBypassPermissions` — `true` → `--permission-mode bypassPermissions` (no hook), `false` → `--permission-mode default` with the hook. Bypass for throwaway daemons, strict for everything you care about. Strict mode also sets `TALYN_PERMISSION_TOKEN` + `TALYN_AGENT_ID` + `TALYN_ENVIRONMENT_ID` in the child's env so the hook can authenticate and the backend can scope allowlist lookups.

- **Renderer** (`apps/desktop/src/renderer/components/terminal/AgentConversation.tsx`, ~450 LOC): replaces the interim `StructuredTranscript.tsx` (deleted). Collapses the event stream into a block model (text / thinking / tool_use / tool_result / permission / system / result) and renders each block with its own component. Text blocks get a hand-rolled markdown-ish renderer (newlines preserved, fenced code blocks, inline backticks — no new deps). Tool_use / tool_result / thinking blocks are collapsed by default; click to expand to full JSON / raw output. Permission blocks show the tool name + JSON input + three buttons: **Allow once**, **Allow always (tool)**, **Deny**; auto-collapse into a green/red summary when the corresponding `fastowl_permission_response` event arrives. Footer shows cost / tokens / denial count from the `result` event.

- **Desktop API** (`apps/desktop/src/renderer/lib/api.ts`): new `api.tasks.respondToPermission(taskId, requestId, decision, persist)` + `api.tasks.listPendingPermissions(taskId)`.

- **Tests** (+13): `permissionService.test.ts` covers the full state machine — token mint + verify, pre-approved tool auto-allows without emitting a request event, non-approved tool registers pending + fires `request`, allow+persist writes the allowlist, allow-without-persist doesn't, unknown requestId returns false, 10-minute timeout auto-denies, `unregisterRun` resolves pending as denied, `listPendingForTask` scoping. Uses `vi.useFakeTimers()` for the timeout assertion. Full suite: **115 tests** passing in ~30s.

- **Deliberate scope boundaries for Slice 2**:
  - Still autonomous-only on local envs (same gate as Slice 1). Interactive user-initiated tasks land in Slice 3.
  - Allowlist is exact tool-name match (`Read`, `Bash`). Pattern matching like `Bash(git *)` — which the CLI's own `--allowedTools` supports — comes later if users want it.
  - Daemon / SSH envs still use PTY (they don't have the hook script or a streaming-exec op yet). Structured + these env types is a Slice 4 follow-up.
  - No global "allow any of: Read, Grep, Glob" preset — the user has to approve each distinct tool once, then "Allow always" sticks it.

- **Files**: `packages/shared/src/index.ts` (permission types + new WS event types), `packages/backend/src/db/schema.ts`, `packages/backend/src/db/migrations/0007_env_tool_allowlist.sql` (new), `packages/backend/src/db/migrations/meta/0007_snapshot.json` (new), `packages/backend/src/services/permissionService.ts` (new), `packages/backend/src/services/permissionHook.ts` (new), `packages/backend/src/services/agentStructured.ts`, `packages/backend/src/services/agent.ts`, `packages/backend/src/services/environment.ts`, `packages/backend/src/services/websocket.ts`, `packages/backend/src/routes/permission.ts` (new), `packages/backend/src/routes/environments.ts`, `packages/backend/src/routes/index.ts`, `packages/backend/src/__tests__/permissionService.test.ts` (new), `apps/desktop/src/renderer/components/terminal/AgentConversation.tsx` (new), `apps/desktop/src/renderer/components/terminal/StructuredTranscript.tsx` (deleted), `apps/desktop/src/renderer/components/panels/TaskTerminal.tsx`, `apps/desktop/src/renderer/components/panels/TerminalHistory.tsx`, `apps/desktop/src/renderer/lib/api.ts`.

## Session 18 (structured-renderer Slice 1 — stream-json plumbing)
Start of the move from raw-PTY CLI output to a structured conversation renderer. The original plan was to swap the `claude` CLI for `@anthropic-ai/claude-agent-sdk`, but research + a spike showed the SDK is API-key-only by policy — Claude Pro/Max subscription auth is explicitly unsupported, so migrating would force every existing user onto metered API billing. Path C instead: keep spawning the `claude` binary (so OAuth subscription auth continues to work) but switch to `--output-format stream-json --verbose --include-partial-messages`, which emits the same structured events the SDK does. All three planned phases (A autonomous-strict, B autonomous-bypass, C interactive) land on this shared foundation.

- **Spike findings** (documented before coding):
  - `claude -p --output-format stream-json --verbose` emits JSONL for `system` / `assistant` / `user` / `stream_event` / `result` — content blocks include `text`, `thinking`, `tool_use`, `tool_result`. Init event shows `apiKeySource: "none"` confirming OAuth creds from `~/.claude/` are honored.
  - `--include-partial-messages` adds `content_block_delta` events (chunky but usable text streaming).
  - `PreToolUse` hooks configured via `--settings '<inline-json>'` synchronously gate tool use — our eventual permission-callback path for Slice 2.
  - Inline `--settings` JSON works, so no temp-file-per-spawn plumbing needed.

- **Shared types** (`packages/shared/src/index.ts`): `Environment.renderer: 'pty' | 'structured'` + new `EnvironmentRenderer`. `Task.transcript?: AgentEvent[]`. `AgentEvent` defined permissively (mirrors the CLI's own schema — `type`, optional `subtype`, `message`, `event`, `result`, etc., plus our own `seq: number` for ordering). Two new WS event types: `agent:event` and `task:event` with `AgentEventBroadcast` / `TaskEventBroadcast` payloads.

- **DB migration** (`0006_structured_renderer.sql`): `environments.renderer` (text, default `'pty'`), `tasks.transcript` (jsonb nullable). Fresh installs default to `'pty'` — no behavioural change for existing envs/tasks.

- **New service** (`packages/backend/src/services/agentStructured.ts`, ~230 LOC):
  - `AgentStructuredService.start(opts)` non-PTY-spawns `claude` with the stream-json argv, writes the prompt on stdin, and parses stdout line by line via `JsonlLineParser`.
  - Each parsed event gets a monotonic `seq` stamp, appended to an in-memory transcript, broadcast as `agent:event` + `task:event`, and persisted to `tasks.transcript` every 25 events (and unconditionally on `type === 'result'`).
  - Transcripts are capped at `TRANSCRIPT_MAX_EVENTS = 2000`: above the cap, the middle drops out with a `{type: 'system', subtype: 'truncated'}` marker. Prevents one unruly autonomous task from nuking the jsonb column.
  - `stop()` kills the child with SIGTERM; the `completion` promise resolves with whatever exit code the child produces.
  - Stderr from the child is surfaced as synthetic `system/stderr` events so the UI can render CLI misbehaviour.

- **Dispatcher** (`packages/backend/src/services/agent.ts`): `startAgent` checks `env.renderer === 'structured' && env.type === 'local' && autonomous && prompt` — if true, calls the new `startStructuredAgent` path; otherwise the existing PTY path. The structured path inserts the same `agents` / `tasks` rows (so inbox, task list, stop endpoint all keep working uniformly), writes `task.metadata.runtime = 'structured'` so the UI can pick the right renderer, and maps exit code onto the existing `awaiting_review` / `failed` rules via a new `handleStructuredExit`. `stopAgent` routes to `agentStructuredService.stop()` for structured sessions and the existing PTY kill for everyone else.

- **Routes** (`packages/backend/src/routes/environments.ts`): `POST /environments` accepts optional `renderer` on create (defaults to `'pty'`, silently falls back to `'pty'` for non-local envs in Slice 1). `PATCH /environments/:id` honors `renderer` updates with the same guard. Both echo `renderer` in responses. `GET /tasks/:id/terminal` now returns `{ terminalOutput, transcript, runtime }` so callers can pick the right renderer.

- **WS helpers** (`packages/backend/src/services/websocket.ts`): `emitAgentEvent` + `emitTaskEvent` broadcast structured events to workspace subscribers.

- **Desktop**:
  - New `apps/desktop/src/renderer/components/terminal/StructuredTranscript.tsx` (interim Slice-1 renderer): one line per event, colour-coded by type, with a one-line summary (text snippet, `→ tool(args)`, `← ok/err`, cost for `result`). Replaced by Slice 2's `AgentConversation.tsx`.
  - `TaskTerminal.tsx` branches on `task.metadata.runtime === 'structured'` — renders `StructuredTranscript` instead of `XTerm`.
  - `TerminalHistory.tsx` rewritten to fetch `{ terminalOutput, transcript, runtime }` and pick the renderer per-task.
  - `useApi.ts` subscribes to `task:event`, dedups by `seq`, maintains a sorted transcript on the task store entry.

- **Tests**: 12 new unit tests in `agentStructured.test.ts` covering the JSONL parser (partial-line buffering, multi-chunk assembly, blank-line handling, malformed-line tolerance) + `buildClaudeArgs` (bypass mode flag, stream-json defaults, session-persistence disabled). Full suite: **101 tests passing** in ~27s. The end-to-end spawn path is easiest to validate by hand with a running backend — no fake-CLI fixture yet.

- **Deliberate scope boundaries for Slice 1**:
  - Only wired for `autonomous && prompt` tasks on `local` envs. Interactive user-initiated tasks + SSH/daemon envs stay on the existing PTY path until Slice 2/3 and a daemon-side follow-up.
  - Bypass-permissions only. Per-tool Approve/Deny UI comes in Slice 2 via a `PreToolUse` hook invoking an in-process FastOwl endpoint.
  - Interim renderer is deliberately ugly — validates plumbing; Slice 2 builds the markdown + collapsible-tool-call conversation UI.
  - No back-migration of historical `terminal_output` — legacy PTY tasks keep rendering via XTerm forever; the runtime field is sticky per task.

- **Files**: `packages/shared/src/index.ts`, `packages/backend/src/db/schema.ts`, `packages/backend/src/db/migrations/0006_structured_renderer.sql` (new), `packages/backend/src/db/migrations/meta/0006_snapshot.json` (new, regenerated journal), `packages/backend/src/services/agentStructured.ts` (new), `packages/backend/src/services/agent.ts`, `packages/backend/src/services/environment.ts`, `packages/backend/src/services/websocket.ts`, `packages/backend/src/routes/environments.ts`, `packages/backend/src/routes/tasks.ts`, `packages/backend/src/__tests__/agentStructured.test.ts` (new), `apps/desktop/src/renderer/components/terminal/StructuredTranscript.tsx` (new), `apps/desktop/src/renderer/components/panels/TaskTerminal.tsx`, `apps/desktop/src/renderer/components/panels/TerminalHistory.tsx`, `apps/desktop/src/renderer/hooks/useApi.ts`, `apps/desktop/src/renderer/lib/api.ts`.

## Session 17 (failure-cascade hardening — scheduler backoff + stuck-task recovery)
Pass over the Continuous Build scheduler + task queue to close the "runs unattended overnight" part of the DoD. Three cascades fixed: deterministic-failure infinite loop, ghost tasks that never recover from a silent agent death, and the markdown-sync-clobbers-running-task case.

- **Failure counter + backoff + auto-block** (`services/continuousBuild.ts` + `services/backlog/service.ts`):
  - New columns on `backlog_items`: `consecutive_failures` (int, default 0) + `last_failure_at` (timestamptz, nullable). Migration `0004_backlog_failure_tracking.sql`.
  - Scheduler's `onTaskStatus` now distinguishes `failed` (counts as a failure, bumps counter + stamps time) from `cancelled` (user-initiated, doesn't count). Completed/approved resets the counter to 0.
  - Backoff schedule: 1m → 5m → 15m → 60m by failure count. `nextActionableItem` filters on `lastFailureAt <= cutoff` and the scheduler re-checks the backoff window for the candidate. A looping broken TODO can't hog the queue anymore.
  - After 5 consecutive failures the item flips to `blocked`. Human has to fix whatever's deterministically wrong, then unblock it in the UI.
- **Periodic stuck-task recovery** (`services/taskQueue.ts`): `recoverStuckTasks` used to run only at `init()`. Now also runs every 2 minutes on a timer, and the query picks up an extra case — tasks whose `updated_at` hasn't moved in 20 minutes (proxy for "agent silently dropped"). Covers daemon disconnects mid-task, hung processes, etc. — previously those required a service restart to clear.
- **Guard claimed items against sync auto-completion** (`services/backlog/service.ts`): when a backlog item disappears from the markdown source, `syncSource` auto-marks it completed — but only if it's **not currently claimed**. Previously a running task could have its item silently marked complete by a concurrent markdown edit, orphaning the task's work.
- **Tests** (+7 total): 5 scheduler tests (failure → counter bump, backoff window, 5th failure blocks, cancelled doesn't count, complete clears counter, sync-with-claim is no-op), 1 taskQueue test (time-based staleness recovery), 1 backlog test (claim survives sync-side-delete). Full suite stays fast — 74+6 = 80 tests in ~11s.

- **Why these three and not others from the failure-path audit**: the audit (via explore subagent) turned up more — orphaned git branches, fire-and-forget promise paths in agent status updates, approval-reject flow — but these three were the direct blockers for "unattended overnight": an infinite loop is catastrophic, a stuck task needs periodic rescue, and a sync-race is a silent data-loss bug. The others are quality-of-life and can land when they land.

- **Schema note**: `BacklogItem` gains two fields in `@talyn/shared` — `consecutiveFailures: number` + `lastFailureAt?: string`. Renderer components that destructure backlog items keep working (new fields are additive); the UI doesn't render them yet, but they're available for a future "this item has failed N times" badge.

- **Files**: `packages/backend/src/services/continuousBuild.ts`, `packages/backend/src/services/backlog/service.ts`, `packages/backend/src/services/taskQueue.ts`, `packages/backend/src/db/schema.ts`, `packages/backend/src/db/migrations/0004_backlog_failure_tracking.sql` (new), `packages/shared/src/index.ts`, tests across three files.

## Session 17 (test hang fix — daemonRegistry fire-and-forget UPDATE race)
CI (and local `npm test`) had been timing out in `daemonRegistry.test.ts`. Diagnosed as a race between `markEnvConnected` (fired by `register()`) and `markEnvDisconnected` (fired by `unregister()`) — both are fire-and-forget `.update()` calls on the same environment row. Under pglite (the test harness), running two unawaited UPDATEs on the same row concurrently **pins the worker at 100% CPU** inside pglite's WASM scheduler. Bisected down from the whole file → to the fourth test ("disconnecting a daemon rejects its in-flight requests") — the one case that exercises both register+unregister inline — and traced it to a hang at `pglite.waitReady` in the *next* test's `beforeEach` (WASM init starves once the previous test leaves pending in-flight queries behind).

- **Fix**: introduced a private `dbTail: Promise<void>` in `daemonRegistry` that serializes every env-status flip. `markEnvConnected` and `markEnvDisconnected` now `.then()`-append onto `dbTail` so writes happen in order, never concurrently for the same row. Added `flushPending()` and made `shutdown()` `async` + await `flushPending()` so tests cleanly drain before pglite closes.
- **Callers updated**: `packages/backend/src/index.ts` SIGTERM handler + `daemonRegistry.test.ts` afterEach now `await daemonRegistry.shutdown()`.
- **Result**: full backend suite goes from timing out to **74/74 passed in 11.6s**. `daemonRegistry.test.ts` on its own: 5/5 in 4s.
- **Why the race didn't show up on real Postgres**: a real connection supports multiple concurrent statements; pglite serializes through a single WASM instance and the fire-and-forget pattern leaves the worker's microtask queue clogged when the following test tries to spin up a fresh pglite. Production (Supabase) was fine.
- **Files**: `packages/backend/src/services/daemonRegistry.ts`, `packages/backend/src/index.ts`, `packages/backend/src/__tests__/daemonRegistry.test.ts`.

## Session 17 (Phase 18.3.B — SSH auto-install of the daemon)
The "give me SSH creds and I'll do the rest" path. Desktop's Add Environment dialog now has a **Remote VM (FastOwl daemon)** type with two modes: **auto-install over SSH** (backend SSHes in and runs a hosted install script) or **manual** (shows a copy-paste one-liner). Either way, a daemon env is created, a pairing token is minted, and the env flips to `connected` as soon as the daemon dials back — no user JWT ever touches the VM.

- **Shared types**: added `DaemonEnvironmentConfig` (`type: 'daemon'`, `hostname?`, `workingDirectory?`) to the `EnvironmentConfig` union + `InstallDaemonOverSshRequest`/`Response`. Keeps the Environment type honest now that daemon envs are first-class.
- **`scripts/install-daemon.sh`** (new): OS-aware provisioning script served via the backend. Installs Node 22 (NodeSource on Debian/Ubuntu, yum-nodesource on RHEL, `brew` on macOS, nvm fallback), installs `build-essential` + `python3` on Linux for node-pty, clones `Gilbert09/owl`, builds `@talyn/shared` + `@talyn/daemon`, runs the daemon once in foreground with `--pairing-token` to exchange for a device token (watches the on-disk config file for `deviceToken` to appear, times out at 60s), then writes a systemd unit at `/etc/systemd/system/fastowl-daemon.service` (Linux) or a launchd plist at `~/Library/LaunchAgents/dev.fastowl.daemon.plist` (darwin). Idempotent — safe to re-run.
- **Backend public route** (`routes/daemon.ts`): `GET /daemon/install.sh` serves the script. Unauthenticated by design — the credential is the pairing token, not the HTTP request. Dockerfile now `COPY scripts ./scripts` so the script is on disk at runtime.
- **Backend SSH installer** (`services/daemonInstaller.ts`): uses ssh2 to dial the target, supports `password` + `privateKey` auth (raw PEM content, not file paths — the private key gets pasted into the desktop UI and is used once per install), exec's `curl -fsSL <backend>/daemon/install.sh | bash -s -- --backend-url ... --pairing-token ...`, captures stdout+stderr, returns the log. 5-minute timeout.
- **Backend route**: `POST /api/v1/environments/:id/install-daemon` — owner-scoped, validates env type is `daemon`, mints a fresh pairing token on every call, resolves the backend URL from `TALYN_PUBLIC_BACKEND_URL` env var (falls back to `req.protocol://req.host`), hands off to `installDaemonOverSsh`. Returns `{ success, log, exitCode, backendUrl }`.
- **Desktop UI** (`AddEnvironmentModal.tsx`): rewritten around three types. "Remote VM (FastOwl daemon)" is the new default for cloud-backend users; "SSH (legacy)" is kept behind a warning for local-backend users. In daemon/ssh-install mode: host/port/user + (password | pasted PEM key + optional passphrase). In daemon/manual mode: after creation, shows the copy-paste one-liner with a Copy button. Either way, after submit, the modal polls `GET /environments/:id` every 3s and flips to "Daemon connected!" when the backend sees the daemon dial back.
- **Docs**: Roadmap 18.3 flipped to `[x]` for remote install; single-file binary is deferred (git-clone install works end-to-end). Priority queue now has 17.3 (notifications) at the top.

- **Design decisions**:
  - **Git clone, not a prebuilt binary** — the MVP install path shells out to `git clone` + `npm install` + `npm run build` rather than shipping a prebuilt tarball. Reasons: `node-pty` is a native module, and cross-compiling a binary that works on linux/amd64 + linux/arm64 + darwin/arm64 adds a whole CI pipeline. The git-clone path uses whatever Node is on the target, builds native modules in place, and avoids a new release surface. Downside: first install on a VM takes ~2 minutes instead of ~10 seconds. Acceptable for now.
  - **Pasted PEM instead of key file** — the hosted backend can't read the user's `~/.ssh/id_rsa`. The install endpoint accepts the private key contents in the request body, uses it for a single ssh2 connection, and never stores it. Memory-only, dies with the request. Same principle as the install-script one-liner: the credential exists in the path of the install and nowhere else.
  - **One pairing token per install call** — every `POST /install-daemon` invocation mints a fresh token (even for the same env). Avoids the "pairing token reuse" failure mode if the previous install timed out or was interrupted. Tokens expire in 10min anyway, so there's no cleanup debt.
  - **Polling instead of WebSocket for "daemon connected"** — the modal polls the env's status every 3s. Could push an `environment:status` WS event (we already emit them), but the modal is short-lived enough that polling is simpler than hooking into the store and filtering.

- **Still to land (deferred)**:
  - Symmetric uninstall flow (delete env → SSH in → systemctl disable + rm). Not critical.
  - Prebuilt daemon binary (`bun --compile`) — avoids the ~2min first-install npm install step. Nice-to-have.
  - Wire-up streaming install logs to the modal via WS (today we only show the log after the install finishes). UX nit.
  - End-to-end test of the install flow against a real VM. Covered manually; no CI yet.

- **Files touched**: `packages/shared/src/index.ts` (DaemonEnvironmentConfig + install API types); `scripts/install-daemon.sh` (new); `packages/backend/src/routes/daemon.ts` (new); `packages/backend/src/routes/index.ts` (mount `/daemon`); `packages/backend/src/services/daemonInstaller.ts` (new); `packages/backend/src/routes/environments.ts` (install-daemon endpoint); `Dockerfile` (COPY scripts); `apps/desktop/src/renderer/lib/api.ts` (pairingToken + installDaemon helpers); `apps/desktop/src/renderer/components/modals/AddEnvironmentModal.tsx` (rewritten).

- **How to exercise it locally**:
  1. `npm run dev -w @talyn/backend` (local backend on 4747)
  2. Open desktop, Settings → Environments → Add
  3. Pick **Remote VM (FastOwl daemon)** → **Show me the install command** (the SSH path requires a real VM)
  4. Name it, Generate → copy the one-liner
  5. On any VM: paste the command (it'll curl from `http://localhost:4747/daemon/install.sh` which only works from the same network; for a real test, set `TALYN_PUBLIC_BACKEND_URL` to the hosted URL)
  6. Modal flips to "Daemon connected!" when the daemon dials back.

- **Next action**: **Phase 18.2 polish** (proper `fastowl login` PKCE + CLI refresh-token rotation + cross-user HTTP-layer integration test) or **Phase 18.3 polish** (single-file daemon binary via `bun --compile`).

### Phase 17.3 landed in the same session

Desktop OS notification fires when any task transitions into `awaiting_review`. Implementation is surprisingly small — the renderer already subscribes to `task:status` events; added a pre-update status check to detect the transition (to avoid firing on idempotent restates), then `new Notification(...)` in the granted-permission path. Electron bridges the renderer-side `Notification` constructor to the native OS surface — no preload work, no main-process IPC.

- **Preference**: stored in `localStorage` under `fastowl:notify:awaitingReview`. Default on. Toggled from Settings → Appearance → Notifications.
- **Permission**: requested lazily on first-eligible event. Settings toggle also requests eagerly on flip-to-on so the permission prompt doesn't race with the actual event. When the OS-level permission is denied, the settings panel surfaces a "Notifications are blocked at the OS level" hint.
- **Click-through**: `n.onclick = () => window.focus()` brings the app forward. Could later deep-link to the specific task (route + select) but the inbox + queue are both visible on the main screen.
- **Transition semantics**: we grab the previous task from the store BEFORE applying the update, so `wasAwaitingReview` reflects the prior state. If a WS event arrives that re-states `awaiting_review` without a transition (recovery path, duplicate event), no notification fires.
- **Files**: `apps/desktop/src/renderer/hooks/useApi.ts` (new `maybeNotifyAwaitingReview` + pref helpers); `apps/desktop/src/renderer/components/panels/SettingsPanel.tsx` (Notifications card in AppearanceSettings); `docs/ROADMAP.md` + `CLAUDE.md` + this note.
- **Deferred**: per-task-type toggles, digest mode, click-through that deep-links to the task. None block the "production ready" goal.

## Session 16 (Phase 18.3.B foundation — daemon relay layer)
Option-1 relay shipped. Child processes spawned by a daemon (`claude` running a task, `fastowl` CLI calls from within that Claude, any MCP server) now reach the backend through a local HTTP proxy on the daemon, which tunnels each request over the daemon's authenticated WS. No user JWT ever lives on the VM.

- **Protocol**: added `ProxyHttpRequest` / `ProxyHttpResult` to the daemon↔backend wire. Request is { method, path, headers, body (base64) } — full REST round-trip, not a typed RPC surface. Keeps every existing route available to daemon children without duplicating the API.
- **Backend auth refactor**: `requireAuth` now accepts two credential paths. Path 1 (existing): `Authorization: Bearer <Supabase JWT>`. Path 2 (new): `X-Fastowl-Internal-User: <uuid>` + `X-Fastowl-Internal-Token: <secret>`. The secret is minted once at process boot with `randomBytes(48)` and held only in memory — reboot rotates it. Comparison is `timingSafeEqual`. Internal requests resolve the user from the `users` table directly, skipping the Supabase round-trip.
- **Backend proxy dispatcher** (`services/daemonProxyHandler.ts`): when a daemon sends `proxy_http_request` on its WS, backend looks up `env.owner_id`, makes a localhost `fetch` against `http://127.0.0.1:${PORT}${path}` with `internalProxyHeaders(ownerId)`, and ships the response back in a `proxy_http_response`. Drops `authorization`, `cookie`, `host`, and hop-by-hop headers from the inbound side; drops `content-length` / `transfer-encoding` from the outbound response (daemon recomputes).
- **Daemon proxy server** (`proxyServer.ts`): HTTP server bound to `127.0.0.1:0` (random port). Every inbound request is serialized into `proxy_http_request`, sent over the WS, and awaited up to 60s. On daemon start, `TALYN_API_URL=http://127.0.0.1:<port>` is set as a child-env override; `TALYN_AUTH_TOKEN` is always scrubbed from the spawn env so a stale user token can't leak through.
- **Daemon WS client**: now sends daemon→backend `request` messages (previously only events). Tracks its own `pendingProxyRequests` map with 60s timeouts; rejects them all on shutdown.
- **Tests**: `daemonProxy.test.ts` mounts `requireAuth` on a minimal Express app and exercises the internal-header path — valid user, wrong token, unknown user. All four pass; full backend suite is 74/74.

- **Still to land in 18.3.B**:
  - Rewire scheduler / taskQueue so tasks actually execute on `daemon` envs end-to-end (today they still prefer legacy `local`/`ssh`).
  - `fastowl-daemon install` + server-hosted `install.sh` + tarball publication (probably from Railway `/daemon/latest.tar.gz` for MVP).
  - Desktop "Add SSH environment → Install FastOwl daemon" checkbox that SSHes in, runs the install, polls for the daemon to dial back.
  - Ownership propagation: provisioning an env + dispatching a proxy request both hinge on `env.owner_id`; need a regression test that covers user-A-VM cannot proxy as user-B.

- **How to exercise the relay today**:
  1. `npm run dev -w @talyn/backend`
  2. Create a daemon env + pairing token via REST (auth'd with your CLI token as before).
  3. `node packages/daemon/dist/index.js --pairing-token <x> --backend-url http://localhost:4747`
  4. Daemon logs `listening on http://127.0.0.1:<port>`.
  5. From the shell where the daemon is running: `TALYN_API_URL=http://127.0.0.1:<port> TALYN_AUTH_TOKEN= fastowl workspace list` — request hits the local proxy, tunnels over WS, backend answers as the daemon's owner.

- **Follow-up commits landed same session**:
  - `a0000ea` Daemon envs are first-class in scheduling: daemonRegistry updates `environments.status` on register/unregister; `backlogService` and `continuousBuildScheduler` fall back to any connected daemon when no env is pinned; `connectSavedEnvironments` on startup marks daemon envs disconnected until they dial back.
  - `9e82bc7` CI hygiene: `@talyn/daemon` gets `--passWithNoTests` so an empty suite doesn't fail CI; `taskQueueService` gains a `shuttingDown` flag + `runProcessQueue` wrapper that swallows the "DATABASE_URL is not set" noise triggered by floating promises after a test's DB reset; AuthProvider no longer `console.error`s when Supabase env vars are missing (LoginScreen already surfaces a visible warning).

## Session 15 (Phase 18.3.A — daemon package + WS transport)
Foundation for the SSH auto-install flow. Daemon package exists and can dial the hosted backend; backend has a `/daemon-ws` endpoint, a registry that tracks live daemons, and a `daemon` env type that proxies commands through. No UX change yet — Phase 18.3.B bolts the "Install daemon" checkbox onto the Add-SSH-env dialog.

- **Wire protocol** in `@talyn/shared/daemonProtocol.ts`: JSON-framed WS envelopes with `hello` / `hello_ack` / `request` / `response` / `event`. Correlation IDs on request/response. Close codes in the 4xxx range for a daemon to log a clear reason (4401 unauthorized, 4409 duplicate, 4500 server shutdown). Encoded as `JSON.stringify(envelope)` so the same types also work over stdio if we ever need a local test daemon.
- **`packages/daemon`** (new workspace): `executor.ts` wraps `child_process.spawn` + `node-pty`, `git.ts` mirrors backend `gitService` via exec, `wsClient.ts` handles the dial/hello/reconnect loop (exponential backoff capped at 30 s), `config.ts` resolves CLI args / env vars / `~/.fastowl/daemon.json` with that precedence. Bin is `fastowl-daemon`.
- **Schema**: `environments` gets `device_token_hash` (SHA-256 of the long-lived daemon token) and `last_seen_at`, plus a new env type `daemon`. Migration 0003. `0002_snapshot.json` got re-ided because Stage 5's manual copy had a duplicate id that collided with drizzle-kit on regen.
- **Backend**:
  - `services/daemonRegistry.ts` owns pairings (in-memory, 10 min TTL) and live daemon connections. Mints device tokens, matches them on reconnect, issues requests with 30 s timeouts, routes responses by correlation id, forwards events as `session.data` / `session.close` / `status` EventEmitter events. No background timers — pairing expiry is swept inline on each `authenticate` call so tests don't have to deal with open timer handles.
  - `services/daemonWs.ts` accepts connections at `/daemon-ws`, enforces a 5-second hello timeout, hands auth off to the registry, then routes subsequent messages.
  - `services/environment.ts` gained `case 'daemon':` branches for `connect`, `exec`, `spawnInteractive`, `writeToSession`, `killSession`, `getStatus`. Sub-daemon events flow back through the existing `session:data` / `session:close` EventEmitter the rest of the backend already listens for.
  - `index.ts`: separate `WebSocketServer({ noServer: true })` for daemon upgrades, path-dispatched on the HTTP `upgrade` event so the existing `/ws` keeps its own handler.
  - `routes/environments.ts`: new `POST /:id/pairing-token` mints a one-shot pairing token for a daemon env. Validates ownership + env type. 10-minute TTL.
- **Tests**: `daemonRegistry.test.ts` covers pairing-then-device handshake, reconnect-with-device-token, request/response round-trip, in-flight rejection on disconnect, and event forwarding. Uses a `FakeWs` EventEmitter stand-in so no sockets or network. 70/70 green.

- **Deliberately deferred to follow-ups**:
  - Bundled daemon spawn from Electron main — the user has to run the daemon manually (CLI) for now. Next: desktop spawns daemon as a child process on app start, creates a local daemon env, pairs automatically.
  - Liveness heartbeat (periodic `last_seen_at` stamp while connected) — today it's set on register only.
  - UI to create a daemon env + show the `fastowl-daemon --pairing-token X --backend-url Y` command.
  - Legacy `local` / `ssh` env types still exist and still work when the backend runs on the user's laptop; only the `daemon` type works against the hosted backend.

- **How to try it locally** (dev loop):
  1. Point desktop at local backend: `TALYN_API_URL=http://localhost:4747` in `apps/desktop/.env`, rebuild.
  2. Start the backend (`npm run dev -w @talyn/backend`).
  3. Create a daemon env via API: `POST /api/v1/environments` with `{ "type": "daemon", "name": "My Mac", "config": {} }` (requires bearer token from desktop login → Copy CLI token).
  4. Mint a pairing token: `POST /api/v1/environments/:id/pairing-token`.
  5. Run the daemon: `node packages/daemon/dist/index.js --pairing-token <token> --backend-url http://localhost:4747`.
  6. Watch it pair, write `~/.fastowl/daemon.json`, stay connected. Restart with no args and it reconnects using the stored device token.

- **Next action (Phase 18.3.B)**: "Add SSH environment → Install FastOwl daemon" checkbox in the desktop dialog. Backend SSHes in, runs a server-hosted `install.sh`, writes a systemd/launchd unit, starts the service. At that point: one click to onboard a VM.

## Session 14 (Phase 18.4 — backend on Railway)
Backend now live at `https://fastowl-backend-production.up.railway.app`. Health check passes, migrations ran on startup, RLS confirmed on every user-scoped table. Desktop `.env` flipped to point at Railway.

- **Dockerfile** (multi-stage): builder installs the whole workspace + compiles with tsc + prunes to prod deps; runtime copies `node_modules` + `dist/` + migrations. Copying node_modules instead of reinstalling keeps `node-pty` / `ssh2` native bindings intact without needing build tools in the runtime image. `.dockerignore` keeps the build context tight (no desktop release, no .env, no docs).
- **Migrations fix**: `tsc` doesn't copy `.sql` files, so the migrate-on-startup would have crashed in prod. Added `build:copy-migrations` postbuild script (`fs.cpSync` — ESM-safe, no shell) that mirrors `src/db/migrations` → `dist/db/migrations`.
- **railway.toml**: DOCKERFILE builder, healthcheck at `/health` (30s window), restart on failure max 5 retries.
- **CI**: `.github/workflows/deploy-backend.yml` deploys on pushes to main that touch backend/shared/Dockerfile, using `RAILWAY_TOKEN` secret. Path-filtered so desktop-only changes don't redeploy.
- **Two gotchas that bit**:
  1. Railway doesn't route IPv6; Supabase's direct `db.<ref>.supabase.co` resolves IPv6. Fix: use the transaction pooler (`aws-1-eu-west-2.pooler.supabase.com:6543`). Session 12 had the wrong region prefix (`aws-0-` vs `aws-1-` — it's project-specific, copy from the dashboard).
  2. `--ignore-scripts` on `npm ci` in the runtime stage strips node-pty's native binary. Moved the install to the builder stage and copied the resulting `node_modules` across — works without shipping python/build-essential to the runtime image.
- **Env vars on Railway** (service `fastowl-backend`): `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TALYN_ALLOWED_EMAILS=owerstom@googlemail.com`, `NODE_ENV=production`. `PORT` auto-provided by Railway.
- **Desktop**: `apps/desktop/.env` gains `TALYN_API_URL=https://fastowl-backend-production.up.railway.app`. Commented fallback to `http://localhost:4747` for running against a local backend.
- **Verified**: `GET /health` returns the full service payload; `GET /api/v1/workspaces` without auth returns 401 (middleware enforcing); Supabase query confirms RLS is on for all 10 user-scoped tables, off for `settings`.

- **Still outstanding**:
  - Add `RAILWAY_TOKEN` to GitHub repo secrets (manual; required before the deploy workflow actually runs).
  - Update workspace-integration GitHub OAuth app callback URL if/when we exercise it against the hosted backend.
  - Extra Railway "FastOwl" service auto-created alongside `fastowl-backend` can be deleted via the dashboard — harmless but cluttered.

- **Next action**: **Phase 18.3 — daemon split + SSH auto-install.** With the backend hosted, a VM now has a target to dial out to. Extract env/agent/git services into `packages/daemon`, flip the connection direction, add the "Install FastOwl daemon" checkbox in the Add-SSH-env dialog.

## Session 13 (Phase 18.2 — end-to-end auth)
Wired Supabase GitHub OAuth through backend, desktop, CLI, and MCP in five focused commits. Every REST endpoint and the WebSocket upgrade now require a valid Supabase JWT; data is scoped by `owner_id` at the app layer with RLS as defense in depth.

- **Schema + routes** (`b267d0f`): added `users` table mirroring `auth.users`, added `owner_id` (NOT NULL, FK) on `workspaces` + `environments` — everything else inherits access through its workspace FK. `requireAuth` middleware verifies Supabase JWTs via `auth.getUser(token)`, upserts the user row on first sight, and enforces `TALYN_ALLOWED_EMAILS` if set. Every route got ownership gates (helper: `requireWorkspaceAccess`, `requireTaskAccess`, etc.). `/api/v1/github/callback` stays public — state-token lookup guards it. WebSocket accepts `?token=` on upgrade, verifies, then scopes subscribe requests to the connected user's workspaces.
- **Desktop login** (`3790764`): `AuthProvider` wraps the app. Sign-in opens GitHub OAuth in the system browser via `shell.openExternal`, Supabase redirects to `fastowl://auth-callback#access_token=...`, the main process catches the deep link and forwards over IPC. `api.ts` attaches `Authorization: Bearer` to every REST call and the WS upgrade query. Added `fastowl://` to the `protocols` field in `package.json` for packaged builds.
- **CLI + MCP** (`4591c7a`): CLI reads token from `~/.fastowl/token` (mode 0600) or `TALYN_AUTH_TOKEN`; new `fastowl token set|show|clear|whoami` commands. MCP is env-only (parent agent sets `TALYN_AUTH_TOKEN` on spawn). Desktop Settings gains an Account tab with sign-out and a one-click "Copy CLI token" button — tokens expire hourly so users re-copy as needed. Proper PKCE `fastowl login` deferred.
- **RLS** (`4a9cdd6`): migration enables RLS on all user-scoped tables + policies on `auth.uid()`. Test helper stubs `auth.uid()` so pglite can apply the migration; pglite's superuser connection bypasses RLS the same way the service role does in prod.
- **Docs**: this session note + SETUP.md (Supabase redirect URL, allow-list env var, desktop/CLI env conventions).

- **Key decisions** (ratified with Tom):
  - Ownership lives only on top-level tables (`workspaces`, `environments`) + `users`. Child tables (tasks, agents, inbox, repos, integrations, backlog_sources, backlog_items) cascade access through the workspace FK. Simpler schema, simpler RLS, matches existing mental model.
  - Backend uses the service-role key + app-level owner filtering. Keeps Drizzle usage unchanged; no per-request Supabase client.
  - Electron OAuth = system browser + `fastowl://` deep link. Rejected embedded BrowserWindow (less secure, non-standard).
  - Allow-list env var for single-user mode; invite flow explicitly deferred (documented as TODO in ROADMAP 12.7).

- **Still on the list**:
  - Proper `fastowl login` with PKCE code flow + local callback server (replaces copy-paste token UX).
  - Refresh-token rotation in CLI (right now CLI tokens expire in an hour, user re-copies).
  - Cross-user integration test at the HTTP layer (today's coverage is: migration applies RLS, app-level helpers are structured around owner checks, but we don't spin up two users and assert user A's routes 404 on user B's resources).
  - Invite flow + `workspaces_users` join table once FastOwl needs real multi-tenancy.

- **Files touched**: schema + 2 new migrations; new `middleware/auth.ts` + `services/supabase.ts`; all 8 route files gated; new `renderer/components/auth/{AuthProvider,LoginScreen}.tsx` + `renderer/lib/supabase.ts`; `main/main.ts` + `preload.ts` for deep-link plumbing; CLI `commands/token.ts` + `config.ts`; MCP `client.ts`; Settings panel Account section.

- **Next action**: continue Phase 18.3 (daemon split + auto-install over SSH) or 17.3 (notifications). Auth is done enough to build on top of.

## Session 12 (Hosted backend — Phase A + B landed, Phase C ready to resume)
Started the hosted-backend work from `docs/CONTINUOUS_BUILD_ROADMAP.md`. Phases A + B complete end-to-end on hosted infra. Phase C started then paused to avoid a half-broken main; picks up next session from a known-green state.

- **Phase A (COMPLETED)** — Drizzle ORM scaffolding:
  - `packages/backend/src/db/schema.ts` — Drizzle schema with all 10 tables (workspaces, repositories, integrations, environments, tasks, agents, inboxItems, settings, backlogSources, backlogItems). Upgraded types for Postgres: `jsonb` for structured payloads (settings, config, metadata, result, actions, source, data), `timestamp with time zone` for dates, `boolean` for flags (no more 0/1 ints).
  - `packages/backend/src/db/client.ts` — wraps postgres-js + drizzle-orm, exposes `getDbClient()` singleton + `setDbClient()`/`resetDbClient()` test hooks. Exports `Database` type alias (the Drizzle query builder) that services will consume in Phase C.
  - `packages/backend/drizzle.config.ts` — points schema → `src/db/migrations/`, dialect postgresql, casing snake_case.
  - `packages/backend/src/db/migrations/0000_initial.sql` — generated by `npx drizzle-kit generate --name initial`. 152 lines. This is the target state of the hosted DB; hand-rolled SQLite migrations 001-007 are being retired.
  - Scripts on backend `package.json`: `db:generate`, `db:migrate`, `db:studio`.
  - Deps added: `drizzle-orm@^0.45.2`, `postgres@^3.4.9`, `drizzle-kit@^0.31.10` (dev), `@electric-sql/pglite@^0.4.4` (dev, intended for Phase C tests).
  - `skipLibCheck: true` on `packages/backend/tsconfig.json` (drizzle-orm/sqlite-core ships types that trip strict checks — harmless since we don't use that module).

- **Phase B (COMPLETED)** — Supabase project provisioned via MCP:
  - Organization: `nmgucldojryyubpdxdfg` ("FastOwl")
  - Project: **`fastowl-prod`** — id `xodyzfwlwvgzezwlkrqn`, region `eu-west-2`, status `ACTIVE_HEALTHY`, cost $0/mo
  - Project URL: `https://xodyzfwlwvgzezwlkrqn.supabase.co`
  - All 10 tables live with 0 rows. **RLS is intentionally off** — Phase E turns it on when auth lands.
  - Publishable API keys:
    - anon (legacy JWT) — `eyJhbGciOiJIUzI1NiIs...` (truncated here; full token in Supabase dashboard + MCP)
    - default publishable — `sb_publishable_g6uFDJjjiMG9DNDB9wt_Rg_KsB2nutR`
  - Postgres connection string lives in `packages/backend/.env` as `DATABASE_URL` (format: `postgresql://postgres.xodyzfwlwvgzezwlkrqn:[password]@aws-0-eu-west-2.pooler.supabase.com:6543/postgres`). `.env` is gitignored.

- **Phase C (STARTED, REVERTED, RESUMES NEXT SESSION)** — services rewrite to Drizzle:
  - **Scope discovered**: 128 `db.prepare(...)` call sites across 13 files (routes/workspaces, routes/environments, routes/tasks, routes/agents, routes/inbox, routes/repositories, routes/github, services/environment, services/agent, services/taskQueue, services/github, services/prMonitor, services/backlog/service, services/continuousBuild, plus src/index.ts). Plus ~20 raw-SQL call sites across the test suite (`packages/backend/src/__tests__/`) that seed fixtures.
  - **Attempted this session**: rewrote `db/index.ts` to Drizzle + converted `routes/workspaces.ts` + `routes/environments.ts` as a proof-of-concept pattern.
  - **Why reverted**: mid-rewrite, main won't typecheck — `DB` type and `db.prepare` calls are incompatible between SQLite (remaining 11 files) and Postgres (the 3 rewritten). No clean incremental path because data lives in one DB (flag-day cutover, not strangler-patternable).
  - **Path for next session**:
    1. Resume by re-doing the conversion for `routes/workspaces.ts`, `routes/environments.ts`, and `db/index.ts`. The pattern is: import `Database` from `db/client.ts`; swap `db.prepare('SELECT ...').all()` for `db.select().from(table).where(...)`; swap `db.prepare('INSERT ...').run(...)` for `db.insert(table).values({...}).returning()`; `rowToXxx` helpers shrink since postgres-js auto-parses jsonb and returns Date objects.
    2. Then bulk-convert in this order: `routes/repositories` → `routes/integrations` (if exists) → `routes/tasks` (biggest, ~550 lines) → `routes/agents` → `routes/inbox` → `routes/github` → `routes/backlog` (mostly already delegates to services, small changes).
    3. Then services in dep order: `services/backlog/service` → `services/continuousBuild` → `services/github` → `services/prMonitor` → `services/agent` → `services/environment` (minimal DB) → `services/taskQueue` (biggest).
    4. Update `src/index.ts` — `initDatabase()` now returns the Drizzle client; `connectSavedEnvironments` needs the new query shape.
    5. Rewrite test suite: `__tests__/helpers/fakeEnvironment.ts` + every `describe` block that seeds via `db.prepare(...)`. Use pglite (`@electric-sql/pglite` already installed) for in-process Postgres. Expected test helper: `await createTestDb()` returns a Drizzle client over pglite with the migration applied; tests inject via `setDbClient()`.
    6. Drop `better-sqlite3` + `@types/better-sqlite3` from backend `package.json` + remove SQLite code from `db/index.ts` (the `getMigrations()` + `runMigrations()` functions — their logic is now encoded in the Drizzle schema).
    7. Final checks: `npm run typecheck`, `npm run lint`, `npm test --workspaces --if-present`, run `npm run dev:backend` locally against Supabase to hit the health endpoint.
  - **Estimated effort**: 3-4 hours of focused editing + 1-2 hours for tests. Single session, single atomic commit (no partial commits — keeps main green until it's done).
  - **Don't forget**: `jsonb` columns come back as parsed objects (not JSON strings) → remove `JSON.parse(row.field)`. Booleans come back as `true`/`false` (not `1`/`0`) → remove `=== 1` checks. Dates come back as `Date` instances (not ISO strings) → call `.toISOString()` when serializing to API responses.

- **Docs** landed/updated this session:
  - `docs/CONTINUOUS_BUILD_ROADMAP.md` already has Phase 18.1 + 18.4 (hosted backend) as #1 active — no doc change needed, just execution.
  - This session note.

- **Next action**: start fresh session. Re-read this note. Go through Phase C step-by-step per the plan above.

## Session 11 (Option 3 + fixes + hosting roadmap)
Shipped the "deterministic completion" path for Continuous Build tasks plus four targeted fixes, wrote the production roadmap, and stood up a one-command VM bootstrap script.

- **Option 3 (non-interactive autonomous mode)** (`packages/backend/src/services/agent.ts`):
  - New private `isAutonomousTask(taskId)` — looks up the task row, parses `metadata.backlogItemId`. True when the task was spawned by Continuous Build.
  - `startAgent` branches on this: autonomous tasks spawn `claude --print --permission-mode acceptEdits <quoted-prompt>` via the existing `bash -c` path in `environment.ts` (which already detected `claude --print` and runs accordingly). Process exit now = task done; `handleSessionClose(code=0)` transitions to `awaiting_review`; `code !== 0` transitions to `failed`. No prompt trickery, no hook, no polling.
  - Interactive (user-launched / pr_response / pr_review / manual) tasks unchanged — still PTY-based with prompt written via `writeToSession` after 500ms.
  - Prompt in `continuousBuild.ts:buildPrompt` rewritten: tells Claude to stop responding when done (exit is the signal); removed the "hit Ready for Review" instruction that was meant for humans.

- **Fix: SSH pty exit code** (`packages/backend/src/services/ssh.ts:189`, `agent.ts:178`):
  - ssh2's `stream.on('close', (code, signal) => ...)` does surface an exit code; we were ignoring it and always emitting 0. Now `pty:close` carries the real exit code (or 0 if ssh2 reports null for a normal close). Agent listener forwards it to `handleSessionClose`.

- **Fix: scheduler env-connectivity gate** (`continuousBuild.ts`):
  - New `isSourceEnvironmentReady(source)` — for SSH envs, skips sources whose env isn't `connected`. For local, always ready. Scheduler iterates sources, skips unconnected, tries next. Test covers the disconnect → connect → fire sequence.

- **`scripts/bootstrap-vm.sh`** (new):
  - Idempotent shell script, runnable over SSH (`ssh <host> bash -s -- [opts] < scripts/bootstrap-vm.sh`). Installs Node via nvm if < 18, npm-installs `@anthropic-ai/claude-code`, clones the FastOwl repo, builds shared + cli + mcp-server, npm-links the `fastowl` binary, writes `TALYN_API_URL` into `~/.bashrc` (in a managed block that round-trips safely on re-run). Flags: `--api-url`, `--branch`, `--install-dir`, `--skip-node`, `--skip-claude`, `--dry-run`, `--help`. This is the design target for the automated "Add SSH env → install daemon" flow that lands with Phase 18.3; until then you run it manually.

- **Docs**:
  - `docs/CONTINUOUS_BUILD_ROADMAP.md` — the top-of-queue plan. Three ordered phases: hosted backend (18.1+18.4), daemon split + SSH auto-install (18.3), Agent SDK migration (optional, later). Definition of done for "production ready" is explicit.
  - `docs/SSH_VM_SETUP.md` — fast path now front-loaded at the top pointing at the bootstrap script. Manual option kept below as fallback.

- **Tests**: 64 backend → 66 backend (2 new scheduler tests: env-disconnected skip, metadata.backlogItemId written on spawn). 66 + 7 MCP + 3 CLI + 1 desktop = 77 total.

- **Project doc updates**:
  - Priority queue re-ordered: hosted backend now #1 (active), daemon/auto-install #2, notifications #3. Continuous Build bulk-work moved to "done above." Everything else pushed to "later."
  - This session note.

Deferred: Layer-5 idle-timeout safeguard (nice-to-have — Option 3 means most timeouts are moot for autonomous tasks, only matters for interactive). Agent SDK migration (Phase 18 follow-up).

## Session 10 (Continuous Build — Phase 20)
Shipped the whole "point FastOwl at a TODO doc and it builds it" feature end-to-end, covering 20.1–20.5.

- **Backlog model** (`packages/backend/src/services/backlog/`):
  - `parser.ts` — GitHub-flavored markdown checklist parser with section scoping (`#/##/###`), indentation-based nesting, `(blocked)` / `[blocked]` detection, stable SHA1-based external IDs.
  - `service.ts` — DB helpers + `syncSource(id)` which reads the file via `environmentService.exec` and upserts items in a transaction, retiring vanished items rather than deleting (preserves claimed-task linkage).
  - Migrations 006 (`backlog_sources` + `backlog_items`) and 007 (`repository_id` on sources).
  - REST at `/api/v1/backlog/*` (sources CRUD + sync, items list, schedule trigger).

- **Scheduler** (`packages/backend/src/services/continuousBuild.ts`):
  - New in-process domain bus at `packages/backend/src/services/events.ts`. `emitTaskStatus` now fires on both websocket AND domainEvents.
  - Subscribes to `task:status`: on `completed` marks the claimed backlog item complete; on `failed/cancelled` releases the claim; on `awaiting_review` or any terminal status, re-evaluates `scheduleNext`.
  - `scheduleNext` respects workspace `continuousBuild.enabled/maxConcurrent/requireApproval`. Transactionally inserts a `code_writing` task row (status `queued`), claims the item, emits `task:status`.
  - Periodic 60s tick as safety net for missed events.

- **UI** (`apps/desktop/src/renderer/components/panels/SettingsPanel.tsx`):
  - New "Continuous Build" nav section. Toggle + `maxConcurrent` select + require-approval switch.
  - Source manager: add markdown_file source (path + section + environment), sync button per source, delete button.
  - Items preview with status chips.
  - "Run scheduler" button kicks `POST /backlog/schedule` for the current workspace.

- **`@talyn/cli`** (new workspace `packages/cli`):
  - `fastowl task create|list|ready` + `fastowl backlog sources|sync|items|schedule` + `fastowl ping`.
  - Thin fetch client (`src/client.ts`) using native fetch, unwraps `ApiResponse<T>`, throws typed `ApiError` on failure.
  - Commander-based command setup. Env-aware defaults read `TALYN_API_URL`, `TALYN_WORKSPACE_ID`, `TALYN_TASK_ID`.
  - README at `packages/cli/README.md`, 3 client tests, wired into root `typecheck`.

- **Agent env injection**:
  - `agent.ts` now builds an inline `KEY=val KEY=val claude` prefix via new exported `buildFastOwlEnvPrefix(workspaceId, taskId, { includeApiUrl })`.
  - For **local** envs, `TALYN_API_URL=http://localhost:${PORT}` is included. For **SSH** envs it's omitted — the remote shell supplies it via `.bashrc` (see SSH setup doc).
  - Workspace/task IDs are always included so `fastowl task create` works without flags in the child session.

- **Docs**:
  - `docs/SSH_VM_SETUP.md` — full end-to-end: install Claude CLI + fastowl on the VM, three networking options (SSH reverse tunnel / LAN bind / backend on VM), wire up the SSH env in the desktop app, first task, turn on Continuous Build. Troubleshooting section covers the common cases (`claude: command not found`, `ECONNREFUSED` on child CLI calls, SSH drop).
  - `docs/CONTINUOUS_BUILD.md` — feature-level walkthrough: mental model, backlog file format, task-spawns-task via CLI, "turn it on for FastOwl itself" recipe, known limitations.

- **Tests**: 59 backend → 64 backend + 3 CLI = 67 total Vitest + 1 Jest smoke.
  - Parser: 9 tests (flat, nesting, section scoping, stop-at-heading, blocked detection, stable IDs, blank-skip, case-insensitive heading).
  - Service: 9 tests (round-trip, update, delete, syncSource add/retire/claim-preserved, nextActionableItem, skip-claimed, null-when-empty).
  - Scheduler: 8 tests (disabled no-op, spawn-on-empty, maxConcurrent cap, approval hold, approval-off proceed, task-completed → item-completed, task-failed → item-released, disabled-source skip).
  - Env prefix: 5 tests (API-URL default/override, task id optional, single-quote escape, SSH exclusion).
  - CLI: 3 tests (unwrap success, throw on error, POST body).
  - Extended `fakeEnvironment` helper to stub `exec` in addition to `spawnInteractive` so the backlog service's file-read path is testable without a real shell.

Deferred for 20.6: FastOwl MCP server. Deferred for 20.7: GitHub/Linear sources, priority inference, cross-source scheduling, structured `depends-on` annotations.

## Session 9 (Approval Gates — Phase 16.2 + 16.5)
- **Backend agent close** (`packages/backend/src/services/agent.ts`):
  - Clean exit (code 0) now sets task to `awaiting_review` instead of `completed` (no `completed_at`)
  - Non-zero exit still sets task to `failed`
  - Emits `task:status` WS event for the transition
- **New routes** (`packages/backend/src/routes/tasks.ts`):
  - `POST /tasks/:id/ready-for-review` — stops agent, moves task to awaiting_review (agent tasks only)
  - `POST /tasks/:id/approve` — awaiting_review → completed
  - `POST /tasks/:id/reject` — awaiting_review → queued for another pass
- **Frontend API + hooks** (`apps/desktop/src/renderer/lib/api.ts`, `apps/desktop/src/renderer/hooks/useApi.ts`):
  - `api.tasks.readyForReview/approve/reject` client methods
  - `readyForReview/approveTask/rejectTask` in `useTaskActions`
- **UI**:
  - `TaskTerminal` now has a primary "Ready for Review" button alongside "Stop" (stop = discard; ready = approval flow)
  - `QueuePanel` TaskDetail shows "Approve" and "Reject & Requeue" buttons when `task.status === 'awaiting_review'`

**Deferred**: git diff preview in the approval view, approval comments, push-after-approve automation, automated PR response triggering (16.3), PR review batch-post flow (16.4).

## Session 8 (Task Type System — Phase 16.1)
- **Shared types** (`packages/shared/src/index.ts`):
  - `TaskType` expanded to `'code_writing' | 'pr_response' | 'pr_review' | 'manual'`
  - Added `AGENT_TASK_TYPES` constant and `isAgentTask(type)` helper
- **Migration 005** (`packages/backend/src/db/index.ts`):
  - `UPDATE tasks SET type = 'code_writing' WHERE type = 'automated'`
- **Task queue + routes** (`packages/backend/src/services/taskQueue.ts`, `packages/backend/src/routes/tasks.ts`):
  - Auto-processing check switched from `type === 'automated'` to `isAgentTask(type)` (any non-manual)
  - `/tasks/:id/start` now accepts any agent task type
- **CreateTaskModal**:
  - 4-button type picker (Code / PR Response / PR Review / Manual) with icons
  - Type-specific prompt placeholder and description
  - Switches between prompt-first (agent) and title-first (manual) layouts via `isAgentTask`
- **QueuePanel**:
  - `taskTypeConfig` renders type-specific icon + label in task list items and detail view
  - Replaced `isAutomated` check with `isAgentTask(task.type)` for "Start Now" button gating

**Deferred for 16.2-16.5**: approval gates (awaiting_review status), diff preview, automated PR Response triggering, PR Review batch-post flow, type-specific default prompt templates.

## Session 7 (Task Terminal History Persistence)
- **Migration 004** (`packages/backend/src/db/index.ts`):
  - Added `terminal_output TEXT NOT NULL DEFAULT ''` column to `tasks` table
- **Append-only task output** (`packages/backend/src/services/agent.ts`):
  - `handleSessionData` now appends incoming chunks to `tasks.terminal_output` via `SET terminal_output = terminal_output || ?`
  - Write cost proportional to each chunk rather than the full buffer
  - Agent record is still truncated to last 10k chars; task output grows for full history
  - Session close preserves the task's output (only deletes the stale agents row)
- **Tasks route** (`packages/backend/src/routes/tasks.ts`):
  - `rowToTask` now takes optional `{ includeTerminalOutput }` flag — only the single-task GET pulls the full output to keep list responses small
  - `/tasks/:id/terminal` falls back to `tasks.terminal_output` when no active agent, so completed/failed/cancelled tasks still return history
- **TerminalHistory component** (`apps/desktop/src/renderer/components/panels/TerminalHistory.tsx`):
  - Fetches task terminal output on mount via `api.tasks.getTerminal`
  - Renders in read-only XTerm with collapse/expand toggle and char count
  - Wired into QueuePanel TaskDetail for `completed`, `failed`, `cancelled` statuses

**Deferred for Phase 15.2/15.4**: structured ndJson conversation log, session resume via Claude CLI, collapsible tool-use sections, history search.

## Session 6 (PR Monitoring + Repository Selector)
- Created PR Monitor service (`packages/backend/src/services/prMonitor.ts`):
  - Polls watched repos every 60 seconds for changes
  - Tracks PR state (reviews, comments, CI status, mergeability)
  - Creates inbox items for: new reviews (approved, changes requested), new review comments, new general comments, CI failures, PR becoming mergeable
  - Filters out user's own comments to avoid self-notifications
  - Initializes state on first poll without creating notifications
- Extended GitHub service (`packages/backend/src/services/github.ts`):
  - Added getPRReviews, getPRReviewComments, getPRComments methods
  - Added GitHubReview, GitHubReviewComment, GitHubIssueComment interfaces
  - Added getConnectedWorkspaces method
- Created repository routes (`packages/backend/src/routes/repositories.ts`):
  - GET / — list watched repos for workspace
  - POST / — add watched repo
  - DELETE /:id — remove watched repo
  - POST /poll — force poll refresh
- Added frontend API client for repositories (`apps/desktop/src/renderer/lib/api.ts`):
  - WatchedRepo type
  - list, add, remove, forcePoll methods
- Updated WorkspaceSettings in SettingsPanel:
  - Real watched repositories list from backend
  - Repository selector with GitHub repo search
  - Add/remove repository functionality
  - Manual poll refresh button

## Session 5 (GitHub OAuth Integration)
- Created GitHub service (`packages/backend/src/services/github.ts`):
  - OAuth authorization URL generation with CSRF state
  - Code-to-token exchange
  - Token storage in integrations table
  - REST API methods: getUser, listRepositories, listPullRequests, getPullRequest, getCheckRuns, createPRComment
  - Auto-load tokens on service init
- Created GitHub routes (`packages/backend/src/routes/github.ts`):
  - GET /status — check configuration and connection status
  - POST /connect — start OAuth flow, return auth URL
  - GET /callback — handle OAuth callback, store token
  - POST /disconnect — remove token
  - GET /user — get authenticated user
  - GET /repos — list repositories
  - GET /repos/:owner/:repo/pulls — list PRs
  - GET /repos/:owner/:repo/pulls/:number/checks — get CI status
- Added GitHub API client to frontend (`apps/desktop/src/renderer/lib/api.ts`):
  - Type definitions for GitHubStatus, GitHubUser, GitHubRepo, GitHubPullRequest
  - Methods: getStatus, connect, disconnect, getUser, listRepos, listPullRequests
- Updated IntegrationsSettings in SettingsPanel:
  - Real-time status fetching from backend
  - Connect button opens OAuth in new window
  - Shows connected user (@username)
  - Disconnect button to remove connection
  - Proper error handling and loading states
- Configuration: Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_REDIRECT_URI env vars

## Session 4 (Task Queue UI + Settings Panel + ESLint + Workspace Editing)
- Created CreateTaskModal (`apps/desktop/src/renderer/components/modals/CreateTaskModal.tsx`):
  - Form fields: title, description, type (automated/manual), priority
  - For automated tasks: agent prompt and preferred environment selection
  - Wired to useTaskActions hook and API
- Updated QueuePanel (`apps/desktop/src/renderer/components/panels/QueuePanel.tsx`):
  - Wired all "Add Task" buttons to open CreateTaskModal
  - Added task action buttons in TaskDetail: Queue, Unqueue, Cancel
  - Actions wired to useTaskActions hook (updateTaskStatus, cancelTask)
- Created SettingsPanel (`apps/desktop/src/renderer/components/panels/SettingsPanel.tsx`):
  - Three sections: Workspace, Integrations, Environments
  - Workspace section: shows name, description, automation settings, repos
  - Integrations section: GitHub, Slack, PostHog connection UI (not wired to backend)
  - Environments section: list environments, test connection, delete
- Updated store to support 'settings' as activePanel
- Wired Settings button in Sidebar footer
- **Fixed ESLint configuration**:
  - Removed broken 'erb' extends from root config
  - Simplified to use eslint:recommended + @typescript-eslint/recommended
  - Removed deprecated ESLint directives from main.ts, util.ts
  - Fixed all unused variable errors across desktop and backend
  - Added varsIgnorePattern and caughtErrorsIgnorePattern for underscore prefix
- **Wired workspace settings editing**:
  - Added useWorkspaceActions hook with updateCurrentWorkspaceSettings
  - Made auto-assign toggle and max agents select interactive in Settings
  - Backend correctly handles partial settings updates (merges with existing)
- Wired agent input sending to agentService in routes/agents.ts

## Session 3 (Terminal + Environment UI)
- Added xterm.js integration (`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`)
- Created XTerm component (`apps/desktop/src/renderer/components/terminal/XTerm.tsx`):
  - Dark theme with proper VS Code-like colors
  - Auto-resize with FitAddon
  - Clickable links with WebLinksAddon
  - Efficient output appending (detects incremental updates)
- Created UI components:
  - Dialog, Input, Select, Textarea (`apps/desktop/src/renderer/components/ui/`)
  - StartAgentModal (`apps/desktop/src/renderer/components/modals/StartAgentModal.tsx`)
  - AddEnvironmentModal (`apps/desktop/src/renderer/components/modals/AddEnvironmentModal.tsx`)
- Updated TerminalsPanel to use:
  - XTerm for terminal rendering
  - StartAgentModal for creating new agents
  - Wired stop agent and send input functionality
- Updated Sidebar to show real environments from store with status indicators
- Added skipLibCheck to tsconfig for lucide-react compatibility

## Session 2 (Foundation + Backend Services)
- Restructured to monorepo: `apps/desktop`, `packages/backend`, `packages/shared`
- Created all core types in `@talyn/shared`
- Built backend server with Express + WebSocket, SQLite database with migrations, REST API routes for all entities, WebSocket service for real-time events
- Added Tailwind CSS + PostCSS to renderer
- Created shadcn/ui style components (Button, Card, Badge, ScrollArea)
- Built UI shell with Sidebar (workspace selector, navigation, environment status), InboxPanel (prioritized items, actions, read/unread states), TerminalsPanel (agent list, terminal view, status indicators), QueuePanel (task list, detail view, priority badges)
- Added Zustand store for app state management
- **SSH Service** (`packages/backend/src/services/ssh.ts`): SSH connection management via ssh2, connection pooling and auto-reconnection, PTY support for interactive terminal sessions, command execution on remote environments
- **Environment Service** (`packages/backend/src/services/environment.ts`): Manages local + SSH environments, health checking, interactive session spawning
- **Agent Service** (`packages/backend/src/services/agent.ts`): Spawns Claude CLI processes on environments, output parsing for status detection, auto-creates inbox items when agent needs attention, agent lifecycle management
- **Task Queue Service** (`packages/backend/src/services/taskQueue.ts`): Automatic task assignment to idle agents, priority-based queue processing, respects workspace maxConcurrentAgents setting
- **Frontend API Client** (`apps/desktop/src/renderer/lib/api.ts`): HTTP client for all backend endpoints, WebSocket client with auto-reconnection, real-time event handling
- **React Hooks** (`apps/desktop/src/renderer/hooks/useApi.ts`): `useApiConnection`, `useInitialDataLoad`, `useAgentActions`, `useTaskActions`, `useInboxActions`
- App auto-detects backend availability; falls back to demo data if not running

## Session 1 (Initial)
- Created the initial context document
- Explored Electron boilerplate structure
- Reviewed PostHog's Coder devbox implementation for reference
- Established architecture decisions
- Created initial TODO list
