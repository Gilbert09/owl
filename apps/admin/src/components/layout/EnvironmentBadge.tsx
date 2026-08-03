import { apiHost, isProductionApi } from '../../lib/env';
import { cn } from '../../lib/utils';

/**
 * Which backend this console is pointed at.
 *
 * Not decoration. This app drains fleet hosts, cancels other people's runs and
 * comps accounts, and the URL bar says `admin.talyn.dev` whether the API
 * underneath is production or a laptop. Rendering the backend host — amber
 * whenever it is NOT production — means "I drained a prod host thinking I was
 * on staging" requires ignoring a coloured banner rather than merely
 * forgetting which terminal you started.
 *
 * Non-production is the highlighted state on purpose: production is the
 * default and should read as unremarkable, so that the unusual case is the one
 * that catches the eye.
 */
export function EnvironmentBadge() {
  const host = apiHost();
  const prod = isProductionApi();
  return (
    <span
      title={`API: ${host}`}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 truncate rounded-md border px-2 py-0.5 font-mono text-[11px]',
        prod
          ? 'border-border text-muted-foreground'
          : 'border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400'
      )}
    >
      {!prod && <span aria-hidden>⚠</span>}
      <span className="truncate">{host}</span>
    </span>
  );
}
