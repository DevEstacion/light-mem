/**
 * Shared lowercase-alphanumeric tokenizer for BM25 keyword scoring.
 *
 * Deliberately simple and stable: split on anything that isn't an ASCII
 * letter or digit, lowercase the result. Both the indexer side and the query
 * side must use this same function so term statistics line up.
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}
