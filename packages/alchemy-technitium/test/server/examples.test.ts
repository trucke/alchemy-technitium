// Runs the documented examples as a reader would: the SDK program with Node and the stack with
// the Alchemy CLI, both logged in through environment variables with the scoped token.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from "vitest";
import { clearZone, recordsAt, webConsole } from "./harness.ts";

const ZONE = "homelab.example.com";
const PACKAGES = join(import.meta.dirname, "../../..");
/** Created before the first test, so a run that skips every test here leaves nothing behind. */
let scratch = "";

/** Runs a command with the test server's login and returns its exit code and output. */
function run(command: string, args: string[]) {
  const { url, scopedToken } = inject("technitium");
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      // State and any `.env` lookup stay in a scratch directory.
      cwd: scratch,
      env: {
        ...process.env,
        CI: "true",
        TECHNITIUM_API_URL: url,
        TECHNITIUM_API_TOKEN: scopedToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (output.includes(scopedToken)) reject(new Error("The token appeared in the output"));
      resolve({ code: code ?? 1, output });
    });
  });
}

const alchemy = (command: "deploy" | "plan" | "destroy") =>
  run(join(PACKAGES, "alchemy-technitium/node_modules/.bin/alchemy"), [
    command,
    join(PACKAGES, "alchemy-technitium/examples/homelab.ts"),
    "--stage",
    "example",
    "--no-input",
    ...(command === "plan" ? [] : ["--yes"]),
  ]);

beforeAll(() => {
  scratch = mkdtempSync(join(PACKAGES, "../.local/examples-"));
});
beforeEach(() => clearZone(ZONE));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("examples", () => {
  it("runs the SDK example", async () => {
    await webConsole("/api/zones/records/add", {
      zone: ZONE,
      domain: `printer.${ZONE}`,
      type: "A",
      ipAddress: "192.0.2.30",
      ttl: 600,
    });
    const { code, output } = await run(process.execPath, [
      join(PACKAGES, "technitium/examples/list-records.ts"),
    ]);
    expect(code, output).toBe(0);
    expect(output).toContain(`printer.${ZONE} A 600`);
  });

  it("deploys the stack example with the Alchemy CLI", async () => {
    const deployed = await alchemy("deploy");
    expect(deployed.code, deployed.output).toBe(0);
    expect(await recordsAt(ZONE, `nas.${ZONE}`)).toEqual([
      {
        type: "A",
        value: "192.0.2.20",
        ttl: 300,
        disabled: false,
        comments: "NAS [alchemy:Homelab/example/nas]",
      },
    ]);
    expect(await recordsAt(ZONE, `files.${ZONE}`)).toMatchObject([
      { type: "CNAME", value: `nas.${ZONE}` },
    ]);

    const planned = await alchemy("plan");
    expect(planned.code, planned.output).toBe(0);
    expect(planned.output).toContain("Plan: no changes");

    // Both records use the default removal policy, retain: destroy forgets them.
    const destroyed = await alchemy("destroy");
    expect(destroyed.code, destroyed.output).toBe(0);
    expect(await recordsAt(ZONE, `nas.${ZONE}`)).toHaveLength(1);
  });
});
