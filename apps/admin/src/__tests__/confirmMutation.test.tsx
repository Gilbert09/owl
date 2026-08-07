import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * The one component every mutation in this console goes through.
 *
 * Which makes it the one place the safeguards can be pinned once instead of
 * five times — and the one place a regression is worst, because it silently
 * weakens drain, comp, grant, kill and GC together.
 *
 * The subtle one is the last: on failure the dialog STAYS OPEN with the typed
 * reason intact. Wiping someone's carefully-worded reason because the backend
 * hiccuped is how you train people to type "asdf" into an audit log.
 */

const trackEvent = vi.fn();
vi.mock('../lib/analytics', () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));
vi.mock('../components/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { email: 'op@talyn.dev' } }),
}));

const { ConfirmMutationDialog, MIN_REASON_LENGTH, SIMPLE_CONFIRM_REASON } = await import(
  '../components/admin/ConfirmMutationDialog'
);

const LONG_REASON = 'hetzner-64 is wedged on a stuck run';

function setup(props: Partial<React.ComponentProps<typeof ConfirmMutationDialog>> = {}) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <ConfirmMutationDialog
      open
      onClose={onClose}
      title="Drain this host?"
      description="It will stop accepting new runs."
      actionLabel="Drain host"
      analyticsAction="fleet.drain"
      analyticsTargetType="host"
      onConfirm={onConfirm}
      {...props}
    />
  );
  return { onConfirm, onClose };
}

const reasonBox = () => screen.getByLabelText('Reason');
const confirmBox = () => screen.getByLabelText('Confirmation');
const action = (label = 'Drain host') => screen.getByText(label).closest('button')!;

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

/**
 * `simple` mode: the plain "are you sure" used for routine reversible actions
 * (cancel a run, delete a golden). The point of these cases is that the audit
 * trail survives the simplification — a dialog that asks for nothing must still
 * send something the backend's reason gate accepts and a reader can interpret.
 */
describe('simple mode', () => {
  it('asks for nothing and submits immediately', async () => {
    const { onConfirm } = setup({ simple: true, actionLabel: 'Cancel run' });

    expect(screen.queryByLabelText('Reason')).toBeNull();
    expect(action('Cancel run').disabled).toBe(false);

    fireEvent.click(action('Cancel run'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    // Non-empty, or routes/admin/guards.ts rejects it with 400 — and it says
    // that no reason was requested rather than fabricating one.
    expect(onConfirm.mock.calls[0][0]).toEqual({
      reason: SIMPLE_CONFIRM_REASON,
      confirm: undefined,
    });
    expect(SIMPLE_CONFIRM_REASON.trim().length).toBeGreaterThan(0);
  });

  it('ignores confirmText instead of silently blocking on a hidden field', async () => {
    // The failure this prevents: a call site passes both `simple` and a leftover
    // `confirmText`, the typed-confirm input isn't rendered, and the action stays
    // disabled forever with nothing on screen explaining why.
    const { onConfirm } = setup({
      simple: true,
      confirmText: 'talyn-242e6d2d-8ffb-4ea4-a655-2aedb153c0f9',
      actionLabel: 'Cancel run',
    });

    expect(screen.queryByLabelText('Confirmation')).toBeNull();
    expect(action('Cancel run').disabled).toBe(false);
    fireEvent.click(action('Cancel run'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0][0].confirm).toBeUndefined();
  });

  it('still keeps the dialog open, with its error, on failure', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('run already gone'));
    render(
      <ConfirmMutationDialog
        open
        simple
        onClose={vi.fn()}
        title="Cancel this run?"
        description="The microVM will be torn down."
        actionLabel="Cancel run"
        analyticsAction="fleet.run.cancel"
        analyticsTargetType="run"
        onConfirm={onConfirm}
      />
    );
    fireEvent.click(action('Cancel run'));
    await waitFor(() => expect(screen.getByText('run already gone')).toBeTruthy());
    expect(action('Cancel run').disabled).toBe(false);
  });
});

describe('the reason gate', () => {
  it('disables the action until the reason is long enough', () => {
    setup();
    expect(action().disabled).toBe(true);
    fireEvent.change(reasonBox(), { target: { value: 'x'.repeat(MIN_REASON_LENGTH - 1) } });
    expect(action().disabled).toBe(true);
    fireEvent.change(reasonBox(), { target: { value: 'x'.repeat(MIN_REASON_LENGTH) } });
    expect(action().disabled).toBe(false);
  });

  it('does not count surrounding whitespace toward the minimum', () => {
    // Otherwise "          " is a valid reason.
    setup();
    fireEvent.change(reasonBox(), { target: { value: '   ab   ' } });
    expect(action().disabled).toBe(true);
  });

  it('submits the trimmed reason', async () => {
    const { onConfirm } = setup();
    fireEvent.change(reasonBox(), { target: { value: `  ${LONG_REASON}  ` } });
    fireEvent.click(action());
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ reason: LONG_REASON, confirm: undefined }));
  });
});

describe('the typed confirmation', () => {
  it('stays disabled until the exact text is typed', () => {
    setup({ confirmText: 'hetzner-64' });
    fireEvent.change(reasonBox(), { target: { value: LONG_REASON } });
    expect(action().disabled).toBe(true);
    fireEvent.change(confirmBox(), { target: { value: 'hetzner-6' } });
    expect(action().disabled).toBe(true);
    fireEvent.change(confirmBox(), { target: { value: 'hetzner-64' } });
    expect(action().disabled).toBe(false);
  });

  it('accepts a case difference — the operator is reading, not transcribing', () => {
    setup({ confirmText: 'Alice@Example.test' });
    fireEvent.change(reasonBox(), { target: { value: LONG_REASON } });
    fireEvent.change(confirmBox(), { target: { value: 'alice@example.TEST' } });
    expect(action().disabled).toBe(false);
  });

  it('sends the confirm value through', async () => {
    const { onConfirm } = setup({ confirmText: 'hetzner-64' });
    fireEvent.change(reasonBox(), { target: { value: LONG_REASON } });
    fireEvent.change(confirmBox(), { target: { value: 'hetzner-64' } });
    fireEvent.click(action());
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({ reason: LONG_REASON, confirm: 'hetzner-64' })
    );
  });
});

describe('what is sent', () => {
  it('NEVER includes an actor', async () => {
    // The backend fills it from req.user. A client-supplied actor on an audit
    // log is a field an attacker gets to write.
    const { onConfirm } = setup();
    fireEvent.change(reasonBox(), { target: { value: LONG_REASON } });
    fireEvent.click(action());
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0]![0]).not.toHaveProperty('actor');
  });

  it('never puts the reason TEXT into analytics', async () => {
    // A reason can carry customer identifiers, and PostHog is not the audit
    // log — the backend is.
    setup();
    fireEvent.change(reasonBox(), { target: { value: 'comping bob@customer.test after an outage' } });
    fireEvent.click(action());
    await waitFor(() => expect(trackEvent).toHaveBeenCalled());
    const props = trackEvent.mock.calls[0]![1] as Record<string, unknown>;
    expect(JSON.stringify(props)).not.toContain('bob@customer.test');
    expect(props.reason_length).toBeGreaterThan(0);
    expect(props.action).toBe('fleet.drain');
  });
});

describe('failure handling', () => {
  it('stays open and KEEPS the typed reason', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('fleet unreachable'));
    const onClose = vi.fn();
    render(
      <ConfirmMutationDialog
        open
        onClose={onClose}
        title="Drain this host?"
        description="d"
        actionLabel="Drain host"
        analyticsAction="fleet.drain"
        analyticsTargetType="host"
        onConfirm={onConfirm}
      />
    );
    fireEvent.change(reasonBox(), { target: { value: LONG_REASON } });
    fireEvent.click(action());

    await waitFor(() => expect(document.body.textContent).toContain('fleet unreachable'));
    expect(onClose).not.toHaveBeenCalled();
    expect((reasonBox() as HTMLTextAreaElement).value).toBe(LONG_REASON);
  });

  it('does not report a failed mutation to analytics', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('nope'));
    render(
      <ConfirmMutationDialog
        open
        onClose={vi.fn()}
        title="t"
        description="d"
        actionLabel="Go"
        analyticsAction="fleet.drain"
        analyticsTargetType="host"
        onConfirm={onConfirm}
      />
    );
    fireEvent.change(reasonBox(), { target: { value: LONG_REASON } });
    fireEvent.click(action('Go'));
    await waitFor(() => expect(document.body.textContent).toContain('nope'));
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('closes on success', async () => {
    const { onClose } = setup();
    fireEvent.change(reasonBox(), { target: { value: LONG_REASON } });
    fireEvent.click(action());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('double submission', () => {
  it('fires once even when clicked repeatedly', async () => {
    // The button disables while busy; the idempotency key is the belt to that
    // brace. Either alone would do, and a drain sent twice is a drain someone
    // has to explain.
    let release: () => void = () => {};
    const onConfirm = vi.fn(
      () => new Promise<void>((resolve) => { release = resolve; })
    );
    render(
      <ConfirmMutationDialog
        open
        onClose={vi.fn()}
        title="t"
        description="d"
        actionLabel="Go"
        analyticsAction="fleet.drain"
        analyticsTargetType="host"
        onConfirm={onConfirm}
      />
    );
    fireEvent.change(reasonBox(), { target: { value: LONG_REASON } });
    fireEvent.click(action('Go'));
    fireEvent.click(action('Go'));
    fireEvent.click(action('Go'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    release();
  });
});

describe('when closed', () => {
  it('renders nothing at all', () => {
    render(
      <ConfirmMutationDialog
        open={false}
        onClose={vi.fn()}
        title="Should not appear"
        description="d"
        actionLabel="Go"
        analyticsAction="fleet.drain"
        analyticsTargetType="host"
        onConfirm={vi.fn()}
      />
    );
    expect(document.body.textContent).not.toContain('Should not appear');
  });
});
