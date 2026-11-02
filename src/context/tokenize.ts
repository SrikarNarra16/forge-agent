/**
 * Identifier-aware tokenizer shared by indexing and querying. Splits snake_case, camelCase, digits, dotted
 * names and paths; lowercases; ALSO keeps the whole compound identifier (`get_debug_flag`) as a token so an
 * exact identifier outranks chunks that merely contain its parts; drops a light list of natural-language
 * stopwords and 1-character tokens. Pure and deterministic.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "an", "of", "to", "in", "is", "it", "and", "or", "for", "on", "with", "as", "at", "by", "be", "that", "this",
  "from", "are", "was", "how", "does", "do", "what", "where", "which", "when", "can", "should", "would", "will", "must",
  "have", "has", "not", "any", "its", "than", "then", "so", "if", "also", "into", "about", "there", "their", "these",
  "those", "each", "me", "my", "you", "your", "we", "our", "us", "i",
]);

const MAX_TOKEN_LENGTH = 40;
const WORD = /[A-Za-z_][A-Za-z0-9_]*|\d+/g;

/** `parseURLString2Go` -> `parse`, `url`, `string`, `2`, `go`. */
export function splitIdentifier(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .split(/[_\s]+/)
    .filter((p) => p !== "")
    .map((p) => p.toLowerCase());
}

function keep(token: string): boolean {
  return token.length >= 2 && token.length <= MAX_TOKEN_LENGTH && !STOPWORDS.has(token);
}

/** Tokens of free text or code, in order of appearance, with duplicates (term frequency matters). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    const parts = splitIdentifier(word);
    const whole = word.toLowerCase().replace(/^_+|_+$/g, "");
    if (parts.length > 1 && keep(whole)) out.push(whole);
    for (const part of parts) if (keep(part)) out.push(part);
  }
  return out;
}

/** Tokens of a file path: directories, the file name and its stem (`tests/test_cli.py` -> tests, test_cli, test, cli, py). */
export function tokenizePath(path: string): string[] {
  return tokenize(path.replace(/[\\/.\-]+/g, " "));
}

/** Distinct query terms in first-seen order. */
export function queryTerms(text: string): string[] {
  return [...new Set(tokenize(text))];
}
