/**
 * Regex symbol extraction for .py / .ts / .tsx / .js / .jsx files. Used by repo_map, search_code
 * (kind=symbol) and as the get_symbols fallback when no language server answers. Top-level only.
 */
export type SymbolLanguage = "py" | "ts";

export interface FoundSymbol {
  name: string;
  kind: "class" | "function" | "interface" | "type" | "enum" | "const";
  /** 1-based. */
  line: number;
}

const EXTENSION_LANGUAGE: Record<string, SymbolLanguage> = {
  py: "py",
  ts: "ts",
  tsx: "ts",
  js: "ts",
  jsx: "ts",
  mjs: "ts",
  cjs: "ts",
};

export function languageOf(relPath: string): SymbolLanguage | undefined {
  const ext = relPath.split(".").pop()?.toLowerCase();
  return ext ? EXTENSION_LANGUAGE[ext] : undefined;
}

const PY = /^(async\s+def|def|class)\s+([A-Za-z_]\w*)/;
const TS_FUNCTION = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const TS_CLASS = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const TS_TYPE = /^(?:export\s+)?(?:declare\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const TS_ARROW = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/;
const TS_FUNCTION_EXPR = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/;

export function extractSymbols(text: string, language: SymbolLanguage): FoundSymbol[] {
  const found: FoundSymbol[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    if (language === "py") {
      const m = PY.exec(line);
      if (m?.[1] && m[2]) found.push({ name: m[2], kind: m[1] === "class" ? "class" : "function", line: lineNo });
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = TS_FUNCTION.exec(line)) && m[1]) found.push({ name: m[1], kind: "function", line: lineNo });
    else if ((m = TS_CLASS.exec(line)) && m[1]) found.push({ name: m[1], kind: "class", line: lineNo });
    else if ((m = TS_TYPE.exec(line)) && m[1] && m[2]) found.push({ name: m[2], kind: m[1] as "interface" | "type" | "enum", line: lineNo });
    else if (((m = TS_ARROW.exec(line)) || (m = TS_FUNCTION_EXPR.exec(line))) && m[1]) found.push({ name: m[1], kind: "function", line: lineNo });
  }
  return found;
}
