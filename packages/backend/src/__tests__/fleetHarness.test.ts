import { describe, it, expect, afterEach } from 'vitest';
import { fleetHarnessFor, fleetPiWorkspaces } from '../services/selfHosted/credentials.js';

/**
 * Which in-guest harness a run uses.
 *
 * Gated by deployment config rather than by a workspace setting on purpose: the
 * Pi harness is proven only as far as the guest image, so a workspace must not
 * be able to opt itself onto it, and nobody should enable it for everyone by
 * editing a row. These assert the default is the safe one and that the gate
 * cannot be widened by accident.
 */
const ORIGINAL = process.env.FLEET_PI_WORKSPACES;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.FLEET_PI_WORKSPACES;
  else process.env.FLEET_PI_WORKSPACES = ORIGINAL;
});

describe('fleetHarnessFor', () => {
  it('defaults every workspace to the Agent SDK', () => {
    delete process.env.FLEET_PI_WORKSPACES;
    expect(fleetHarnessFor('ws_anything')).toBe('sdk');
  });

  it('is still the SDK when the list is blank or whitespace', () => {
    for (const value of ['', '   ', ',', ' , ']) {
      process.env.FLEET_PI_WORKSPACES = value;
      expect(fleetHarnessFor('ws_1'), `blank list "${value}" enabled pi`).toBe('sdk');
    }
  });

  it('enables pi only for a workspace on the list', () => {
    process.env.FLEET_PI_WORKSPACES = 'ws_mine';
    expect(fleetHarnessFor('ws_mine')).toBe('pi');
    expect(fleetHarnessFor('ws_someone_else')).toBe('sdk');
  });

  it('tolerates spacing in the list without widening it', () => {
    process.env.FLEET_PI_WORKSPACES = ' ws_a , ws_b ';
    expect(fleetPiWorkspaces()).toEqual(new Set(['ws_a', 'ws_b']));
    expect(fleetHarnessFor('ws_a')).toBe('pi');
    expect(fleetHarnessFor('ws_b')).toBe('pi');
    expect(fleetHarnessFor('ws_c')).toBe('sdk');
  });

  /**
   * Exact ids only. A prefix or substring match would put every workspace whose
   * id merely starts with a listed one onto an unproven harness.
   */
  it('matches ids exactly, never by prefix', () => {
    process.env.FLEET_PI_WORKSPACES = 'ws_mine';
    expect(fleetHarnessFor('ws_mine_other')).toBe('sdk');
    expect(fleetHarnessFor('ws_min')).toBe('sdk');
    expect(fleetHarnessFor('WS_MINE')).toBe('sdk');
  });

  /** Removing the id returns the workspace to the SDK on the next dispatch,
   *  with nothing to migrate and nothing to undo. */
  it('reverts as soon as the id is removed', () => {
    process.env.FLEET_PI_WORKSPACES = 'ws_mine';
    expect(fleetHarnessFor('ws_mine')).toBe('pi');
    process.env.FLEET_PI_WORKSPACES = '';
    expect(fleetHarnessFor('ws_mine')).toBe('sdk');
  });
});
