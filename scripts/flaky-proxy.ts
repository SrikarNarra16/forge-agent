/**
 * TCP proxy in front of TrueForge that cuts the connection to simulate a dropped stream ("terminated").
 *   npx tsx scripts/flaky-proxy.ts [--listen 8791] [--target 8790] [--cut-after 4]   (seconds after a connection opens)
 * Then set forge.trueforge.baseUrl to http://localhost:8791 in the Extension Development Host. Only the FIRST long-lived
 * connection (the turn stream) is cut; later ones pass through, so the re-attach (resume) works. Ctrl-C to stop.
 */
import * as net from "node:net";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const listen = Number(arg("--listen", "8791"));
const target = Number(arg("--target", "8790"));
const cutAfterMs = Number(arg("--cut-after", "4")) * 1000;
let cuts = 0;

net
  .createServer((client) => {
    const upstream = net.connect(target, "127.0.0.1");
    client.pipe(upstream);
    upstream.pipe(client);
    const closeBoth = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", closeBoth);
    upstream.on("error", closeBoth);
    client.on("close", closeBoth);
    // cut the first connection that is still open after cutAfterMs (a streaming turn), once
    const timer = setTimeout(() => {
      if (cuts === 0 && !client.destroyed) {
        cuts++;
        console.log(`[flaky-proxy] cutting a connection that stayed open for ${cutAfterMs / 1000}s`);
        closeBoth();
      }
    }, cutAfterMs);
    client.on("close", () => clearTimeout(timer));
  })
  .listen(listen, "127.0.0.1", () => console.log(`[flaky-proxy] 127.0.0.1:${listen} -> 127.0.0.1:${target}; first long connection is cut after ${cutAfterMs / 1000}s`));
