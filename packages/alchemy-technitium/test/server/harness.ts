// Drives the real Alchemy plan and apply against the throwaway test server, with in-memory state.
import * as ResponseValidation from "@distilled.cloud/core/response-validation";
import { fromApiToken } from "@distilled.cloud/technitium/credentials";
import * as Drift from "alchemy/Drift";
import * as Provider from "alchemy/Provider";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as State from "alchemy/State";
import * as Core from "alchemy/Test/Core";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { expect, inject } from "vitest";
import * as Technitium from "../../src/index.ts";
import "./context.ts";

/** Direct API calls with the admin token, standing in for someone using the web console. */
export async function webConsole<A = Record<string, unknown>>(
  path: string,
  params: Record<string, string | number | boolean> = {},
): Promise<A> {
  const { url, adminToken } = inject("technitium");
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });
  const body = (await response.json()) as { status: string; errorMessage?: string; response?: A };
  if (body.status !== "ok") throw new Error(`${path}: ${body.status} ${body.errorMessage ?? ""}`);
  return body.response as A;
}

export interface ConsoleRecord {
  readonly type: string;
  readonly value: string;
  readonly ttl: number;
  readonly disabled: boolean;
  readonly comments: string | undefined;
}

/** Every record at a name, as the web console shows it, sorted by type and value. */
export async function recordsAt(zone: string, name: string): Promise<ConsoleRecord[]> {
  const { records } = await webConsole<{
    records: {
      name: string;
      type: string;
      ttl: number;
      disabled: boolean;
      comments?: string;
      rData: { ipAddress?: string; cname?: string; ptrName?: string };
    }[];
  }>("/api/zones/records/get", { zone, domain: name });
  return records
    .filter((record) => record.name.toLowerCase() === name)
    .map((record) => ({
      type: record.type,
      value: record.rData.ipAddress ?? record.rData.cname ?? record.rData.ptrName ?? "",
      ttl: record.ttl,
      disabled: record.disabled,
      comments: record.comments,
    }))
    .sort((x, y) => `${x.type} ${x.value}`.localeCompare(`${y.type} ${y.value}`));
}

/** Removes every record the tests may have left at the names they use. */
export async function clearZone(zone: string) {
  const { records } = await webConsole<{
    records: { name: string; type: string; rData: { ipAddress?: string } }[];
  }>("/api/zones/records/get", { zone, domain: zone, listZone: true });
  for (const record of records)
    if (
      record.type === "A" ||
      record.type === "AAAA" ||
      record.type === "CNAME" ||
      record.type === "PTR"
    )
      await webConsole("/api/zones/records/delete", {
        zone,
        domain: record.name,
        type: record.type,
        ...(record.rData.ipAddress ? { ipAddress: record.rData.ipAddress } : {}),
        ...("ptrName" in record.rData ? { ptrName: String(record.rData.ptrName) } : {}),
      });
}

/**
 * Matches a comment that ends with the marker of a resource of the harness stack. The marker's
 * instance part is random, so only its form is checked.
 */
export const marked = (fqn: string, comment = "", stack = "technitium") =>
  expect.stringMatching(
    new RegExp(`^${comment ? `${comment} ` : ""}\\[alchemy:${stack}/test/${fqn}#[0-9a-f]{8}\\]$`),
  );

/** The stored comment of the only record of a type at a name, to resend it as the web console does. */
export async function commentsOf(zone: string, name: string, type: string) {
  const record = (await recordsAt(zone, name)).find((r) => r.type === type);
  if (record?.comments === undefined)
    throw new Error(`no ${type} record with a comment at ${name}`);
  return record.comments;
}

/**
 * The Record provider with the scoped token, strict response validation and an HTTP client that
 * records every write as `<operation> <name>`, so tests can prove that a deploy wrote nothing.
 */
function recordingProviders(writes: string[]) {
  const { url, scopedToken } = inject("technitium");
  const recordingHttp = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return HttpClient.tapRequest(client, (request) =>
        Effect.sync(() => {
          const operation = /\/api\/zones\/records\/(add|update|delete)$/.exec(
            new URL(request.url).pathname,
          )?.[1];
          if (operation === undefined) return;
          const body =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
          writes.push(`${operation} ${new URLSearchParams(body).get("domain")}`);
        }),
      );
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
  return Layer.effect(Technitium.Providers, Provider.collection([Technitium.Record])).pipe(
    Layer.provide(Technitium.RecordProvider()),
    Layer.provideMerge(fromApiToken({ apiToken: Redacted.make(scopedToken), apiUrl: url })),
    Layer.provideMerge(recordingHttp),
    // Every response the provider reads must match the generated (and patched) model exactly.
    Layer.provideMerge(ResponseValidation.strict),
  );
}

/** The package's own `providers()`, logged in through `TECHNITIUM_API_TOKEN` and `TECHNITIUM_API_URL`. */
function loginProviders() {
  const { url, scopedToken } = inject("technitium");
  return Technitium.providers().pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: { TECHNITIUM_API_URL: url, TECHNITIUM_API_TOKEN: scopedToken },
        }),
      ),
    ),
  );
}

export function harness({ login = false, stack = "technitium" } = {}) {
  const writes: string[] = [];
  const providers = login ? loginProviders() : recordingProviders(writes);
  let stateLayer = Layer.succeed(State.State, State.InMemoryService({}));
  const options = () => ({ providers, state: stateLayer, stage: "test" });
  const scratch = () => Core.scratchStack(options(), stack);
  let current = scratch();
  const run = <A>(effect: Core.TestEffect<A>, adopt: boolean) =>
    Effect.runPromiseExit(Core.toEffect(effect, { ...options(), adopt }));
  const succeed = async <A>(effect: Core.TestEffect<A>, adopt = false) => {
    const exit = await run(effect, adopt);
    if (Exit.isFailure(exit)) throw new Error(`Expected success, got ${String(exit.cause)}`);
    return exit.value;
  };
  const failure = async <A>(effect: Core.TestEffect<A>, adopt = false) => {
    const exit = await run(effect, adopt);
    if (Exit.isSuccess(exit)) throw new Error("Expected a failure");
    return String(exit.cause);
  };
  /** Stack, stage and providers for operations outside a deploy, such as drift. */
  const stackServices = () =>
    current.state.pipe(
      Layer.provideMerge(providers),
      Layer.provideMerge(
        Layer.succeed(Stack, {
          name: current.name,
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        }),
      ),
      Layer.provideMerge(Layer.succeed(Stage, "test")),
    );
  return {
    writes,
    deploy: <A, E>(
      program: Effect.Effect<A, E, Technitium.Providers>,
      adopt = false,
      force = false,
    ) => succeed(current.deploy(program, { force }), adopt),
    deployFailure: <A, E>(program: Effect.Effect<A, E, Technitium.Providers>, adopt = false) =>
      failure(current.deploy(program), adopt),
    plan: <A, E>(program: Effect.Effect<A, E, Technitium.Providers>, adopt = false) =>
      succeed(current.plan(program), adopt),
    planFailure: <A, E>(program: Effect.Effect<A, E, Technitium.Providers>, adopt = false) =>
      failure(current.plan(program), adopt),
    destroy: () => succeed(current.destroy()),
    destroyFailure: () => failure(current.destroy()),
    /** Drift detection (`alchemy drift --dry-run`) and repair (`alchemy drift`). */
    drift: (repair = false) =>
      succeed(
        (repair ? Drift.repair : Drift.detect)({ name: current.name, stage: "test" }).pipe(
          Effect.provide(stackServices()),
        ),
      ),
    /** Forgets all state, as if `.alchemy/` had been deleted. */
    loseState: () => {
      stateLayer = Layer.succeed(State.State, State.InMemoryService({}));
      current = scratch();
    },
    /** The attributes Alchemy persisted, by logical ID. */
    attributes: () =>
      succeed(
        Effect.gen(function* () {
          const state = yield* yield* State.State;
          const fqns = yield* state.list({ stack: current.name, stage: current.stage });
          const rows = yield* Effect.forEach(fqns, (fqn) =>
            state.get({ stack: current.name, stage: current.stage, fqn }),
          );
          return Object.fromEntries(
            rows.flatMap((row) =>
              row === undefined || !("attr" in row) ? [] : [[row.logicalId, row.attr]],
            ),
          );
        }).pipe(Effect.provide(current.state)),
      ),
  };
}
