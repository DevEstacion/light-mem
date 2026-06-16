import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Data-dir tripwire — no test may ever touch the real ~/.light-mem.
 * src/shared/paths.ts freezes DATA_DIR at first evaluation (env
 * LIGHT_MEM_DATA_DIR wins), and module-level consts inherit that frozen value,
 * so the env var must be set BEFORE any source module loads. Vitest runs
 * setupFiles before the test file's imports are evaluated in each worker, so
 * pinning it here fills the default while per-file overrides still win.
 *
 * (Replaces tests/preload.ts from the bun:test era.)
 */
if (!process.env.LIGHT_MEM_DATA_DIR) {
  process.env.LIGHT_MEM_DATA_DIR = mkdtempSync(join(tmpdir(), 'light-mem-test-run-'));
}
