import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'net';
import {
  isPortInUse,
  waitForHealth,
  waitForPortFree,
  getInstalledPluginVersion,
  checkVersionMatch
} from '../../src/services/infrastructure/index.js';

describe('HealthMonitor', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('isPortInUse', () => {

    it('should return true for occupied port (EADDRINUSE)', async () => {
      const createServerMock = vi.fn(() => ({
        once: vi.fn((event: string, cb: Function) => {
          if (event === 'error') {
            setTimeout(() => cb({ code: 'EADDRINUSE' }), 0);
          }
        }),
        listen: vi.fn(() => {})
      }));
      
      const spy = vi.spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const result = await isPortInUse(37777);

      expect(result).toBe(true);
      expect(net.createServer).toHaveBeenCalled();
      
      spy.mockRestore();
    });

    it('should return false for free port (listening succeeds)', async () => {
      const closeMock = vi.fn((cb: Function) => cb());
      const createServerMock = vi.fn(() => ({
        once: vi.fn((event: string, cb: Function) => {
          if (event === 'listening') {
            setTimeout(() => cb(), 0);
          }
        }),
        listen: vi.fn(() => {}),
        close: closeMock
      }));
      
      const spy = vi.spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const result = await isPortInUse(39999);

      expect(result).toBe(false);
      expect(net.createServer).toHaveBeenCalled();
      expect(closeMock).toHaveBeenCalled();
      
      spy.mockRestore();
    });

    it('should return false for other socket errors', async () => {
      const createServerMock = vi.fn(() => ({
        once: vi.fn((event: string, cb: Function) => {
          if (event === 'error') {
            setTimeout(() => cb({ code: 'EACCES' }), 0);
          }
        }),
        listen: vi.fn(() => {})
      }));
      
      const spy = vi.spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const result = await isPortInUse(37777);

      expect(result).toBe(false);
      
      spy.mockRestore();
    });
  });

  describe('waitForHealth', () => {
    it('should succeed immediately when server responds', async () => {
      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('')
      } as unknown as Response));

      const start = Date.now();
      const result = await waitForHealth(37777, 5000);
      const elapsed = Date.now() - start;

      expect(result).toBe(true);
      expect(elapsed).toBeLessThan(1000);
    });

    it('should timeout when no server responds', async () => {
      global.fetch = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));

      const start = Date.now();
      const result = await waitForHealth(39999, 1500);
      const elapsed = Date.now() - start;

      expect(result).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(1400);
      expect(elapsed).toBeLessThan(2500);
    });

    it('should succeed after server becomes available', async () => {
      let callCount = 0;
      global.fetch = vi.fn(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.reject(new Error('ECONNREFUSED'));
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('')
        } as unknown as Response);
      });

      const result = await waitForHealth(37777, 5000);

      expect(result).toBe(true);
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    it('should check health endpoint for liveness', async () => {
      const fetchMock = vi.fn(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('')
      } as unknown as Response));
      global.fetch = fetchMock;

      await waitForHealth(37777, 1000);

      const calls = fetchMock.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0][0]).toBe('http://127.0.0.1:37777/api/health');
    });

    it('should use default timeout when not specified', async () => {
      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('')
      } as unknown as Response));

      const result = await waitForHealth(37777);

      expect(result).toBe(true);
    });
  });

  describe('getInstalledPluginVersion', () => {
    it('should return a valid semver string', () => {
      const version = getInstalledPluginVersion();

      if (version !== 'unknown') {
        expect(version).toMatch(/^\d+\.\d+\.\d+/);
      }
    });

    it('should not throw on ENOENT (graceful degradation)', () => {
      expect(() => getInstalledPluginVersion()).not.toThrow();
    });
  });

  describe('checkVersionMatch', () => {
    it('should assume match when worker version is unavailable', async () => {
      global.fetch = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));

      const result = await checkVersionMatch(39999);

      expect(result.matches).toBe(true);
      expect(result.workerVersion).toBeNull();
    });

    it('should detect version mismatch', async () => {
      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ version: '0.0.0-definitely-wrong' }))
      } as unknown as Response));

      const result = await checkVersionMatch(37777);

      const pluginVersion = getInstalledPluginVersion();
      if (pluginVersion !== 'unknown' && pluginVersion !== '0.0.0-definitely-wrong') {
        expect(result.matches).toBe(false);
      }
    });

    it('should detect version match', async () => {
      const pluginVersion = getInstalledPluginVersion();
      if (pluginVersion === 'unknown') return; 

      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ version: pluginVersion }))
      } as unknown as Response));

      const result = await checkVersionMatch(37777);

      expect(result.matches).toBe(true);
      expect(result.pluginVersion).toBe(pluginVersion);
      expect(result.workerVersion).toBe(pluginVersion);
    });
  });

  describe('waitForPortFree', () => {
    it('should return true immediately when port is already free', async () => {
      const createServerMock = vi.fn(() => ({
        once: vi.fn((event: string, cb: Function) => {
          if (event === 'listening') setTimeout(() => cb(), 0);
        }),
        listen: vi.fn(() => {}),
        close: vi.fn((cb: Function) => cb())
      }));
      const spy = vi.spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const start = Date.now();
      const result = await waitForPortFree(39999, 5000);
      const elapsed = Date.now() - start;

      expect(result).toBe(true);
      expect(elapsed).toBeLessThan(1000);
      spy.mockRestore();
    });

    it('should timeout when port remains occupied', async () => {
      const createServerMock = vi.fn(() => ({
        once: vi.fn((event: string, cb: Function) => {
          if (event === 'error') setTimeout(() => cb({ code: 'EADDRINUSE' }), 0);
        }),
        listen: vi.fn(() => {})
      }));
      const spy = vi.spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const start = Date.now();
      const result = await waitForPortFree(37777, 1500);
      const elapsed = Date.now() - start;

      expect(result).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(1400);
      expect(elapsed).toBeLessThan(2500);
      spy.mockRestore();
    });

    it('should succeed when port becomes free', async () => {
      let callCount = 0;
      const spy = vi.spyOn(net, 'createServer').mockImplementation(() => ({
        once: vi.fn((event: string, cb: Function) => {
          callCount++;
          if (callCount < 3) {
            if (event === 'error') setTimeout(() => cb({ code: 'EADDRINUSE' }), 0);
          } else {
            if (event === 'listening') setTimeout(() => cb(), 0);
          }
        }),
        listen: vi.fn(() => {}),
        close: vi.fn((cb: Function) => cb())
      } as any));

      const result = await waitForPortFree(37777, 5000);

      expect(result).toBe(true);
      expect(callCount).toBeGreaterThanOrEqual(3);
      spy.mockRestore();
    });

    it('should use default timeout when not specified', async () => {
      const createServerMock = vi.fn(() => ({
        once: vi.fn((event: string, cb: Function) => {
          if (event === 'listening') setTimeout(() => cb(), 0);
        }),
        listen: vi.fn(() => {}),
        close: vi.fn((cb: Function) => cb())
      }));
      const spy = vi.spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const result = await waitForPortFree(39999);

      expect(result).toBe(true);
      spy.mockRestore();
    });
  });
});
