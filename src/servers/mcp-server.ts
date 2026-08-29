
declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

import { logger } from '../utils/logger.js';

console['log'] = (...args: any[]) => {
  logger.error('CONSOLE', 'Intercepted console output (MCP protocol protection)', undefined, { args });
};

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getWorkerPort, workerHttpRequest, resolveWorkerScriptPath } from '../shared/worker-utils.js';
import { ensureWorkerStarted } from '../services/worker-spawner.js';
import { searchCodebase, formatSearchResults } from '../services/smart-file-read/search.js';
import { parseFile, formatFoldedView, unfoldSymbol, findProjectRoot } from '../services/smart-file-read/parser.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

let mcpServerDirResolutionFailed = false;
const mcpServerDir = (() => {
  if (typeof __dirname !== 'undefined') return __dirname;
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    mcpServerDirResolutionFailed = true;
    return process.cwd();
  }
})();
// Prefer the canonical marketplace copy of the worker bundle (same
// marketplace-first candidates as the hook launcher) over this server's own
// directory: an MCP server still running out of a stale plugin cache dir
// would otherwise auto-spawn a stale worker. The own-dir resolution stays as
// the fallback for installs without a marketplace copy.
const WORKER_SCRIPT_PATH = resolveWorkerScriptPath() ?? resolve(mcpServerDir, 'worker-service.cjs');

function errorIfWorkerScriptMissing(): void {
  if (!mcpServerDirResolutionFailed) return;
  if (existsSync(WORKER_SCRIPT_PATH)) return;

  logger.error(
    'SYSTEM',
    'mcp-server: dirname resolution failed (both __dirname and import.meta.url are unavailable). Fell back to process.cwd() and the resolved WORKER_SCRIPT_PATH does not exist. This is the actual problem — the worker bundle is fine, but mcp-server cannot locate it. Worker auto-start will fail until the dirname-resolution path is fixed.',
    { workerScriptPath: WORKER_SCRIPT_PATH, mcpServerDir }
  );
}

const TOOL_ENDPOINT_MAP: Record<string, string> = {
  'index': '/api/search',
  'timeline': '/api/timeline'
};

async function callWorkerAPI(
  endpoint: string,
  params: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  logger.debug('SYSTEM', '→ Worker API', undefined, { endpoint, params });

  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      searchParams.append(key, String(value));
    }
  }

  const apiPath = `${endpoint}?${searchParams}`;

  try {
    const response = await workerHttpRequest(apiPath);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

    logger.debug('SYSTEM', '← Worker API success', undefined, { endpoint });

    return data;
  } catch (error: unknown) {
    logger.error('SYSTEM', '← Worker API error', { endpoint }, error instanceof Error ? error : new Error(String(error)));
    return {
      content: [{
        type: 'text' as const,
        text: `Error calling Worker API: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

async function executeWorkerPostRequest(
  endpoint: string,
  body: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const response = await workerHttpRequest(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  logger.debug('HTTP', 'Worker API success (POST)', undefined, { endpoint });

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data, null, 2)
    }]
  };
}

async function callWorkerAPIPost(
  endpoint: string,
  body: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  logger.debug('HTTP', 'Worker API request (POST)', undefined, { endpoint });

  try {
    return await executeWorkerPostRequest(endpoint, body);
  } catch (error: unknown) {
    logger.error('HTTP', 'Worker API error (POST)', { endpoint }, error instanceof Error ? error : new Error(String(error)));
    return {
      content: [{
        type: 'text' as const,
        text: `Error calling Worker API: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

async function callWorkerAPIRaw(
  endpoint: string,
  method: 'GET' | 'DELETE'
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  logger.debug('HTTP', 'Worker API request (raw)', undefined, { endpoint, method });

  try {
    const response = await workerHttpRequest(endpoint, { method });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    logger.debug('HTTP', 'Worker API success (raw)', undefined, { endpoint, method });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(data, null, 2)
      }]
    };
  } catch (error: unknown) {
    logger.error('HTTP', 'Worker API error (raw)', { endpoint, method }, error instanceof Error ? error : new Error(String(error)));
    return {
      content: [{
        type: 'text' as const,
        text: `Error calling Worker API: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

async function verifyWorkerConnection(): Promise<boolean> {
  try {
    const response = await workerHttpRequest('/api/health');
    return response.ok;
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Worker health check failed', {}, error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

async function ensureWorkerConnection(): Promise<boolean> {
  if (await verifyWorkerConnection()) {
    return true;
  }

  logger.warn('SYSTEM', 'Worker not available, attempting auto-start for MCP client');

  errorIfWorkerScriptMissing();

  try {
    const port = getWorkerPort();
    const result = await ensureWorkerStarted(port, WORKER_SCRIPT_PATH);
    if (result === 'dead') {
      logger.error(
        'SYSTEM',
        'Worker auto-start failed — MCP tools that require the worker (search modes: index/timeline/fetch) will fail until the worker is running. Check earlier log lines for the specific failure reason (Bun not found, missing worker bundle, port conflict, etc.).'
      );
    }
    return result !== 'dead';
  } catch (error: unknown) {
    logger.error(
      'SYSTEM',
      'Worker auto-start threw — MCP tools that require the worker (search modes: index/timeline/fetch) will fail until the worker is running.',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
    return false;
  }
}

export const tools = [
  {
    name: '__IMPORTANT',
    description: `3-LAYER WORKFLOW (ALWAYS FOLLOW):
1. search(mode='index', query) → Get index with IDs (~50-100 tokens/result)
2. search(mode='timeline', anchor=ID) → Get context around interesting results
3. search(mode='fetch', ids=[...]) → Fetch full details ONLY for filtered IDs
NEVER fetch full details without filtering first. 10x token savings.`,
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async () => ({
      content: [{
        type: 'text' as const,
        text: `# Memory Search Workflow

**3-Layer Pattern (ALWAYS follow this):**

1. **Search** - Get index of results with IDs
   \`search(mode="index", query="...", limit=20, project="...")\`
   Returns: Table with IDs, titles, dates (~50-100 tokens/result)

2. **Timeline** - Get context around interesting results
   \`search(mode="timeline", anchor=<ID>, depth_before=3, depth_after=3)\`
   Returns: Chronological context showing what was happening

3. **Fetch** - Get full details ONLY for relevant IDs
   \`search(mode="fetch", ids=[...])\`  # ALWAYS batch for 2+ items
   Returns: Complete details (~500-1000 tokens/result)

**Why:** 10x token savings. Never fetch full details without filtering first.`
      }]
    })
  },
  {
    name: 'search',
    description: "Memory search, 3-layer workflow. mode='index': Step 1, search memory, returns index with IDs (params: query, limit, project, platformSource, type, obs_type, dateStart, dateEnd, offset, orderBy). mode='timeline': Step 2, get context around results (params: anchor OR query, depth_before, depth_after, project). mode='fetch': Step 3, fetch full details for filtered IDs (params: ids, required array).",
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['index', 'timeline', 'fetch'],
          description: "'index' (keyword/semantic search), 'timeline' (chronological context around an anchor), 'fetch' (full details for specific IDs)"
        },
        query: { type: 'string', description: 'Search query (mode=index) or query to auto-find an anchor (mode=timeline)' },
        limit: { type: 'number', description: 'Max results (default 20) — mode=index' },
        project: { type: 'string', description: 'Filter by project name — mode=index, timeline' },
        platformSource: { type: 'string', description: "Filter by platform source (e.g. claude, grok, codex, opencode) — restricts results to that agent's own memory — mode=index" },
        type: { type: 'string', description: 'Filter by observation type — mode=index' },
        obs_type: { type: 'string', description: 'Filter by obs_type field — mode=index' },
        dateStart: { type: 'string', description: 'Start date filter (ISO) — mode=index' },
        dateEnd: { type: 'string', description: 'End date filter (ISO) — mode=index' },
        offset: { type: 'number', description: 'Pagination offset — mode=index' },
        orderBy: { type: 'string', description: 'Sort order: date_desc or date_asc — mode=index' },
        anchor: { type: 'number', description: 'Observation ID to center the timeline around — mode=timeline' },
        depth_before: { type: 'number', description: 'Items before anchor (default 3) — mode=timeline' },
        depth_after: { type: 'number', description: 'Items after anchor (default 3) — mode=timeline' },
        ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of observation IDs to fetch — required for mode=fetch'
        }
      },
      required: ['mode'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { mode, ...rest } = args;
      switch (mode) {
        case 'index': {
          return await callWorkerAPI(TOOL_ENDPOINT_MAP['index'], rest);
        }
        case 'timeline': {
          return await callWorkerAPI(TOOL_ENDPOINT_MAP['timeline'], rest);
        }
        case 'fetch': {
          if (!Array.isArray(rest.ids) || rest.ids.length === 0) {
            throw new Error("Missing required argument: ids (required for mode='fetch')");
          }
          return await callWorkerAPIPost('/api/observations/batch', rest);
        }
        default:
          throw new Error(`Unknown mode: ${mode}. Expected 'index' | 'timeline' | 'fetch'.`);
      }
    }
  },
  {
    name: 'code',
    description: "Codebase structural tools (tree-sitter AST). mode='search': find symbols/files by term (params: query required, path, max_results, file_pattern). mode='outline': structural map of one file, symbols with folded bodies (params: file_path required). mode='unfold': full source of one symbol from a file (params: file_path, symbol_name, both required).",
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['search', 'outline', 'unfold'],
          description: "'search' (find symbols/files by term), 'outline' (structural map of one file), 'unfold' (full source of one symbol)"
        },
        query: { type: 'string', description: 'Search term — matches symbol names, file names, file content — required for mode=search' },
        path: { type: 'string', description: 'Root directory to search (default: current working directory) — mode=search' },
        max_results: { type: 'number', description: 'Maximum results to return (default: 20) — mode=search' },
        file_pattern: { type: 'string', description: 'Substring filter for file paths (e.g. ".ts", "src/services") — mode=search' },
        file_path: { type: 'string', description: 'Path to the source file — required for mode=outline, unfold' },
        symbol_name: { type: 'string', description: 'Name of the symbol to unfold (function, class, method, etc.) — required for mode=unfold' }
      },
      required: ['mode'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { mode, ...rest } = args;
      switch (mode) {
        case 'search': {
          if (typeof rest.query !== 'string' || rest.query.trim() === '') {
            throw new Error("Missing required argument: query (required for mode='search')");
          }
          const rootDir = resolve(rest.path || process.cwd());
          const result = await searchCodebase(rootDir, rest.query, {
            maxResults: rest.max_results || 20,
            filePattern: rest.file_pattern
          });
          const formatted = formatSearchResults(result, rest.query);
          return {
            content: [{ type: 'text' as const, text: formatted }]
          };
        }
        case 'outline': {
          if (typeof rest.file_path !== 'string' || rest.file_path.trim() === '') {
            throw new Error("Missing required argument: file_path (required for mode='outline')");
          }
          const filePath = resolve(rest.file_path);
          const content = await readFile(filePath, 'utf-8');
          const parsed = parseFile(content, filePath, findProjectRoot(filePath) ?? process.cwd());
          if (parsed.symbols.length > 0) {
            return {
              content: [{ type: 'text' as const, text: formatFoldedView(parsed) }]
            };
          }
          return {
            content: [{
              type: 'text' as const,
              text: `Could not parse ${rest.file_path}. File may use an unsupported language or be empty.`
            }]
          };
        }
        case 'unfold': {
          if (typeof rest.file_path !== 'string' || rest.file_path.trim() === '') {
            throw new Error("Missing required argument: file_path (required for mode='unfold')");
          }
          if (typeof rest.symbol_name !== 'string' || rest.symbol_name.trim() === '') {
            throw new Error("Missing required argument: symbol_name (required for mode='unfold')");
          }
          const filePath = resolve(rest.file_path);
          const content = await readFile(filePath, 'utf-8');
          const projectRoot = findProjectRoot(filePath) ?? process.cwd();
          const unfolded = unfoldSymbol(content, filePath, rest.symbol_name, projectRoot);
          if (unfolded) {
            return {
              content: [{ type: 'text' as const, text: unfolded }]
            };
          }
          const parsed = parseFile(content, filePath, projectRoot);
          if (parsed.symbols.length > 0) {
            const available = parsed.symbols.map(s => `  - ${s.name} (${s.kind})`).join('\n');
            return {
              content: [{
                type: 'text' as const,
                text: `Symbol "${rest.symbol_name}" not found in ${rest.file_path}.\n\nAvailable symbols:\n${available}`
              }]
            };
          }
          return {
            content: [{
              type: 'text' as const,
              text: `Could not parse ${rest.file_path}. File may be unsupported or empty.`
            }]
          };
        }
        default:
          throw new Error(`Unknown mode: ${mode}. Expected 'search' | 'outline' | 'unfold'.`);
      }
    }
  },
  {
    name: 'corpus',
    description: "Knowledge corpus management. action='build': create a corpus from filtered observations (params: name required, description, project, types, concepts, files, query, dateStart, dateEnd, limit). action='list': list all corpora with stats. action='get': fetch one corpus's metadata (params: name required). action='delete': delete a corpus (params: name required). action='prime': create an AI session loaded with corpus knowledge (params: name required; must run before query). action='query': ask a question of a primed corpus (params: name, question, both required). action='rebuild': re-run the stored filter to refresh the corpus (params: name required). action='reprime': create a fresh knowledge-agent session, clearing prior Q&A context (params: name required).",
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['build', 'list', 'get', 'delete', 'prime', 'query', 'rebuild', 'reprime'],
          description: "Which corpus operation to perform"
        },
        name: { type: 'string', description: 'Corpus name — required for every action except list' },
        description: { type: 'string', description: 'What this corpus is about — action=build' },
        project: { type: 'string', description: 'Filter by project — action=build' },
        types: { type: 'string', description: 'Comma-separated observation types: decision,bugfix,feature,refactor,discovery,change — action=build' },
        concepts: { type: 'string', description: 'Comma-separated concepts to filter by — action=build' },
        files: { type: 'string', description: 'Comma-separated file paths to filter by — action=build' },
        query: { type: 'string', description: 'Semantic search query — action=build' },
        dateStart: { type: 'string', description: 'Start date (ISO format) — action=build' },
        dateEnd: { type: 'string', description: 'End date (ISO format) — action=build' },
        limit: { type: 'number', description: 'Maximum observations (default 500) — action=build' },
        question: { type: 'string', description: 'The question to ask — required for action=query' }
      },
      required: ['action'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { action, name, ...rest } = args;
      const requireName = (a: string) => {
        if (typeof name !== 'string' || name.trim() === '') {
          throw new Error(`Missing required argument: name (required for action='${a}')`);
        }
      };
      switch (action) {
        case 'build': {
          requireName('build');
          // The build route (CorpusRoutes buildCorpusSchema) reads snake_case
          // date_start/date_end; map the tool's camelCase fields across so the
          // date filter is actually applied instead of silently dropped.
          const { dateStart, dateEnd, ...buildRest } = rest;
          const payload: Record<string, unknown> = { name, ...buildRest };
          if (dateStart !== undefined) payload.date_start = dateStart;
          if (dateEnd !== undefined) payload.date_end = dateEnd;
          return await callWorkerAPIPost('/api/corpus', payload);
        }
        case 'list': {
          return await callWorkerAPI('/api/corpus', rest);
        }
        case 'get': {
          requireName('get');
          return await callWorkerAPIRaw(`/api/corpus/${encodeURIComponent(name)}`, 'GET');
        }
        case 'delete': {
          requireName('delete');
          return await callWorkerAPIRaw(`/api/corpus/${encodeURIComponent(name)}`, 'DELETE');
        }
        case 'prime': {
          requireName('prime');
          return await callWorkerAPIPost(`/api/corpus/${encodeURIComponent(name)}/prime`, rest);
        }
        case 'query': {
          requireName('query');
          if (typeof rest.question !== 'string' || rest.question.trim() === '') {
            throw new Error("Missing required argument: question (required for action='query')");
          }
          return await callWorkerAPIPost(`/api/corpus/${encodeURIComponent(name)}/query`, rest);
        }
        case 'rebuild': {
          requireName('rebuild');
          return await callWorkerAPIPost(`/api/corpus/${encodeURIComponent(name)}/rebuild`, rest);
        }
        case 'reprime': {
          requireName('reprime');
          return await callWorkerAPIPost(`/api/corpus/${encodeURIComponent(name)}/reprime`, rest);
        }
        default:
          throw new Error(`Unknown action: ${action}. Expected 'build' | 'list' | 'get' | 'delete' | 'prime' | 'query' | 'rebuild' | 'reprime'.`);
      }
    }
  },
  {
    name: 'manage',
    description: 'Administrative actions. action=stats: store/vector counts + compaction preview (cheap). action=compact: prune/flatten aged, near-duplicate, and low-signal observations. SAFETY: compact defaults to dry_run=true (preview only) — pass dry_run=false to actually delete/write.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['stats', 'compact'], description: 'stats or compact' },
        dry_run: { type: 'boolean', description: 'compact only. Default true (preview). Set false to apply.' },
        project: { type: 'string', description: 'compact only. Scope to one project (default: all). Ignored by stats (always global).' },
        age_days: { type: 'number', description: 'compact only. AGE window override (default from settings)' },
        near_dup_threshold: { type: 'number', description: 'compact only. Cosine similarity threshold, default 0.93' },
        low_signal_min_age_days: { type: 'number', description: 'compact only. Min age before "never retrieved" counts, default 30' }
      },
      required: ['action'],
      additionalProperties: false
    },
    handler: async (args: any) => {
      if (args.action === 'stats') return await callWorkerAPIRaw('/api/stats', 'GET');
      if (args.action === 'compact') {
        return await callWorkerAPIPost('/api/manage/compact', {
          dryRun: args.dry_run !== false,
          project: args.project,
          ageDays: args.age_days,
          nearDupThreshold: args.near_dup_threshold,
          lowSignalMinAgeDays: args.low_signal_min_age_days,
        });
      }
      throw new Error(`Unknown manage action: ${args.action}`);
    }
  }
];

const server = new Server(
  {
    name: 'light-mem',
    version: packageVersion,
  },
  {
    capabilities: {
      tools: {},  // Exposes tools capability (handled by ListToolsRequestSchema and CallToolRequestSchema)
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find(t => t.name === request.params.name);

  if (!tool) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  try {
    return await tool.handler(request.params.arguments || {});
  } catch (error: unknown) {
    logger.error('SYSTEM', 'Tool execution failed', { tool: request.params.name }, error instanceof Error ? error : new Error(String(error)));
    return {
      content: [{
        type: 'text' as const,
        text: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
});

const HEARTBEAT_INTERVAL_MS = 30_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let isCleaningUp = false;

function handleStdioClosed() {
  cleanup('stdio-closed');
}

function handleStdioError(error: Error) {
  logger.warn('SYSTEM', 'MCP stdio stream errored, shutting down', {
    message: error.message
  });
  cleanup('stdio-error');
}

function attachStdioLifecycle() {
  process.stdin.on('end', handleStdioClosed);
  process.stdin.on('close', handleStdioClosed);
  process.stdin.on('error', handleStdioError);
}

function detachStdioLifecycle() {
  process.stdin.off('end', handleStdioClosed);
  process.stdin.off('close', handleStdioClosed);
  process.stdin.off('error', handleStdioError);
}

function startParentHeartbeat() {
  if (process.platform === 'win32') return;

  const initialPpid = process.ppid;
  heartbeatTimer = setInterval(() => {
    if (process.ppid === 1 || process.ppid !== initialPpid) {
      logger.info('SYSTEM', 'Parent process died, self-exiting to prevent orphan', {
        initialPpid,
        currentPpid: process.ppid
      });
      cleanup();
    }
  }, HEARTBEAT_INTERVAL_MS);

  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function cleanup(reason: string = 'shutdown') {
  if (isCleaningUp) return;
  isCleaningUp = true;

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  detachStdioLifecycle();
  logger.info('SYSTEM', 'MCP server shutting down', { reason });
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

function checkMarketplaceMarker(): void {
  try {
    const home = homedir();
    const marketplaceCandidates = [
      resolve(home, '.claude', 'plugins', 'marketplaces', 'light-mem'),
      resolve(home, '.config', 'claude', 'plugins', 'marketplaces', 'light-mem'),
    ];
    const present = marketplaceCandidates.some(p => p && existsSync(p));
    const cacheCandidates = [
      resolve(home, '.claude', 'plugins', 'cache', 'light-mem', 'light-mem'),
      resolve(home, '.config', 'claude', 'plugins', 'cache', 'light-mem', 'light-mem'),
    ];
    const cachePresent = cacheCandidates.some(p => p && existsSync(p));
    const cacheRoot = cacheCandidates[0];

    if (!present && cachePresent) {
      logger.error(
        'SYSTEM',
        'light-mem MCP started but no marketplace directory was found at ~/.claude/plugins/marketplaces/light-mem or the XDG equivalent. The IDE plugin loader needs that directory to fire light-mem hooks (SessionStart, PostToolUse, Stop, etc.). Without it, MCP search will work but no new memories will be captured. To self-heal, run: node ~/.claude/plugins/cache/light-mem/light-mem/*/scripts/smart-install.js (or reinstall the plugin from the marketplace).',
        { marketplaceCandidates, cacheRoot }
      );
    }
  } catch {
  }
}

async function main() {
  const transport = new StdioServerTransport();
  attachStdioLifecycle();
  await server.connect(transport);
  logger.info('SYSTEM', 'light-mem search server started');

  checkMarketplaceMarker();

  startParentHeartbeat();

  setTimeout(async () => {
    const workerAvailable = await ensureWorkerConnection();
    if (!workerAvailable) {
      logger.error('SYSTEM', 'Worker not available', undefined, {});
      logger.error('SYSTEM', 'Tools will fail until Worker is started');
      logger.error('SYSTEM', 'Start Worker with: npm run worker:restart');
    } else {
      logger.info('SYSTEM', 'Worker available', undefined, {});
    }
  }, 0);
}

// Auto-start only when run as the actual MCP server entrypoint. Under vitest the
// module is imported to unit-test `tools` handlers, and must NOT connect a
// stdio transport / start heartbeats (VITEST is set by the test runner; the
// bundled runtime .cjs never has it set, so production behavior is unchanged).
if (!process.env.VITEST) {
  main().catch((error) => {
    logger.error('SYSTEM', 'Fatal error', undefined, error);
    process.exit(0);
  });
}
