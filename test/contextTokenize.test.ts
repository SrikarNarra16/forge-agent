import { describe, expect, it } from "vitest";
import { queryTerms, splitIdentifier, tokenize, tokenizePath } from "../src/context/tokenize";

describe("splitIdentifier", () => {
  it("splits snake_case, camelCase, acronyms and digits", () => {
    expect(splitIdentifier("get_debug_flag")).toEqual(["get", "debug", "flag"]);
    expect(splitIdentifier("FlaskGroup")).toEqual(["flask", "group"]);
    expect(splitIdentifier("parseURLString2Go")).toEqual(["parse", "url", "string", "2", "go"]);
    expect(splitIdentifier("__init__")).toEqual(["init"]);
    expect(splitIdentifier("HTTPServer")).toEqual(["http", "server"]);
  });
});

describe("tokenize", () => {
  it("keeps the whole compound identifier AND its parts, so exact identifiers outrank partial matches", () => {
    expect(tokenize("get_debug_flag")).toEqual(["get_debug_flag", "get", "debug", "flag"]);
    expect(tokenize("FlaskGroup.add_command")).toEqual(["flaskgroup", "flask", "group", "add_command", "add", "command"]);
  });

  it("lowercases and keeps repeats (term frequency matters)", () => {
    expect(tokenize("Config config CONFIG")).toEqual(["config", "config", "config"]);
  });

  it("drops stopwords and 1-character tokens but keeps code words like add, get, test", () => {
    expect(tokenize("how does the app context get pushed")).toEqual(["app", "context", "get", "push"]);
    expect(tokenize("treat 'off' and 'n' as false")).toEqual(["treat", "off", "fals"]);
    expect(tokenize("add a test")).toEqual(["add", "test"]);
  });

  it("splits paths", () => {
    expect(tokenizePath("tests/test_cli.py")).toEqual(["test", "test_cli", "test", "cli", "py"]);
    expect(tokenizePath("src/flask/sansio/app.py")).toEqual(["src", "flask", "sansio", "app", "py"]);
    expect(tokenizePath("docs/cli.rst")).toEqual(["doc", "cli", "rst"]);
  });

  it("handles empty and symbol-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("!!! --- ***")).toEqual([]);
  });

  it("queryTerms are distinct and ordered by first appearance", () => {
    expect(queryTerms("config Config JSON json config")).toEqual(["config", "json"]);
  });

  it("is deterministic", () => {
    const text = "def routes_command(sort: str, all_methods: bool) -> None:";
    expect(tokenize(text)).toEqual(tokenize(text));
  });
});
