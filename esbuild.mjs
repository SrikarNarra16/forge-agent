// Bundles the extension host (node, cjs) and the webview (browser, iife) into dist/.
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.env.NODE_ENV === "production";

/** Prints markers the VS Code problem matcher in .vscode/tasks.json waits for. */
const watchLogger = {
  name: "watch-logger",
  setup(build) {
    build.onStart(() => console.log("[watch] build started"));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) console.error(`    ${location.file}:${location.line}:${location.column}:`);
      }
      console.log("[watch] build finished");
    });
  },
};

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  plugins: watch ? [watchLogger] : [],
};

const configs = [
  {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
  },
  {
    ...common,
    entryPoints: { webview: "src/ui/webview/main.ts" },
    outdir: "dist",
    platform: "browser",
    format: "iife",
    target: "es2022",
  },
];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
