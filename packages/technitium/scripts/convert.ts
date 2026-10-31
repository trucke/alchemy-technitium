/**
 * convert: specs/api-structure.json -> Smithy JSON models in .generated-specs, one model per
 * API area (the first path segment after /api: `zones`, `settings`, `admin`, ...), then
 * distilled's finalize step, which applies patches/<area>/*.patch.json.
 *
 * Every call is a POST with a form-encoded body: Technitium reads each parameter from the
 * query string or the form, and the form keeps values such as passwords out of URLs and
 * access logs. Responses are JSON objects; the protocol unwraps the envelope.
 *
 * Calls that upload or download files are not generated (see {@link convert}).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { finalizeConvert } from "@distilled.cloud/core/codegen/patches";
import type { ApiStructure, Operation, Parameter, Shape } from "./extract.ts";

export interface Member {
  readonly target: string;
  readonly traits?: Record<string, unknown>;
}
export interface SmithyShape {
  readonly type: string;
  readonly traits?: Record<string, unknown>;
  readonly members?: Record<string, Member>;
  readonly member?: Member;
  readonly key?: Member;
  readonly value?: Member;
  readonly input?: Member;
  readonly output?: Member;
  readonly version?: string;
  readonly operations?: Member[];
}
export interface Model {
  readonly smithy: "2.0";
  readonly metadata: Record<string, unknown>;
  readonly shapes: Record<string, SmithyShape>;
}

/**
 * Members that carry secrets, in requests and responses: passwords, one-time codes, API and
 * session tokens, TSIG and SSO secrets, private keys and the 2FA secret with its QR code. The
 * SDK returns them as `Redacted` values and accepts strings or `Redacted` values.
 */
export const SENSITIVE: ReadonlySet<string> = new Set([
  "pass",
  "newPass",
  "totp",
  "primaryNodePassword",
  "primaryNodeTotp",
  "proxyPassword",
  "dnsTlsCertificatePassword",
  "webServiceTlsCertificatePassword",
  "ssoClientSecret",
  "tsigKeys",
  "sharedSecret",
  "token",
  "secret",
  "qrCodePngImage",
  "pemPrivateKey",
  "pemKskPrivateKey",
  "pemZskPrivateKey",
]);
export const SENSITIVE_TRAIT = "smithy.api#sensitive";
/** Marks a sensitive response member, which the protocol always returns as `Redacted`. */
export const REDACTED_OUTPUT_TRAIT = "technitium.api#redactedOutput";

const pascal = (text: string) =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join("");
/** `Get DS Info` -> `GetDsInfo`, `Get Metrics (JSON)` -> `GetMetricsJson`. */
export const operationName = (title: string) => pascal(title);
/** Member names keep their case: `rData` -> `RData`, `ANCOUNT` -> `ANCOUNT`. */
const memberSuffix = (name: string) => name[0]!.toUpperCase() + name.slice(1);
/** `/api/zones/records/add` -> `zones`. */
export const areaOf = (path: string) => {
  const area = path.split("/")[2];
  if (area === undefined || !/^[a-zA-Z]+$/.test(area)) throw new Error(`Unexpected path ${path}`);
  return area;
};

const PRELUDE = {
  string: "smithy.api#String",
  integer: "smithy.api#Integer",
  number: "smithy.api#Double",
  boolean: "smithy.api#Boolean",
  unknown: "smithy.api#Document",
} as const;

/** Why an operation is not generated, or `undefined` when it is. */
export const unsupported = (operation: Operation): string | undefined =>
  operation.request === "upload"
    ? "uploads a file"
    : operation.response.kind === "file"
      ? `downloads a file (${operation.response.contentType})`
      : undefined;

export function convert(structure: ApiStructure, source: string) {
  const models: Record<string, Model> = {};
  const skipped: { path: string; reason: string }[] = [];
  for (const operation of structure.operations) {
    const reason = unsupported(operation);
    if (reason !== undefined) {
      skipped.push({ path: operation.path, reason });
      continue;
    }
    if (operation.response.kind !== "json") continue;
    const area = areaOf(operation.path);
    const ns = `technitium.${area}#`;
    const model = (models[area] ??= { smithy: "2.0", metadata: { source }, shapes: {} });
    const shapes = model.shapes;
    const name = operationName(operation.title);
    if (shapes[ns + name]) throw new Error(`Two operations named ${name} in ${area}`);

    const define = (local: string, shape: SmithyShape) => {
      if (shapes[ns + local]) throw new Error(`Shape ${ns + local} defined twice`);
      shapes[ns + local] = shape;
      return ns + local;
    };
    const parameterTarget = (parameter: Parameter) =>
      parameter.enum
        ? define(`${name}Request${memberSuffix(parameter.name)}`, {
            type: "enum",
            members: Object.fromEntries(
              parameter.enum.map((value, i) => [
                `Value${i}`,
                { target: "smithy.api#Unit", traits: { "smithy.api#enumValue": value } },
              ]),
            ),
          })
        : PRELUDE[parameter.type];
    const shapeTarget = (shape: Shape, local: string, sensitive: boolean): string => {
      switch (shape.type) {
        case "object":
          return define(local, {
            type: "structure",
            members: Object.fromEntries(
              Object.entries(shape.properties).map(([key, member]) => [
                key,
                responseMember(key, member, local + memberSuffix(key)),
              ]),
            ),
          });
        case "array":
          return define(local, {
            type: "list",
            member: { target: shapeTarget(shape.items, `${local}Item`, sensitive) },
          });
        case "map":
          return define(local, {
            type: "map",
            key: { target: PRELUDE.string },
            value: { target: shapeTarget(shape.values, `${local}Value`, sensitive) },
          });
        default:
          // A secret documented with a `null` example is still a string.
          return sensitive && shape.type === "unknown" ? PRELUDE.string : PRELUDE[shape.type];
      }
    };
    const responseMember = (key: string, shape: Shape, local: string): Member => {
      const sensitive = SENSITIVE.has(key);
      return {
        target: shapeTarget(shape, local, sensitive),
        ...(sensitive ? { traits: { [SENSITIVE_TRAIT]: {}, [REDACTED_OUTPUT_TRAIT]: {} } } : {}),
      };
    };

    const input = define(`${name}Request`, {
      type: "structure",
      members: Object.fromEntries(
        operation.parameters.map((parameter) => {
          const traits: Record<string, unknown> = {};
          if (parameter.required) traits["smithy.api#required"] = {};
          if (SENSITIVE.has(parameter.name)) traits[SENSITIVE_TRAIT] = {};
          return [
            parameter.name,
            {
              target: parameterTarget(parameter),
              ...(Object.keys(traits).length ? { traits } : {}),
            },
          ];
        }),
      ),
    });
    if (operation.response.shape.type !== "object")
      throw new Error(`${operation.path}: the response payload is not an object`);
    const output = shapeTarget(operation.response.shape, `${name}Response`, false);
    const permissions = operation.permissions.filter((p) => !p.endsWith(": None"));
    define(name, {
      type: "operation",
      input: { target: input },
      output: { target: output },
      traits: {
        "smithy.api#http": { method: "POST", uri: operation.path, code: 200 },
        // Our own structural summary instead of Technitium's description.
        "smithy.api#documentation":
          `POST ${operation.path}` +
          (permissions.length ? `. Permissions: ${permissions.join(", ")}.` : ""),
      },
    });
    const service = (shapes[`${ns}Service`] ??= {
      type: "service",
      version: source,
      operations: [],
    });
    service.operations!.push({ target: ns + name });
  }
  return { models, skipped };
}

/**
 * Reads the structure written by `pnpm specs:fetch` and checks it against the SHA-256 in
 * provenance.json, so a hand-edited structure fails instead of generating.
 */
export async function readStructure(
  root: URL,
): Promise<{ structure: ApiStructure; source: string }> {
  const text = await readFile(new URL("specs/api-structure.json", root), "utf8");
  const provenance: { tag: string; structure: { sha256: string } } = JSON.parse(
    await readFile(new URL("specs/provenance.json", root), "utf8"),
  );
  if (createHash("sha256").update(text).digest("hex") !== provenance.structure.sha256)
    throw new Error(
      "specs/api-structure.json does not match provenance.json; run pnpm specs:fetch",
    );
  return { structure: JSON.parse(text), source: `Technitium DNS Server ${provenance.tag}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = new URL("../", import.meta.url);
  const { structure, source } = await readStructure(root);
  const { models, skipped } = convert(structure, source);
  const output = new URL(".generated-specs/", root);
  await mkdir(output, { recursive: true });
  for (const file of await readdir(output))
    if (file.endsWith(".json")) await rm(new URL(file, output));
  for (const [area, model] of Object.entries(models))
    await writeFile(new URL(`${area}.json`, output), `${JSON.stringify(model, null, 2)}\n`);
  const count = Object.values(models).reduce(
    (sum, model) => sum + Object.values(model.shapes).filter((s) => s.type === "operation").length,
    0,
  );
  console.log(
    `Converted ${count} of ${structure.operations.length} operations into ${Object.keys(models).length} models; ` +
      `not generated: ${skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`,
  );
  // Operation names come from the section headings and are already verb-first.
  await finalizeConvert({ root: root.pathname, operationNaming: "as-is" });
}
