/**
 * Fills the video URL (and optionally the college and team name) into the write-up facts and the README's demo link, re-renders Forge-writeup.pdf and
 * re-checks it: at most 3 pages, the 8 headings, and NO placeholder text left in the PDF text layer.
 *
 *   npm run writeup:set-url -- https://youtu.be/XXXX [--college "FLAME University"] [--team-name "Monarch"]
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readTeam, render, writeTeam } from "./render-writeup";

/** Rewrites the video block of README.md (between the video:start / video:end markers) for the given URL. */
async function updateReadme(url: string): Promise<void> {
  const file = join(__dirname, "..", "README.md");
  const text = await readFile(file, "utf8");
  const block = `<!-- video:start -->\n**[Watch the demo video (3:30, under the 4-minute limit)](${url})**: ${url}\n<!-- video:end -->`;
  const next = text.replace(/<!-- video:start -->[\s\S]*?<!-- video:end -->/, () => block);
  if (next === text && !text.includes(url)) throw new Error("README.md has no video:start / video:end block");
  await writeFile(file, next, "utf8");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const take = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const [, value] = args.splice(i, 2);
    return value;
  };
  const college = take("--college");
  const teamName = take("--team-name");
  const url = args.find((a) => /^https?:\/\//.test(a));
  if (!url) {
    console.error('usage: npm run writeup:set-url -- <https://youtu.be/...> [--college "X"] [--team-name "Y"]');
    return 2;
  }
  const team = await readTeam();
  team.videoUrl = url;
  if (college) team.college = college;
  if (teamName) team.team = teamName;
  await writeTeam(team);
  await updateReadme(url);
  const r = await render({ png: process.env["WRITEUP_PNG"] === "1" });
  const leftover = r.placeholders.length;
  console.log(`\nVideo URL set to ${url}. Pages: ${r.pages}. Placeholder text left in the PDF: ${leftover === 0 ? "none" : r.placeholders.join(" ")}. The URL is a clickable link: ${r.links.includes(url)}.`);
  if (!r.links.includes(url)) console.log("WARNING: the video URL is not among the PDF's link annotations.");
  return r.ok && r.links.includes(url) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
