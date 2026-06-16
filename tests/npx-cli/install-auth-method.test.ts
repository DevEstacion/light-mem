import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { USER_SETTINGS_PATH } from '../../src/shared/paths.js';
import { resolveClaudeAuthMethod } from '../../src/npx-cli/commands/install.js';

// resolveClaudeAuthMethod() resolves the Claude auth/runtime mode from a stored
// LIGHT_MEM_CLAUDE_AUTH_METHOD (wins) else env signals. These tests cover the
// Bedrock detection added for the model-selection fix: on a Bedrock environment
// the installer must NOT fall through to 'subscription' (which would pick a
// Direct-API model id that Bedrock rejects with HTTP 400).
//
// USER_SETTINGS_PATH is frozen at module load from LIGHT_MEM_DATA_DIR (a temp dir
// pinned by tests/vitest.setup.ts), so writing/removing it here is safe and
// never touches the real ~/.light-mem.

const BEDROCK_ENV = 'CLAUDE_CODE_USE_BEDROCK';

function clearStoredSettings(): void {
  if (existsSync(USER_SETTINGS_PATH)) rmSync(USER_SETTINGS_PATH, { force: true });
}

describe('resolveClaudeAuthMethod — Bedrock detection', () => {
  let prevBedrock: string | undefined;

  beforeEach(() => {
    prevBedrock = process.env[BEDROCK_ENV];
    delete process.env[BEDROCK_ENV];
    clearStoredSettings();
  });

  afterEach(() => {
    if (prevBedrock === undefined) delete process.env[BEDROCK_ENV];
    else process.env[BEDROCK_ENV] = prevBedrock;
    clearStoredSettings();
  });

  it('returns "bedrock" when CLAUDE_CODE_USE_BEDROCK=1', () => {
    process.env[BEDROCK_ENV] = '1';
    expect(resolveClaudeAuthMethod()).toBe('bedrock');
  });

  it('returns "bedrock" for any truthy value (e.g. "true")', () => {
    process.env[BEDROCK_ENV] = 'true';
    expect(resolveClaudeAuthMethod()).toBe('bedrock');
  });

  it('does NOT treat CLAUDE_CODE_USE_BEDROCK=0 as bedrock', () => {
    process.env[BEDROCK_ENV] = '0';
    expect(resolveClaudeAuthMethod()).toBe('subscription');
  });

  it('does NOT treat CLAUDE_CODE_USE_BEDROCK=false as bedrock', () => {
    process.env[BEDROCK_ENV] = 'false';
    expect(resolveClaudeAuthMethod()).toBe('subscription');
  });

  it('falls back to "subscription" when CLAUDE_CODE_USE_BEDROCK is unset', () => {
    expect(resolveClaudeAuthMethod()).toBe('subscription');
  });

  it('lets a stored LIGHT_MEM_CLAUDE_AUTH_METHOD="bedrock" round-trip', () => {
    delete process.env[BEDROCK_ENV]; // no env signal — stored value is the only source
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({ LIGHT_MEM_CLAUDE_AUTH_METHOD: 'bedrock' }),
    );
    expect(resolveClaudeAuthMethod()).toBe('bedrock');
  });

  it('lets a stored auth method win over the Bedrock env signal', () => {
    // Stored value is checked first; env detection must not override it.
    process.env[BEDROCK_ENV] = '1';
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({ LIGHT_MEM_CLAUDE_AUTH_METHOD: 'subscription' }),
    );
    expect(resolveClaudeAuthMethod()).toBe('subscription');
  });
});
