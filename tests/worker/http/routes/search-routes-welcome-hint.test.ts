
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';

const generateContextStub = vi.hoisted(() =>
  vi.fn(async () => ({ text: 'CONTEXT_FROM_GENERATOR', stats: null }))
);

vi.mock('../../../../src/services/context-generator.js', () => ({
  generateContext: vi.fn(async () => 'CONTEXT_FROM_GENERATOR'),
  generateContextWithStats: generateContextStub,
}));

vi.mock('../../../../src/shared/paths.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../src/shared/paths.js')>();
  return { ...actual };
});

import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';

let loggerSpies: ReturnType<typeof vi.spyOn>[] = [];

interface MockRes {
  setHeader: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  headersSent: boolean;
}

function createMockRes(): MockRes {
  const res: MockRes = {
    setHeader: vi.fn(() => {}),
    send: vi.fn(() => {}),
    status: vi.fn(() => res as any),
    json: vi.fn(() => {}),
    headersSent: false,
  };
  return res;
}

function captureContextInjectHandler(routes: SearchRoutes): (req: Request, res: Response) => void {
  let captured: ((req: Request, res: Response) => void) | undefined;
  const mockApp: any = {
    get: vi.fn((path: string, handler: (req: Request, res: Response) => void) => {
      if (path === '/api/context/inject') {
        captured = handler;
      }
    }),
    post: vi.fn(() => {}),
    delete: vi.fn(() => {}),
    use: vi.fn(() => {}),
  };
  routes.setupRoutes(mockApp);
  if (!captured) throw new Error('Failed to capture /api/context/inject handler');
  return captured;
}

describe('SearchRoutes Welcome Hint', () => {
  let countQueryStub: ReturnType<typeof vi.fn>;
  let prepareStub: ReturnType<typeof vi.fn>;
  let mockSessionStore: any;
  let mockSearchManager: any;

  beforeEach(() => {
    loggerSpies = [
      vi.spyOn(logger, 'info').mockImplementation(() => {}),
      vi.spyOn(logger, 'debug').mockImplementation(() => {}),
      vi.spyOn(logger, 'warn').mockImplementation(() => {}),
      vi.spyOn(logger, 'error').mockImplementation(() => {}),
      vi.spyOn(logger, 'failure').mockImplementation(() => {}),
    ];

    countQueryStub = vi.fn(() => ({ count: 0 }));
    prepareStub = vi.fn(() => ({ get: countQueryStub }));
    mockSessionStore = { db: { prepare: prepareStub } };
    mockSearchManager = {
      getSessionStore: () => mockSessionStore,
    };

    generateContextStub.mockClear();
    delete process.env.LIGHT_MEM_WELCOME_HINT_ENABLED;
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    delete process.env.LIGHT_MEM_WELCOME_HINT_ENABLED;
    delete process.env.LIGHT_MEM_WORKER_PORT;
  });

  it('returns the welcome hint when project has zero observations', async () => {
    const routes = new SearchRoutes(mockSearchManager);
    const handler = captureContextInjectHandler(routes);

    const res = createMockRes();
    const req = { query: { projects: '/path/to/empty-project' } } as unknown as Request;

    handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    expect(res.send).toHaveBeenCalledTimes(1);
    const body = (res.send as any).mock.calls[0][0] as string;
    expect(body).toContain('# light-mem status');
    expect(body).toContain('/learn-codebase');
    expect(body).toContain('http://localhost:');
    expect(body).toContain('Memory injection starts on your second session in a project.');
    expect(body).toContain('disappears once the first observation lands');
    expect(body).not.toContain('Welcome');
    expect(generateContextStub).not.toHaveBeenCalled();
  });

  it('skips the welcome hint when at least one observation exists', async () => {
    countQueryStub = vi.fn(() => ({ count: 7 }));
    prepareStub = vi.fn(() => ({ get: countQueryStub }));
    mockSessionStore = { db: { prepare: prepareStub } };
    mockSearchManager = { getSessionStore: () => mockSessionStore };

    const routes = new SearchRoutes(mockSearchManager);
    const handler = captureContextInjectHandler(routes);

    const res = createMockRes();
    const req = { query: { projects: '/path/to/active-project' } } as unknown as Request;

    handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    expect(generateContextStub).toHaveBeenCalledTimes(1);
    expect(res.send).toHaveBeenCalledWith('CONTEXT_FROM_GENERATOR');
  });

  it('skips the welcome hint when LIGHT_MEM_WELCOME_HINT_ENABLED=false', async () => {
    process.env.LIGHT_MEM_WELCOME_HINT_ENABLED = 'false';

    const routes = new SearchRoutes(mockSearchManager);
    const handler = captureContextInjectHandler(routes);

    const res = createMockRes();
    const req = { query: { projects: '/path/to/empty-project' } } as unknown as Request;

    handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    expect(generateContextStub).toHaveBeenCalledTimes(1);
    expect(res.send).toHaveBeenCalledWith('CONTEXT_FROM_GENERATOR');
  });

  it('queries both projects in a worktree (multi-project) request', async () => {
    const routes = new SearchRoutes(mockSearchManager);
    const handler = captureContextInjectHandler(routes);

    const res = createMockRes();
    const req = { query: { projects: '/path/parent, /path/worktree' } } as unknown as Request;

    handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    expect(res.send).toHaveBeenCalledTimes(1);
    expect(countQueryStub).toHaveBeenCalledWith(
      '/path/parent',
      '/path/worktree',
      '/path/parent',
      '/path/worktree',
    );
  });

  it('does not leak positive observation state across route instances', async () => {
    countQueryStub = vi.fn(() => ({ count: 3 }));
    prepareStub = vi.fn(() => ({ get: countQueryStub }));
    mockSessionStore = { db: { prepare: prepareStub } };
    mockSearchManager = { getSessionStore: () => mockSessionStore };

    const activeRoutes = new SearchRoutes(mockSearchManager);
    const activeHandler = captureContextInjectHandler(activeRoutes);
    const activeRes = createMockRes();
    const activeReq = { query: { projects: '/path/to/project' } } as unknown as Request;

    activeHandler(activeReq, activeRes as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));
    expect(generateContextStub).toHaveBeenCalledTimes(1);

    generateContextStub.mockClear();
    countQueryStub = vi.fn(() => ({ count: 0 }));
    prepareStub = vi.fn(() => ({ get: countQueryStub }));
    mockSessionStore = { db: { prepare: prepareStub } };
    mockSearchManager = { getSessionStore: () => mockSessionStore };

    const emptyRoutes = new SearchRoutes(mockSearchManager);
    const emptyHandler = captureContextInjectHandler(emptyRoutes);
    const emptyRes = createMockRes();
    const emptyReq = { query: { projects: '/path/to/project' } } as unknown as Request;

    emptyHandler(emptyReq, emptyRes as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    const body = (emptyRes.send as any).mock.calls[0][0] as string;
    expect(body).toContain('# light-mem status');
    expect(generateContextStub).not.toHaveBeenCalled();
  });

  it('uses the request-local worker port env override in the welcome hint URL', async () => {
    process.env.LIGHT_MEM_WORKER_PORT = '43210';

    const routes = new SearchRoutes(mockSearchManager);
    const handler = captureContextInjectHandler(routes);

    const res = createMockRes();
    const req = { query: { projects: '/path/to/empty-project' } } as unknown as Request;

    handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    const body = (res.send as any).mock.calls[0][0] as string;
    expect(body).toContain('http://localhost:43210');
  });
});
