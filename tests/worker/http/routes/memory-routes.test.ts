
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';

vi.mock('../../../../src/shared/paths.js', () => ({
  getPackageRoot: () => '/tmp/test',
}));
vi.mock('../../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

import { MemoryRoutes } from '../../../../src/services/worker/http/routes/MemoryRoutes.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function createMockReqRes(body: any): { req: Partial<Request>; res: Partial<Response>; jsonSpy: ReturnType<typeof mock>; statusSpy: ReturnType<typeof mock> } {
  const jsonSpy = vi.fn(() => {});
  const statusSpy = vi.fn(() => ({ json: jsonSpy }));
  return {
    req: { body, path: '/api/memory/save', query: {} } as Partial<Request>,
    res: { json: jsonSpy, status: statusSpy } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

function captureChain(mockApp: any, targetPath: string): (req: Request, res: Response) => void {
  let middleware: ((req: Request, res: Response, next: () => void) => void) | undefined;
  let handler: ((req: Request, res: Response) => void) | undefined;
  mockApp.post = vi.fn((path: string, ...rest: any[]) => {
    if (path !== targetPath) return;
    if (rest.length === 1) {
      handler = rest[0];
    } else {
      middleware = rest[0];
      handler = rest[1];
    }
  });
  return (req: Request, res: Response): void => {
    if (!middleware) {
      handler!(req, res);
      return;
    }
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    if (nextCalled) handler!(req, res);
  };
}

describe('MemoryRoutes — POST /api/memory/save (#2116)', () => {
  let routes: MemoryRoutes;
  let mockStoreObservation: ReturnType<typeof mock>;
  let mockGetOrCreateManualSession: ReturnType<typeof mock>;
  let storeObservationCalls: any[][] = [];

  beforeEach(() => {
    loggerSpies = [
      vi.spyOn(logger, 'info').mockImplementation(() => {}),
      vi.spyOn(logger, 'debug').mockImplementation(() => {}),
      vi.spyOn(logger, 'warn').mockImplementation(() => {}),
      vi.spyOn(logger, 'error').mockImplementation(() => {}),
      vi.spyOn(logger, 'failure').mockImplementation(() => {}),
    ];

    storeObservationCalls = [];
    mockStoreObservation = vi.fn((...args: any[]) => {
      storeObservationCalls.push(args);
      return { id: 42, createdAtEpoch: 1234567890 };
    });
    mockGetOrCreateManualSession = vi.fn((project: string) => `manual-${project}`);

    const mockDbManager = {
      getSessionStore: () => ({
        storeObservation: mockStoreObservation,
        getOrCreateManualSession: mockGetOrCreateManualSession,
      }),
      getChromaSync: () => null,
    };

    routes = new MemoryRoutes(mockDbManager as any, 'light-mem');
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    vi.restoreAllMocks();
  });

  function buildHandler(): (req: Request, res: Response) => void {
    const mockApp: any = {
      get: vi.fn(() => {}),
      delete: vi.fn(() => {}),
      use: vi.fn(() => {}),
    };
    const handler = captureChain(mockApp, '/api/memory/save');
    routes.setupRoutes(mockApp as any);
    return handler;
  }

  it('persists arbitrary metadata as JSON-encoded string', () => {
    const handler = buildHandler();
    const metadata = {
      obsidian_note: 'Atom — Test',
      light_mem_version: '12.4.4',
      custom_key: 'value',
    };
    const { req, res } = createMockReqRes({ text: 'hello', metadata });
    handler(req as Request, res as Response);

    expect(mockStoreObservation).toHaveBeenCalledTimes(1);
    const observationArg = storeObservationCalls[0][2];
    expect(observationArg.metadata).toBe(JSON.stringify(metadata));
  });

  it('passes metadata: null when none provided', () => {
    const handler = buildHandler();
    const { req, res } = createMockReqRes({ text: 'hello' });
    handler(req as Request, res as Response);

    const observationArg = storeObservationCalls[0][2];
    expect(observationArg.metadata).toBeNull();
  });

  it('uses top-level project when present', () => {
    const handler = buildHandler();
    const { req, res } = createMockReqRes({
      text: 'hello',
      project: 'top-level-project',
      metadata: { project: 'metadata-project' },
    });
    handler(req as Request, res as Response);

    expect(mockGetOrCreateManualSession).toHaveBeenCalledWith('top-level-project');
    expect(storeObservationCalls[0][1]).toBe('top-level-project');
  });

  it('falls back to metadata.project when top-level project is omitted (#2116)', () => {
    const handler = buildHandler();
    const { req, res } = createMockReqRes({
      text: 'hello',
      metadata: { project: 'my-custom-project' },
    });
    handler(req as Request, res as Response);

    expect(mockGetOrCreateManualSession).toHaveBeenCalledWith('my-custom-project');
    expect(storeObservationCalls[0][1]).toBe('my-custom-project');
  });

  it('falls back to defaultProject when no project supplied anywhere', () => {
    const handler = buildHandler();
    const { req, res } = createMockReqRes({ text: 'hello' });
    handler(req as Request, res as Response);

    expect(mockGetOrCreateManualSession).toHaveBeenCalledWith('light-mem');
    expect(storeObservationCalls[0][1]).toBe('light-mem');
  });

  it('rejects unknown top-level fields with HTTP 400 (no silent drop)', () => {
    const handler = buildHandler();
    const { req, res, statusSpy } = createMockReqRes({ text: 'hello', foo: 'bar' });
    handler(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(mockStoreObservation).not.toHaveBeenCalled();
  });

  it('rejects empty/missing text with HTTP 400', () => {
    const handler = buildHandler();
    const { req, res, statusSpy } = createMockReqRes({});
    handler(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(mockStoreObservation).not.toHaveBeenCalled();
  });
});
