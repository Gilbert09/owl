import { describe, it, expect } from 'vitest';
import { detectStatusFromOutput } from '../services/agent.js';

const idle = { status: 'idle' as const, attention: 'none' as const };

describe('detectStatusFromOutput', () => {
  it('returns the current status when nothing matches', () => {
    expect(detectStatusFromOutput('just some neutral text', idle)).toEqual(idle);
  });

  it('detects awaiting_input on a question mark at end of line', () => {
    const result = detectStatusFromOutput('Do you want me to proceed?', idle);
    expect(result.status).toBe('awaiting_input');
    expect(result.attention).toBe('high');
  });

  it('detects awaiting_input on y/n prompts', () => {
    const result = detectStatusFromOutput('Confirm deletion (y/n)', idle);
    expect(result.status).toBe('awaiting_input');
  });

  it('detects tool_use on "> Reading ..." lines', () => {
    const result = detectStatusFromOutput('> Reading src/auth/login.ts', idle);
    expect(result.status).toBe('tool_use');
    expect(result.attention).toBe('none');
  });

  it('detects working on "Let me ..." narration', () => {
    const result = detectStatusFromOutput("Let me explore the codebase", idle);
    expect(result.status).toBe('working');
  });

  it('detects completed on "Done."', () => {
    const result = detectStatusFromOutput('Done.', idle);
    expect(result.status).toBe('completed');
    expect(result.attention).toBe('low');
  });

  it('detects error on "Error: ..."', () => {
    const result = detectStatusFromOutput('Error: cannot open file', idle);
    expect(result.status).toBe('error');
    expect(result.attention).toBe('high');
  });

  it('prefers error over awaiting_input when both match', () => {
    const result = detectStatusFromOutput(
      'Error: command not found\nDo you want to retry?',
      idle
    );
    expect(result.status).toBe('error');
  });

  it('prefers awaiting_input over completed when both match', () => {
    const result = detectStatusFromOutput(
      'Done.\nWould you like to continue?',
      idle
    );
    expect(result.status).toBe('awaiting_input');
  });

  it('sticks on error once set, even if later output looks benign', () => {
    // The cascade gates working/awaiting_input/completed behind `status !== error`,
    // so once an error is flagged it won't be downgraded by subsequent narration.
    const result = detectStatusFromOutput(
      'Let me try again...',
      { status: 'error', attention: 'high' }
    );
    expect(result.status).toBe('error');
  });
});
