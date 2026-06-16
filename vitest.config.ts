import { defineConfig } from 'vitest/config';

/**
 * Vitest config — the test runner after the Bun→Node migration. Tests run on
 * plain Node (no Bun), using Vitest's Jest-compatible `expect`/`vi` so the
 * existing assertions and mocks port with minimal churn.
 */
export default defineConfig({
  resolve: {
    // Source imports use explicit `.js` extensions on `.ts` files (NodeNext
    // ESM convention). Vite/Vitest resolves TS natively, so map the `.js`
    // specifier back to its `.ts` source.
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
  test: {
    environment: 'node',
    globals: false,
    // Replaces bunfig.toml [test].preload — pins LIGHT_MEM_DATA_DIR to a temp
    // dir before any module loads so no test can touch the real ~/.light-mem.
    setupFiles: ['./tests/vitest.setup.ts'],
    include: ['tests/**/*.test.ts'],
    // Many tests spawn the worker / bind ports / touch SQLite files; isolate
    // per-file in forks to mirror bun:test's process-level isolation and avoid
    // cross-file singleton bleed (paths.ts freezes DATA_DIR at first eval).
    pool: 'forks',
    testTimeout: 15000,
  },
});
