// The Record resource through the real Alchemy plan and apply, against the test server.
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { renamedFrom } from "alchemy/Rename";
import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it } from "vitest";
import * as Technitium from "../../src/index.ts";
import { ZONES } from "./context.ts";
import { clearZone, commentsOf, harness, marked, recordsAt, webConsole } from "./harness.ts";

const ZONE = "example.test";
const WWW = "www.example.test";

const a = (
  props: Partial<{
    address: string;
    ttl: number;
    comment: string;
    disabled: boolean;
    name: string;
  }> = {},
) =>
  Technitium.Record("www", {
    zone: ZONE,
    name: props.name ?? WWW,
    type: "A",
    address: props.address ?? "192.0.2.10",
    ...(props.ttl === undefined ? {} : { ttl: props.ttl }),
    ...(props.comment === undefined ? {} : { comment: props.comment }),
    ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
  });

/** An A record at the zone apex, next to the zone's SOA and NS records. */
const apex = (address: string) =>
  Technitium.Record("apex", {
    zone: ZONE,
    name: ZONE,
    type: "A",
    address,
    ttl: 300,
    comment: "apex",
  }).pipe(RemovalPolicy.destroy());

interface ApexRecord {
  readonly type: string;
  readonly ttl: number;
  readonly disabled: boolean;
  readonly comments?: string;
  readonly rData: { readonly serial?: number } & Record<string, unknown>;
}

/** The zone's SOA and NS records, as the server reports them. */
async function zoneRecords() {
  const { records } = await webConsole<{ records: ApexRecord[] }>("/api/zones/records/get", {
    zone: ZONE,
    domain: ZONE,
  });
  return records
    .filter((record) => record.type === "SOA" || record.type === "NS")
    .map(({ type, ttl, disabled, comments, rData }) => ({ type, ttl, disabled, comments, rData }));
}

/** Changes the SOA record's refresh interval in the web console and keeps everything else. */
async function setSoaRefresh(refresh: number) {
  const soa = (await zoneRecords()).find((record) => record.type === "SOA");
  if (soa === undefined) throw new Error("no SOA record");
  const { primaryNameServer, responsiblePerson, serial, retry, expire, minimum } = soa.rData;
  await webConsole("/api/zones/records/update", {
    zone: ZONE,
    domain: ZONE,
    type: "SOA",
    ttl: soa.ttl,
    ...Object.fromEntries(
      Object.entries({ primaryNameServer, responsiblePerson, serial, retry, expire, minimum }).map(
        ([key, value]) => [key, String(value)],
      ),
    ),
    refresh,
  });
}

/** A record added in the web console, outside Alchemy. */
const addByHand = (params: Record<string, string | number | boolean>) =>
  webConsole("/api/zones/records/add", { zone: ZONE, domain: WWW, ...params });

beforeEach(() => clearZone(ZONE));

describe("Technitium.Record", () => {
  it("creates a marked record, then plans no change and writes nothing", async () => {
    const serial = async () =>
      (
        await webConsole<{ zone: { soaSerial: number } }>("/api/zones/records/get", {
          zone: ZONE,
          domain: ZONE,
        })
      ).zone.soaSerial;
    const before = await serial();
    const stack = harness();
    await stack.deploy(a({ ttl: 300, comment: "web server" }));
    // A new serial makes secondary servers transfer the zone.
    expect(await serial()).toBeGreaterThan(before);
    expect(await recordsAt(ZONE, WWW)).toEqual([
      {
        type: "A",
        value: "192.0.2.10",
        ttl: 300,
        disabled: false,
        comments: marked("www", "web server"),
      },
    ]);
    expect(stack.writes).toEqual([`add ${WWW}`]);

    const plan = await stack.plan(a({ ttl: 300, comment: "web server" }));
    expect(plan.resources.www?.action).toBe("noop");
    await stack.deploy(a({ ttl: 300, comment: "web server" }));
    expect(stack.writes).toHaveLength(1);
    expect((await stack.attributes()).www).toEqual({
      zone: ZONE,
      name: WWW,
      type: "A",
      value: "192.0.2.10",
      ttl: 300,
      comment: "web server",
      disabled: false,
    });
  });

  it("compares IPv6 addresses in canonical form", async () => {
    const stack = harness();
    const v6 = (address: string) =>
      Technitium.Record("v6", { zone: ZONE, name: WWW, type: "AAAA", address });
    await stack.deploy(v6("2001:DB8:0:0::10"));
    expect((await recordsAt(ZONE, WWW))[0]?.value).toBe("2001:db8::10");
    expect((await stack.plan(v6("2001:db8::10"))).resources.v6?.action).toBe("noop");
  });

  it("changes address, TTL, comment, disabled state and name in place", async () => {
    const stack = harness();
    await stack.deploy(a());
    await stack.deploy(a({ address: "192.0.2.11", ttl: 60, comment: "moved", disabled: true }));
    expect(await recordsAt(ZONE, WWW)).toEqual([
      {
        type: "A",
        value: "192.0.2.11",
        ttl: 60,
        disabled: true,
        comments: marked("www", "moved"),
      },
    ]);
    await stack.deploy(
      a({
        name: "web.example.test",
        address: "192.0.2.11",
        ttl: 60,
        comment: "moved",
        disabled: true,
      }),
    );
    expect(await recordsAt(ZONE, WWW)).toEqual([]);
    expect(await recordsAt(ZONE, "web.example.test")).toHaveLength(1);
    expect(stack.writes).toEqual([`add ${WWW}`, `update ${WWW}`, `update ${WWW}`]);
  });

  it("finds a record that was already renamed when the state was not saved", async () => {
    const stack = harness();
    await stack.deploy(a({ ttl: 300 }));
    // The same request a rename sends, without Alchemy recording it.
    await webConsole("/api/zones/records/update", {
      zone: ZONE,
      domain: WWW,
      newDomain: "web.example.test",
      type: "A",
      ipAddress: "192.0.2.10",
      ttl: 300,
      comments: await commentsOf(ZONE, WWW, "A"),
    });
    await stack.deploy(a({ name: "web.example.test", ttl: 300 }));
    expect(stack.writes).toEqual([`add ${WWW}`]);
    expect((await stack.attributes()).www).toMatchObject({ name: "web.example.test" });
  });

  it("follows a logical ID rename with renamedFrom", async () => {
    const stack = harness();
    await stack.deploy(a().pipe(RemovalPolicy.destroy()));
    const renamed = Technitium.Record("web", {
      zone: ZONE,
      name: WWW,
      type: "A",
      address: "192.0.2.10",
    }).pipe(renamedFrom("www"), RemovalPolicy.destroy());
    // The state moves to the new ID, and the engine's update replaces the old marker.
    await stack.deploy(renamed);
    expect(await recordsAt(ZONE, WWW)).toMatchObject([{ comments: marked("web") }]);
    await stack.destroy();
    expect(await recordsAt(ZONE, WWW)).toEqual([]);
    expect(stack.writes).toEqual([`add ${WWW}`, `update ${WWW}`, `delete ${WWW}`]);
  });

  it("passes another resource's output in the same plan", async () => {
    const stack = harness();
    const pair = (address: string) =>
      Effect.gen(function* () {
        const host = yield* Technitium.Record("host", {
          zone: ZONE,
          name: "host.example.test",
          type: "A",
          address,
        });
        yield* Technitium.Record("alias", {
          zone: ZONE,
          name: WWW,
          type: "CNAME",
          target: host.name,
        });
      });
    await stack.deploy(pair("192.0.2.20"));
    expect(await recordsAt(ZONE, WWW)).toMatchObject([
      { type: "CNAME", value: "host.example.test" },
    ]);
    await stack.deploy(pair("192.0.2.21"));
    expect(await recordsAt(ZONE, "host.example.test")).toMatchObject([{ value: "192.0.2.21" }]);
    // The alias's target was unresolved at plan time; reconcile found nothing to write.
    expect(stack.writes).toEqual([
      "add host.example.test",
      `add ${WWW}`,
      "update host.example.test",
    ]);
  });

  it("joins and changes a record set without touching the records it does not manage", async () => {
    await addByHand({ type: "A", ipAddress: "192.0.2.99", ttl: 120, comments: "by hand" });
    await webConsole("/api/zones/records/update", {
      zone: ZONE,
      domain: WWW,
      type: "A",
      ipAddress: "192.0.2.99",
      ttl: 120,
      comments: "by hand",
      disable: true,
    });
    const unmanaged = {
      type: "A",
      value: "192.0.2.99",
      ttl: 120,
      disabled: true,
      comments: "by hand",
    };
    const stack = harness();
    // Without a TTL, the record takes the TTL of the set.
    await stack.deploy(a());
    await stack.deploy(a({ address: "192.0.2.12", comment: "managed" }));
    expect(await recordsAt(ZONE, WWW)).toEqual([
      {
        type: "A",
        value: "192.0.2.12",
        ttl: 120,
        disabled: false,
        comments: marked("www", "managed"),
      },
      unmanaged,
    ]);
    // A new TTL would apply to the unmanaged record too, and reset its comment and state.
    const ttl = await stack.deployFailure(
      a({ address: "192.0.2.12", comment: "managed", ttl: 600 }),
    );
    expect(ttl).toContain("TechnitiumRecordRefused");
    // Changing the address to the unmanaged record's would merge the two.
    const merge = await stack.deployFailure(a({ address: "192.0.2.99", comment: "managed" }));
    expect(merge).toContain("would merge the two records");
    expect(stack.writes).toEqual([`add ${WWW}`, `update ${WWW}`]);

    await stack.deploy(
      a({ address: "192.0.2.12", comment: "managed" }).pipe(RemovalPolicy.destroy()),
    );
    await stack.deploy(Effect.void);
    expect(await recordsAt(ZONE, WWW)).toEqual([unmanaged]);
  });

  it("refuses records that cannot share a name", async () => {
    await addByHand({ type: "CNAME", cname: "elsewhere.example.test" });
    const stack = harness();
    expect(await stack.deployFailure(a())).toContain("has a CNAME record");
    await clearZone(ZONE);
    await addByHand({ type: "A", ipAddress: "192.0.2.1" });
    const alias = Technitium.Record("alias", {
      zone: ZONE,
      name: WWW,
      type: "CNAME",
      target: "x.example.test",
    });
    expect(await stack.deployFailure(alias)).toContain("cannot share its name");
    expect(stack.writes).toEqual([]);
  });

  it("adopts an existing record only with --adopt, and adoption only adds the marker", async () => {
    await addByHand({ type: "A", ipAddress: "192.0.2.10", ttl: 60, comments: "legacy" });
    const stack = harness();
    expect(await stack.deployFailure(a({ ttl: 60, comment: "legacy" }))).toContain(
      "OwnedBySomeoneElse",
    );
    const changed = await stack.deployFailure(a({ ttl: 300, comment: "legacy" }), true);
    expect(changed).toContain("ttl 60 (declared 300)");
    expect(stack.writes).toEqual([]);
    await stack.deploy(a({ ttl: 60, comment: "legacy" }), true);
    expect(await recordsAt(ZONE, WWW)).toEqual([
      {
        type: "A",
        value: "192.0.2.10",
        ttl: 60,
        disabled: false,
        comments: marked("www", "legacy"),
      },
    ]);
    expect(stack.writes).toEqual([`update ${WWW}`]);
  });

  it("recovers lost state from the marker without --adopt, rewriting only the marker", async () => {
    const stack = harness();
    await stack.deploy(a({ ttl: 300 }));
    const before = await recordsAt(ZONE, WWW);
    stack.loseState();
    await stack.deploy(a({ ttl: 300 }));
    // The new state has a new instance, so the marker's instance part is rewritten once.
    expect(stack.writes).toEqual([`add ${WWW}`, `update ${WWW}`]);
    expect(await recordsAt(ZONE, WWW)).toEqual([{ ...before[0], comments: marked("www") }]);
    expect((await recordsAt(ZONE, WWW))[0]?.comments).not.toBe(before[0]?.comments);
    expect((await stack.attributes()).www).toMatchObject({ value: "192.0.2.10", ttl: 300 });
    // Another stack sees the marker of this one and needs --adopt.
    expect(await harness({ stack: "other" }).deployFailure(a({ ttl: 300 }))).toContain(
      "OwnedBySomeoneElse",
    );
  });

  it("detects and repairs changes made in the web console", async () => {
    const stack = harness();
    await stack.deploy(a({ ttl: 300 }));
    await webConsole("/api/zones/records/update", {
      zone: ZONE,
      domain: WWW,
      type: "A",
      ipAddress: "192.0.2.10",
      newIpAddress: "192.0.2.50",
      ttl: 300,
      comments: await commentsOf(ZONE, WWW, "A"),
    });
    const detected = await stack.drift();
    expect(Object.values(detected.resources)[0]).toMatchObject({
      action: "drifted",
      attr: { value: "192.0.2.50" },
    });
    await stack.drift(true);
    expect(await recordsAt(ZONE, WWW)).toMatchObject([
      { value: "192.0.2.10", comments: marked("www") },
    ]);

    await clearZone(ZONE);
    expect(Object.values((await stack.drift()).resources)[0]?.action).toBe("missing");
    await stack.drift(true);
    expect(await recordsAt(ZONE, WWW)).toMatchObject([{ value: "192.0.2.10" }]);
  });

  it("keeps removed records unless their removal policy is destroy", async () => {
    const stack = harness();
    await stack.deploy(a());
    await stack.deploy(Effect.void);
    expect(await recordsAt(ZONE, WWW)).toHaveLength(1);

    await clearZone(ZONE);
    const destroyed = harness();
    await destroyed.deploy(a().pipe(RemovalPolicy.destroy()));
    await destroyed.destroy();
    expect(await recordsAt(ZONE, WWW)).toEqual([]);
    expect(destroyed.writes).toEqual([`add ${WWW}`, `delete ${WWW}`]);
  });

  it("deletes only a record that still carries its marker", async () => {
    const stack = harness();
    await stack.deploy(a().pipe(RemovalPolicy.destroy()));
    await webConsole("/api/zones/records/update", {
      zone: ZONE,
      domain: WWW,
      type: "A",
      ipAddress: "192.0.2.10",
      ttl: 3600,
      comments: "someone else's now",
    });
    expect(await stack.destroyFailure()).toContain("does not carry this resource's marker");
    expect(await recordsAt(ZONE, WWW)).toHaveLength(1);
  });

  it("never changes a record that lost this resource's marker or carries another one", async () => {
    const stack = harness();
    await stack.deploy(a({ ttl: 300 }));
    // Deleted and recreated in the web console with the same address, without the marker.
    await webConsole("/api/zones/records/delete", {
      zone: ZONE,
      domain: WWW,
      type: "A",
      ipAddress: "192.0.2.10",
    });
    await addByHand({
      type: "A",
      ipAddress: "192.0.2.10",
      ttl: 300,
      comments: "externally recreated",
    });
    const recreated = await recordsAt(ZONE, WWW);
    expect(await stack.deployFailure(a({ address: "192.0.2.11", ttl: 300 }))).toContain(
      "has no marker of this resource",
    );
    expect(await recordsAt(ZONE, WWW)).toEqual(recreated);
    // Taken over by another resource of the same stack and stage.
    await webConsole("/api/zones/records/update", {
      zone: ZONE,
      domain: WWW,
      type: "A",
      ipAddress: "192.0.2.10",
      ttl: 300,
      comments: "[alchemy:technitium/test/other#00000000]",
    });
    const reassigned = await recordsAt(ZONE, WWW);
    expect(await stack.deployFailure(a({ address: "192.0.2.11", ttl: 300 }))).toContain(
      "carries the marker of technitium/test/other",
    );
    expect(await recordsAt(ZONE, WWW)).toEqual(reassigned);
    expect(stack.writes).toEqual([`add ${WWW}`]);
  });

  it("deletes an address record only when it can check that Technitium keeps the PTR records", async () => {
    const ptrName = "10.2.0.192.in-addr.arpa";
    const reversePermissions = (userPermissions: string) =>
      webConsole("/api/zones/permissions/set", {
        zone: ZONES.reverse,
        userPermissions,
        groupPermissions: "Administrators|true|true|true",
      });
    await webConsole("/api/zones/records/add", {
      zone: ZONES.reverse,
      domain: ptrName,
      type: "PTR",
      ptrName: WWW,
    });
    try {
      const stack = harness();
      await stack.deploy(a().pipe(RemovalPolicy.destroy()));
      // Delete without View: Technitium would delete the PTR record the provider cannot see.
      await reversePermissions("alchemy|false|false|true");
      expect(await stack.destroyFailure()).toContain("cannot read the reverse zone");
      // View: the provider sees the PTR record and refuses.
      await reversePermissions("alchemy|true|false|false");
      expect(await stack.destroyFailure()).toContain(`PTR record ${ptrName}`);
      expect(await recordsAt(ZONES.reverse, ptrName)).toHaveLength(1);
      expect(await recordsAt(ZONE, WWW)).toHaveLength(1);
      // Without a PTR record, the deletion goes ahead.
      await clearZone(ZONES.reverse);
      await stack.destroy();
      expect(await recordsAt(ZONE, WWW)).toEqual([]);
    } finally {
      await clearZone(ZONES.reverse);
      await reversePermissions("alchemy|true|false|false");
    }
  });

  it("adopts, changes, deletes and creates a record at the zone apex", async () => {
    await webConsole("/api/zones/records/add", {
      zone: ZONE,
      domain: ZONE,
      type: "A",
      ipAddress: "192.0.2.50",
      ttl: 300,
      comments: "apex",
    });
    const before = await zoneRecords();
    const stack = harness();
    await stack.deploy(apex("192.0.2.50"), true);
    await stack.deploy(apex("192.0.2.51"));
    await stack.destroy();
    const created = harness();
    await created.deploy(apex("192.0.2.52"));
    expect((await recordsAt(ZONE, ZONE)).filter((record) => record.type === "A")).toEqual([
      {
        type: "A",
        value: "192.0.2.52",
        ttl: 300,
        disabled: false,
        comments: marked("apex", "apex"),
      },
    ]);
    const writes = [...stack.writes, ...created.writes];
    expect(writes).toEqual([`update ${ZONE}`, `update ${ZONE}`, `delete ${ZONE}`, `add ${ZONE}`]);
    // Each write raised the SOA serial once, and nothing else changed at the apex.
    const after = await zoneRecords();
    const serial = (records: readonly ApexRecord[]) =>
      records.find((record) => record.type === "SOA")?.rData.serial ?? 0;
    expect(serial(after)).toBe(serial(before) + writes.length);
    const withoutSerial = (records: readonly ApexRecord[]) =>
      records.map((record) => ({ ...record, rData: { ...record.rData, serial: undefined } }));
    expect(withoutSerial(after)).toEqual(withoutSerial(before));
  });

  it("still fails when another SOA setting changes during a write at the apex", async () => {
    const [soa] = (await zoneRecords()).filter((record) => record.type === "SOA");
    const refresh = Number(soa?.rData.refresh);
    const stack = harness({ beforeWrite: () => setSoaRefresh(refresh + 600) });
    try {
      const failure = await stack.deployFailure(apex("192.0.2.50"));
      expect(failure).toContain(`other records at "${ZONE}" changed during the write`);
      expect(failure).toContain(`"refresh":${refresh + 600}`);
    } finally {
      await setSoaRefresh(refresh);
    }
  });

  it("refuses zones that do not exist or are not Primary", async () => {
    const stack = harness();
    const at = (zone: string, name: string) =>
      Technitium.Record("www", { zone, name, type: "A", address: "192.0.2.10" });
    // Technitium would fall back to the closest enclosing zone, example.test.
    expect(await stack.planFailure(at("sub.example.test", "www.sub.example.test"))).toContain(
      'zone "sub.example.test" does not exist',
    );
    expect(await stack.planFailure(at(ZONES.forwarder, `www.${ZONES.forwarder}`))).toContain(
      "Forwarder zone",
    );
    expect(await stack.planFailure(at(ZONE, "www.other.test"))).toContain("is not inside zone");
    expect(stack.writes).toEqual([]);
  });

  it("logs in through TECHNITIUM_API_TOKEN and TECHNITIUM_API_URL with the default providers", async () => {
    const stack = harness({ login: true });
    await stack.deploy(a().pipe(RemovalPolicy.destroy()));
    expect(await recordsAt(ZONE, WWW)).toHaveLength(1);
    await stack.destroy();
    expect(await recordsAt(ZONE, WWW)).toEqual([]);
  });
});
