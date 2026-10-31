import { describe, expect, it } from "vitest";
import { isInside } from "../src/util/paths";

describe("isInside", () => {
  const root = "/work/flask";

  it("accepts the root and paths beneath it", () => {
    expect(isInside(root, ".")).toBe(true);
    expect(isInside(root, "src/flask/helpers.py")).toBe(true);
    expect(isInside(root, "/work/flask/tests/test_cli.py")).toBe(true);
  });

  it("rejects parent escapes and unrelated absolute paths", () => {
    expect(isInside(root, "../secrets.txt")).toBe(false);
    expect(isInside(root, "src/../../etc/passwd")).toBe(false);
    expect(isInside(root, "/etc/passwd")).toBe(false);
  });

  it("does not treat a sibling with a shared prefix as inside", () => {
    expect(isInside(root, "/work/flask-other/file.py")).toBe(false);
  });
});
