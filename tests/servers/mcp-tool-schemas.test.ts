import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';

const mcpServerPath = new URL('../../src/servers/mcp-server.ts', import.meta.url).pathname;

describe('MCP tool inputSchema declarations', () => {
  let tools: any[];

  it('search tool declares query parameter', async () => {
    const src = await readFile(mcpServerPath, 'utf-8');

    expect(src).toContain("name: 'search'");
    const searchSection = src.slice(src.indexOf("name: 'search'"), src.indexOf("name: 'timeline'"));
    expect(searchSection).toContain("query:");
    expect(searchSection).toContain("limit:");
    expect(searchSection).toContain("project:");
    expect(searchSection).toContain("orderBy:");
    expect(searchSection).not.toContain("properties: {}");
  });

  it('timeline tool declares anchor and query parameters', async () => {
    const src = await readFile(mcpServerPath, 'utf-8');

    const timelineSection = src.slice(
      src.indexOf("name: 'timeline'"),
      src.indexOf("name: 'get_observations'")
    );
    expect(timelineSection).toContain("anchor:");
    expect(timelineSection).toContain("query:");
    expect(timelineSection).toContain("depth_before:");
    expect(timelineSection).toContain("depth_after:");
    expect(timelineSection).toContain("project:");
    expect(timelineSection).not.toContain("properties: {}");
  });

  it('get_observations still declares ids (regression check)', async () => {
    const src = await readFile(mcpServerPath, 'utf-8');

    const getObsSection = src.slice(src.indexOf("name: 'get_observations'"));
    expect(getObsSection).toContain("ids:");
    expect(getObsSection).toContain("required:");
  });

  // The server-beta-only observation_*/memory_* tools were removed when the
  // server-beta runtime was stripped. Guard that they stay gone (local worker
  // mode exposes search/timeline/get_observations/smart_* instead).
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
