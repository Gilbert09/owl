import { useEffect } from 'react';
import { Bug, Sparkles, Zap } from 'lucide-react';
import type { HighlightKind, ReleaseNoteEntry } from '@talyn/shared';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { useWorkspaceStore } from '../../stores/workspace';

/**
 * "What's new" — the highlights that landed since the version this client last
 * showed, grouped by release.
 *
 * Self-driving and prop-less, like ConnectAgentModal: mounted once in
 * MainLayout, opened either by useWhatsNew on launch or by the button in
 * Settings → About. It renders whatever it is handed and never fetches; the
 * decision about whether there is anything worth showing is made before it
 * opens (see @talyn/shared's shouldShowWhatsNew).
 *
 * Several releases at once is the normal case, not the exception — Talyn ships
 * every night, so a user who has been away for a week sees a week of them.
 */

const KIND_ICON: Record<HighlightKind, typeof Sparkles> = {
  feature: Sparkles,
  fix: Bug,
  improvement: Zap,
};

const KIND_CLASS: Record<HighlightKind, string> = {
  feature: 'text-primary',
  fix: 'text-muted-foreground',
  improvement: 'text-muted-foreground',
};

function releaseDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function Release({ entry, showVersion }: { entry: ReleaseNoteEntry; showVersion: boolean }) {
  return (
    <section className="space-y-3">
      {showVersion && (
        <div className="flex items-baseline gap-2 border-b pb-1.5">
          <h3 className="text-sm font-medium">Version {entry.version}</h3>
          <span className="text-xs text-muted-foreground">{releaseDate(entry.publishedAt)}</span>
        </div>
      )}
      <ul className="space-y-3">
        {entry.highlights.map((h) => {
          const Icon = KIND_ICON[h.kind];
          return (
            <li key={`${entry.version}-${h.title}`} className="flex gap-3">
              <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', KIND_CLASS[h.kind])} />
              <div className="min-w-0">
                <p className="text-sm font-medium leading-snug">{h.title}</p>
                <p className="mt-0.5 text-sm text-muted-foreground leading-snug">
                  {h.description}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function WhatsNewModal() {
  const open = useWorkspaceStore((s) => s.whatsNewOpen);
  const entries = useWorkspaceStore((s) => s.whatsNewEntries);
  const close = useWorkspaceStore((s) => s.closeWhatsNew);

  // ui/dialog is hand-rolled — no Radix, so no Escape handling comes for free.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Only worth stamping each release with its own heading when there is more
  // than one; a single release's version is already in the description.
  const multiple = entries.length > 1;
  const only = entries[0];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="max-w-2xl" onClose={close}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            What&rsquo;s new
          </DialogTitle>
          <DialogDescription>
            {entries.length === 0
              ? 'Nothing new to report yet.'
              : multiple
                ? `Everything that landed across ${entries.length} releases since you last looked.`
                : `Version ${only.version}, released ${releaseDate(only.publishedAt)}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-6 overflow-y-auto py-2 pr-1">
          {entries.map((entry) => (
            <Release key={entry.version} entry={entry} showVersion={multiple} />
          ))}
        </div>

        <DialogFooter>
          <Button size="sm" onClick={close}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
