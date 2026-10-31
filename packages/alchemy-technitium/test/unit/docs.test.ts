// The examples in the READMEs are the example files that the server tests run, verbatim.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const codeBlocks = (markdown: string) =>
  [...markdown.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((match) => match[1]!.trim());

describe("README examples", () => {
  it.each([
    ["README.md", "packages/alchemy-technitium/examples/homelab.ts"],
    ["packages/alchemy-technitium/README.md", "packages/alchemy-technitium/examples/homelab.ts"],
    ["packages/technitium/README.md", "packages/technitium/examples/list-records.ts"],
  ])("%s shows %s", (readme, example) => {
    expect(codeBlocks(read(readme))).toContain(read(example).trim());
  });
});
