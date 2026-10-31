// The pure parts of the Record resource: declarations, the marker and the record set rules.
import { describe, expect, it } from "vitest";
import {
  adoptionDifferences,
  canonicalAddress,
  type Desired,
  findRecord,
  markedComment,
  normalize,
  type Observed,
  ownerOf,
  parseComment,
  placement,
  reverseName,
} from "../../src/Record.ts";

const record = (overrides: Partial<Observed>): Observed => ({
  name: "www.example.com",
  type: "A",
  value: "192.0.2.1",
  ttl: 300,
  disabled: false,
  comment: "",
  owner: undefined,
  expiryTtl: 0,
  comments: "",
  ...overrides,
});
const want: Desired = {
  zone: "example.com",
  name: "www.example.com",
  type: "A",
  value: "192.0.2.2",
  ttl: undefined,
  comment: "",
  disabled: false,
};

describe("normalize", () => {
  it("lowercases names, drops trailing dots and canonicalizes addresses", () => {
    expect(
      normalize({
        zone: "Example.COM.",
        name: "WWW.example.com",
        type: "AAAA",
        address: "2001:DB8:0::1",
      }),
    ).toEqual({
      ok: true,
      desired: { ...want, type: "AAAA", value: "2001:db8::1" },
    });
  });

  it("lists every problem with a declaration", () => {
    const result = normalize({
      zone: "example.com",
      name: "www.other.com",
      type: "A",
      address: "192.168.010.1",
      ttl: 1.5,
      comment: "two\nlines",
    });
    expect(result.ok ? [] : result.problems).toEqual([
      'name "www.other.com" is not inside zone "example.com"; use the fully-qualified name',
      '"192.168.010.1" is not an IPv4 address',
      "ttl 1.5 is not a whole number of seconds",
      "comment must be one line without an [alchemy:...] marker",
    ]);
    expect(
      normalize({
        zone: "example.com",
        name: "ä.example.com",
        type: "CNAME",
        target: "x.example.com",
      }).ok,
    ).toBe(false);
    expect(
      normalize({
        zone: "example.com",
        name: "a.example.com",
        type: "CNAME",
        target: "A.example.com.",
      }).ok,
    ).toBe(false);
  });

  it("accepts the apex and wildcards", () => {
    expect(
      normalize({ zone: "example.com", name: "example.com", type: "A", address: "192.0.2.1" }).ok,
    ).toBe(true);
    expect(
      normalize({ zone: "example.com", name: "*.example.com", type: "A", address: "192.0.2.1" }).ok,
    ).toBe(true);
  });

  it("compares IPv4-mapped IPv6 addresses however they are written", () => {
    expect(canonicalAddress("AAAA", "::ffff:192.0.2.1")).toBe(
      canonicalAddress("AAAA", "::ffff:c000:201"),
    );
    expect(canonicalAddress("AAAA", "fe80::1%eth0")).toBeUndefined();
  });
});

describe("the marker", () => {
  const owner = ownerOf("infra", "prod", "Homelab/nas record");

  it("encodes each part so the marker stays one token", () => {
    expect(owner).toBe("infra/prod/Homelab/nas%20record");
    expect(markedComment("", owner)).toBe("[alchemy:infra/prod/Homelab/nas%20record]");
  });

  it("splits a stored comment into the comment and the owner", () => {
    expect(parseComment(markedComment("NAS on VLAN 10", owner))).toEqual({
      comment: "NAS on VLAN 10",
      owner,
    });
    expect(parseComment("by hand")).toEqual({ comment: "by hand", owner: undefined });
    expect(parseComment(undefined)).toEqual({ comment: "", owner: undefined });
  });
});

describe("findRecord", () => {
  const owner = ownerOf("infra", "prod", "nas");

  it("prefers the record with the marker, then the declared value", () => {
    const marked = record({ value: "192.0.2.9", owner });
    const plain = record({ value: "192.0.2.2" });
    expect(findRecord([plain, marked], "A", owner, "192.0.2.2")).toBe(marked);
    expect(findRecord([plain], "A", owner, "192.0.2.2")).toBe(plain);
    expect(findRecord([plain], "A", owner, "192.0.2.3")).toBeUndefined();
    expect(findRecord([marked, record({ value: "192.0.2.8", owner })], "A", owner, "x")).toBe(
      "ambiguous",
    );
  });

  it("treats the only CNAME at a name as the record whatever its target", () => {
    const alias = record({ type: "CNAME", value: "elsewhere.example.com" });
    expect(findRecord([alias], "CNAME", owner, "target.example.com")).toBe(alias);
  });
});

describe("placement", () => {
  it("takes the TTL of the records it joins", () => {
    expect(placement([record({ ttl: 120 })], want, undefined)).toEqual({ ttl: 120 });
    expect(placement([], want, undefined)).toEqual({ ttl: undefined });
  });

  it("refuses a TTL that would change the other records", () => {
    expect(placement([record({ ttl: 120 })], { ...want, ttl: 600 }, undefined)).toMatchObject({
      refused: expect.stringContaining("declare ttl: 120"),
    });
  });

  it("refuses to merge into an existing value or to share a name with a CNAME", () => {
    expect(placement([record({ value: "192.0.2.2" })], want, undefined)).toMatchObject({
      refused: expect.stringContaining("would merge"),
    });
    expect(placement([record({ type: "CNAME" })], want, undefined)).toMatchObject({
      refused: expect.stringContaining("has a CNAME record"),
    });
    expect(
      placement([record({})], { ...want, type: "CNAME", value: "x.example.com" }, undefined),
    ).toMatchObject({
      refused: expect.stringContaining("already has A records"),
    });
  });
});

describe("adoptionDifferences", () => {
  it("lists everything adoption would change besides the marker", () => {
    const current = record({ value: "192.0.2.2", ttl: 60, comment: "legacy", disabled: true });
    expect(adoptionDifferences({ ...want, ttl: 300 }, current)).toEqual([
      "ttl 60 (declared 300)",
      "disabled true (declared false)",
      'comment "legacy" (declared "")',
    ]);
    expect(adoptionDifferences({ ...want, comment: "legacy", disabled: true }, current)).toEqual(
      [],
    );
  });
});

describe("reverseName", () => {
  it("builds the PTR names Technitium deletes along with an address record", () => {
    expect(reverseName("A", "192.0.2.10")).toBe("10.2.0.192.in-addr.arpa");
    expect(reverseName("AAAA", "2001:db8::1")).toBe(
      "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa",
    );
  });
});
