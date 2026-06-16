import { describe, it, expect } from 'vitest';

import { resolveBedrockModel } from '../../src/npx-cli/install/bedrock-models.js';

describe('resolveBedrockModel — env var wins', () => {
  it('returns the haiku env var verbatim when set', () => {
    const env = { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'custom-haiku-id' };
    expect(resolveBedrockModel('haiku', env)).toBe('custom-haiku-id');
  });

  it('returns the sonnet env var verbatim when set', () => {
    const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-sonnet-id' };
    expect(resolveBedrockModel('sonnet', env)).toBe('custom-sonnet-id');
  });

  it('returns the opus env var verbatim when set', () => {
    const env = { ANTHROPIC_DEFAULT_OPUS_MODEL: 'custom-opus-id' };
    expect(resolveBedrockModel('opus', env)).toBe('custom-opus-id');
  });
});

describe('resolveBedrockModel — baked fallback when env unset', () => {
  it('falls back to sonnet Bedrock id for haiku tier', () => {
    expect(resolveBedrockModel('haiku', {})).toBe('global.anthropic.claude-sonnet-4-6[1m]');
  });

  it('falls back to sonnet Bedrock id for sonnet tier', () => {
    expect(resolveBedrockModel('sonnet', {})).toBe('global.anthropic.claude-sonnet-4-6[1m]');
  });

  it('falls back to opus Bedrock id for opus tier', () => {
    expect(resolveBedrockModel('opus', {})).toBe('global.anthropic.claude-opus-4-8[1m]');
  });

  it('opus fallback is exactly global.anthropic.claude-opus-4-8[1m]', () => {
    expect(resolveBedrockModel('opus', {})).toBe('global.anthropic.claude-opus-4-8[1m]');
  });
});

describe('resolveBedrockModel — empty / whitespace env falls back', () => {
  it('treats empty string as unset for haiku', () => {
    const env = { ANTHROPIC_DEFAULT_HAIKU_MODEL: '' };
    expect(resolveBedrockModel('haiku', env)).toBe('global.anthropic.claude-sonnet-4-6[1m]');
  });

  it('treats whitespace-only string as unset for sonnet', () => {
    const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: '   ' };
    expect(resolveBedrockModel('sonnet', env)).toBe('global.anthropic.claude-sonnet-4-6[1m]');
  });

  it('treats whitespace-only string as unset for opus', () => {
    const env = { ANTHROPIC_DEFAULT_OPUS_MODEL: '\t' };
    expect(resolveBedrockModel('opus', env)).toBe('global.anthropic.claude-opus-4-8[1m]');
  });

  it('trims and returns the env var when it has surrounding whitespace but a real value', () => {
    const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: '  global.anthropic.claude-sonnet-4-6[1m]  ' };
    expect(resolveBedrockModel('sonnet', env)).toBe('global.anthropic.claude-sonnet-4-6[1m]');
  });
});
