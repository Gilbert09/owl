import { ProviderConnectCards } from '../../panels/SettingsPanel';

/**
 * Onboarding step 2: connect the agent that will actually do the work.
 *
 * # Why this is a setup step now, when it deliberately was not
 *
 * The wizard used to leave the agent out on the argument that task buttons
 * render regardless and `ConnectAgentModal` prompts on the first dispatch. That
 * was right while the agent was metered API credits somebody else billed. It is
 * not right now: Talyn Fleet is the default compute, and it runs on the USER'S
 * OWN Claude or Codex subscription — so connecting it up front is what makes
 * the very first task run on their key rather than dead-end at a modal.
 *
 * Skippable, though, and that matters as much. A workspace that is not on the
 * fleet allow-list is served no fleet card at all, and hard-gating Next would
 * strand it on a step it cannot complete. The modal stays as the fallback for
 * anyone who skips.
 */
export function ConnectAgentStep() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Talyn hands your PR work to a coding agent running on your own subscription. Connect
        Claude or Codex — one is enough, and you can add the other later in Settings.
      </p>
      <ProviderConnectCards />
    </div>
  );
}
