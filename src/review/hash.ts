import { createHash } from "node:crypto";

/** Content hash used to detect that a file changed while a review was open. */
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
