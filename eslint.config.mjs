import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "out/**", "coverage/**", "*.vsix"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // These modules run outside the editor too (scripts/tf-setup.ts, vitest), so they must stay vscode-free.
    files: [
      "src/trueforge/client.ts",
      "src/trueforge/providers.ts",
      "src/trueforge/events.ts",
      "src/trueforge/runState.ts",
      "src/trueforge/agentController.ts",
      "src/trueforge/sdkAdapter.ts",
      "src/trueforge/uiSinks.ts",
      "src/trueforge/preflight.ts",
      "src/ui/protocol.ts",
      "src/ui/batcher.ts",
      "src/ui/transcript.ts",
      "src/ui/webview/markdown.ts",
      "src/ui/webview/format.ts",
      "src/review/hunks.ts",
      "src/review/session.ts",
      "src/review/tracker.ts",
      "src/review/checkpoints.ts",
      "src/review/applyCore.ts",
      "src/review/hash.ts",
      "src/review/reviewHandler.ts",
      "src/review/runScope.ts",
      "src/review/fakeProposalPlan.ts",
      "src/trueforge/routingApprovals.ts",
      "src/mcp/**/*.ts",
      "scripts/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "vscode", message: "This module is shared with scripts/tests; keep it free of the vscode API." }] },
      ],
    },
  },
);
