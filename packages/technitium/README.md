# @distilled.cloud/technitium

Effect-native SDK for the [Technitium DNS Server](https://technitium.com/dns/) HTTP API, generated
from the structure of Technitium's API documentation (`APIDOCS.md`) and its server's request
handlers at release v15.5.0: 127 operations in 13 modules. It follows the conventions of
[distilled](https://github.com/alchemy-run/distilled). The
[Alchemy provider](../alchemy-technitium/README.md) builds on it.

## Installation

The package is not on npm. [Install a release](../../docs/RELEASING.md#install-a-release), or use
it from a clone of the repository (see [Try it](../../README.md#try-it)).

## Quick start

This program prints every record of a zone:

```ts
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
```

The program is `examples/list-records.ts`. Set the [variables](#auth) and run it from the
repository root:

```sh
node packages/technitium/examples/list-records.ts
```

Operations are grouped by the first path segment after `/api`: `zones`, `settings`, `admin`,
`dhcp`, `user`, `apps`, `allowed`, `blocked`, `cache`, `dashboard`, `dnsClient`, `logs` and
`status`. Their names come from the section headings of `APIDOCS.md`: `Add Record` becomes
`zones.addRecord`. Each operation's doc comment names its path and the permissions it needs, for
example `POST /api/zones/records/add. Permissions: Zone: Modify.`

## Auth

Required: `TECHNITIUM_API_TOKEN` and `TECHNITIUM_API_URL`. The token is sent as
`Authorization: Bearer <token>`, never as a query or form parameter.

`TECHNITIUM_API_URL` is the origin of the web service, such as `https://dns.example.com:53443`. It
must use HTTPS and have no path, query or credentials; plain HTTP is accepted only for
`127.0.0.1`, `localhost` and `[::1]`, for a local server or an SSH tunnel. Anything else fails
with `ConfigError`.

To pass the values in code, use
`Technitium.fromApiToken({ apiToken: Redacted.make(token), apiUrl })`.

Technitium creates non-expiring API tokens with `user.createApiToken` or, for another user, with
`admin.createApiToken`, and in the web console under Administration > Sessions. A token has the
permissions of its user, so create a user for each purpose and give it only the permissions it
needs.

### Private certificate authority

To trust a certificate from a private CA on Node, set `NODE_EXTRA_CA_CERTS` to the CA's PEM file,
or provide the HTTP client from `@effect/platform-node` with that CA instead of
`FetchHttpClient.layer`:

```ts
import { readFileSync } from "node:fs";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";

const Live = Layer.mergeAll(
  NodeHttpClient.layerNodeHttpOptions({
    ca: readFileSync("dns-root-ca.pem", "utf8"),
    rejectUnauthorized: true,
  }),
  Technitium.CredentialsFromEnv,
  Technitium.TechnitiumProtocol,
);
```

## Requests and responses

Every call is a `POST` with a form-encoded body, so parameters such as passwords stay out of URLs
and access logs. Booleans are sent as `true` and `false`, numbers as decimal strings. Parameter
types come from the server's handlers: a parameter that the server parses as a number or a
boolean has that type, and enum values come from the documentation.

Response types come from the documentation's example responses. Their members are optional unless
a [patch](#develop-and-regenerate) marks them required after checking the server source, as for
the records and zone summaries of `zones.getRecords`, `zones.addRecord` and `zones.updateRecord`.
Responses are not validated by default. To check them, provide distilled's
`ResponseValidation.strict` or `ResponseValidation.additionalProperties` layer from
`@distilled.cloud/core`; a mismatch then fails with `TechnitiumParseError`.

Passwords, tokens, TSIG and SSO secrets, private keys and the 2FA secret are sensitive: inputs
accept strings or `Redacted` values, and outputs are `Redacted`.

## Errors

Technitium answers HTTP 200 for failed calls and reports the outcome in the `status` member:

| Technitium response                     | Error                                      |
| --------------------------------------- | ------------------------------------------ |
| `status: "error"`                       | `TechnitiumError`                          |
| `status: "error"`, `Access was denied.` | `Forbidden`                                |
| `status: "invalid-token"`               | `Unauthorized`                             |
| `status: "2fa-required"`                | `TwoFactorAuthRequired`                    |
| Not JSON, or an unknown `status`        | `UnknownTechnitiumError`                   |
| HTTP 4xx or 5xx (from a proxy)          | Core's status errors, such as `BadGateway` |

`TechnitiumError.message` is Technitium's error message. HTTP client errors keep only the method
and URL of the failed request: the `Authorization` header and the form body are removed, so
neither the token nor a password can reach a log.

## Limits

- 12 documented calls transfer files and are not generated: `zones/import`, `zones/export`,
  `allowed/export`, `blocked/export`, `apps/install`, `apps/update`, `settings/backup`,
  `settings/restore`, `dashboard/metrics/text`, `admin/cluster/primary/transferConfig`,
  `logs/download` and `logs/export`. `zones.createZone` is generated without its optional zone
  file upload.
- 6 routes of the server are not documented and not generated: `admin/ldap/get`,
  `admin/ldap/set`, `admin/ldap/test`, `sso/status` (an old name of `status`),
  `zones/dnssec/properties/generatePrivateKey` (an old name of `addPrivateKey`) and
  `zones/dnssec/properties/activateKskDnsKey`.
- Operations are not retried, because replaying a write could apply it twice.
- Only the operations of the Alchemy provider (`zones.getRecords`, `addRecord`, `updateRecord` and
  `deleteRecord`) are tested against a server. Their responses pass strict validation on
  Technitium 15.5.0, 15.5.1 and 15.6.2.

## Develop and regenerate

Requires Node 24 and pnpm 12.15.0. Run these commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm specs:fetch   # download the pinned release's docs and handlers, extract the structure
pnpm generate      # regenerate src/services and check for Technitium text
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

The pipeline:

1. `scripts/fetch-specs.ts` downloads `APIDOCS.md`, `LICENSE`, the route table
   (`DnsServerCore/DnsWebService.cs`) and the request handlers (`DnsServerCore/WebService*.cs`) at
   the pinned commit, checks them against the SHA-256 values in `specs/provenance.json` and keeps
   them in the ignored `specs/.cache/`.
2. `scripts/extract.ts` reduces them to `specs/api-structure.json`: paths, parameter names, types
   and enum values, and the shapes of the example responses. Example values and all text are
   dropped. Every documented path must exist in the route table.
3. `scripts/convert.ts` turns the structure into one Smithy model per module and applies the
   patches in `patches/<module>/`.
4. `scripts/generate.ts` compiles the models with distilled's code generator from
   `@distilled.cloud/core` 1.0.0-rc.17.

`specs/api-structure.json`, `specs/provenance.json` and the generated code are committed, so
installing and the checks work without downloading anything, and so does
`pnpm --filter @distilled.cloud/technitium generate`. `convert` refuses a structure whose SHA-256
differs from `provenance.json`. The root `pnpm generate` ends with `pnpm check:prose`, which needs
the downloaded documentation: it fails if a sentence of it appears in a committed file. Never edit files in `src/services/` by
hand: correct the model with a patch, and record the evidence in its `description`.

To move to another release, run `pnpm specs:fetch v15.6.2`, then `pnpm generate`, and review the
diff of `specs/api-structure.json`. [docs/DESIGN.md](../../docs/DESIGN.md#the-client) explains the
pipeline and its explicit adapters.
