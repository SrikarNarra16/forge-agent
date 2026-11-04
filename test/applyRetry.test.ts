import { describe, expect, it } from "vitest";
import { ConflictError } from "../src/review/applyCore";
import { applyExistingFile, isClosedDocumentError, type EditPort, type EditRequest } from "../src/review/applyRetry";
import { hashText } from "../src/review/hash";

const BASE = "line1\nline2\nline3\n";
const NEW = "line1\nLINE2\nline3\n";
const request: EditRequest = { path: "src/a.py", baseHash: hashText(BASE), newText: NEW, edits: [{ startLine: 1, endLine: 2, text: "LINE2\n" }] };
const CLOSED = new Error("Document has been closed");

/** A fake editor: the text lives in `doc`; individual operations can be told to fail with a scripted error. */
function fakePort(script: { replace?: Array<Error | "ok">; persist?: Array<Error | "ok">; replaceAll?: Array<Error | "ok"> } = {}) {
  const calls: string[] = [];
  const state = { doc: BASE, saved: BASE };
  const next = (list: Array<Error | "ok"> | undefined): Error | "ok" => list?.shift() ?? "ok";
  const port: EditPort = {
    readText: () => (calls.push("read"), Promise.resolve(state.doc)),
    replaceRanges: (edits) => {
      calls.push("replace");
      const r = next(script.replace);
      if (r !== "ok") return Promise.reject(r);
      state.doc = NEW; // the edit lands in the buffer ...
      void edits;
      return Promise.resolve(true);
    },
    replaceAll: (text) => {
      calls.push("replaceAll");
      const r = next(script.replaceAll);
      if (r !== "ok") return Promise.reject(r);
      state.doc = text;
      return Promise.resolve(true);
    },
    persist: () => {
      calls.push("persist");
      const r = next(script.persist);
      if (r !== "ok") return Promise.reject(r); // ... and saving fails when the document object was disposed
      state.saved = state.doc;
      return Promise.resolve(true);
    },
  };
  return { port, calls, state };
}

describe("applyExistingFile", () => {
  it("normal case: reads once, replaces once, saves once", async () => {
    const f = fakePort();
    await applyExistingFile(f.port, request);
    expect(f.calls).toEqual(["read", "replace", "persist"]);
    expect(f.state.saved).toBe(NEW);
  });

  it("the document is closed during the save (the e2e finding): the edit already landed, so it re-opens and only saves: ONE retry, success, edit applied once", async () => {
    const f = fakePort({ persist: [CLOSED] });
    const logs: string[] = [];
    await applyExistingFile(f.port, request, (m) => logs.push(m));
    expect(f.calls).toEqual(["read", "replace", "persist", "read", "persist"]); // no second replace
    expect(f.state).toEqual({ doc: NEW, saved: NEW });
    expect(logs.join("\n")).toMatch(/closed during the edit.*retrying once/);
    expect(logs.join("\n")).toMatch(/already landed/);
  });

  it("the document is closed before the edit landed: the retry re-applies it once", async () => {
    const f = fakePort({ replace: [CLOSED] });
    await applyExistingFile(f.port, request);
    expect(f.calls).toEqual(["read", "replace", "read", "replace", "persist"]);
    expect(f.state.saved).toBe(NEW);
  });

  it("both attempts fail: the clear error is raised, the buffer is put back, and nothing was saved", async () => {
    const f = fakePort({ persist: [CLOSED, new Error("Document has been closed")] });
    await expect(applyExistingFile(f.port, request)).rejects.toThrow(/Document has been closed/);
    expect(f.state.doc).toBe(BASE); // the unsaved new text was taken back
    expect(f.state.saved).toBe(BASE); // and the file on disk never changed
    expect(f.calls.filter((c) => c === "replace")).toHaveLength(1);
    expect(f.calls).toContain("replaceAll");
  });

  it("both attempts fail before anything landed: no restore needed, nothing written", async () => {
    const f = fakePort({ replace: [CLOSED, CLOSED] });
    await expect(applyExistingFile(f.port, request)).rejects.toThrow(/closed/);
    expect(f.state).toEqual({ doc: BASE, saved: BASE });
    expect(f.calls).not.toContain("persist");
    expect(f.calls).not.toContain("replaceAll");
  });

  it("the file changed between the attempts: ConflictError (the 'changed while it was being reviewed' abort), no write", async () => {
    const f = fakePort({ replace: [CLOSED] });
    const original = f.port.readText;
    let reads = 0;
    f.port.readText = () => (++reads === 2 ? Promise.resolve("someone else edited this\n") : original());
    await expect(applyExistingFile(f.port, request)).rejects.toBeInstanceOf(ConflictError);
    await expect(applyExistingFile(fakePort({ replace: [CLOSED] }).port, request)).resolves.toBeUndefined(); // control: unchanged file succeeds
    expect(f.calls.filter((c) => c === "replace")).toHaveLength(1);
    expect(f.calls).not.toContain("persist");
    expect(f.state.saved).toBe(BASE);
  });

  it("a user's own text found after a failure is never overwritten while putting the base back", async () => {
    const f = fakePort({ persist: [CLOSED, CLOSED] });
    const original = f.port.readText;
    let reads = 0;
    f.port.readText = () => (++reads >= 3 ? Promise.resolve("the user typed something else\n") : original());
    await expect(applyExistingFile(f.port, request)).rejects.toThrow();
    expect(f.calls).not.toContain("replaceAll");
  });

  it("other errors are not retried", async () => {
    const f = fakePort({ replace: [new Error("EACCES: permission denied")] });
    await expect(applyExistingFile(f.port, request)).rejects.toThrow(/EACCES/);
    expect(f.calls).toEqual(["read", "replace", "read"]); // one attempt, then the check for a half-applied buffer
  });

  it("a refused edit and a failed save give clear errors", async () => {
    const refused = fakePort();
    refused.port.replaceRanges = () => Promise.resolve(false);
    await expect(applyExistingFile(refused.port, request)).rejects.toThrow(/VS Code rejected the edit to src\/a\.py/);
    const unsaved = fakePort();
    unsaved.port.persist = () => Promise.resolve(false);
    await expect(applyExistingFile(unsaved.port, request)).rejects.toThrow(/could not be saved/);
  });
});

describe("isClosedDocumentError", () => {
  it("recognises VS Code's wording only", () => {
    expect(isClosedDocumentError(new Error("Document has been closed"))).toBe(true);
    expect(isClosedDocumentError(new Error("Error: document is closed"))).toBe(true);
    expect(isClosedDocumentError(new Error("ENOENT"))).toBe(false);
    expect(isClosedDocumentError("Document has been closed")).toBe(true);
  });
});
