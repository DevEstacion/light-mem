/**
 * Pure-TS BERT WordPiece tokenizer — zero dependencies.
 *
 * Reproduces the HuggingFace `tokenizers` pipeline for potion-base-8M's
 * tokenizer.json exactly (verified 100% token-id parity across 789 real
 * strings + unicode/emoji in /tmp/potion-spike): BertNormalizer
 * (lowercase, clean_text, handle_chinese_chars, strip_accents follows
 * lowercase) → BertPreTokenizer (whitespace + punctuation split) →
 * WordPiece (greedy longest-match with `##` continuation, `[UNK]` fallback).
 *
 * GOTCHA: BERT punctuation-splits on Unicode category P (`\p{P}`) ONLY,
 * NOT on S (symbols). A symbol like `→` must stay glued to its word, or
 * token ids diverge from the reference tokenizer.
 *
 * model2vec embeds with NO special tokens, so encode() never emits
 * [CLS]/[SEP]; out-of-vocab words become a single [UNK] row (which model2vec
 * keeps in the mean-pool).
 */
import { readFileSync } from 'fs';

interface TokenizerJson {
  normalizer?: {
    lowercase?: boolean;
    strip_accents?: boolean | null;
    handle_chinese_chars?: boolean;
    clean_text?: boolean;
  };
  model: {
    vocab: Record<string, number>;
    unk_token?: string;
    continuing_subword_prefix?: string;
    max_input_chars_per_word?: number;
  };
}

export class WordPieceTokenizer {
  private vocab: Map<string, number>;
  private unk: string;
  private unkId: number;
  private prefix: string;
  private maxChars: number;
  private lowercase: boolean;
  private stripAccents: boolean | null;
  private handleChinese: boolean;

  constructor(tokenizerJsonPath: string) {
    const t = JSON.parse(readFileSync(tokenizerJsonPath, 'utf8')) as TokenizerJson;
    this.vocab = new Map(Object.entries(t.model.vocab));
    this.unk = t.model.unk_token ?? '[UNK]';
    this.prefix = t.model.continuing_subword_prefix ?? '##';
    this.maxChars = t.model.max_input_chars_per_word ?? 100;
    const nrm = t.normalizer ?? {};
    this.lowercase = !!nrm.lowercase;
    this.stripAccents = nrm.strip_accents ?? null;
    this.handleChinese = !!nrm.handle_chinese_chars;
    const unkId = this.vocab.get(this.unk);
    if (unkId === undefined) {
      throw new Error(`WordPieceTokenizer: unk_token ${this.unk} not in vocab`);
    }
    this.unkId = unkId;
  }

  private isControl(cp: number): boolean {
    if (cp === 9 || cp === 10 || cp === 13) return false;
    return cp < 32 || (cp >= 127 && cp < 160);
  }

  private isWhitespace(cp: number): boolean {
    return (
      cp === 32 || cp === 9 || cp === 10 || cp === 13 ||
      cp === 0x2028 || cp === 0x2029 || (cp >= 0x2000 && cp <= 0x200a) ||
      cp === 0x00a0 || cp === 0x3000 || cp === 0x1680 || cp === 0x202f || cp === 0x205f
    );
  }

  private isChinese(cp: number): boolean {
    return (
      (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x20000 && cp <= 0x2a6df) || (cp >= 0x2a700 && cp <= 0x2b73f) ||
      (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f)
    );
  }

  private isPunct(cp: number): boolean {
    // BERT treats the ASCII punctuation ranges as punctuation explicitly,
    // then falls back to Unicode category P (NOT S — see file header).
    if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) {
      return true;
    }
    return /\p{P}/u.test(String.fromCodePoint(cp));
  }

  /** clean_text: drop null/replacement/control chars, normalize all whitespace to a single space char. */
  private clean(text: string): string {
    let out = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0 || cp === 0xfffd || this.isControl(cp)) continue;
      out += this.isWhitespace(cp) ? ' ' : ch;
    }
    return out;
  }

  private normalize(text: string): string {
    text = this.clean(text);
    if (this.handleChinese) {
      let o = '';
      for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        o += this.isChinese(cp) ? ` ${ch} ` : ch;
      }
      text = o;
    }
    if (this.lowercase) text = text.toLowerCase();
    // strip_accents defaults to following the lowercase flag when null.
    const doStrip = this.stripAccents === null ? this.lowercase : this.stripAccents;
    if (doStrip) text = text.normalize('NFD').replace(/\p{Mn}/gu, '');
    return text;
  }

  /** BertPreTokenizer: split on whitespace, then peel punctuation into standalone tokens. */
  private preTokenize(text: string): string[] {
    const words: string[] = [];
    for (const chunk of text.split(/\s+/)) {
      if (!chunk) continue;
      let cur = '';
      for (const ch of chunk) {
        const cp = ch.codePointAt(0)!;
        if (this.isPunct(cp)) {
          if (cur) { words.push(cur); cur = ''; }
          words.push(ch);
        } else {
          cur += ch;
        }
      }
      if (cur) words.push(cur);
    }
    return words;
  }

  /** Returns token ids (no special tokens). OOV words collapse to a single [UNK] id. */
  encode(text: string): number[] {
    const ids: number[] = [];
    for (const word of this.preTokenize(this.normalize(text))) {
      const chars = [...word];
      if (chars.length > this.maxChars) {
        ids.push(this.unkId);
        continue;
      }
      let start = 0;
      const sub: number[] = [];
      let bad = false;
      while (start < chars.length) {
        let end = chars.length;
        let found: number | null = null;
        while (start < end) {
          let piece = chars.slice(start, end).join('');
          if (start > 0) piece = this.prefix + piece;
          const id = this.vocab.get(piece);
          if (id !== undefined) { found = id; break; }
          end--;
        }
        if (found === null) { bad = true; break; }
        sub.push(found);
        start = end;
      }
      if (bad) ids.push(this.unkId);
      else ids.push(...sub);
    }
    return ids;
  }
}
