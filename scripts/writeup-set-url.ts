/**
 * Fills the video URL (and optionally the college and team name) into the write-up facts, re-renders Forge-writeup.pdf and
 * re-checks it: at most 3 pages, the 8 headings, and NO placeholder text left in the PDF text layer.
 *
 *   npm run writeup:set-url -- https://youtu.be/XXXX [--college "FLAME University"] [--team-name "Monarch"]
 */
import { readTeam, render, writeTeam } from "./render-writeup";

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
