# alchemy-technitium

Manage DNS records on a [Technitium DNS Server](https://technitium.com/dns/) as code with
[Alchemy](https://alchemy.run).

> [!WARNING]
> Early. Nothing is published to npm, and the API can still change. Tagged releases can be
> [installed as tarballs](docs/RELEASING.md#install-a-release).

| Package                                                            | Contents                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [`@alchemy.run/technitium`](packages/alchemy-technitium/README.md) | Alchemy resource for A, AAAA and CNAME records in existing zones   |
| [`@distilled.cloud/technitium`](packages/technitium/README.md)     | Effect client for the Technitium HTTP API, generated from its docs |

## Example

This stack points `nas.homelab.example.com` at an address and `files.homelab.example.com` at
that name:

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

`alchemy deploy` adds both records to the existing zone `homelab.example.com` and marks them with
`[alchemy:Homelab/<stage>/nas#<instance>]` and `[alchemy:Homelab/<stage>/files#<instance>]` in
their comments. A
changed `address` updates the record in place, in the same plan as the resource that produced
the address. Technitium increases the zone's serial and notifies its secondary servers, which
transfer the zone as usual.

A stack groups resources. `"nas"` and `"files"` are the names Alchemy uses for the resources in
the stack. Alchemy records what it manages in the `.alchemy/` directory next to the stack file.
Each stage (`--stage`, by default `live_<your user name>`) is a separate deployment with its own
state.

## Try it

Requires Node 24, pnpm 12.15.0 and a Technitium DNS Server 15.5 or later whose web service is
reachable over HTTPS, or over HTTP on a loopback address (for example through an SSH tunnel).

1. Clone the repository and install the dependencies:

   ```sh
   git clone https://github.com/trucke/alchemy-technitium.git
   cd alchemy-technitium
   pnpm install --frozen-lockfile
   ```

2. Save the example as `packages/alchemy-technitium/alchemy.run.ts`, with your own zone, names and
   address. Run the remaining commands from that directory:

   ```sh
   cd packages/alchemy-technitium
   ```

3. Create an API token for a user that may change only the zone, as described in
   [Create a scoped token](packages/alchemy-technitium/README.md#create-a-scoped-token).
4. Provide the token through the
   [environment variables or an Alchemy profile](packages/alchemy-technitium/README.md#authentication).
5. Preview and apply the changes. `plan` only reads; it lists both records as new resources.

   ```sh
   pnpm exec alchemy plan
   pnpm exec alchemy deploy
   ```

## Safety defaults

- **Only marked records change.** A record without this resource's marker is never changed, also
  when it was recreated in the web console after Alchemy created it. Taking it over is explicit,
  and adopting only adds the marker. Records with the same name that the stack does not declare
  are never changed; a declaration that Technitium would apply to them as well fails.
- **Nothing is deleted by accident.** Removing a record from the stack makes Alchemy forget it and
  leaves it on the server. Deleting needs an explicit `RemovalPolicy.destroy()`, and the provider
  deletes only records that still carry the resource's marker.
- **No side effects.** The provider never creates zones, never creates or changes PTR records
  and never refreshes SVCB or HTTPS hints. It refuses a deletion that would make Technitium
  delete a PTR record.
- **The token stays secret.** It travels in the `Authorization` header over HTTPS, and never
  appears in URLs, state, logs or errors.

## Limitations

- Only A, AAAA and CNAME records in existing Primary zones.
- The TTL of a record that shares its name and type with other records cannot change through the
  provider (see [Record sets](packages/alchemy-technitium/README.md#record-sets)).
- Tested against Technitium DNS Server 15.5.0, 15.5.1 and 15.6.2 in local containers. Not tested
  against a production server yet.

## Development

```sh
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test   # offline checks
pnpm test:server                                                 # against a local container
pnpm specs:fetch && pnpm generate                                # regenerate the client
```

[Develop and regenerate](packages/technitium/README.md#develop-and-regenerate) explains the client
generation, and [docs/TESTING.md](docs/TESTING.md) the tests. [docs/DESIGN.md](docs/DESIGN.md)
explains the design decisions, and [docs/RELEASING.md](docs/RELEASING.md) describes how to create
and install a release.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The client is generated from Technitium's
API documentation and server source (GPL-3.0) but contains only the structure of the API, no
Technitium text or code; see [Technitium text](docs/DESIGN.md#technitium-text).

This is an independent project, not affiliated with Technitium or Alchemy.
