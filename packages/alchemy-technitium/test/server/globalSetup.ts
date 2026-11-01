// Starts a throwaway Technitium DNS Server in a Podman container on this machine, on a network of
// its own. Its configuration lives in memory, its web service listens on a random loopback port,
// and the container, its files and the network are removed when the run ends. Nothing here can
// reach a real server.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { ZONES, SCOPED_USER } from "./context.ts";

/** technitium/dns-server:15.5.0, pinned by digest (multi-architecture index). */
const IMAGE =
  process.env.TECHNITIUM_TEST_IMAGE ??
  "docker.io/technitium/dns-server@sha256:2502fd4993d18a8c6665ce6eefb20c76ca21918c5435a015d9485b36e8275b5e";
const NAME = `alchemy-technitium-test-${process.pid}`;
/** One network per run, so a test can add a second server that the first one reaches. */
const NETWORK = NAME;
const FILES = join(import.meta.dirname, "../../../../.local/test-server");

const podman = (...args: string[]) =>
  execFileSync("podman", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const secret = () => randomBytes(24).toString("hex");

async function until<A>(what: string, attempt: () => Promise<A | undefined>, seconds = 90) {
  for (let i = 0; i < seconds * 2; i++) {
    const result = await attempt().catch(() => undefined);
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Test server: timed out waiting for ${what}`);
}

/** Calls the API and returns the token that some calls answer with. */
export async function call(
  url: string,
  path: string,
  params: Record<string, string>,
  token?: string,
) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: new URLSearchParams(params),
  });
  const body = (await response.json()) as {
    status: string;
    errorMessage?: string;
    token?: string;
    response?: { token?: string };
  };
  if (body.status !== "ok")
    throw new Error(`Test server: ${path} -> ${body.status} ${body.errorMessage ?? ""}`);
  // A few calls answer without the `response` member.
  return { token: body.response?.token ?? body.token };
}

export interface TestServer {
  readonly url: string;
  readonly adminToken: string;
  /** The server's address on the run's network. */
  readonly address: string;
  /** Removes the container and its files. */
  readonly stop: () => void;
}

/**
 * Starts a throwaway server named `name` on the run's network and logs in as admin. Its
 * configuration lives in memory and its web service listens on a random loopback port.
 */
export async function startServer(name: string, network = NETWORK): Promise<TestServer> {
  const dir = join(FILES, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The admin password reaches the container as a file, never through argv or the environment.
  const passwordFile = join(dir, "admin-password");
  const adminPassword = secret();
  writeFileSync(passwordFile, adminPassword, { mode: 0o600 });
  // Readable by the container's user; the directory itself stays private.
  chmodSync(passwordFile, 0o644);
  const stop = () => {
    try {
      podman("rm", "--force", "--time", "0", name);
    } finally {
      // Only this server's folder: Podman's file sharing can still see a removed parent folder
      // for a moment, and the next run would then fail to mount its password file.
      rmSync(dir, { recursive: true, force: true });
    }
  };
  try {
    podman(
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      network,
      "--publish",
      "127.0.0.1::5380",
      "--volume",
      `${passwordFile}:/run/secrets/admin-password:ro`,
      "--env",
      "DNS_SERVER_ADMIN_PASSWORD_FILE=/run/secrets/admin-password",
      "--env",
      "DNS_SERVER_DOMAIN=test-dns.invalid",
      "--tmpfs",
      "/etc/dns",
      IMAGE,
    );
    const port = podman("port", name, "5380/tcp").split(":").at(-1);
    const url = `http://127.0.0.1:${port}`;
    const address = podman(
      "inspect",
      "--format",
      `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
      name,
    );
    await until("the web service", async () =>
      (await fetch(`${url}/api/status`)).ok ? true : undefined,
    );
    const { token: adminToken } = await until("the admin login", () =>
      call(url, "/api/user/createToken", {
        user: "admin",
        pass: adminPassword,
        tokenName: "tests",
      }),
    );
    if (!adminToken) throw new Error("Test server: no admin token");
    return { url, adminToken, address, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

export default async function setup(project: TestProject) {
  try {
    podman("--version");
  } catch {
    throw new Error("The server tests need Podman (https://podman.io) on this machine.");
  }
  podman("network", "create", NETWORK);
  const removeNetwork = () => podman("network", "rm", "--force", NETWORK);
  let server: TestServer;
  try {
    server = await startServer(NAME);
  } catch (error) {
    removeNetwork();
    throw error;
  }
  const stop = () => {
    try {
      server.stop();
    } finally {
      removeNetwork();
    }
  };
  try {
    const { url, adminToken } = server;
    const admin = (path: string, params: Record<string, string> = {}) =>
      call(url, path, params, adminToken);

    for (const zone of ZONES.primary) await admin("/api/zones/create", { zone, type: "Primary" });
    await admin("/api/zones/create", { zone: ZONES.reverse, type: "Primary" });
    await admin("/api/zones/create", {
      zone: ZONES.forwarder,
      type: "Forwarder",
      initializeForwarder: "true",
      forwarder: "this-server",
    });

    // The provider's tests use a token with permissions on the managed zones and View on the
    // reverse zone, as a real deployment should. Some tests change them for a single case.
    await admin("/api/admin/users/create", { user: SCOPED_USER, pass: secret() });
    for (const zone of [...ZONES.primary, ZONES.forwarder])
      await admin("/api/zones/permissions/set", {
        zone,
        userPermissions: `${SCOPED_USER}|true|true|true`,
        groupPermissions: "Administrators|true|true|true|DNS Administrators|true|true|true",
      });
    // View only on the reverse zone, so the provider can check for PTR records before it deletes.
    await admin("/api/zones/permissions/set", {
      zone: ZONES.reverse,
      userPermissions: `${SCOPED_USER}|true|false|false`,
      groupPermissions: "Administrators|true|true|true|DNS Administrators|true|true|true",
    });
    const { token: scopedToken } = await admin("/api/admin/sessions/createToken", {
      user: SCOPED_USER,
      tokenName: "alchemy",
    });
    if (!scopedToken) throw new Error("Test server: no scoped token");

    project.provide("technitium", { url, adminToken, scopedToken, network: NETWORK });
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
