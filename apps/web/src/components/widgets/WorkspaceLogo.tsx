import React, { useMemo } from 'react';
import { toSvg } from 'jdenticon';
import type { WorkspaceLogo as WorkspaceLogoData } from '@talyn/shared';
import { cn } from '../../lib/utils';

interface WorkspaceLogoProps {
  /** The workspace's stored logo, if any. */
  logo?: WorkspaceLogoData;
  /** Seed to fall back to when there's no stored identicon (e.g. workspace id). */
  fallbackSeed: string;
  /** Rendered pixel size (square). */
  size: number;
  className?: string;
}

/**
 * Renders a workspace logo: a user-uploaded image, or a deterministic
 * jdenticon identicon generated from the logo seed (falling back to
 * `fallbackSeed` for legacy rows with no logo).
 */
export function WorkspaceLogo({ logo, fallbackSeed, size, className }: WorkspaceLogoProps) {
  const seed = logo?.kind === 'identicon' ? logo.seed : fallbackSeed;
  const svg = useMemo(
    () => (logo?.kind === 'image' ? null : toSvg(seed, size, { padding: 0.08 })),
    [logo?.kind, seed, size],
  );

  const box = cn('inline-block overflow-hidden rounded-lg bg-muted', className);

  if (logo?.kind === 'image') {
    return (
      <img
        src={logo.dataUrl}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className={cn(box, 'object-cover')}
      />
    );
  }

  return (
    <span
      className={box}
      style={{ width: size, height: size }}
      // jdenticon returns a self-contained SVG string sized to `size`.
      dangerouslySetInnerHTML={{ __html: svg ?? '' }}
    />
  );
}
