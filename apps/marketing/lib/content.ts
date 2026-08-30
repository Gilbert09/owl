/**
 * Single source of truth for all marketing copy.
 * Edit here to retune the voice without touching component layout.
 */

export const site = {
  name: "Talyn",
  domain: "talyn.dev",
  /** Canonical origin — the apex 308-redirects to www at the Vercel level. */
  url: "https://www.talyn.dev",
  tagline: "Wake up to green PRs.",
  description:
    "Talyn ranks your whole PR queue by what's blocking you, then sends cloud agents to fix the checks, clear the conflicts, and reply to reviews, so your PRs land without you babysitting them.",
  githubUrl: "https://github.com/Gilbert09/talyn",
  /** The browser app — same product, nothing to install. */
  appUrl: "https://app.talyn.dev",
  /** Support/contact channel — every Talyn user has a GitHub account. */
  supportUrl: "https://github.com/Gilbert09/talyn/issues",
};

export const nav = [
  { label: "How it works", href: "#how" },
  { label: "Features", href: "#features" },
  { label: "Providers", href: "#providers" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
];

export const hero = {
  badge: "Public beta",
  titleLead: "Wake up to",
  titleAccent: "green PRs.",
  sub: "You live in GitHub PRs, and half of them are red, behind main, or stuck waiting on a review. Talyn ranks the whole queue by what's blocking you, then sends a cloud agent to clear each one. Flag the PRs you trust and they merge themselves the moment they go green, overnight included.",
  primaryCta: "Download for {platform}",
  secondaryCta: "See how it works",
  webCta: "Open in browser",
  microtrust: "macOS, Windows & Linux — or run it in your browser",
};

export const poweredBy = {
  kicker: "Bring your own agent",
  blurb:
    "Talyn conducts the coding agents you already trust.",
  logos: [
    { name: "Claude Code", mark: "claude" as const },
    { name: "PostHog Code", mark: "posthog" as const },
  ],
};

export const problem = {
  kicker: "The PR tax",
  title: "Babysitting CI is a full-time job.",
  body: "Shipping with AI got fast. The part after the PR opens did not. Every green checkmark is one git pull, one flaky retry, one \"merge main into your branch\" away from being your whole afternoon.",
  pains: [
    {
      title: "The refresh loop",
      body: "Ten GitHub tabs open, hunting for which PR just went red, got a review, or quietly fell behind main.",
    },
    {
      title: "CI whack-a-mole",
      body: "A one-line lint fix means checking out the branch, re-running the suite, pushing, and waiting. Again.",
    },
    {
      title: "Stale-branch rot",
      body: "You approved it Tuesday. It's Thursday, main moved, and now it conflicts. Back to square one.",
    },
    {
      title: "Agent babysitting",
      body: "You kicked off an agent, then sat there watching the log so you could merge it yourself.",
    },
  ],
};

export const how = {
  kicker: "How it works",
  title: "Three steps from chaos to merged.",
  sub: "Connect once. Talyn handles the loop.",
  steps: [
    {
      n: "01",
      title: "Connect GitHub",
      body: "Sign in with GitHub and pick the repos you live in. Your PR queue shows up right away. You only connect a cloud agent (Claude Code or PostHog Code) when you send your first fix, not before.",
      shot: "onboarding",
    },
    {
      n: "02",
      title: "Talyn watches every PR",
      body: "One live dashboard ranks your PRs by what needs you. CI status, review state, conflicts, and merge-readiness, all at a glance, in real time.",
      shot: "dashboard",
    },
    {
      n: "03",
      title: "Delegate, or let it auto-fix",
      body: "Hit \"fix this PR\" and a cloud agent resolves CI and pushes the fix to the branch. Run one of your skills on it: a review pass, a security sweep. Or flag it keep-mergeable and Talyn does it the moment things go red.",
      shot: "task-running",
    },
  ],
};

export const features = [
  {
    id: "dashboard",
    eyebrow: "Mission control",
    title: "Every PR, triaged. No tabs required.",
    body: "A live dashboard sorts your work into Needs attention, Mine, and Review. Status pills show the CI rollup, review state, and conflicts at a glance, so the PR that's actually blocking you is always at the top.",
    bullets: [
      "Real-time check rollups across every watched repo",
      "Needs-attention bucket surfaces blockers instantly",
      "Diffs, checks, and conversation right inside the app",
    ],
    shot: "dashboard",
    flip: false,
  },
  {
    id: "delegate",
    eyebrow: "Delegate the drudgery",
    title: "Send a cloud agent. Get back a mergeable PR.",
    body: "Point Talyn at a PR that's red or behind main and it dispatches a cloud agent to fix the checks, clear the conflicts, and answer the review, pushing straight to the branch. Watch the transcript stream live; what comes back is green ticks, ready to merge.",
    bullets: [
      "Fixes CI, resolves conflicts, addresses review comments",
      "Live transcript streaming as the agent works",
      "Green checks back on your existing PR, no new PR to wrangle",
    ],
    shot: "task-running",
    flip: true,
  },
  {
    id: "auto-merge",
    eyebrow: "The merge queue",
    title: "A merge queue that lands PRs for you.",
    body: "Flag a PR keep-mergeable and Talyn watches it: the moment it falls behind main, hits a conflict, or goes red, a fix run dispatches automatically. Then the merge queue takes over. It lands your PRs in order the second they're green, rebasing and clearing conflicts along the way, and drains independent PRs concurrently so one slow branch never holds up the rest.",
    bullets: [
      "Lands ready PRs in order, the moment they go green",
      "Rebases and resolves conflicts on the way in, no manual \"update branch\"",
      "Independent PRs merge in parallel; one slow build can't stall the queue",
      "Auto-fixes any PR that falls behind or breaks before it merges",
    ],
    shot: "merge-queue",
    flip: false,
  },
  {
    id: "skills",
    eyebrow: "Skills",
    title: "Your playbooks, runnable on any PR.",
    body: "Skills are reusable agent playbooks: a security sweep, your team's review checklist, a changelog writer. Talyn finds them everywhere they already live, whether that's committed to the repo, sitting in ~/.claude/skills on your machine, or saved to your workspace. Hit the wand on any PR, pick one, and a cloud agent runs it against that PR, posting the review or pushing the fix.",
    bullets: [
      "Picks up SKILL.md files from the repo, your machine, and your workspace, zero setup",
      "Searchable picker with your most-used skills on top",
      "Output lands on the PR: a single review comment, or commits to the branch",
    ],
    shot: "skill-picker",
    flip: true,
  },
  {
    id: "context",
    eyebrow: "Full context, zero tabs",
    title: "Know what's blocking. Know what's ready.",
    body: "See the diff, the check breakdown, the conversation, and the review state for any PR without leaving Talyn. The ones that are good to go go straight into the merge queue.",
    bullets: [
      "Diffs, checks, and conversation in one view",
      "Live review + CI state at a glance",
      "Queue the ready ones straight to merge",
    ],
    shot: "pr-detail",
    flip: false,
  },
];

/** Compact CTA band mid-page — the stretch between Features and Pricing had
 *  no action to take without scrolling to the bottom. */
export const midCta = {
  title: "Ready to stop babysitting CI?",
  sub: "Open it in your browser or download the app, connect your repos, and clear the queue tonight.",
  cta: "Download for {platform}",
  secondary: "See pricing",
};

export const providers = {
  kicker: "Providers",
  title: "No lock-in. Use the agent you trust.",
  sub: "Talyn is a pluggable conductor for cloud coding agents. Use the one your team already pays for, or pick a different one per task.",
  items: [
    {
      name: "Claude Code",
      mark: "claude" as const,
      body: "Anthropic's hosted agents run the loop and push the fix back to your PR, live transcript and all.",
    },
    {
      name: "PostHog Code",
      mark: "posthog" as const,
      body: "Connect PostHog Code to power auto-fixes, conflict resolution, and review replies end to end.",
    },
    {
      name: "More on the way",
      mark: "soon" as const,
      body: "Every provider is a self-contained module behind one clean interface, so the next agent slots in without touching your workflow.",
    },
  ],
};

export const why = {
  kicker: "Why Talyn",
  title: "Talyn fixes what other tools only flag.",
  cards: [
    {
      title: "Triage that thinks",
      body: "Every PR ranked by what needs you (blocked, behind, or ready) the moment you open the app.",
    },
    {
      title: "Fixes, not just alerts",
      body: "Other tools tell you CI broke. Talyn sends an agent to fix it and push the checks back to green.",
    },
    {
      title: "Stays green on its own",
      body: "Flag a PR keep-mergeable and Talyn re-fixes it the moment it falls behind or breaks.",
    },
    {
      title: "Bring your own agent",
      body: "Claude Code or PostHog Code, whichever you trust. No model lock-in, switch per task.",
    },
    {
      title: "A merge queue that lands them",
      body: "Queue your ready PRs and Talyn merges them in order the second they're green, rebasing and clearing conflicts on the way, and landing independent ones in parallel.",
    },
    {
      title: "Built to live in",
      body: "Real diffs, live transcripts, instant triage: the polish of a tool you keep open all day.",
    },
  ],
};

export const pricing = {
  kicker: "Pricing",
  title: "Start free. Upgrade when the queue gets serious.",
  sub: "Talyn is the control tower. Your cloud agents do the flying, billed by the provider you connect. One flat price for the tower.",
  footnote:
    "Prices exclude agent usage: runs execute in your provider's cloud, on your account and credits. Upgrade, manage, or cancel anytime from Settings → Billing in the app.",
  annualBadge: "2 months free",
  tiers: [
    {
      name: "Free",
      priceMonthly: "$0",
      priceAnnual: "$0",
      period: "forever",
      periodAnnualNote: null,
      blurb: "Full mission control, for a calmer queue.",
      features: [
        "The whole PR dashboard, every repo, every workspace",
        "All agent providers, switch per task",
        "Skills, the merge queue & auto-keep-mergeable on any PR you flag",
        "Up to 3 tasks running and 3 PRs queued at once",
      ],
      cta: "Download for {platform}",
      highlighted: false,
    },
    {
      name: "Unlimited",
      priceMonthly: "$15",
      priceAnnual: "$12.50",
      period: "/month",
      periodAnnualNote: "billed annually ($150/yr)",
      blurb: "For the weeks when everything ships at once.",
      features: [
        "Everything in Free",
        "Unlimited concurrent tasks",
        "Unlimited PRs in the merge queue",
        "Keep every new PR green automatically, without flagging them one by one",
        "Automation never waits for a slot: merge queue and auto-keep always dispatch",
        "Cancel anytime, in-app",
      ],
      cta: "Download & upgrade in-app",
      highlighted: true,
    },
  ],
};

export const faq = [
  {
    q: "What is Talyn, exactly?",
    a: "A desktop app that tracks your GitHub PRs and delegates the routine work (fixing CI, clearing conflicts, replying to reviews) to cloud coding agents that run the loop and push the fix back to your PR. Think mission control for getting PRs to a mergeable state.",
  },
  {
    q: "Which AI agents does it use?",
    a: "You bring your own. Claude Code (Anthropic Managed Agents) and PostHog Code are supported today, with more providers on the way. Talyn conducts whichever provider you connect, and you can switch per task.",
  },
  {
    q: "Where does the work actually happen?",
    a: "Agent runs happen in your provider's cloud, under your account. Talyn is the desktop control surface that kicks them off, streams the progress live, and links the resulting PR back onto your dashboard.",
  },
  {
    q: "What are skills?",
    a: "Reusable agent playbooks: SKILL.md files, the same format Claude Code uses. Talyn discovers them in the PR's repo (.claude/skills), on your machine (~/.claude/skills), and in your workspace, and lets you run any of them against a PR with one click. The agent follows the skill and posts its output back to the PR, as a review comment or as commits to the branch.",
  },
  {
    q: "How does auto-keep-mergeable work?",
    a: "Flag a PR and Talyn watches it. When it falls behind main, hits a conflict, or fails CI, Talyn dispatches a cloud fix run automatically. Once the checks are green again, the merge queue lands it in order. Flagging PRs one at a time is free; having every new PR you open flagged automatically is an Unlimited feature.",
  },
  {
    q: "Is my code safe?",
    a: "Talyn talks to GitHub and your chosen provider over their official APIs using credentials you supply. The heavy lifting runs in the provider's sandbox under your account, and Talyn never stores your source.",
  },
  {
    q: "What does it cost?",
    a: "The free plan is the full app with up to 3 tasks running and 3 PRs in the merge queue at once, and auto-keep-mergeable on any PR you flag by hand. Unlimited removes both caps and keeps every new PR you open mergeable automatically, for $15/month (or $150/year, 2 months free), managed entirely in-app with cancel-anytime. Either way you bring your own cloud-agent credits: runs execute under the provider account you connect.",
  },
  {
    q: "What platforms are supported?",
    a: "All of them. There are desktop builds for macOS (Apple silicon), Windows and Linux, and a web app at app.talyn.dev that needs no install at all — same product, same account, your workspaces and PR queue follow you between them. The desktop app adds two things a browser can't: it reads skills from ~/.claude/skills on your machine, and it keeps your session in the OS keychain.",
  },
];

export const finalCta = {
  titleLead: "Stop babysitting CI.",
  titleAccent: "Let the talons out.",
  sub: "In public beta. Bring your own agent. Clear your PR backlog tonight.",
  cta: "Download for {platform}",
  // Waitlist row (absorbed from the removed Beta section).
  emailLabel: "Want release notes? Get notified.",
  emailPlaceholder: "you@startup.dev",
  emailCta: "Notify me",
};

export const footer = {
  blurb: "Mission control for your GitHub PRs, powered by cloud coding agents.",
  madeBy: "Made by night owls who were tired of babysitting CI.",
  columns: [
    {
      title: "Product",
      links: [
        { label: "How it works", href: "/#how" },
        { label: "Features", href: "/#features" },
        { label: "Providers", href: "/#providers" },
        { label: "Pricing", href: "/#pricing" },
        { label: "Download", href: "/#download" },
        { label: "Open the web app", href: site.appUrl },
      ],
    },
    {
      title: "Company",
      links: [
        { label: "FAQ", href: "/#faq" },
        { label: "GitHub", href: site.githubUrl },
        { label: "Support", href: site.supportUrl },
      ],
    },
    {
      title: "Legal",
      links: [
        { label: "Privacy", href: "/privacy" },
        { label: "Terms", href: "/terms" },
      ],
    },
  ],
};
