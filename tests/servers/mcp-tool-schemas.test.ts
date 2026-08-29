import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';

const mcpServerPath = new URL('../../src/servers/mcp-server.ts', import.meta.url).pathname;

// Mock the worker HTTP transport so handler-level tests exercise the real
// dispatch/wrapping logic without a live worker. Everything else in worker-utils
// (getWorkerPort, resolveWorkerScriptPath) is preserved.
vi.mock('../../src/shared/worker-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/worker-utils.js')>();
  return { ...actual, workerHttpRequest: vi.fn() };
});

// Slice one tool's source region by name, bounded by the next tool's `name:`
// declaration (or end of the tools array). The 13 legacy tools were
// consolidated into 4 argument-driven tools: search / code / corpus / manage
// (+ the __IMPORTANT pseudo-tool).
function toolSection(src: string, name: string, nextName?: string): string {
  const start = src.indexOf(`name: '${name}'`);
  if (start === -1) return '';
  const end = nextName ? src.indexOf(`name: '${nextName}'`, start + 1) : src.length;
  return src.slice(start, end === -1 ? src.length : end);
}

describe('MCP tool inputSchema declarations (consolidated)', () => {
  it('search tool folds index/timeline/fetch into one mode-dispatched tool', async () => {
    const src = await readFile(mcpServerPath, 'utf-8');

    expect(src).toContain("name: 'search'");
    const section = toolSection(src, 'search', 'code');
    // discriminator
    expect(section).toContain('mode:');
    expect(section).toContain("enum: ['index', 'timeline', 'fetch']");
    // index params
    expect(section).toContain('query:');
    expect(section).toContain('limit:');
    expect(section).toContain('project:');
    expect(section).toContain('orderBy:');
    // timeline params
    expect(section).toContain('anchor:');
    expect(section).toContain('depth_before:');
    expect(section).toContain('depth_after:');
    // fetch params
    expect(section).toContain('ids:');
    expect(section).toContain("required: ['mode']");
    expect(section).not.toContain('properties: {}');
  });

  it('code tool folds search/outline/unfold into one mode-dispatched tool', async () => {
    const src = await readFile(mcpServerPath, 'utf-8');

    expect(src).toContain("name: 'code'");
    const section = toolSection(src, 'code', 'corpus');
    expect(section).toContain('mode:');
    expect(section).toContain("enum: ['search', 'outline', 'unfold']");
    expect(section).toContain('file_path:');
    expect(section).toContain('symbol_name:');
    expect(section).toContain('file_pattern:');
    expect(section).toContain("required: ['mode']");
  });

  it('corpus tool folds the six corpus tools into one action-dispatched tool', async () => {
    const src = await readFile(mcpServerPath, 'utf-8');

    expect(src).toContain("name: 'corpus'");
    const section = toolSection(src, 'corpus', 'manage');
    expect(section).toContain('action:');
    expect(section).toContain("enum: ['build', 'list', 'get', 'delete', 'prime', 'query', 'rebuild', 'reprime']");
    expect(section).toContain('name:');
    expect(section).toContain('question:');
    // the two previously-unexposed worker routes are now reachable
    expect(section).toContain("case 'get'");
    expect(section).toContain("case 'delete'");
    expect(section).toContain("required: ['action']");
  });

  it('manage tool exposes stats + compact with a safe dry_run default', async () => {
    const src = await readFile(mcpServerPath, 'utf-8');

    expect(src).toContain("name: 'manage'");
    const section = toolSection(src, 'manage');
    expect(section).toContain("enum: ['stats', 'compact']");
    expect(section).toContain('dry_run:');
    // compact must opt IN to destructive writes
    expect(section).toContain('args.dry_run !== false');
  });

  it('no longer registers the legacy per-operation tool names', async () => {
    const src = await readFile(mcpServerPath, 'utf-8');
    for (const name of [
      'timeline', 'get_observations',
      'smart_search', 'smart_outline', 'smart_unfold',
      'build_corpus', 'list_corpora', 'prime_corpus',
      'query_corpus', 'rebuild_corpus', 'reprime_corpus',
    ]) {
      expect(src).not.toContain(`name: '${name}'`);
    }
  });

  // The server-beta-only observation_*/memory_* tools were removed when the
  // server-beta runtime was stripped. Guard that they stay gone.
  it('does not expose the removed server-beta observation_*/memory_* tools', async () => {
    const src = await readFile(mcpServerPath, 'utf-8');
    for (const name of [
      'observation_add', 'observation_record_event', 'observation_search',
      'observation_context', 'observation_generation_status',
      'memory_add', 'memory_search', 'memory_context',
    ]) {
      expect(src).not.toContain(`name: '${name}'`);
    }
    expect(src).not.toContain('server-beta');
    expect(src).not.toContain('runtime-selector');
  });

  it('mcp-server does NOT import WorkerService (anti-pattern guard, plan line 772)', async () => {
    const src = await readFile(mcpServerPath, 'utf-8');
    expect(src).not.toMatch(/from\s+['"][^'"]*WorkerService[^'"]*['"]/);
    expect(src).not.toMatch(/import\s+\{[^}]*WorkerService[^}]*\}/);
  });
});

// Handler-level behavior (not just source string-matching) — catches regressions
// the static checks above cannot: missing-mode dispatch, MCP response shape, and
// argument forwarding to the worker. Importing mcp-server is side-effect-free
// under VITEST (main() is guarded), so `tools` can be exercised directly.
describe('MCP tool handler behavior', () => {
  let tools: any[];
  let workerHttpRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const workerUtils = await import('../../src/shared/worker-utils.js');
    workerHttpRequest = workerUtils.workerHttpRequest as unknown as ReturnType<typeof vi.fn>;
    workerHttpRequest.mockReset();
    ({ tools } = await import('../../src/servers/mcp-server.js'));
  });

  const tool = (name: string) => tools.find((t) => t.name === name);

  it('search throws when mode is missing (would have silently 404d before)', async () => {
    await expect(tool('search').handler({})).rejects.toThrow(/mode/i);
  });

  it("manage(action='stats') returns a well-formed MCP result with a content array", async () => {
    workerHttpRequest.mockResolvedValue({
      ok: true,
      json: async () => ({ worker: {}, database: { observations: 1 }, compaction: {} }),
    });
    const result = await tool('manage').handler({ action: 'stats' });
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0].type).toBe('text');
    expect(workerHttpRequest).toHaveBeenCalledWith('/api/stats', { method: 'GET' });
  });

  it('corpus build maps camelCase date filters to the snake_case fields the worker reads', async () => {
    workerHttpRequest.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    await tool('corpus').handler({ action: 'build', name: 'x', dateStart: '2026-01-01', dateEnd: '2026-06-01' });
    const [, opts] = workerHttpRequest.mock.calls[0];
    expect(opts.method).toBe('POST');
    // CorpusRoutes buildCorpusSchema reads date_start/date_end, not camelCase.
    expect(opts.body).toContain('date_start');
    expect(opts.body).toContain('date_end');
    expect(opts.body).toContain('2026-01-01');
    expect(opts.body).not.toContain('dateStart');
  });
});
