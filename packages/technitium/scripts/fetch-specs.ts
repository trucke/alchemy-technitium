/**
 * Downloads Technitium's API documentation and the server's request handlers for one release,
 * reduces them to the API structure and records where they came from.
 *
 *   pnpm specs:fetch            # the pinned release in specs/provenance.json
 *   pnpm specs:fetch v15.6.2    # move to another release
 *
 * Writes specs/api-structure.json and specs/provenance.json, which are committed, and keeps the
 * downloaded files in specs/.cache/<commit>/, which is not: they are GPL-3.0 text (see
 * docs/DESIGN.md#technitium-text). For the pinned release, every file must match the SHA-256 in
 * provenance.json, so a moved tag or a changed file fails instead of regenerating silently.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extract, parseRoutes } from "./extract.ts";

const REPOSITORY = "TechnitiumSoftware/DnsServer";
const DEFAULT_TAG = "v15.5.0";
const specs = new URL("../specs/", import.meta.url);

export interface SourceFile {
  readonly path: string;
  readonly sha256: string;
}
export interface Provenance {
  readonly repository: string;
  readonly tag: string;
  readonly commit: string;
  /** The license of the repository at that commit, checked from its LICENSE file. */
  readonly license: "GPL-3.0";
  readonly files: readonly SourceFile[];
  readonly structure: {
    readonly sha256: string;
    readonly operations: number;
    readonly undocumentedRoutes: number;
    readonly repairedExamples: readonly string[];
    readonly untypedParameters: number;
  };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const pinned: Provenance | undefined = existsSync(new URL("provenance.json", specs))
  ? JSON.parse(await readFile(new URL("provenance.json", specs), "utf8"))
  : undefined;
const tag = process.argv[2] ?? pinned?.tag ?? DEFAULT_TAG;
if (!/^v\d+\.\d+\.\d+$/.test(tag))
  throw new Error(`Expected a release tag such as v15.5.0, got ${tag}`);

const fetchOk = async (url: string) => {
  const response = await fetch(url, { headers: { "User-Agent": "alchemy-technitium" } });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return response;
};

const commit = (
  (await (await fetchOk(`https://api.github.com/repos/${REPOSITORY}/commits/${tag}`)).json()) as {
    sha: string;
  }
).sha;
if (pinned?.tag === tag && pinned.commit !== commit)
  throw new Error(`${tag} now points at ${commit}, not the pinned ${pinned.commit}`);

const cache = new URL(`.cache/${commit}/`, specs);
/** A file at the commit: from the cache when its checksum is pinned, otherwise downloaded. */
async function source(path: string): Promise<SourceFile & { text: string }> {
  const expected =
    pinned?.tag === tag ? pinned.files.find((f) => f.path === path)?.sha256 : undefined;
  const cached = new URL(path, cache);
  let text = existsSync(cached) ? await readFile(cached, "utf8") : undefined;
  if (text === undefined || (expected !== undefined && sha256(text) !== expected)) {
    // The commit, not the tag, so the file cannot change between requests.
    text = await (
      await fetchOk(`https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${path}`)
    ).text();
    await mkdir(new URL(".", cached), { recursive: true });
    await writeFile(cached, text);
  }
  if (expected !== undefined && sha256(text) !== expected)
    throw new Error(`${path} at ${tag} does not match its SHA-256 in specs/provenance.json`);
  return { path, sha256: sha256(text), text };
}

const license = await source("LICENSE");
if (!/GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/.test(license.text))
  throw new Error(`LICENSE at ${tag} is no longer GPL-3.0; review docs/DESIGN.md#technitium-text`);
const docs = await source("APIDOCS.md");
const webService = await source("DnsServerCore/DnsWebService.cs");
const classes = [
  ...new Set([...parseRoutes(webService.text).values()].map((r) => r.className)),
].sort();
const handlers = await Promise.all(classes.map((name) => source(`DnsServerCore/${name}.cs`)));

const { structure, report } = extract({
  docs: docs.text,
  webService: webService.text,
  handlers: Object.fromEntries(handlers.map((file, i) => [classes[i]!, file.text])),
});
// A rate-limit page or a rewritten document still parses as Markdown: check the result.
if (structure.operations.length < 100)
  throw new Error(
    `Only ${structure.operations.length} operations extracted from APIDOCS.md at ${tag}`,
  );

const payload = `${JSON.stringify(structure, null, 2)}\n`;
const provenance: Provenance = {
  repository: REPOSITORY,
  tag,
  commit,
  license: "GPL-3.0",
  files: [license, docs, webService, ...handlers].map(({ path, sha256 }) => ({ path, sha256 })),
  structure: {
    sha256: sha256(payload),
    operations: structure.operations.length,
    undocumentedRoutes: structure.undocumentedRoutes.length,
    repairedExamples: report.repairedExamples,
    untypedParameters: report.untypedParameters,
  },
};
await writeFile(new URL("api-structure.json", specs), payload);
await writeFile(new URL("provenance.json", specs), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(
  `Technitium ${tag} (${commit.slice(0, 12)}): ${structure.operations.length} operations, ` +
    `${structure.undocumentedRoutes.length} undocumented routes, ` +
    `${report.repairedExamples.length} repaired examples, ${report.untypedParameters} untyped parameters`,
);
