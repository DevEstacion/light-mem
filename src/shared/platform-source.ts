export const DEFAULT_PLATFORM_SOURCE = 'claude';

function sanitizeRawSource(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Grok Build injects GROK_HOOK_EVENT / GROK_SESSION_ID on every hook process
 * (docs.x.ai/build/features/hooks). light-mem hooks are still registered as
 * `hook claude-code …`, so without this check observations would be tagged
 * "claude" even when captured under Grok.
 */
export function isGrokHookProcess(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.GROK_HOOK_EVENT || env.GROK_SESSION_ID);
}

export function normalizePlatformSource(value?: string | null): string {
  // Prefer live host detection over the static CLI platform arg.
  if (isGrokHookProcess()) return 'grok';

  if (!value) return DEFAULT_PLATFORM_SOURCE;

  const source = sanitizeRawSource(value);
  if (!source) return DEFAULT_PLATFORM_SOURCE;

  if (source.includes('claude')) return 'claude';
  if (source.includes('grok')) return 'grok';

  return source;
}

export function sortPlatformSources(sources: string[]): string[] {
  const priority = ['claude'];

  return [...sources].sort((a, b) => {
    const aPriority = priority.indexOf(a);
    const bPriority = priority.indexOf(b);

    if (aPriority !== -1 || bPriority !== -1) {
      if (aPriority === -1) return 1;
      if (bPriority === -1) return -1;
      return aPriority - bPriority;
    }

    return a.localeCompare(b);
  });
}
