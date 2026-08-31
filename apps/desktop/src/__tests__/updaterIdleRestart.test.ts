import { IDLE_RESTART_AFTER_MS, shouldApplyUpdateWhileIdle } from '../main/updater';

/**
 * When a staged update gets applied on its own.
 *
 * `autoInstallOnAppQuit` already meant nobody had to press a button, but it only
 * fires on QUIT — and Talyn is a dashboard people leave open for days, so the
 * update sat staged while the running version never moved.
 *
 * The two properties worth pinning are both about NOT firing: never before the
 * download has finished (quitting with nothing staged closes the app and
 * installs nothing), and never while someone is actually at the machine.
 */
describe('shouldApplyUpdateWhileIdle', () => {
  const hour = 60 * 60 * 1000;

  it('applies once the machine has been idle past the threshold', () => {
    expect(shouldApplyUpdateWhileIdle({ stagedVersion: '0.2.62', systemIdleMs: hour })).toBe(
      true
    );
  });

  it('never fires before the download has finished', () => {
    expect(shouldApplyUpdateWhileIdle({ stagedVersion: null, systemIdleMs: hour })).toBe(
      false
    );
  });

  it.each([0, 1_000, 60_000, IDLE_RESTART_AFTER_MS - 1])(
    'holds off while the machine is only %dms idle',
    (systemIdleMs) => {
      expect(shouldApplyUpdateWhileIdle({ stagedVersion: '0.2.62', systemIdleMs })).toBe(false);
    }
  );

  it('fires exactly at the threshold, not one tick later', () => {
    expect(
      shouldApplyUpdateWhileIdle({
        stagedVersion: '0.2.62',
        systemIdleMs: IDLE_RESTART_AFTER_MS,
      })
    ).toBe(true);
  });

  it('honours an overridden threshold', () => {
    expect(
      shouldApplyUpdateWhileIdle({
        stagedVersion: '0.2.62',
        systemIdleMs: 5_000,
        idleThresholdMs: 1_000,
      })
    ).toBe(true);
    expect(
      shouldApplyUpdateWhileIdle({
        stagedVersion: '0.2.62',
        systemIdleMs: 500,
        idleThresholdMs: 1_000,
      })
    ).toBe(false);
  });

  it('waits long enough that it cannot fire while someone is reading', () => {
    // The threshold is a product decision, not an implementation detail: drop it
    // to a couple of minutes and the app starts restarting under people who
    // stepped away for a coffee.
    expect(IDLE_RESTART_AFTER_MS).toBeGreaterThanOrEqual(15 * 60 * 1000);
  });
});
