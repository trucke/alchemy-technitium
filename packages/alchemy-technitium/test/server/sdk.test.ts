// Reads whole zones through the SDK with strict response validation. The zones hold a record of
// every type but APP (which needs an installed DNS app) and ALIAS, a signed zone of each kind and
// a conditional forwarder zone, so the generated record model must describe every member
// Technitium writes for them (WriteRecordAsJson in DnsServerCore/WebServiceZonesApi.cs).
import * as ResponseValidation from "@distilled.cloud/core/response-validation";
import * as Technitium from "@distilled.cloud/technitium";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { webConsole } from "./harness.ts";

const ZONE = "variants.test";
const SIGNED = { NSEC: "nsec.test", NSEC3: "nsec3.test" } as const;
const FORWARDER = "proxied.test";

/** A record of each type that records/add creates, added as the web console does. */
const RECORDS: Record<string, string | number | boolean>[] = [
  { domain: `a.${ZONE}`, type: "A", ipAddress: "192.0.2.1" },
  { domain: `bücher.${ZONE}`, type: "AAAA", ipAddress: "2001:db8::1" },
  { domain: `cname.${ZONE}`, type: "CNAME", cname: "xn--bcher-kva.example" },
  { domain: `sub.${ZONE}`, type: "NS", nameServer: `ns.sub.${ZONE}`, glue: "192.0.2.53" },
  {
    domain: `sub.${ZONE}`,
    type: "DS",
    keyTag: 12345,
    algorithm: "ECDSAP256SHA256",
    digestType: "SHA256",
    digest: "AB".repeat(32),
  },
  { domain: `ptr.${ZONE}`, type: "PTR", ptrName: "host.example" },
  { domain: ZONE, type: "MX", preference: 10, exchange: `mail.${ZONE}` },
  { domain: `txt.${ZONE}`, type: "TXT", text: "v=spf1 -all" },
  { domain: `split.${ZONE}`, type: "TXT", text: "first\nsecond", splitText: true },
  { domain: `rp.${ZONE}`, type: "RP", mailbox: `admin.${ZONE}`, txtDomain: `txt.${ZONE}` },
  {
    domain: `_sip._tcp.${ZONE}`,
    type: "SRV",
    priority: 10,
    weight: 5,
    port: 5060,
    target: `sip.${ZONE}`,
  },
  {
    domain: `naptr.${ZONE}`,
    type: "NAPTR",
    naptrOrder: 100,
    naptrPreference: 10,
    naptrFlags: "U",
    naptrServices: "E2U+sip",
    naptrRegexp: "!^.*$!sip:info@example.com!",
    naptrReplacement: ".",
  },
  { domain: `dname.${ZONE}`, type: "DNAME", dname: "example.net" },
  {
    domain: `ssh.${ZONE}`,
    type: "SSHFP",
    sshfpAlgorithm: "Ed25519",
    sshfpFingerprintType: "SHA256",
    sshfpFingerprint: "CD".repeat(32),
  },
  {
    domain: `_443._tcp.${ZONE}`,
    type: "TLSA",
    tlsaCertificateUsage: "DANE-EE",
    tlsaSelector: "SPKI",
    tlsaMatchingType: "SHA2-256",
    tlsaCertificateAssociationData: "EF".repeat(32),
  },
  {
    domain: `_dns.${ZONE}`,
    type: "SVCB",
    svcPriority: 1,
    svcTargetName: `dns.${ZONE}`,
    svcParams: "alpn|dot|port|853",
  },
  {
    domain: `a.${ZONE}`,
    type: "HTTPS",
    svcPriority: 1,
    svcTargetName: ".",
    svcParams: "alpn|h2",
    autoIpv4Hint: true,
  },
  {
    domain: `_http._tcp.${ZONE}`,
    type: "URI",
    uriPriority: 10,
    uriWeight: 1,
    uri: "https://example.com/",
  },
  { domain: ZONE, type: "CAA", flags: 0, tag: "issue", value: "letsencrypt.org" },
  { domain: `aname.${ZONE}`, type: "ANAME", aname: "example.net" },
  // Types without their own parameters take wire-format RDATA: 192.0.2.0/24, and a digest.
  { domain: `apl.${ZONE}`, type: "APL", rdata: "00011803C00002" },
  { domain: ZONE, type: "ZONEMD", rdata: `0000000101${"01"}${"00".repeat(48)}` },
  { domain: `unknown.${ZONE}`, type: "65450", rdata: "0102" },
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
  for (const record of RECORDS)
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
});

describe("SDK responses", () => {
  it("reads a whole zone with every record type but APP and ALIAS", async () => {
    const records = await wholeZone(ZONE);
    expect(typesOf(records)).toEqual(
      [...new Set(["SOA", "NS", ...RECORDS.map((record) => String(record.type))])].sort(),
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
});
