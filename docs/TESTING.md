# Testing

`pnpm test` runs the offline tests:

- **Client:** the protocol (form encoding, the `Authorization` header, the envelope, errors and
  `Redacted` secrets, and credentials removed from HTTP client errors), the credentials, and the
  extraction and conversion with invented documentation, C# and structure fragments. Like
  distilled's own SDKs, the generated operations have no tests of their own; the server tests use
  them.
- **Provider:** the pure parts of the Record resource (declarations, the marker, finding a record
  among others, record set rules, adoption and reverse names) and a check that the examples in
  the READMEs are the example files the server tests run.

`pnpm test:server` runs the Record resource through the real Alchemy plan and apply against a
Technitium DNS Server that exists only for the run. It never contacts another server.

## Run the server tests

Requires Podman with a running machine (`podman machine start` on macOS) and network access to
Docker Hub.

```sh
pnpm test:server
```

The setup in `packages/alchemy-technitium/test/server/globalSetup.ts`:

1. Starts a container named `alchemy-technitium-test-<pid>` from `technitium/dns-server:15.5.0`,
   pinned by digest, with its configuration on a tmpfs and its web service on a random
   `127.0.0.1` port. The admin password is random and reaches the container as a file.
2. Creates an admin token, the Primary zones `example.test` and `homelab.example.com`, the reverse
   zone `2.0.192.in-addr.arpa` and the conditional forwarder zone `forward.test`.
3. Creates the user `alchemy` with View, Modify and Delete on the two Primary zones and on
   `forward.test`, and an API token for it. The provider uses this token, as a real deployment
   should; the admin token stands in for someone using the web console.

The container and its files under `.local/test-server/` are removed when the run ends, also after
a failure.

The tests run with distilled's strict response validation, so every response the provider reads
must match the generated model. They record every record write the provider sends, so they can
prove that an unchanged deploy or a recovered state writes nothing. Two tests run the documented
examples: the SDK program with Node, and the stack with the Alchemy CLI (`deploy`, `plan` and
`destroy`), both logged in through `TECHNITIUM_API_URL` and `TECHNITIUM_API_TOKEN`.

To test another Technitium release, set `TECHNITIUM_TEST_IMAGE`, for example:

```sh
TECHNITIUM_TEST_IMAGE=docker.io/technitium/dns-server:15.6.2 pnpm test:server
```

The suite passed against 15.5.0, 15.5.1 and 15.6.2.

After an interrupted run, remove leftover containers:

```sh
podman ps -a --filter name=alchemy-technitium-test --format '{{.Names}}' | xargs -r podman rm -f
```

## Check a regeneration

`pnpm specs:fetch` reuses the downloaded files when their SHA-256 matches `provenance.json`, and
downloads them otherwise. Regenerating from the pinned release must change nothing except the
dates that distilled's generator stamps into `packages/technitium/package.json`:

```sh
pnpm specs:fetch && pnpm generate
jj diff --stat
```
