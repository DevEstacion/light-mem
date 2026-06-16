import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { PotionEmbedder } from '../../../src/services/embed/PotionEmbedder.js';
import { WordPieceTokenizer } from '../../../src/services/embed/WordPieceTokenizer.js';

const MODEL_DIR = join(import.meta.dirname, '..', '..', '..', 'src', 'models', 'potion-base-8m');

describe('PotionEmbedder', () => {
  const e = new PotionEmbedder(MODEL_DIR);

  it('produces 256-dim unit vectors', () => {
    const v = e.embed('aws okta authentication kubeconfig patch');
    expect(v.length).toBe(256);
    let norm = 0;
    for (const x of v) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it('returns a zero vector for empty / whitespace input (no NaN)', () => {
    for (const t of ['', '   ', '\n\t']) {
      const v = e.embed(t);
      expect(v.every(x => x === 0)).toBe(true);
      expect(v.some(x => Number.isNaN(x))).toBe(false);
    }
  });

  it('is deterministic', () => {
    const a = e.embed('PTY terminal buffer replay');
    const b = e.embed('PTY terminal buffer replay');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('ranks a relevant document above an unrelated one (cosine)', () => {
    const q = e.embed('how does websocket reconnect work');
    const relevant = e.embed('Dashboard WebSocket reconnects with backoff after the connection drops');
    const unrelated = e.embed('aws okta login and kubeconfig download in settings');
    const cos = (x: Float32Array, y: Float32Array) => {
      let d = 0;
      for (let i = 0; i < x.length; i++) d += x[i] * y[i];
      return d;
    };
    expect(cos(q, relevant)).toBeGreaterThan(cos(q, unrelated));
  });
});

describe('WordPieceTokenizer', () => {
  const tok = new WordPieceTokenizer(join(MODEL_DIR, 'tokenizer.json'));

  it('matches the known reference token ids for a sample query', () => {
    // Content ids for "what alerts fire for CPS" (no special tokens), verified
    // against the HuggingFace tokenizer in /tmp/potion-spike.
    expect(tok.encode('what alerts fire for CPS')).toEqual([1060, 8505, 1021, 1549, 1011, 17139, 1021]);
  });

  it('does not split on symbol characters like the arrow → (only \\p{P})', () => {
    // BERT punctuation = \p{P} only, not \p{S}. The arrow must not split words.
    const ids = tok.encode('Create→Run');
    // wrong behavior would insert the standalone arrow token between word pieces
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain(591); // 591 == standalone "→" token id (regression guard)
  });
});
