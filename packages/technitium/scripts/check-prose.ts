/**
 * Fails if a sentence of Technitium's API documentation appears in a file that is or would be
 * committed. The documentation is GPL-3.0 text; this repository keeps only its structure (see
 * docs/DESIGN.md#technitium-text). Needs the files that `pnpm specs:fetch` caches.
 *
 * Sentences of at least eight words are compared as lowercase word sequences, so line breaks,
 * comment markers, Markdown and escapes do not hide a copy.
 */
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const MIN_WORDS = 8;
const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Sentences outside code fences, as normalized word sequences. */
export function sentences(markdown: string): string[] {
  const prose = markdown.replace(/^```[\s\S]*?^```/gm, " ");
  return prose
    .split(/(?<=[.!?:])\s+|\n\s*\n|\n- /)
    .map((sentence) => words(sentence).join(" "))
    .filter((sentence) => sentence.split(" ").length >= MIN_WORDS);
}

const IGNORED = new Set([
  ".git",
  ".jj",
  ".local",
  "node_modules",
  "lib",
  "release",
  ".cache",
  ".generated-specs",
]);
async function* files(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.(ts|md|json|ya?ml)$/.test(entry.name) || entry.name === "NOTICE") yield path;
  }
}

const root = new URL("../../../", import.meta.url).pathname;
const specs = new URL("../specs/", import.meta.url);
const { commit }: { commit: string } = JSON.parse(
  await readFile(new URL("provenance.json", specs), "utf8"),
);
const cached = new URL(`.cache/${commit}/APIDOCS.md`, specs);
if (!existsSync(cached)) {
  console.error("The Technitium documentation is not cached. Run `pnpm specs:fetch` first.");
  process.exit(1);
}
const needles = [...new Set(sentences(await readFile(cached, "utf8")))];
const found: string[] = [];
for await (const file of files(root)) {
  const text = ` ${words(await readFile(file, "utf8")).join(" ")} `;
  for (const needle of needles)
    if (text.includes(` ${needle} `))
      found.push(`${relative(root, file)}: "${needle.slice(0, 80)}..."`);
}
if (found.length > 0) {
  console.error(`Technitium documentation text found in committed files:\n${found.join("\n")}`);
  process.exit(1);
}
console.log(`No Technitium documentation text found (${needles.length} sentences checked).`);
