import { useSearchParams } from 'react-router-dom';
import type { AdminFleetHost, AdminGolden } from '@talyn/shared';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { StatCard } from '../../components/ui/StatCard';
import { CopyableId } from '../../components/ui/CopyableId';
import { absolute, bytes, relativeAge, shortSha } from '../../lib/format';
import { GOLDEN_GC_LOW_PCT, goldenFreePct } from '../../lib/fleetView';

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
    </Page>
  );
}
