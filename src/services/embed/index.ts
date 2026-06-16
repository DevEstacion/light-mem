/**
 * Process-wide singleton accessor for the potion-base-8M embedder.
 *
 * The model files (model.safetensors + tokenizer.json, ~30MB) are bundled into
 * the plugin under `plugin/models/potion-base-8m/`. At runtime the worker
 * executes from `plugin/scripts/`, so `__dirname/../models/...` resolves them.
 * In dev/test (bun running TS straight from `src/`) we fall back to the
 * in-repo source copy at `src/models/potion-base-8m/`.
 */
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PotionEmbedder } from './PotionEmbedder.js';

export { PotionEmbedder } from './PotionEmbedder.js';
export { WordPieceTokenizer } from './WordPieceTokenizer.js';

const MODEL_SUBDIR = join('models', 'potion-base-8m');

function thisDir(): string {
  // Works under both the bundled CJS worker (__dirname) and ESM/bun (import.meta).
  if (typeof __dirname !== 'undefined') return __dirname;
  return resolve(fileURLToPath(import.meta.url), '..');
}

export function resolveModelDir(): string {
  const candidates = [
    // Bundled plugin layout: plugin/scripts/<worker>.cjs → plugin/models/...
    resolve(thisDir(), '..', MODEL_SUBDIR),
    // dev: src/services/embed/ → src/models/...
    resolve(thisDir(), '..', '..', MODEL_SUBDIR),
    // dev when running compiled-from-src with a deeper layout
    resolve(thisDir(), '..', '..', '..', 'src', MODEL_SUBDIR),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'model.safetensors'))) return dir;
  }
  throw new Error(
    `potion-base-8m model not found. Looked in:\n${candidates.join('\n')}`
  );
}

let instance: PotionEmbedder | null = null;

/** Lazily construct and cache the embedder (loads the 29MB matrix once, ~8ms). */
export function getEmbedder(): PotionEmbedder {
  if (!instance) {
    instance = new PotionEmbedder(resolveModelDir());
  }
  return instance;
}
