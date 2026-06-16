import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const indexSource = readFileSync(join(import.meta.dirname, '..', 'src', 'npx-cli', 'index.ts'), 'utf-8');
const serverSource = readFileSync(join(import.meta.dirname, '..', 'src', 'npx-cli', 'commands', 'server.ts'), 'utf-8');

describe('npx CLI worker namespace', () => {
  it('routes worker lifecycle aliases through the server command module', () => {
    expect(indexSource).toContain("case 'worker'");
    expect(indexSource).toContain('runWorkerAliasCommand(args.slice(1))');
    expect(serverSource).toContain('runWorkerLifecycleCommand');
    expect(serverSource).toContain('runStartCommand()');
    expect(serverSource).toContain('runStopCommand()');
    expect(serverSource).toContain('runRestartCommand()');
    expect(serverSource).toContain('runStatusCommand()');
  });

  it('no longer exposes the removed server-beta runtime namespace', () => {
    expect(indexSource).not.toContain("case 'server'");
    expect(serverSource).not.toContain('runServerBeta');
    expect(serverSource).not.toContain('server-beta');
  });
});
