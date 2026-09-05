import { useWorkspaceStore } from '../renderer/stores/workspace';
import type { PRRow } from '../renderer/lib/api';
import type { SkillSummary } from '@talyn/shared';

const row = { id: 'pr1', owner: 'acme', repo: 'w', number: 7 } as unknown as PRRow;
const skill: SkillSummary = { key: 'platform:1', source: 'platform', name: 'pr-review', description: '', id: '1' };

describe('workspace store — connect-agent modal state', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().closeConnectAgent();
  });

  it('is closed with no pending task by default', () => {
    const s = useWorkspaceStore.getState();
    expect(s.connectAgentOpen).toBe(false);
    expect(s.pendingCloudTask).toBeNull();
  });

  it('openConnectAgent opens the modal and stashes a fix intent', () => {
    useWorkspaceStore.getState().openConnectAgent({ kind: 'fix', row, providerType: 'selfhosted' });
    const s = useWorkspaceStore.getState();
    expect(s.connectAgentOpen).toBe(true);
    expect(s.pendingCloudTask).toEqual({ kind: 'fix', row, providerType: 'selfhosted' });
  });

  it('openConnectAgent stashes a skill intent with its content', () => {
    useWorkspaceStore.getState().openConnectAgent({ kind: 'skill', row, skill, localContent: 'body' });
    expect(useWorkspaceStore.getState().pendingCloudTask).toEqual({
      kind: 'skill',
      row,
      skill,
      localContent: 'body',
    });
  });

  it('openConnectAgent with no argument opens without a pending task', () => {
    useWorkspaceStore.getState().openConnectAgent();
    const s = useWorkspaceStore.getState();
    expect(s.connectAgentOpen).toBe(true);
    expect(s.pendingCloudTask).toBeNull();
  });

  it('closeConnectAgent clears both the open flag and the pending task', () => {
    useWorkspaceStore.getState().openConnectAgent({ kind: 'fix', row });
    useWorkspaceStore.getState().closeConnectAgent();
    const s = useWorkspaceStore.getState();
    expect(s.connectAgentOpen).toBe(false);
    expect(s.pendingCloudTask).toBeNull();
  });

  it('clearPendingCloudTask drops the task but leaves the modal open', () => {
    useWorkspaceStore.getState().openConnectAgent({ kind: 'fix', row });
    useWorkspaceStore.getState().clearPendingCloudTask();
    const s = useWorkspaceStore.getState();
    expect(s.connectAgentOpen).toBe(true);
    expect(s.pendingCloudTask).toBeNull();
  });
});
