import { Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Technitium from "@distilled.cloud/technitium";

const program = Effect.gen(function* () {
  const { records = [] } = yield* Technitium.zones.getRecords({
    zone: "homelab.example.com",
    domain: "homelab.example.com",
    listZone: true,
  });
  for (const record of records) console.log(record.name, record.type, record.ttl);
});

const Live = Layer.mergeAll(
  FetchHttpClient.layer,
  Technitium.CredentialsFromEnv,
  Technitium.TechnitiumProtocol,
);

program.pipe(Effect.provide(Live), Effect.runPromise);
