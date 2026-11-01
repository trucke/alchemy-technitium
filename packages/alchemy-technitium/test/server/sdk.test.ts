// Reads records through the SDK with strict response validation: whole zones with a record of
// every type but APP (which needs an installed DNS app) and ALIAS, a signed zone of each kind, a
// conditional forwarder zone, the allowed and blocked zone lists and the cache. The generated
// models must describe every member Technitium writes for them (WriteRecordAsJson in
// DnsServerCore/WebServiceZonesApi.cs).
import * as ResponseValidation from "@distilled.cloud/core/response-validation";
import * as Technitium from "@distilled.cloud/technitium";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { call, startServer, type TestServer } from "./globalSetup.ts";
import { webConsole } from "./harness.ts";

const ZONE = "variants.test";
const SIGNED = { NSEC: "nsec.test", NSEC3: "nsec3.test" } as const;
const FORWARDER = "proxied.test";
const ALLOWED = "allowed.example";
const BLOCKED = "blocked.example";
/** Served by a second server, which the test server forwards to and caches answers from. */
const CACHED = "cached.test";

/** A record of each type that records/add creates in `zone`, added as the web console does. */
const recordsIn = (zone: string): Record<string, string | number | boolean>[] => [
  { domain: `a.${zone}`, type: "A", ipAddress: "192.0.2.1" },
  { domain: `bücher.${zone}`, type: "AAAA", ipAddress: "2001:db8::1" },
  { domain: `cname.${zone}`, type: "CNAME", cname: "xn--bcher-kva.example" },
  { domain: `sub.${zone}`, type: "NS", nameServer: `ns.sub.${zone}`, glue: "192.0.2.53" },
  {
    domain: `sub.${zone}`,
    type: "DS",
    keyTag: 12345,
    algorithm: "ECDSAP256SHA256",
    digestType: "SHA256",
    digest: "AB".repeat(32),
  },
  { domain: `ptr.${zone}`, type: "PTR", ptrName: "host.example" },
  { domain: zone, type: "MX", preference: 10, exchange: `mail.${zone}` },
  { domain: `txt.${zone}`, type: "TXT", text: "v=spf1 -all" },
  { domain: `split.${zone}`, type: "TXT", text: "first\nsecond", splitText: true },
  { domain: `rp.${zone}`, type: "RP", mailbox: `admin.${zone}`, txtDomain: `txt.${zone}` },
  {
    domain: `_sip._tcp.${zone}`,
    type: "SRV",
    priority: 10,
    weight: 5,
    port: 5060,
    target: `sip.${zone}`,
  },
  {
    domain: `naptr.${zone}`,
    type: "NAPTR",
    naptrOrder: 100,
    naptrPreference: 10,
    naptrFlags: "U",
    naptrServices: "E2U+sip",
    naptrRegexp: "!^.*$!sip:info@example.com!",
    naptrReplacement: ".",
  },
  { domain: `dname.${zone}`, type: "DNAME", dname: "example.net" },
  {
    domain: `ssh.${zone}`,
    type: "SSHFP",
    sshfpAlgorithm: "Ed25519",
    sshfpFingerprintType: "SHA256",
    sshfpFingerprint: "CD".repeat(32),
  },
  {
    domain: `_443._tcp.${zone}`,
    type: "TLSA",
    tlsaCertificateUsage: "DANE-EE",
    tlsaSelector: "SPKI",
    tlsaMatchingType: "SHA2-256",
    tlsaCertificateAssociationData: "EF".repeat(32),
  },
  {
    domain: `_dns.${zone}`,
    type: "SVCB",
    svcPriority: 1,
    svcTargetName: `dns.${zone}`,
    svcParams: "alpn|dot|port|853",
  },
  {
    domain: `a.${zone}`,
    type: "HTTPS",
    svcPriority: 1,
    svcTargetName: ".",
    svcParams: "alpn|h2",
    autoIpv4Hint: true,
  },
  {
    domain: `_http._tcp.${zone}`,
    type: "URI",
    uriPriority: 10,
    uriWeight: 1,
    uri: "https://example.com/",
  },
  { domain: zone, type: "CAA", flags: 0, tag: "issue", value: "letsencrypt.org" },
  { domain: `aname.${zone}`, type: "ANAME", aname: "example.net" },
  // Types without their own parameters take wire-format RDATA: 192.0.2.0/24, and a digest.
  { domain: `apl.${zone}`, type: "APL", rdata: "00011803C00002" },
  { domain: zone, type: "ZONEMD", rdata: `0000000101${"01"}${"00".repeat(48)}` },
  { domain: `unknown.${zone}`, type: "65450", rdata: "0102" },
];

function sdk<A, E>(effect: Effect.Effect<A, E, Technitium.TechnitiumOpContext>) {
  const { url, adminToken } = inject("technitium");
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          FetchHttpClient.layer,
          Technitium.fromApiToken({ apiToken: Redacted.make(adminToken), apiUrl: url }),
          Technitium.TechnitiumProtocol,
          ResponseValidation.strict,
        ),
      ),
    ),
  );
}

const wholeZone = (zone: string) =>
  sdk(Technitium.zones.getRecords({ zone, domain: zone, listZone: true })).then(
    ({ records = [] }) => records,
  );
const typesOf = (records: readonly { type: string }[]) => [
  ...new Set(records.map((record) => record.type).sort()),
];

beforeAll(async () => {
  await webConsole("/api/zones/create", { zone: ZONE, type: "Primary" });
  for (const record of recordsIn(ZONE))
    await webConsole("/api/zones/records/add", { zone: ZONE, ...record });
  for (const [nxProof, zone] of Object.entries(SIGNED)) {
    await webConsole("/api/zones/create", { zone, type: "Primary" });
    await webConsole("/api/zones/records/add", {
      zone,
      domain: zone,
      type: "A",
      ipAddress: "192.0.2.1",
    });
    await webConsole("/api/zones/dnssec/sign", {
      zone,
      algorithm: "ECDSA",
      curve: "P256",
      nxProof,
    });
  }
  for (const domain of [ALLOWED, `www.${ALLOWED}`])
    await webConsole("/api/allowed/add", { domain });
  await webConsole("/api/blocked/add", { domain: BLOCKED });
  await webConsole("/api/zones/create", {
    zone: FORWARDER,
    type: "Forwarder",
    initializeForwarder: true,
    protocol: "Tcp",
    forwarder: "192.0.2.1",
    proxyType: "Http",
    proxyAddress: "192.0.2.2",
    proxyPort: 3128,
    proxyUsername: "user",
    proxyPassword: "password",
  });
});
afterAll(async () => {
  for (const zone of [ZONE, ...Object.values(SIGNED), FORWARDER])
    await webConsole("/api/zones/delete", { zone }).catch(() => undefined);
  await webConsole("/api/allowed/flush").catch(() => undefined);
  await webConsole("/api/blocked/flush").catch(() => undefined);
});

describe("SDK responses", () => {
  it("reads a whole zone with every record type but APP and ALIAS", async () => {
    const records = await wholeZone(ZONE);
    expect(typesOf(records)).toEqual(
      [...new Set(["SOA", "NS", ...recordsIn(ZONE).map((record) => String(record.type))])].sort(),
    );
    const at = (name: string, type: string) =>
      records.find((record) => record.name === name && record.type === type)?.rData;
    expect(at(ZONE, "SOA")).toMatchObject({
      refreshString: expect.any(String),
      useSerialDateScheme: false,
    });
    expect(at(`split.${ZONE}`, "TXT")).toMatchObject({
      splitText: true,
      characterStrings: ["first", "second"],
    });
    expect(at(ZONE, "CAA")?.flags).toBe(0);
    expect(at(`a.${ZONE}`, "HTTPS")?.svcParams).toMatchObject({ alpn: "h2" });
    expect(
      records.find((record) => record.name === `sub.${ZONE}` && record.type === "NS"),
    ).toMatchObject({ glueRecords: ["192.0.2.53"] });
  });

  it("returns added and updated records in the same model", async () => {
    const { addedRecord } = await sdk(
      Technitium.zones.addRecord({
        zone: ZONE,
        domain: `added.${ZONE}`,
        type: "MX",
        preference: 5,
        exchange: `mail.${ZONE}`,
      }),
    );
    expect(addedRecord?.rData).toMatchObject({ preference: 5, exchange: `mail.${ZONE}` });
    // records/update needs every SOA field; resend the current ones with a new refresh interval.
    const soa = (await wholeZone(ZONE)).find((record) => record.type === "SOA")?.rData;
    const { primaryNameServer, responsiblePerson, serial, retry, expire, minimum } = soa ?? {};
    const { updatedRecord } = await sdk(
      Technitium.zones.updateRecord({
        zone: ZONE,
        domain: ZONE,
        type: "SOA",
        primaryNameServer,
        responsiblePerson,
        serial,
        refresh: 1800,
        retry,
        expire,
        minimum,
      }),
    );
    expect(updatedRecord?.rData).toMatchObject({ refresh: 1800, refreshString: "30m" });
  });

  it("reads whole signed zones", async () => {
    expect(typesOf(await wholeZone(SIGNED.NSEC))).toEqual([
      "A",
      "DNSKEY",
      "NS",
      "NSEC",
      "RRSIG",
      "SOA",
    ]);
    expect(typesOf(await wholeZone(SIGNED.NSEC3))).toEqual([
      "A",
      "DNSKEY",
      "NS",
      "NSEC3",
      "NSEC3PARAM",
      "RRSIG",
      "SOA",
    ]);
  });

  it("reads a whole conditional forwarder zone and redacts the proxy password", async () => {
    const records = await wholeZone(FORWARDER);
    expect(typesOf(records)).toEqual(["FWD", "SOA"]);
    const forwarder = records.find((record) => record.type === "FWD")?.rData;
    expect(forwarder).toMatchObject({ protocol: "Tcp", forwarder: "192.0.2.1", proxyPort: 3128 });
    expect(Redacted.isRedacted(forwarder?.proxyPassword)).toBe(true);
  });

  it("reads the allowed and blocked zone lists", async () => {
    const allowed = await sdk(Technitium.allowed.listAllowedZones({ domain: ALLOWED }));
    const blocked = await sdk(Technitium.blocked.listBlockedZones({ domain: BLOCKED }));
    expect(typesOf(allowed.records)).toEqual(["NS", "SOA"]);
    expect(typesOf(blocked.records)).toEqual(["NS", "SOA"]);
    expect(allowed.zones).toEqual([`www.${ALLOWED}`]);
  });

  describe("cache", () => {
    let upstream: TestServer | undefined;
    /** Every name and type the test server resolves; ANAME would need the internet. */
    const queries = [
      ...recordsIn(CACHED).filter((record) => record.type !== "ANAME"),
      { domain: CACHED, type: "SOA" },
      { domain: CACHED, type: "NS" },
      // A negative answer, which the cache keeps as well.
      { domain: `nothing.${CACHED}`, type: "A" },
    ].map(({ domain, type }) => ({ domain: String(domain), type: String(type) }));

    beforeAll(async () => {
      upstream = await startServer(
        `alchemy-technitium-upstream-${process.pid}`,
        inject("technitium").network,
      );
      const { url, adminToken, address } = upstream;
      const onUpstream = (path: string, params: Record<string, string | number | boolean>) =>
        call(
          url,
          path,
          Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
          adminToken,
        );
      await onUpstream("/api/zones/create", { zone: CACHED, type: "Primary" });
      for (const record of recordsIn(CACHED))
        await onUpstream("/api/zones/records/add", { zone: CACHED, ...record });
      await webConsole("/api/zones/create", {
        zone: CACHED,
        type: "Forwarder",
        initializeForwarder: true,
        forwarder: address,
      });
      for (const { domain, type } of queries)
        await webConsole("/api/dnsClient/resolve", { server: "this-server", domain, type });
    });
    afterAll(async () => {
      upstream?.stop();
      await webConsole("/api/zones/delete", { zone: CACHED }).catch(() => undefined);
      await webConsole("/api/cache/flush").catch(() => undefined);
    });

    it("reads cached records of every type", async () => {
      const lists = await Promise.all(
        [...new Set(queries.map(({ domain }) => domain))].map((domain) =>
          sdk(Technitium.cache.listCachedZones({ domain })),
        ),
      );
      const records = lists.flatMap(({ records }) => records);
      expect(typesOf(records)).toEqual(typesOf(queries));
      // Outside a zone, the SOA intervals are text, and a negative answer has no record data.
      const soa = records.find((record) => record.type === "SOA")?.rData;
      expect(soa?.refresh).toEqual(expect.any(String));
      expect(records.find((record) => record.name === `nothing.${CACHED}`)?.rData).toMatchObject({
        dataType: expect.any(String),
        data: expect.any(String),
      });
    });
  });
});
