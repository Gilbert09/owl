import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ProviderIcon } from '../lib/providerMeta';

/**
 * How the Fleet mark is coloured.
 *
 * It is the only provider mark that is ours rather than a vendor's, so it is
 * the only one that has to follow the theme: black on light, brand clay on
 * dark. That is two classes on one element, and losing either is silent — a
 * mark that is merely the wrong colour still renders, still has the right
 * size, and nothing throws. The same silence is how the mark before this one
 * shipped invisible for months.
 */
describe('ProviderIcon colouring', () => {
  function classesFor(provider: string): string {
    const { container } = render(<ProviderIcon provider={provider} />);
    const el = container.querySelector('[role="img"]') ?? container.querySelector('img');
    return el?.getAttribute('class') ?? '';
  }

  it('renders Talyn Fleet as an inline mark, not an <img>', () => {
    // An <img> cannot inherit currentColor, so it could not be themed at all.
    const { container } = render(<ProviderIcon provider="selfhosted" />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('is the theme ink on light and brand clay on dark', () => {
    const cls = classesFor('selfhosted');
    expect(cls).toContain('text-foreground');
    expect(cls).toContain('dark:text-[#cf7553]');
  });

  it('names the provider for screen readers and on hover', () => {
    const { container } = render(<ProviderIcon provider="selfhosted" />);
    const el = container.querySelector('[role="img"]');
    expect(el?.getAttribute('title')).toBe('Talyn Fleet');
    expect(el?.getAttribute('aria-label')).toBe('Talyn Fleet');
  });

  it('leaves vendor logos as plain images', () => {
    // Their colours are the vendor's, not ours — theming them would be wrong.
    for (const p of ['posthog_code', 'codex_cloud']) {
      const { container } = render(<ProviderIcon provider={p} />);
      expect(container.querySelector('img')).not.toBeNull();
      expect(container.querySelector('[role="img"]')).toBeNull();
    }
  });

  it('lets a caller override the colour', () => {
    // cn() puts the caller's class last, so a badge that needs a muted mark
    // can still ask for one.
    expect(classesFor('selfhosted')).toContain('text-foreground');
    const { container } = render(
      <ProviderIcon provider="selfhosted" className="text-muted-foreground" />,
    );
    expect(container.querySelector('[role="img"]')?.getAttribute('class')).toContain(
      'text-muted-foreground',
    );
  });

  it('still renders nothing for a task with no provider', () => {
    const { container } = render(<ProviderIcon provider={null} />);
    expect(container.firstChild).toBeNull();
  });
});
