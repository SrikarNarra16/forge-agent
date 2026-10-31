import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/util/tokens";
import { capabilitiesUrl } from "../src/util/url";

describe("estimateTokens", () => {
  it("is chars / 4 rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("capabilitiesUrl", () => {
  it("tolerates trailing slashes and whitespace", () => {
    expect(capabilitiesUrl("http://localhost:8790")).toBe("http://localhost:8790/api/v1/capabilities");
    expect(capabilitiesUrl(" http://localhost:8790/// ")).toBe("http://localhost:8790/api/v1/capabilities");
  });
});
