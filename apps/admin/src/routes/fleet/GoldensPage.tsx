import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AdminFleetHost, AdminGcResult, AdminGolden } from '@talyn/shared';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { StatCard } from '../../components/ui/StatCard';
import { CopyableId } from '../../components/ui/CopyableId';
import { absolute, bytes, relativeAge, shortSha } from '../../lib/format';
import { GOLDEN_GC_LOW_PCT, goldenFreePct } from '../../lib/fleetView';
import { useAdminMutation } from '../../hooks/useAdminMutation';
import { ConfirmMutationDialog } from '../../components/admin/ConfirmMutationDialog';
import { useCapability } from '../../components/auth/AdminGate';

/**
 * Baked images on one host.
 *
 * Host-scoped because goldens are: they are files on that box's XFS volume,
 * and "the fleet's goldens" is not a thing that exists. The host picker lives
 * in the URL so a link points at a specific box's images.
 *
 * `diskBytes` is the number that bills — it is reflink-aware, so a per-repo
 * layer sharing extents with the base image costs far less than its apparent
 * size. Showing apparent size as the headline would have an operator GC'ing to
 * reclaim space that was never occupied.
 */
export function GoldensPage() {
  const [params, setParams] = useSearchParams();
  const host = params.get('host') ?? '';

  const hosts = useAdminQuery<AdminFleetHost[]>(() => api.admin.fleet.hosts(), {});

  // Default to the first online host rather than making the operator pick
  // before seeing anything — there is usually exactly one.
  const effectiveHost = host || hosts.data?.find((h) => h.online)?.name || '';

  const goldens = useAdminQuery(() => api.admin.fleet.goldens(effectiveHost), {
    deps: [effectiveHost],
    enabled: Boolean(effectiveHost),
  });

  const canMutate = useCapability('fleet.mutate');
  const pin = useAdminMutation<AdminGolden>(goldens.refresh);
  const gc = useAdminMutation<{ host: string; force: boolean }>(goldens.refresh);

  const [gcResult, setGcResult] = useState<AdminGcResult | null>(null);

  const view = goldens.data;
  const rows = view?.goldens ?? null;
  const free = goldenFreePct(view?.freePct);
  const totalDisk = (rows ?? []).reduce((n, g) => n + g.diskBytes, 0);
  const stale = (rows ?? []).filter((g) => !g.selectable).length;
  const pinned = (rows ?? []).filter((g) => g.operatorPinned).length;

  const columns: Column<AdminGolden>[] = [
    {
      key: 'repo',
      header: 'Repo',
      cell: (g) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{g.repoSlug ?? <span className="italic">base image</span>}</span>
          {g.baseBranch && <span className="text-xs text-muted-foreground">{g.baseBranch}</span>}
        </div>
      ),
    },
    {
      key: 'state',
      header: 'State',
      cell: (g) => (
        <div className="flex flex-wrap items-center gap-1">
          {!g.selectable && (
            <Pill tone="warn" title="Baked on a superseded base image — selection refuses it, so runs on this repo fall back to cloning">
              stale
            </Pill>
          )}
          {g.inUse && (
            <Pill tone="good" title="A live run is reflinked from this image">
              in use
            </Pill>
          )}
          {g.operatorPinned && <Pill tone="muted">pinned</Pill>}
          {g.selectable && !g.inUse && !g.operatorPinned && <Pill tone="muted">idle</Pill>}
        </div>
      ),
    },
    {
      key: 'disk',
      header: 'Disk',
      cell: (g) => (
        <span className="tabular-nums" title={`apparent ${bytes(g.apparentBytes)}`}>
          {bytes(g.diskBytes)}
        </span>
      ),
    },
    {
      key: 'commit',
      header: 'Commit',
      cell: (g) => <CopyableId value={g.repoCommit} display={shortSha(g.repoCommit, 8)} />,
    },
    {
      key: 'content',
      header: 'Content SHA',
      cell: (g) => <CopyableId value={g.contentSha} display={shortSha(g.contentSha, 10)} />,
    },
    { key: 'pm', header: 'Pkg mgr', cell: (g) => g.packageManager ?? '—' },
    ...(canMutate
      ? [
          {
            key: 'actions',
            header: '',
            cell: (g: AdminGolden) => (
              <button
                onClick={() =>
                  pin.start(g, ({ reason }) =>
                    api.admin.fleet.goldensPin(effectiveHost, {
                      path: g.path,
                      pinned: !g.operatorPinned,
                      reason,
                    })
                  )
                }
                className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
              >
                {g.operatorPinned ? 'Unpin' : 'Pin'}
              </button>
            ),
          } satisfies Column<AdminGolden>,
        ]
      : []),
    {
      key: 'built',
      header: 'Built',
      cell: (g) => (
        <span className="tabular-nums" title={absolute(g.builtAt)}>
          {relativeAge(g.builtAt)}
        </span>
      ),
    },
  ];

  return (
    <Page
      title="Goldens"
      subtitle={effectiveHost ? `on ${effectiveHost}` : 'pick a host'}
      onRefresh={goldens.refresh}
      refreshing={goldens.loading}
      actions={
        <div className="flex items-center gap-2">
        {canMutate && effectiveHost && (
          <button
            onClick={() =>
              gc.start({ host: effectiveHost, force: true }, async ({ reason }) => {
                // `force` is the point of this button. Without it the fleet's
                // GC is disk-pressure driven — it only evicts below the 15%
                // low-water mark — so on a healthy disk it correctly removes
                // NOTHING, which is what made the first version look broken.
                const res = await api.admin.fleet.goldensGc(effectiveHost, {
                  reason,
                  force: true,
                });
                setGcResult(res);
              })
            }
            className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent"
          >
            Run GC
          </button>
        )}
        <select
          value={effectiveHost}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            next.set('host', e.target.value);
            setParams(next, { replace: true });
          }}
          aria-label="Host"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
        >
          {(hosts.data ?? []).map((h) => (
            <option key={h.name} value={h.name}>
              {h.name}
              {h.online ? '' : ' (offline)'}
            </option>
          ))}
        </select>
        </div>
      }
    >
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Free space"
          value={free == null ? '—' : `${Math.round(free)}%`}
          tone={free != null && free <= GOLDEN_GC_LOW_PCT ? 'critical' : 'default'}
          barPct={free == null ? null : 100 - free}
          hint={
            free != null && free <= GOLDEN_GC_LOW_PCT
              ? `below the ${GOLDEN_GC_LOW_PCT}% GC threshold — eviction is running`
              : `GC starts below ${GOLDEN_GC_LOW_PCT}%`
          }
        />
        <StatCard label="Images" value={`${rows?.length ?? 0}`} hint={bytes(totalDisk)} />
        <StatCard
          label="Stale"
          value={`${stale}`}
          tone={stale > 0 ? 'warn' : 'good'}
          hint={stale > 0 ? 'runs on these repos fall back to cloning' : 'all on the current base'}
        />
        <StatCard label="Pinned" value={`${pinned}`} hint="never evicted by GC" />
      </div>

      {view?.baseGolden && (
        <div className="mb-4 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Base image: </span>
          <span className="font-mono">{view.baseGolden}</span>
          {view.baseOsSha && <span className="ml-2 font-mono">({shortSha(view.baseOsSha, 10)})</span>}
        </div>
      )}

      {gcResult && (
        <div className="mb-3 rounded-md border border-border bg-card px-3 py-2 text-xs">
          <div className="flex items-start justify-between gap-3">
            <span>
              {gcResult.removed.length > 0 ? (
                <>
                  Evicted <strong>{gcResult.removed.length}</strong> image
                  {gcResult.removed.length === 1 ? '' : 's'}, reclaiming{' '}
                  <strong>{bytes(gcResult.freedBytes)}</strong> — free space{' '}
                  {Math.round(gcResult.freePctBefore)}% → {Math.round(gcResult.freePctAfter)}%.
                </>
              ) : (
                <>
                  Nothing was evicted. {gcResult.candidates} candidate
                  {gcResult.candidates === 1 ? '' : 's'}, {gcResult.protected} protected
                  (in use, pinned, or the newest for their repo).
                </>
              )}
            </span>
            <button
              onClick={() => setGcResult(null)}
              className="shrink-0 text-muted-foreground underline hover:no-underline"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(g) => g.path}
        error={goldens.error}
        loading={goldens.loading}
        initialLoading={goldens.initialLoading}
        onRetry={goldens.refresh}
        emptyMessage={effectiveHost ? 'No baked images on this host' : 'No host selected'}
        emptyHint={
          effectiveHost
            ? 'Per-repo layers appear after the first bake for a repo. Until then every run clones.'
            : 'Pick a host to see its images.'
        }
        rowClassName={(g) => (g.selectable ? undefined : 'opacity-70')}
      />

      <ConfirmMutationDialog
        open={Boolean(pin.pending)}
        onClose={pin.close}
        title={pin.pending?.target.operatorPinned ? 'Unpin this image?' : 'Pin this image?'}
        description={
          pin.pending?.target.operatorPinned ? (
            <>
              GC will be free to evict <strong>{pin.pending.target.repoSlug ?? 'this image'}</strong>{' '}
              again once disk gets tight.
            </>
          ) : (
            <>
              GC will never evict <strong>{pin.pending?.target.repoSlug ?? 'this image'}</strong>,
              even under disk pressure. That is a permanent hold on{' '}
              {pin.pending ? bytes(pin.pending.target.diskBytes) : 'its'} of disk.
            </>
          )
        }
        actionLabel={pin.pending?.target.operatorPinned ? 'Unpin' : 'Pin'}
        analyticsAction="fleet.golden.pin"
        analyticsTargetType="golden"
        onConfirm={async (input) => {
          await pin.pending!.run(input);
          pin.succeeded(pin.pending!.target.operatorPinned ? 'Image unpinned' : 'Image pinned');
        }}
      />

      <ConfirmMutationDialog
        open={Boolean(gc.pending)}
        onClose={gc.close}
        title="Evict unused golden images?"
        description={
          <>
            Evicts unpinned, unused images on <strong>{gc.pending?.target.host}</strong> to reclaim
            disk. Images a live run is reflinked from, and the newest per repo, are never touched —
            but a repo whose layer is evicted falls back to cloning on its next run.
            <br />
            <br />
            This <strong>forces</strong> the eviction. The fleet&apos;s own GC only runs under disk
            pressure (below {GOLDEN_GC_LOW_PCT}% free)
            {free != null ? `, and this host is at ${Math.round(free)}%` : ''} — so without forcing
            it, nothing would be removed.
          </>
        }
        actionLabel="Evict now"
        confirmText={gc.pending?.target.host}
        confirmLabel="the host name"
        destructive
        analyticsAction="fleet.golden.gc"
        analyticsTargetType="host"
        onConfirm={async (input) => {
          await gc.pending!.run(input);
          // Report what actually happened rather than "GC complete". The
          // fleet reclaims BLOCKS, not apparent size: an image sharing all its
          // extents with another frees nothing, so saying "2.9 GB reclaimed"
          // off the apparent size would make a no-op look like a win.
          gc.succeeded('GC finished');
        }}
      />
    </Page>
  );
}
