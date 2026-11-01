/**
 * generate: the Smithy models from scripts/convert.ts -> src/services/<area>.ts. Run it through
 * `pnpm generate`, which converts first and formats and checks for Technitium text afterwards.
 */
import { runGeneratorCli } from "@distilled.cloud/core/codegen/cli";
import type { SdkSpec } from "@distilled.cloud/core/codegen/generator";
import { REDACTED_OUTPUT_TRAIT, SENSITIVE_TRAIT } from "./convert.ts";

const spec: SdkSpec = {
  sourceNote: "specs/api-structure.json",
  // Set by patches where Technitium writes an explicit null.
  nullableTrait: "technitium.api#nullable",
  // Record data members whose type depends on the record type, such as `flags` (see
  // patches/zones/record-data.patch.json), are unions of primitives.
  unionStyle: "primitive",
  // Secrets arrive as Redacted values; inputs accept a string or a Redacted value.
  memberTraitPipes: { [SENSITIVE_TRAIT]: "T.SensitiveValue" },
  memberTsType: (member) =>
    REDACTED_OUTPUT_TRAIT in member.traits
      ? "Redacted.Redacted<string>"
      : SENSITIVE_TRAIT in member.traits
        ? "string | Redacted.Redacted<string>"
        : undefined,
  // Every call is a POST with a form-encoded body (see scripts/convert.ts).
  structPipes: ({ httpTrait }) =>
    typeof httpTrait === "object" && httpTrait !== null
      ? [`T.Http(${JSON.stringify({ ...httpTrait, contentType: "form-urlencoded" })})`]
      : [],
  operationDecl: {
    contextType: "TechnitiumOpContext",
    commonErrorType: "TechnitiumOpError",
    commonErrorClasses: ["UnknownTechnitiumError"],
    protocol: "TechnitiumProtocol",
    // No retry policy: replaying a write could apply it twice.
  },
  postProcess: (code) =>
    code.includes("Redacted.Redacted<")
      ? code.replace(
          `import * as S from "@distilled.cloud/core/schema-lite";\n`,
          `import * as S from "@distilled.cloud/core/schema-lite";\nimport type * as Redacted from "effect/Redacted";\n`,
        )
      : code,
};

runGeneratorCli({
  description: "Generate the Technitium DNS Server Effect SDK from the Smithy models",
  root: `${import.meta.dirname}/..`,
  // scripts/convert.ts already applied the patches.
  patchesDir: false,
  spec: () => spec,
});
