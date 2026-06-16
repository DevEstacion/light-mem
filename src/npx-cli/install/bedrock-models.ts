// WHY: Bedrock rejects Direct-API model identifiers (e.g. 'claude-haiku-4-5-20251001')
// with a 400 "invalid model identifier" error, causing compression to silently fail.
// This resolver checks the user's claude.sh env vars first (env-first), then falls back
// to baked Bedrock ids so the worker functions even when env vars are unset.

export type Tier = 'haiku' | 'sonnet' | 'opus';

const ENV_VAR: Record<Tier, string> = {
  haiku:  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus:   'ANTHROPIC_DEFAULT_OPUS_MODEL',
};

// Baked fallback from the user's claude.sh baseline. haiku maps to sonnet
// (no distinct Haiku model is used on this Bedrock setup); opus pinned to 4.8.
const BEDROCK_FALLBACK: Record<Tier, string> = {
  haiku:  'global.anthropic.claude-sonnet-4-6[1m]',
  sonnet: 'global.anthropic.claude-sonnet-4-6[1m]',
  opus:   'global.anthropic.claude-opus-4-8[1m]',
};

export function resolveBedrockModel(tier: Tier, env: NodeJS.ProcessEnv = process.env): string {
  return env[ENV_VAR[tier]]?.trim() || BEDROCK_FALLBACK[tier];
}
