import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { usePanelUrlSync } from '../hooks/usePanelUrlSync';
import { useWorkspaceStore } from '../stores/workspace';
import { PANEL_PATHS } from '../lib/routes';
import type { ActivePanel } from '../lib/panels';

/**
 * URL ⇄ activePanel synchronisation.
 *
 * This exists because the first implementation used one effect per direction,
 * and they raced: both ran in the same commit off the same snapshot, so the
 * store→URL effect navigated while the URL→store effect simultaneously
 * "corrected" the store back to the not-yet-updated pathname. Clicking Merge
 * Queue highlighted it in the sidebar and then dumped you on My PRs.
 *
 * A unit test would not have caught it — it only appears once a real click
 * changes the store and the router commits on the next tick.
 */

let currentPath = '';

function Probe() {
  usePanelUrlSync();
  currentPath = useLocation().pathname;
  return null;
}

function mount(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Probe />
    </MemoryRouter>
  );
}

const setPanel = (p: ActivePanel) =>
  act(() => {
    useWorkspaceStore.getState().setActivePanel(p);
  });

beforeEach(() => {
  currentPath = '';
  setPanel('my_prs');
});

describe('store → URL', () => {
  it.each(Object.entries(PANEL_PATHS) as Array<[ActivePanel, string]>)(
    'setting activePanel=%s navigates to %s',
    (panel, path) => {
      mount(PANEL_PATHS.my_prs);
      setPanel(panel);
      expect(currentPath).toBe(path);
      // And it STAYS there — the original bug was an immediate revert.
      expect(useWorkspaceStore.getState().activePanel).toBe(panel);
    }
  );

  it('does not revert after a change (the regression)', () => {
    mount(PANEL_PATHS.my_prs);
    setPanel('reviews');
    expect(currentPath).toBe(PANEL_PATHS.reviews);
    setPanel('merge_queue');
    expect(currentPath).toBe(PANEL_PATHS.merge_queue);
    expect(useWorkspaceStore.getState().activePanel).toBe('merge_queue');
  });
});

describe('URL → store', () => {
  it.each(Object.entries(PANEL_PATHS) as Array<[ActivePanel, string]>)(
    'opening %s directly selects panel %s',
    (panel, path) => {
      mount(path);
      expect(useWorkspaceStore.getState().activePanel).toBe(panel);
      expect(currentPath).toBe(path);
    }
  );

  it('an unmapped path falls back to the current panel without looping', () => {
    mount('/definitely-not-a-panel');
    expect(currentPath).toBe(PANEL_PATHS.my_prs);
    expect(useWorkspaceStore.getState().activePanel).toBe('my_prs');
  });
});
