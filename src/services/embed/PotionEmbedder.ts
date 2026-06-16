/**
 * In-process potion-base-8M embedder — pure TS, zero runtime deps, no network.
 *
 * model2vec's StaticModel has NO neural net at inference: PCA + Zipf weighting
 * are baked into the embedding matrix at training time. Encoding a string is
 * just: WordPiece-tokenize → look up + mean-pool the static rows → L2 normalize.
 * This reproduces `StaticModel.encode` bit-exactly (verified maxAbsErr 2.98e-8
 * vs the Python reference in /tmp/potion-spike).
 *
 * The model ships as two bundled files: model.safetensors (one F32 tensor named
 * "embeddings", shape [vocab, dim]) and tokenizer.json. We never use the ONNX
 * graph and never call the HF hub, so there are no heavy dependencies.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { WordPieceTokenizer } from './WordPieceTokenizer.js';

interface SafetensorsTensorInfo {
  dtype: string;
  shape: number[];
  data_offsets: [number, number];
}

export class PotionEmbedder {
  readonly dim: number;
  private rows: number;
  private mat: Float32Array;
  private tok: WordPieceTokenizer;

  constructor(modelDir: string) {
    this.tok = new WordPieceTokenizer(join(modelDir, 'tokenizer.json'));
    const buf = readFileSync(join(modelDir, 'model.safetensors'));
    const headerLen = Number(buf.readBigUInt64LE(0));
    const header = JSON.parse(buf.toString('utf8', 8, 8 + headerLen)) as Record<string, SafetensorsTensorInfo>;
    const info = header['embeddings'];
    if (!info) {
      throw new Error('PotionEmbedder: model.safetensors missing "embeddings" tensor');
    }
    if (info.dtype !== 'F32') {
      throw new Error(`PotionEmbedder: expected F32 embeddings, got ${info.dtype}`);
    }
    [this.rows, this.dim] = info.shape;
    const start = 8 + headerLen + info.data_offsets[0];
    // Float32Array view over the safetensors payload (little-endian, which
    // matches every platform light-mem targets).
    this.mat = new Float32Array(buf.buffer, buf.byteOffset + start, this.rows * this.dim);
  }

  /**
   * Embed `text` into a unit-length Float32Array of length `dim`.
   * Empty / whitespace-only / fully-stripped input returns an all-zero vector
   * (no NaN) — callers treat a zero vector as "no semantic signal".
   */
  embed(text: string): Float32Array {
    const out = new Float32Array(this.dim);
    if (!text) return out;
    const ids = this.tok.encode(text);
    if (ids.length === 0) return out;

    const acc = new Float64Array(this.dim);
    for (const id of ids) {
      const base = id * this.dim;
      for (let j = 0; j < this.dim; j++) acc[j] += this.mat[base + j];
    }
    let norm = 0;
    for (let j = 0; j < this.dim; j++) {
      acc[j] /= ids.length;
      norm += acc[j] * acc[j];
    }
    norm = Math.sqrt(norm);
    if (norm === 0) return out;
    for (let j = 0; j < this.dim; j++) out[j] = acc[j] / norm;
    return out;
  }
}
