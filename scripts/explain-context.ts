/**
 * Dev tool: shows how the context engine ranks a query over fixtures/flask (read-only): query terms, their
 * document frequency, and the top hits with scores and matched terms.
 *
 *   npx tsx scripts/explain-context.ts "where is jsonify defined" [--top 12]
 */
import { join } from "node:path";
import { ContextIndex } from "../src/context/indexer";
import { retrieve } from "../src/context/retrieval";
import { queryTerms } from "../src/context/tokenize";
import { DiskHost } from "./diskHost";

async function main(): Promise<void> {
  const query = process.argv[2];
  if (!query) throw new Error('usage: explain-context.ts "<query>" [--top N]');
  const topArg = process.argv.indexOf("--top");
  const top = topArg >= 0 ? Number(process.argv[topArg + 1]) : 10;
  const index = new ContextIndex();
  await index.build(new DiskHost(join(__dirname, "..", "..", "fixtures", "flask")));
  console.log(`terms: ${queryTerms(query).join(", ")}`);
  console.log("\nraw BM25 hits (before diversification):");
  for (const [i, hit] of index.search(query, { limit: top }).entries()) {
    console.log(`${String(i + 1).padStart(2)}. ${hit.score.toFixed(2).padStart(7)}  ${hit.chunk.path}:${hit.chunk.startLine}-${hit.chunk.endLine} ${hit.chunk.symbol ?? `(${hit.chunk.kind})`}  [${hit.terms.join(", ")}]`);
  }
  const { plan } = retrieve(index, { query, budgetTokens: 6000 });
  console.log("\nfinal plan:");
  for (const item of plan.items) console.log(`  ${item.form === "body" ? "BODY" : "loc "} ${item.path}:${item.startLine}-${item.endLine} ${item.symbol ?? `(${item.kind})`}  ${item.reason}  ~${item.tokens} tok`);
  console.log(`  used ${plan.usedTokens}/${plan.budgetTokens} tokens`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
