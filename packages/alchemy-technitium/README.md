# @alchemy.run/technitium

Alchemy resource for DNS records on a [Technitium DNS Server](https://technitium.com/dns/), built on
the [`@distilled.cloud/technitium`](../technitium/README.md) SDK.

> [!WARNING]
> Not published to npm, and the API can still change. The repository README explains how to
> install a release.

`Technitium.Record` manages one A, AAAA or CNAME record in an existing Primary zone. Zones, other
records, reverse zones and server settings stay as they are.

Requires `alchemy` 2.0.0-beta.84, Effect 4.0.5 and Node 24. Tested against Technitium DNS Server
15.5.0, 15.5.1 and 15.6.2 in local containers.

## Example

```ts
import * as Alchemy from "alchemy";
import * as Technitium from "@alchemy.run/technitium";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "Homelab",
  { providers: Technitium.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const nas = yield* Technitium.Record("nas", {
      zone: "homelab.example.com",
      name: "nas.homelab.example.com",
      type: "A",
      address: "192.0.2.20",
      ttl: 300,
      comment: "NAS",
    });
    yield* Technitium.Record("files", {
      zone: "homelab.example.com",
      name: "files.homelab.example.com",
      type: "CNAME",
      target: nas.name,
    });
    return { nas: nas.name };
  }),
);
```

The example is `examples/homelab.ts`. To delete a record when it leaves the stack, pipe it
through `RemovalPolicy.destroy()` from `alchemy/RemovalPolicy`.

## Authentication

The provider uses a Technitium API token from environment variables or from an Alchemy profile.
When `TECHNITIUM_API_TOKEN` is set, the variables take precedence over the profile.

| Variable               | Required | Value                                                          |
| ---------------------- | -------- | -------------------------------------------------------------- |
| `TECHNITIUM_API_TOKEN` | Yes      | API token of a user with permissions on the managed zones only |
| `TECHNITIUM_API_URL`   | Yes      | Web service origin, such as `https://dns.example.com:53443`    |

The variables are read through Effect `Config`, so a stack's `secrets` can supply them. The token
is resolved on first use and never written to state, logs or errors. `TECHNITIUM_API_URL` must be
an HTTPS origin without a path. Plain HTTP is accepted only for `127.0.0.1`, `localhost` and
`[::1]`, for example through an SSH tunnel to a server whose web service listens on HTTP only.
For a certificate from a private CA, set `NODE_EXTRA_CA_CERTS` to the CA's PEM file.

To store the token in a profile instead, set both variables, then run this from the directory that
contains your `alchemy.run.ts`:

```sh
pnpm exec alchemy profile create dns
pnpm exec alchemy profile edit --profile dns --add Technitium --method stored \
  --set apiUrl=env:TECHNITIUM_API_URL --set apiToken=env:TECHNITIUM_API_TOKEN
```

The `env:` references read the values from the variables, so the token never appears in the
command. Afterwards, unset the variables and pass `--profile dns` to `pnpm exec alchemy plan` and
`deploy`.

### Create a scoped token

A token has the permissions of its user. Give the provider a user of its own:

1. In the web console, create a user, for example `alchemy`, and add it to no groups.
2. In the permissions of each managed zone, give the user View and Modify. Add Delete only if a
   record uses `RemovalPolicy.destroy()`.
3. Create an API token for the user: in the web console under Administration, or with the SDK's
   `admin.createApiToken`.

For A and AAAA records that use `RemovalPolicy.destroy()`, also give the user View on the
reverse zones of their addresses, and nothing more there. Before a deletion, the provider checks
that Technitium would not delete a PTR record along with it, and refuses the deletion if it
cannot read the reverse zone (see [Side effects](#side-effects)).

The provider needs no permission on the Zones section and none on other zones; the server tests
use exactly such a user.

Technitium adds every user to the `Everyone` group, which by default may view the dashboard,
logs, cache and other sections, but no zone's records. Restrict that group if
the token must not read them; the change applies to all users.

## Record properties

| Property   | Default                         | Meaning                                                                               |
| ---------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| `zone`     |                                 | An existing Primary zone. Cannot change                                               |
| `name`     |                                 | Fully-qualified name inside the zone, or the zone name for the apex. Changes in place |
| `type`     |                                 | `"A"`, `"AAAA"` or `"CNAME"`. Cannot change                                           |
| `address`  |                                 | A and AAAA: the address, compared in canonical form. Changes in place                 |
| `target`   |                                 | CNAME: the name the alias points to. Changes in place                                 |
| `ttl`      | see [Record sets](#record-sets) | TTL in seconds                                                                        |
| `comment`  | `""`                            | Shown in the web console, followed by the provider's marker                           |
| `disabled` | `false`                         | Whether the server leaves the record out of answers                                   |

Names, zones and targets are compared in lowercase without a trailing dot. Use the ASCII form of
internationalized names.

Attributes contain `zone`, `name`, `type`, `value` (the address or target), `ttl`, `comment`
(without the marker) and `disabled`, as the server reports them.

## Ownership

Technitium records have no IDs: a record is its zone, name, type and value. The provider marks the
records it manages by appending `[alchemy:<stack>/<stage>/<resource>#<instance>]` to their
comment, for example `NAS [alchemy:Homelab/prod/nas#1f2e3d4c]`. Each part is URI-encoded, and
`<instance>` is the start of Alchemy's instance ID for the resource.

- A record with this resource's marker is found by the marker, even after its value changed in
  the web console. Without the marker, the declared value finds it (a name holds at most one
  CNAME record).
- A record found without state is owned only if it carries this resource's marker. Then Alchemy
  takes it over silently, so lost state recovers without `--adopt`; the only write updates the
  marker's instance. Any other record needs `--adopt`.
- **With state, only a record with this resource's marker is changed or deleted.** A record
  found by its value without the marker may have been deleted and recreated in the web console,
  and one with another resource's marker belongs to that resource. The deploy fails and nothing is
  written. To manage the record again, add the marker from the error message to its comment in the
  web console, or remove the resource from the stack for one deploy and declare it again with
  `--adopt`.
- **Adoption only adds the marker.** If the record's TTL (when declared), disabled state or
  comment differ from the declaration, or a CNAME points elsewhere, adoption fails and nothing is
  written. Make the declaration match the server first.
- A resource renamed with `renamedFrom` from `alchemy/Rename` keeps its instance, so it
  recognizes its old marker and replaces it.

A plan compares the declaration with Alchemy's state, not with the server; `alchemy drift` shows
changes made in the web console and repairs them.

## Record sets

All records with the same name and type form a set with one TTL. When a TTL changes, Technitium
(tested up to 15.6.2) rewrites the other records of the set and resets their comments and disabled
state, also when the change is made in the web console. The provider therefore never writes a TTL
that differs from the TTL of other records in the set:

- Without `ttl`, a new record takes the TTL of the set, or the server's default for a new set, and
  an existing record keeps its TTL.
- A declared `ttl` that differs from the set's fails the plan. A record alone in its set changes
  its TTL in place.
- A new value that another record of the set already has fails, because Technitium would merge
  the two records.
- A CNAME record cannot share its name with other records, and an A or AAAA record cannot join a
  name that has a CNAME record.

Each write sends every field of the record (TTL, comment, disabled state, no expiry), because
Technitium resets fields that a request leaves out. After each write the provider reads the name
again and fails if the record differs from the declaration or any other record at the name changed.
A record with an automatic expiry (`expiryTtl`) is refused.

## Side effects

- **PTR records:** the provider never asks Technitium to create or update PTR records or reverse
  zones. When an A or AAAA record is deleted, Technitium also deletes a PTR record that points back
  at it, if the token may delete in the reverse zone, even without permission to view it; this
  cannot be turned off. The provider refuses the deletion if it finds such a PTR record, or if a
  reverse zone exists that the token cannot read. Give the token View on the reverse zones.
- **SVCB and HTTPS hints:** automatic address hints of SVCB and HTTPS records are not refreshed
  when an address changes.
- **Secondary servers:** each write increases the zone's SOA serial, and Technitium notifies the
  zone's secondary servers as for an edit in the web console.

## Changes and deletion

- **Changes** to `address`, `target`, `name`, `ttl`, `comment` and `disabled` are made in place,
  so a record never disappears for a moment. A new `zone` or `type` fails the plan; declare a new
  resource instead.
- **Same plan:** an `address` or `target` can be another resource's output. Alchemy then compares
  it during the deploy and writes only if the server differs.
- **Concurrency:** Technitium has no version check for records. The provider reads the name right
  before each write, serializes writes to the same name within a deploy and verifies afterwards.
  An edit in the web console in the moment between the read and the write can still be overwritten.
- **Deletion:** `defaultRemovalPolicy` is `retain`: a record removed from the stack stays on the
  server and keeps its marker. With `RemovalPolicy.destroy()`, the provider deletes the record
  only if it still carries the resource's marker and it can confirm that Technitium would not
  delete a PTR record along with it.
  A record that is already gone, or whose zone is gone, counts as deleted.

[docs/DESIGN.md](../../docs/DESIGN.md) explains these decisions, and
[docs/TESTING.md](../../docs/TESTING.md) describes the tests.
