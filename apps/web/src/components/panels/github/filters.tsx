import { ArrowUpDown } from 'lucide-react';

export type SortDir = 'asc' | 'desc';

/** Repo dropdown — native select keeps the bar compact + keyboard-friendly. */
export function RepoFilter({
  value,
  onChange,
  repos,
}: {
  value: string;
  onChange: (v: string) => void;
  repos: Array<{ id: string; name: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 rounded-md border bg-background px-2 py-0 text-xs leading-7"
    >
      <option value="all">All repos</option>
      {repos.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </select>
  );
}

/** Created-at sort toggle (newest/oldest first). */
export function SortToggle({ sortDir, onToggle }: { sortDir: SortDir; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-1 rounded-md border px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
      title={`Sorted by created date — ${
        sortDir === 'desc' ? 'newest first' : 'oldest first'
      }. Click to flip.`}
    >
      <ArrowUpDown className="h-3 w-3" />
      {sortDir === 'desc' ? 'Newest' : 'Oldest'}
    </button>
  );
}

/**
 * Whether a PR matches a (lowercased, trimmed) search query by its title,
 * `owner/repo`, `owner/repo#number` ref, or bare PR number. A leading `#` on
 * the query is ignored so both `#123` and `123` match the number.
 */
export function prMatchesText(
  r: { owner: string; repo: string; number: number; summary: { title?: string } },
  q: string
): boolean {
  const title = r.summary.title?.toLowerCase() ?? '';
  const repo = `${r.owner}/${r.repo}`.toLowerCase();
  const ref = `${repo}#${r.number}`;
  const num = String(r.number);
  return (
    title.includes(q) ||
    ref.includes(q) ||
    num.includes(q.replace(/^#/, ''))
  );
}

/** Order two PRs by when they were opened on GitHub (DB createdAt fallback). */
export function compareByCreated(
  a: { summary: { createdAt?: string }; createdAt: string },
  b: { summary: { createdAt?: string }; createdAt: string },
  sortDir: SortDir
): number {
  const ta = new Date(a.summary.createdAt || a.createdAt).getTime();
  const tb = new Date(b.summary.createdAt || b.createdAt).getTime();
  return sortDir === 'desc' ? tb - ta : ta - tb;
}
