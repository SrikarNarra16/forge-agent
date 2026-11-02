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

// --- light Porter-style stemming ---------------------------------------------------------------------------------
// Both documents and queries are stemmed the same way, so "pushed", "pushes" and "push" meet, as do "registered" /
// "register" and "served" / "serve". Stems need not be real words; the UI shows the user's own words as the reason.

const isVowel = (w: string, i: number): boolean => {
  const ch = w[i];
  if (ch === undefined) return false;
  if ("aeiou".includes(ch)) return true;
  return ch === "y" && i > 0 && !isVowel(w, i - 1);
};

/** Porter's "measure": the number of vowel-consonant sequences. */
function measure(w: string): number {
  let m = 0;
  let inVowel = false;
  for (let i = 0; i < w.length; i++) {
    const v = isVowel(w, i);
    if (inVowel && !v) m++;
    inVowel = v;
  }
  return m;
}

const hasVowel = (w: string): boolean => [...w].some((_, i) => isVowel(w, i));
const endsDoubleConsonant = (w: string): boolean => w.length >= 2 && w[w.length - 1] === w[w.length - 2] && !isVowel(w, w.length - 1);
function endsCvc(w: string): boolean {
  const n = w.length;
  if (n < 3) return false;
  const last = w[n - 1] ?? "";
  return !isVowel(w, n - 1) && isVowel(w, n - 2) && !isVowel(w, n - 3) && !"wxy".includes(last);
}

export function stem(word: string): string {
  if (word.length < 4 || !/^[a-z]+$/.test(word)) return word;
  let w = word;
  // 1a: plurals
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -2);
  else if (!w.endsWith("ss") && w.endsWith("s")) w = w.slice(0, -1);
  // 1b: -eed, -ed, -ing
  if (w.endsWith("eed")) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else {
    const base = w.endsWith("ed") ? w.slice(0, -2) : w.endsWith("ing") ? w.slice(0, -3) : undefined;
    if (base !== undefined && hasVowel(base)) {
      w = base;
      if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
      else if (endsDoubleConsonant(w) && !"lsz".includes(w[w.length - 1] ?? "")) w = w.slice(0, -1);
      else if (measure(w) === 1 && endsCvc(w)) w += "e";
    }
  }
  // 1c: y -> i
  if (w.endsWith("y") && hasVowel(w.slice(0, -1))) w = `${w.slice(0, -1)}i`;
  // 5a: a final e
  if (w.endsWith("e")) {
    const base = w.slice(0, -1);
    const m = measure(base);
    if (m > 1 || (m === 1 && !endsCvc(base))) w = base;
  }
  return w;
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
    for (const part of parts) if (keep(part)) out.push(stem(part));
  }
  return out;
}

/** Tokens of a file path: directories, the file name and its stem (`tests/test_cli.py` -> tests, test_cli, test, cli, py). */
export function tokenizePath(path: string): string[] {
  return tokenize(path.replace(/[\\/.\-]+/g, " "));
}

/**
 * Words that frame a question ("where is X implemented", "show me") rather than say what to look for.
 * Dropped from QUERIES only: they are ordinary words in documents, but matching prose that happens to contain
 * "implemented" or "defined" is noise.
 */
const QUESTION_FRAMING = /\b(?:implemented|implementation|defined|definition|located|location|find|finds|show|shows|explain|works|working|happens|happen|please|want|need|needs|appear|appears|other|others|must|ensure)\b/gi;

/** Distinct query terms (stems) in first-seen order. */
export function queryTerms(text: string): string[] {
  return [...new Set(tokenize(text.replace(QUESTION_FRAMING, " ")))];
}

export interface QueryOptions {
  /** Also try adjacent query words joined as one identifier ("test client" -> test_client, testclient). */
  bigrams?: boolean;
}

export interface WeightedQuery {
  terms: string[];
  weights: Map<string, number>;
}

/**
 * Query terms with weights. Adjacent content words are also offered as joined identifiers, because natural
 * language splits what code joins ("test client" is `test_client`, "app context" is `AppContext`); a joined
 * term only matters if it exists in the corpus.
 */
export function weightedQuery(rawText: string, options: QueryOptions = {}): WeightedQuery {
  const text = rawText.replace(QUESTION_FRAMING, " ");
  const weights = new Map<string, number>();
  const add = (term: string, weight: number): void => {
    weights.set(term, Math.max(weights.get(term) ?? 0, weight));
  };
  for (const term of tokenize(text)) add(term, 1);
  if (options.bigrams !== false) {
    const words = [...text.replace(/`/g, " ").matchAll(/[A-Za-z][A-Za-z0-9]*/g)].map((m) => m[0].toLowerCase()).filter(keep);
    for (let i = 0; i + 1 < words.length; i++) {
      add(`${words[i]}_${words[i + 1]}`, 1);
      add(`${words[i]}${words[i + 1]}`, 1);
    }
  }
  return { terms: [...weights.keys()], weights };
}

/** stem -> the first word of the text that produced it, so match reasons use the user's own words. */
export function surfaceForms(rawText: string): Map<string, string> {
  const text = rawText.replace(QUESTION_FRAMING, " ");
  const out = new Map<string, string>();
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    const whole = word.toLowerCase().replace(/^_+|_+$/g, "");
    const parts = splitIdentifier(word);
    if (parts.length > 1 && keep(whole) && !out.has(whole)) out.set(whole, whole);
    for (const part of parts) {
      const stemmed = keep(part) ? stem(part) : undefined;
      if (stemmed !== undefined && !out.has(stemmed)) out.set(stemmed, part);
    }
  }
  return out;
}
