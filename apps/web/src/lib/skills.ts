// Pure helpers for the skill picker — local-skill summary derivation and
// the usage-ordered sort. Kept free of React/api imports so Jest can hit
// them directly.

import {
  localSkillKey,
  parseSkillFrontmatter,
  SKILL_MAX_BYTES,
  type SkillSummary,
  type SkillUsageEntry,
} from '@talyn/shared';
import type { LocalSkillFile } from './env';

/**
 * Turn the raw IPC listing into picker summaries. Frontmatter `name` wins
 * over the directory name; duplicate names keep the first occurrence
 * (directory order) since the key namespace is flat for local skills.
 */
export function toLocalSkillSummaries(files: LocalSkillFile[]): SkillSummary[] {
  const seen = new Set<string>();
  const out: SkillSummary[] = [];
  for (const file of files) {
    const parsed = file.content !== null ? parseSkillFrontmatter(file.content) : null;
    const name = parsed?.name ?? file.dirName;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      key: localSkillKey(name),
      source: 'local',
      name,
      description: parsed?.description ?? '',
      localPath: file.path,
      contentSize: file.size,
    });
  }
  return out;
}

/** A skill too large to inline into a prompt — listed but not runnable. */
export function isSkillTooLarge(skill: SkillSummary): boolean {
  return (skill.contentSize ?? 0) > SKILL_MAX_BYTES;
}

const SOURCE_ORDER: Record<SkillSummary['source'], number> = {
  repo: 0,
  platform: 1,
  local: 2,
};

/**
 * Filter by the query (name/description substring, case-insensitive) and
 * order for the picker: most-used first (count desc), recency as the
 * tiebreak, then never-used skills grouped by source (repo, platform,
 * local) and alphabetical within each.
 */
export function sortSkillsForPicker(
  skills: SkillSummary[],
  usage: Record<string, SkillUsageEntry>,
  query: string
): SkillSummary[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? skills.filter(
        (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
      )
    : [...skills];

  return filtered.sort((a, b) => {
    const ua = usage[a.key];
    const ub = usage[b.key];
    if ((ub?.count ?? 0) !== (ua?.count ?? 0)) return (ub?.count ?? 0) - (ua?.count ?? 0);
    if (ua && ub && ua.lastUsedAt !== ub.lastUsedAt) {
      return ub.lastUsedAt.localeCompare(ua.lastUsedAt);
    }
    if (SOURCE_ORDER[a.source] !== SOURCE_ORDER[b.source]) {
      return SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
    }
    return a.name.localeCompare(b.name);
  });
}

/** The top-N used skills, for the picker's "Frequently used" section. */
export function frequentlyUsedSkills(
  skills: SkillSummary[],
  usage: Record<string, SkillUsageEntry>,
  limit = 4
): SkillSummary[] {
  return skills
    .filter((s) => (usage[s.key]?.count ?? 0) > 0)
    .sort((a, b) => {
      const ua = usage[a.key]!;
      const ub = usage[b.key]!;
      if (ub.count !== ua.count) return ub.count - ua.count;
      return ub.lastUsedAt.localeCompare(ua.lastUsedAt);
    })
    .slice(0, limit);
}
