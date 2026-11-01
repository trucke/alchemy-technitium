# Design

This document explains how the client and the provider are built and why. The package READMEs
describe how to use them: [`@distilled.cloud/technitium`](../packages/technitium/README.md) and
[`@alchemy.run/technitium`](../packages/alchemy-technitium/README.md).

The repository follows the layout of `trucke/alchemy-proxmox` and `trucke/alchemy-netbird`: a
client in the style of [distilled](https://github.com/alchemy-run/distilled), the generated SDKs
that Alchemy's providers build on, and an Alchemy provider that calls only that client.

## Toolchain and packaging

Node 24, TypeScript 7, Effect 4.0.5, vitest and pnpm 12.15.0. Dependencies are pinned exactly:
`@distilled.cloud/core` 1.0.0-rc.17 for the runtime and the code generator, and `alchemy`
2.0.0-beta.84, the versions the infrastructure repository uses with the Proxmox and NetBird
providers.

Inside the repository, both packages export their TypeScript sources. Each package's `prepack`
compiles them into `lib/`, and `publishConfig.exports` points the packed package there. pnpm
refuses tarball sources in dependencies of dependencies, so the provider declares the client,
`alchemy` and `effect` as peer dependencies, and a project lists both tarballs. One copy of
Alchemy and Effect in a project keeps the service keys of the provider and the stack identical.

## The client

### Source of truth

Technitium publishes no OpenAPI or other machine-readable description of its HTTP API. Two
sources describe it, both in the `TechnitiumSoftware/DnsServer` repository:

- **`APIDOCS.md`** documents every call in a Markdown section: a URL, the required permissions, a
  `WHERE:` list of parameters marked `(optional)` where they are, enum values as
  ``Valid values are [`A`, `B`]`` and an example response. It gives no parameter types.
- **The server source** maps each path to a handler in `DnsServerCore/DnsWebService.cs`, and each
  handler in `DnsServerCore/WebService*.cs` parses its parameters:
  `request.GetQueryOrForm("ttl", ZoneFile.ParseTtl, defaultTtl)` or
  `request.GetQueryOrForm("overwrite", bool.Parse, false)`.

The client uses both: the documentation decides which calls and parameters exist, whether a
parameter is optional and what a response looks like; the handlers decide each parameter's type.
Typing from the documentation's prose would be guesswork. `svcParams`, for example, is a string
that accepts `false` to clear it.

The pinned source is release v15.5.0 (commit `68ef950e4d2999f3dc19d75e4e32383633adf3e5`), the
release on the DNS servers this provider is meant for. `APIDOCS.md` is identical in v15.5.1; in
v15.6.2 it differs only in settings and cluster members. `specs/provenance.json` records the
SHA-256 of every downloaded file and of the extracted structure.

**Coverage.** The documentation has 139 sections, one per path, and every documented path exists
in the route table. 127 calls are generated. 12 calls upload or download files (zone files, app
and backup archives, logs and Prometheus metrics) and are not generated, as in the Proxmox
client: the protocol reads JSON envelopes only. 6 routes in the route table are not documented
and not generated; two of them are old names of documented calls.

### Extraction

`scripts/extract.ts` turns the documentation and the handlers into `specs/api-structure.json`.
Its rules are general, and every exception is an explicit adapter that is checked against the
inputs, so a changed document fails instead of being read differently:

- **Sections.** The parser reads the URL, the permissions, the first `WHERE:` list and the
  response part of each `###` section. A `WHERE:` list after the response describes response
  members and is ignored.
- **Parameters.** `token` is dropped, because the client sends the token in a header only.
  Obsolete parameters are dropped. A parameter's type is `boolean` or `integer` when its handler,
  or a helper the handler passes the request to, parses it that way; anything else, including
  the `node` parameter that the cluster middleware reads, is a string.
- **Responses.** Example values are dropped; only member names and value types remain. Array items
  merge into one shape. An object whose keys are data, such as zone names, becomes a map. Four
  examples in v15.5.0 are not valid JSON (three trailing commas, one missing comma) and are
  repaired.
- **Adapters.** `SAME_RESPONSE` maps `settings/set` and `settings/restore` to the response of
  `settings/get`, which their sections reference in prose. `UPLOADS` lists the four calls that
  require a file body, and `OPTIONAL_UPLOADS` lists `zones/create`, whose zone file is optional.

The structure is committed. It holds no sentence of the documentation and no example value; see
[Technitium text](#technitium-text).

### Conversion and generation

`scripts/convert.ts` turns the structure into one Smithy model per module (the first path segment
after `/api`) and applies the patches. `scripts/generate.ts` compiles the models with distilled's
generator from `@distilled.cloud/core` 1.0.0-rc.17, the same way the Proxmox and NetBird clients
are generated. Generated files are never edited by hand.

- Every call is a `POST` with a form-encoded body (`T.Http({ contentType: "form-urlencoded" })`).
  Technitium reads each parameter from the query string or the form; the form keeps passwords and
  other values out of URLs and access logs.
- Operation names come from the section headings (`Get Records` becomes `getRecords`). Doc
  comments name the path and the permissions, not Technitium's description.
- Response members are optional, because an example does not show which members the server always
  writes. Patches mark members required where the source shows they always are.
- Members named like secrets (`pass`, `newPass`, `token`, `proxyPassword`, `sharedSecret`, TSIG
  keys, private keys, the 2FA secret and others listed in `SENSITIVE`) are sensitive: inputs
  accept `Redacted` values and outputs are `Redacted`.

Each generate run stamps `distilled.generatedAt` and `distilled.specUpdatedAt` into the package's
`package.json`, as distilled does. Apart from these dates, regenerating reproduces the committed
files exactly.

### Patches

The examples in `APIDOCS.md` predate some members the server writes and show only some record
types. Three patches in `patches/zones/` correct the shapes of records and zones, each with its
evidence in `description`:

- `record-data.patch.json`: `rData` has the members of every record type that `WriteRecordAsJson`
  in `WebServiceZonesApi.cs` writes, such as the `*String` intervals of SOA records and the
  character strings of TXT records. Two members change type with the record type, so they are
  unions of primitives (`unionStyle: "primitive"`, as in distilled's Fly.io SDK): `flags` is a
  number for CAA records and a string otherwise, and `protocol` is a string for FWD records and a
  number for DNSKEY records.
- `record-members.patch.json`: records in `getRecords`, `addRecord` and `updateRecord` have
  `comments`, `expiryTtl`, `lastModified`, `glueRecords` and further members, and all three use
  the `rData` shape of `getRecords`.
- `zone-summary.patch.json`: the zone summary in the same responses (`WriteZoneInfoAsJson`), where
  `catalog` is `null` for zones outside a catalog zone.

The server tests run these operations with strict response validation, which fails on any member
the model lacks, and read whole zones with every record type except APP and ALIAS. Removing a
patched member makes them fail.

### Protocol

Technitium wraps every answer in an envelope and reports failures with HTTP 200:

```json
{ "status": "error", "errorMessage": "No such zone was found: example.com", "server": "dns1" }
```

`protocol.ts` maps `status` to typed errors (`TechnitiumError`, `Unauthorized` for
`invalid-token`, `Forbidden` for `Access was denied.`, `TwoFactorAuthRequired` and
`UnknownTechnitiumError`), unwraps the `response` member and then applies core's key mapping,
response validation and `Redacted` wrapping, as core's REST protocol does. Core's `Protocol`
interface erases the error channel; one `fail` function bridges it, as in core.

HTTP client errors keep the request they failed for, and Node prints them without Effect's
redaction. The protocol replaces that request with one that has only the method and URL, so
neither the `Authorization` header nor a form body with a password reaches a crash report.

Operations are not retried: a replayed write could apply twice.

## Technitium text

The repository is licensed under Apache-2.0, like distilled and Alchemy. Technitium DNS Server,
including `APIDOCS.md`, is licensed under GPL-3.0; `pnpm specs:fetch` checks the `LICENSE` file at
the pinned commit and fails if it changes. The handling follows the Proxmox client:

- The documentation and the source files are downloaded into the ignored `specs/.cache/` and never
  committed or packed.
- The committed structure contains interface facts only: paths, permission names, parameter and
  member names, types and enum values, and the section headings, which become operation names.
- Generated doc comments are built from the path and permissions.
- `pnpm generate` ends with `pnpm check:prose`. It collects every sentence of at least eight words
  from the documentation and fails if one appears in a file that is or would be committed. It
  compares lowercase word sequences, so line breaks, comment markers and Markdown do not hide a
  copy.
- Extraction and conversion tests use invented fragments.
- Hand-written docs paraphrase Technitium's behavior. A few short server messages appear verbatim,
  such as `Access was denied.`, because the code and the tests match them.

## The provider

### One resource

`Technitium.Record` manages one A, AAAA or CNAME record in an existing Primary zone. Zones, zone
options, other record types, reverse zones and server settings are out of scope. Primary zones
replicate to secondary servers through Technitium's own NOTIFY and zone transfer; the provider's
writes go through the same code as edits in the web console, so replication needs nothing from it.

The `zone` is always passed explicitly. Technitium falls back to the closest enclosing zone when
the named zone does not exist, so the provider checks that the zone in each response is the
declared one and that it is a Primary zone. The server tests confirm the fallback.

### Identity and ownership

Records have no IDs. A record is its zone, name, type and value (the address or target), and
several records with the same name and type form a set.

The provider marks the records it manages by appending `[alchemy:<stack>/<stage>/<fqn>#<instance>]`
to their comment, where `<instance>` is the first eight hex digits of Alchemy's instance ID for
the resource. A marker was chosen over state alone, as NetBird policies are handled, because
comments exist and a marker:

- identifies the record when its value was changed in the web console, which state alone cannot;
- recovers lost state without `--adopt`;
- tells a managed record from one that someone recreated with the same value;
- shows in the web console that a record is managed by a stack.

The marker includes the resource's FQN, not only the stack and stage as the Proxmox tags do. Two
resources that declare the same record therefore conflict instead of sharing it, and a removed
resource with `RemovalPolicy.destroy()` cannot delete a record that another resource of the stack
adopted. A record is this resource's when its marker has the resource's stack, stage and FQN, or
the same stack, stage and instance. The second case is a `renamedFrom` rename: the engine moves
the state with its instance ID to the new FQN and calls an update, which replaces the old marker.

A record found without state is owned only with this resource's marker; anything else is
`Unowned` and needs `--adopt`. Adoption may only add the marker: it fails if the declared TTL,
disabled state, comment or CNAME target differs from the record. A recovered state has a new
instance ID, so the update after adoption rewrites the marker's instance and nothing else.

With state, a record found by its value is still only changed or deleted if it carries this
resource's marker. Without it, the record may have been deleted and recreated in the web
console; with another resource's marker, it belongs to that resource. The engine offers no
`--adopt` for resources that have state, so taking such a record over is a manual step: add the
marker to its comment, or remove the resource from the stack for one deploy (the default removal
policy keeps the record) and declare it again with `--adopt`. Markers written before 0.2.0 have
no instance and match by stack, stage and FQN.

### Record sets

Technitium keeps one TTL per set. Adding a record with another TTL, or updating one with
another TTL, rewrites the other records of the set (`AuthZone.AddRecord` creates new record
objects for them). The new objects lose their comments, disabled state and modification time.
Local tests on 15.5.0 and 15.6.2, the latest release, confirmed it: a disabled, commented sibling
became enabled and lost its comment, and on 15.6.2 it appeared in DNS answers again. The web console sends the
same update request, so a TTL change there does the same. It is reported as
[TechnitiumSoftware/DnsServer#2269](https://github.com/TechnitiumSoftware/DnsServer/issues/2269).
The provider therefore:

- writes the set's TTL when a declaration leaves `ttl` out, and refuses a declared TTL that differs
  from the TTL of other records in the set;
- refuses a TTL change for a record that has siblings;
- refuses a new value that another record of the set already has, because Technitium would merge
  the two records into one;
- refuses CNAME records next to other records, and other records next to a CNAME record.

### Writes

`zones/records/update` resets every field a request leaves out: `ttl` to the server's default,
`disable` to `false`, `comments` to none and `expiryTtl` to `0`. A local test confirmed that an
update without these fields also reset the TTL and metadata of a sibling. The provider sends all
fields on every update. Records with an automatic expiry are refused, because the provider would
otherwise remove the expiry.

Changes are made in place: a new address or target with `newIpAddress` or `cname`, a new name
with `newDomain`. A record therefore never disappears for a moment, and an address from another
resource can change in the same plan. `zone` and `type` cannot change. Technitium cannot create a
disabled record, so a disabled record is added and then disabled.

Before each write, the provider reads the records at the name; after it, it reads them again and
fails with `TechnitiumRecordMismatch` if the record differs from the declaration or any other
record at the name changed. Technitium has no version check for records, so writes to the same
name are serialized within a deploy. An edit in the web console between the read and the write
can still be overwritten; the check after the write does not detect changes to the managed
record itself.

### Side effects

- **PTR records.** Adding and updating records can create PTR records and reverse zones (`ptr`,
  `createPtrZone`); the provider always sends `false`. Deleting an A or AAAA record also deletes a
  PTR record that points back at it whenever the token may delete in the reverse zone, and the API
  offers no way to prevent it (`DeleteRecord` in `WebServiceZonesApi.cs`). Permissions are
  separate flags, so a token can delete in a zone it cannot view, and no call tells a token its
  own zone permissions (`zones/permissions/get` needs Modify on the Zones section). Before
  deleting, the provider therefore reads the closest zone of the reverse name, as Technitium
  does. It deletes only when no zone holds the name, when that zone is not a Primary or Forwarder
  zone, or when it holds no PTR record that points at the name. It refuses when it finds one,
  when it cannot read the zone and on any other error. The server tests cover a token with Delete
  but not View on the reverse zone.
- **SVCB and HTTPS hints.** `updateSvcbHints` is always `false`, so changing an address never
  changes other records.

### Removal

`defaultRemovalPolicy` is `retain`, as for Proxmox guests: removing a record from the stack makes
Alchemy forget it. With `RemovalPolicy.destroy()`, deletion requires the resource's marker and
refuses a deletion that could remove a PTR record or whose effect on PTR records it cannot check.
A missing record or zone counts as deleted.

The provider implements no `list`, so `alchemy unsafe nuke` deletes no records.

### Credentials

The provider registers a stored Alchemy login, as the NetBird provider does.
`TECHNITIUM_API_TOKEN` and `TECHNITIUM_API_URL` take precedence and are read through Effect
`Config`. The address must use HTTPS, except on a loopback address: Technitium's web service often
listens on plain HTTP, and the token would cross the network in clear text. An SSH tunnel to the
server's loopback interface is the alternative to enabling HTTPS on the server. A private CA is
trusted through `NODE_EXTRA_CA_CERTS`.

## Upstream

The client follows distilled's requirements for a new SDK, checked against the distilled checkout
(`AGENTS.md` and the `distilled-sdk` and `distilled-sdk-patch` skills) as of 2026-10-31:

- `credentials.ts` holds the token as `Redacted`, read with `Config.Redacted`; no secret is typed
  as a plain string.
- `errors.ts` declares only classes the protocol raises: `UnknownTechnitiumError` and
  `TechnitiumParseError` are constructed in `protocol.ts`, and `TechnitiumOpError` includes the
  parse error.
- A hand-written protocol validates 2xx bodies after key mapping and before `Redacted` wrapping.
- The README quick start provides `FetchHttpClient.layer`, `CredentialsFromEnv` and
  `TechnitiumProtocol` and makes a real call.
- Generated code has no tests of its own; tests cover the hand-written protocol and credentials,
  the extraction and the conversion.
- Patches are RFC 6902 operations on the Smithy model, applied in convert, each with its evidence
  and test date in `description`.

As with Proxmox and NetBird, there are two copies of the client. This repository holds the one
that projects install, built with the published `@distilled.cloud/core` 1.0.0-rc.17. A second
copy, fitted into the distilled repository, is the draft pull request
[alchemy-run/distilled#1026](https://github.com/alchemy-run/distilled/pull/1026), as
[#990](https://github.com/alchemy-run/distilled/pull/990) is for Proxmox and
[#1024](https://github.com/alchemy-run/distilled/pull/1024) for NetBird. It differs where
distilled's repository differs:

- The fetch script is `stacks/distilled-submodules/spec-repos/technitium/fetch-specs.ts`. Only that
  file reaches the spec mirror, so it contains the extraction and writes `api-structure.json` and
  `provenance.json`, never the GPL text. It produces the same structure as this repository, byte
  for byte.
- The package uses distilled's unpublished `@distilled.cloud/dev` generator and the newer core
  helpers, such as `validateSuccess`, and is wired into the repository's `tsconfig`, `SpecRepos.ts`,
  `.gitmodules` and website catalogue. The converter is `scripts/schema.ts`; the extraction tests
  stay in this repository.

The distilled copy passes `pnpm specs:check`, `tsrs --noCheck false` and core's checks for every
SDK, and its README example ran against a local Technitium server. Its description asks the same
license question as the Proxmox pull request.

## Open questions

- **TTL changes for shared sets.** Changing the TTL of a set with several records resets the
  metadata of the other records in Technitium up to 15.6.2. A deliberate, opt-in procedure could
  rewrite every record's metadata afterwards; a fix in Technitium would make it unnecessary.
- **Other record types.** TXT, MX, SRV and PTR records fit the same model; each needs its own
  value comparison and conflict rules.
- **File transfers.** Zone export and import would need binary and multipart support in the
  protocol.
- **Forwarder zones** accept records too, but are refused until there is a need.
