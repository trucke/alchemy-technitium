import { isIPv4, isIPv6 } from "node:net";
import * as Technitium from "@distilled.cloud/technitium";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

export type RecordType = "A" | "AAAA" | "CNAME";

interface RecordCommonProps {
  /**
   * An existing Primary zone on the server, such as `homelab.example.com`. The provider never
   * creates zones and never writes to a zone other than this one. Cannot change.
   */
  readonly zone: string;
  /**
   * The record's fully-qualified name inside `zone`, such as `nas.homelab.example.com`, or the
   * zone name itself for the apex. Changing it renames the record in place.
   */
  readonly name: string;
  /**
   * TTL in seconds. All records with the same name and type share one TTL, so a record with
   * other records next to it must declare their TTL or leave `ttl` out.
   * @default the TTL of the other records with the same name and type, or the server's default
   */
  readonly ttl?: number;
  /**
   * Shown in the web console. The provider appends its ownership marker to it.
   * @default ""
   */
  readonly comment?: string;
  /**
   * Whether the server leaves the record out of answers.
   * @default false
   */
  readonly disabled?: boolean;
}

export type RecordProps = RecordCommonProps &
  (
    | {
        /** An IPv4 address record. Cannot change. */
        readonly type: "A";
        /** IPv4 address, such as `192.0.2.10`. Changes in place. */
        readonly address: string;
      }
    | {
        /** An IPv6 address record. Cannot change. */
        readonly type: "AAAA";
        /** IPv6 address, such as `2001:db8::10`. Changes in place. */
        readonly address: string;
      }
    | {
        /** An alias record. Cannot change. */
        readonly type: "CNAME";
        /** The name the alias points to, such as `ingress.homelab.example.com`. Changes in place. */
        readonly target: string;
      }
  );

export interface RecordAttributes {
  /** The zone that holds the record. */
  readonly zone: string;
  /** The record's fully-qualified name, lowercase. */
  readonly name: string;
  readonly type: RecordType;
  /** The address of an A or AAAA record, or the target of a CNAME record. */
  readonly value: string;
  /** TTL in seconds, shared with the other records of the same name and type. */
  readonly ttl: number;
  /** The comment without the provider's ownership marker. */
  readonly comment: string;
  readonly disabled: boolean;
}

export type Record = Resource<
  "Technitium.Record",
  RecordProps,
  RecordAttributes,
  never,
  import("./Providers.ts").Providers
>;

/**
 * One A, AAAA or CNAME record in an existing Primary zone of a Technitium DNS Server.
 *
 * Technitium records have no IDs. A record is identified by its zone, name, type and value, and
 * the provider marks the records it manages with `[alchemy:<stack>/<stage>/<resource>#<instance>]`
 * at the end of their comment. A record without this resource's marker is never changed: without
 * state it needs `--adopt`, and adopting adds the marker without changing anything else. Other
 * records with the same name and type
 * are left as they are; a change that Technitium would apply to them as well, such as a new
 * TTL, fails the plan.
 *
 * Changes are made in place, including a new address, target or name, so other resources can
 * pass an address to a record in the same plan. Removing a record from the stack keeps it on
 * the server; deleting it needs `RemovalPolicy.destroy()`.
 *
 * **Example:** an address that follows a container
 * ```typescript
 * yield* Technitium.Record("nas", {
 *   zone: "homelab.example.com",
 *   name: "nas.homelab.example.com",
 *   type: "A",
 *   address: "192.168.10.20",
 *   ttl: 300,
 * });
 * ```
 *
 * **Example:** an alias that Alchemy deletes when it leaves the stack
 * ```typescript
 * yield* Technitium.Record("grafana", {
 *   zone: "apps.example.com",
 *   name: "grafana.apps.example.com",
 *   type: "CNAME",
 *   target: "ingress.apps.example.com",
 * }).pipe(RemovalPolicy.destroy());
 * ```
 * @resource
 */
export const Record = Resource<Record>("Technitium.Record", { defaultRemovalPolicy: "retain" });

/** The declaration is invalid. Nothing was written. */
export class TechnitiumRecordInvalid extends Data.TaggedError("TechnitiumRecordInvalid")<{
  message: string;
}> {}

/** The server holds something the provider must not change. Nothing was written. */
export class TechnitiumRecordRefused extends Data.TaggedError("TechnitiumRecordRefused")<{
  message: string;
}> {}

/** After a write, the server holds something other than what was sent. */
export class TechnitiumRecordMismatch extends Data.TaggedError("TechnitiumRecordMismatch")<{
  message: string;
}> {}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/** A declaration in the form the server reports: lowercase names and canonical addresses. */
export interface Desired {
  readonly zone: string;
  readonly name: string;
  readonly type: RecordType;
  readonly value: string;
  /** `undefined` leaves the TTL to the record set or the server. */
  readonly ttl: number | undefined;
  readonly comment: string;
  readonly disabled: boolean;
}

const normalizeName = (name: string) => name.trim().toLowerCase().replace(/\.$/, "");
const LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;
const validName = (name: string, wildcard: boolean) =>
  name.length > 0 &&
  name.length <= 253 &&
  name.split(".").every((label, i) => (wildcard && i === 0 && label === "*") || LABEL.test(label));

/** The canonical form of an address, as the server prints it, or `undefined` when invalid. */
export function canonicalAddress(type: "A" | "AAAA", address: string): string | undefined {
  if (type === "A") return isIPv4(address) ? address : undefined;
  if (!isIPv6(address) || address.includes("%")) return undefined;
  return new URL(`http://[${address}]`).hostname.slice(1, -1);
}

/** Validates a declaration and normalizes it, or lists what is wrong with it. */
export function normalize(
  props: RecordProps,
):
  | { readonly ok: true; readonly desired: Desired }
  | { readonly ok: false; readonly problems: string[] } {
  const problems: string[] = [];
  const zone = normalizeName(props.zone);
  const name = normalizeName(props.name);
  if (!validName(zone, false))
    problems.push(`zone "${props.zone}" is not a valid DNS name (use the ASCII form)`);
  if (!validName(name, true))
    problems.push(`name "${props.name}" is not a valid DNS name (use the ASCII form)`);
  else if (name !== zone && !name.endsWith(`.${zone}`))
    problems.push(`name "${name}" is not inside zone "${zone}"; use the fully-qualified name`);
  let value: string | undefined;
  if (props.type === "CNAME") {
    value = normalizeName(props.target);
    if (!validName(value, false)) problems.push(`target "${props.target}" is not a valid DNS name`);
    else if (value === name) problems.push("a CNAME record cannot point at its own name");
  } else if (props.type === "A" || props.type === "AAAA") {
    value = canonicalAddress(props.type, props.address);
    if (value === undefined)
      problems.push(`"${props.address}" is not an ${props.type === "A" ? "IPv4" : "IPv6"} address`);
  } else problems.push(`type must be A, AAAA or CNAME`);
  if (
    props.ttl !== undefined &&
    !(Number.isInteger(props.ttl) && props.ttl >= 0 && props.ttl <= 2_147_483_647)
  )
    problems.push(`ttl ${props.ttl} is not a whole number of seconds`);
  const comment = props.comment ?? "";
  if (/[\r\n]/.test(comment) || comment.includes("[alchemy:"))
    problems.push("comment must be one line without an [alchemy:...] marker");
  if (problems.length > 0 || value === undefined) return { ok: false, problems };
  return {
    ok: true,
    desired: {
      zone,
      name,
      type: props.type,
      value,
      ttl: props.ttl,
      comment: comment.trim(),
      disabled: props.disabled ?? false,
    },
  };
}

const validate = (props: RecordProps) => {
  const result = normalize(props);
  return result.ok
    ? Effect.succeed(result.desired)
    : Effect.fail(
        new TechnitiumRecordInvalid({
          message: `Technitium record "${props.name}": ${result.problems.join("; ")}`,
        }),
      );
};

// ---------------------------------------------------------------------------
// Ownership marker
// ---------------------------------------------------------------------------

/**
 * The resource that manages a record. `path` is the stack, the stage and the resource's
 * fully-qualified name, each segment URI-encoded so the marker stays one token. `instance` is
 * the first eight hex digits of Alchemy's instance ID, which a `renamedFrom` rename keeps and
 * which differs between resources.
 */
export interface Owner {
  readonly path: string;
  readonly instance: string;
}

export const ownerOf = (stack: string, stage: string, fqn: string, instanceId: string): Owner => ({
  path: [stack, stage, ...fqn.split("/")].map(encodeURIComponent).join("/"),
  instance: instanceId.slice(0, 8),
});

const currentOwner = (fqn: string, instanceId: string) =>
  Effect.gen(function* () {
    const stack = yield* Stack;
    const stage = yield* Stage;
    return ownerOf(stack.name, stage, fqn, instanceId);
  });

/** A marker as found in a comment. Markers written before 0.2.0 have no instance. */
export interface Marker {
  readonly path: string;
  readonly instance: string | undefined;
}

export const markerText = (owner: Owner) => `[alchemy:${owner.path}#${owner.instance}]`;

/** The comment the server stores: the declared comment, then the marker. */
export const markedComment = (comment: string, owner: Owner) =>
  comment === "" ? markerText(owner) : `${comment} ${markerText(owner)}`;

/** Splits a stored comment into the comment and its marker, if any. */
export function parseComment(comments: string | undefined): {
  readonly comment: string;
  readonly marker: Marker | undefined;
} {
  const match = /^([\s\S]*?)\s*\[alchemy:([^\]\s#]+)(?:#([0-9a-f]+))?\]\s*$/.exec(comments ?? "");
  return match
    ? { comment: match[1]!, marker: { path: match[2]!, instance: match[3] } }
    : { comment: (comments ?? "").trim(), marker: undefined };
}

/**
 * Whose a record is. A marker with this resource's path, or with its instance in the same stack
 * and stage after a `renamedFrom` rename, is `ours`. A record without a marker may have been
 * recreated outside Alchemy, and one with another marker belongs to another resource.
 */
export function ownership(
  marker: Marker | undefined,
  owner: Owner,
): "ours" | "unmarked" | "foreign" {
  if (marker === undefined) return "unmarked";
  if (marker.path === owner.path) return "ours";
  const stage = (path: string) => path.split("/").slice(0, 2).join("/");
  return stage(marker.path) === stage(owner.path) && marker.instance === owner.instance
    ? "ours"
    : "foreign";
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

type LiveRecord = Technitium.zones.GetRecordsResponseRecordsItem;

/** A record as the server reports it, with its comment split from the marker. */
export interface Observed {
  readonly name: string;
  readonly type: string;
  /**
   * The canonical address or target; the raw data for other types, except the SOA serial. The
   * server raises the serial with every write to the zone, so it is no change to look out for.
   */
  readonly value: string;
  readonly ttl: number;
  readonly disabled: boolean;
  readonly comment: string;
  readonly marker: Marker | undefined;
  readonly expiryTtl: number;
  /** The stored comment, to detect changes to records the provider does not manage. */
  readonly comments: string;
}

export function observeRecord(record: LiveRecord): Observed {
  const { comment, marker } = parseComment(record.comments);
  const data = record.rData;
  const value =
    record.type === "A" || record.type === "AAAA"
      ? (canonicalAddress(record.type, data.ipAddress ?? "") ?? data.ipAddress ?? "")
      : record.type === "CNAME"
        ? normalizeName(data.cname ?? "")
        : JSON.stringify(record.type === "SOA" ? { ...data, serial: undefined } : data);
  return {
    name: normalizeName(record.name),
    type: record.type,
    value,
    ttl: record.ttl,
    disabled: record.disabled,
    comment,
    marker,
    expiryTtl: record.expiryTtl,
    comments: record.comments ?? "",
  };
}

/**
 * Records that Technitium derives from the others when it signs a zone and renews with every
 * write. They belong to no one, and DNS lets them share a name with a CNAME record.
 */
const SIGNATURES: ReadonlySet<string> = new Set(["RRSIG", "NSEC", "NSEC3"]);

/**
 * Every record at one name of a zone, after checking that the zone exists and is Primary,
 * without {@link SIGNATURES}.
 */
interface NameRecords {
  readonly zone: string;
  readonly name: string;
  readonly records: readonly Observed[];
}

/**
 * The records at one name of a zone, or `"no-zone"` when the zone does not exist. Technitium
 * answers for the closest enclosing zone when the named zone does not exist, and with
 * `No such zone was found` when there is none.
 */
const lookupName = (zone: string, name: string) =>
  Technitium.zones.getRecords({ zone, domain: name }).pipe(
    Effect.map((response) => ({ response })),
    Effect.catchTag("TechnitiumError", (error) =>
      error.message.startsWith("No such zone was found")
        ? Effect.succeed({ response: undefined })
        : Effect.fail(
            new TechnitiumRecordRefused({
              message: `Technitium zone "${zone}" could not be read: ${error.message}`,
            }),
          ),
    ),
    Effect.flatMap(
      ({ response }): Effect.Effect<NameRecords | "no-zone", TechnitiumRecordRefused> => {
        if (response === undefined || normalizeName(response.zone?.name ?? "") !== zone)
          return Effect.succeed("no-zone");
        if (response.zone?.type !== "Primary")
          return Effect.fail(
            new TechnitiumRecordRefused({
              message: `Technitium zone "${zone}" is a ${response.zone?.type ?? "unknown"} zone; records can only be managed in Primary zones.`,
            }),
          );
        return Effect.succeed({
          zone,
          name,
          records: (response.records ?? [])
            .map(observeRecord)
            .filter((record) => record.name === name && !SIGNATURES.has(record.type)),
        });
      },
    ),
  );

/** The records at one name of a zone that must exist. */
const observeName = (zone: string, name: string) =>
  Effect.flatMap(lookupName(zone, name), (found) =>
    found === "no-zone"
      ? Effect.fail(
          new TechnitiumRecordRefused({
            message: `Technitium zone "${zone}" does not exist. The provider does not create zones.`,
          }),
        )
      : Effect.succeed(found),
  );

/**
 * The record a resource manages among the records at its name: the one with its marker,
 * otherwise the one with its value (for a CNAME, the only one). The caller decides from
 * {@link ownership} whether it may change the second kind.
 */
export function findRecord(
  records: readonly Observed[],
  type: RecordType,
  owner: Owner,
  value: string,
): Observed | "ambiguous" | undefined {
  const sameType = records.filter((record) => record.type === type);
  const marked = sameType.filter((record) => ownership(record.marker, owner) === "ours");
  if (marked.length > 1) return "ambiguous";
  if (marked[0]) return marked[0];
  return type === "CNAME" ? sameType[0] : sameType.find((record) => record.value === value);
}

const find = (set: NameRecords, type: RecordType, owner: Owner, value: string) => {
  const found = findRecord(set.records, type, owner, value);
  return found === "ambiguous"
    ? Effect.fail(
        new TechnitiumRecordRefused({
          message: `Technitium has several ${type} records at "${set.name}" with the marker of this resource. Remove all but one in the web console first.`,
        }),
      )
    : Effect.succeed(found);
};

const toAttributes = (zone: string, record: Observed, type: RecordType): RecordAttributes => ({
  zone,
  name: record.name,
  type,
  value: record.value,
  ttl: record.ttl,
  comment: record.comment,
  disabled: record.disabled,
});

/** The parts of a record that other records at its name must keep across a write. */
const fingerprint = (records: readonly Observed[], except: readonly Observed[]) =>
  records
    .filter((record) => !except.some((e) => e.type === record.type && e.value === record.value))
    .map(
      (r) =>
        `${r.type} ${r.value} ttl=${r.ttl} disabled=${r.disabled} comments=${JSON.stringify(r.comments)}`,
    )
    .sort();

// ---------------------------------------------------------------------------
// Checks before writing
// ---------------------------------------------------------------------------

const refuse = (message: string) => Effect.fail(new TechnitiumRecordRefused({ message }));

/**
 * Checks that `want` can join the records at its name without changing them, and returns the
 * TTL to write. `moving` is the managed record when it is already among them.
 */
export function placement(
  records: readonly Observed[],
  want: Desired,
  moving: Observed | undefined,
): { readonly ttl: number | undefined } | { readonly refused: string } {
  const label = `${want.type} record "${want.name}"`;
  const others = records.filter((record) => record !== moving);
  if (want.type === "CNAME") {
    if (others.length > 0)
      return {
        refused: `${label}: the name already has ${[...new Set(others.map((r) => r.type))].join(", ")} records, and a CNAME record cannot share its name.`,
      };
    return { ttl: want.ttl ?? moving?.ttl };
  }
  if (others.some((record) => record.type === "CNAME"))
    return { refused: `${label}: the name has a CNAME record, which cannot share its name.` };
  const siblings = others.filter((record) => record.type === want.type);
  if (siblings.some((record) => record.value === want.value))
    return {
      refused: `${label}: ${want.value} already exists at this name without this resource's marker. Technitium would merge the two records; adopt the existing one with --adopt instead.`,
    };
  const shared = siblings[0]?.ttl;
  if (shared !== undefined && want.ttl !== undefined && want.ttl !== shared)
    return {
      refused: `${label}: the other ${want.type} records at this name have TTL ${shared}. Technitium applies one TTL to all of them and resets their comments and disabled state when it changes, so declare ttl: ${shared} or leave ttl out.`,
    };
  return { ttl: want.ttl ?? shared ?? moving?.ttl };
}

/** Why adopting `current` for `want` would change more than the marker, if it would. */
export function adoptionDifferences(want: Desired, current: Observed): string[] {
  const differences: string[] = [];
  if (current.value !== want.value)
    differences.push(`value ${current.value} (declared ${want.value})`);
  if (want.ttl !== undefined && current.ttl !== want.ttl)
    differences.push(`ttl ${current.ttl} (declared ${want.ttl})`);
  if (current.disabled !== want.disabled)
    differences.push(`disabled ${current.disabled} (declared ${want.disabled})`);
  if (current.comment !== want.comment)
    differences.push(
      `comment ${JSON.stringify(current.comment)} (declared ${JSON.stringify(want.comment)})`,
    );
  return differences;
}

/** The reverse-lookup name of an address: `10.2.0.192.in-addr.arpa` or nibbles in `ip6.arpa`. */
export function reverseName(type: "A" | "AAAA", address: string): string {
  if (type === "A") return `${address.split(".").reverse().join(".")}.in-addr.arpa`;
  const [head = "", tail = ""] = address.split("::");
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const missing = 8 - groups(head).length - groups(tail).length;
  const full = [
    ...groups(head),
    ...Array<string>(address.includes("::") ? missing : 0).fill("0"),
    ...groups(tail),
  ];
  return `${[...full.map((group) => group.padStart(4, "0")).join("")].reverse().join(".")}.ip6.arpa`;
}

/**
 * Technitium deletes the PTR record that points back at a deleted A or AAAA record whenever the
 * token may delete in the reverse zone, and offers no way to turn this off. A token can have
 * Delete without View there, and no call tells a token its own zone permissions. So the provider
 * deletes only when no zone holds the reverse name, or when it can read that zone and finds no
 * such PTR record. Anything else is refused.
 */
const checkNoPtr = (name: string, type: "A" | "AAAA", address: string) => {
  const ptr = reverseName(type, address);
  const label = `Deleting ${type} record "${name}" (${address})`;
  return Technitium.zones.getRecords({ domain: ptr }).pipe(
    Effect.flatMap(({ zone, records = [] }) => {
      if (zone === undefined)
        return refuse(
          `${label}: the reverse zone of ${ptr} could not be checked. Nothing was deleted.`,
        );
      // Technitium deletes PTR records only from Primary and Forwarder zones.
      if (zone.type !== "Primary" && zone.type !== "Forwarder") return Effect.void;
      const pointsBack = records.some(
        (record) =>
          record.type === "PTR" &&
          normalizeName(record.name) === ptr &&
          normalizeName(record.rData.ptrName ?? "") === name,
      );
      return pointsBack
        ? refuse(
            `${label} could also delete the PTR record ${ptr} in zone "${zone.name}", which Technitium does when the token may delete there. Delete the PTR record first. Nothing was deleted.`,
          )
        : Effect.void;
    }),
    Effect.catchTags({
      TechnitiumError: (error) =>
        // No zone holds the reverse name, so Technitium has nothing to delete.
        error.message.startsWith("No such zone was found")
          ? Effect.void
          : refuse(
              `${label}: the reverse zone of ${ptr} could not be checked (${error.message}). Nothing was deleted.`,
            ),
      Forbidden: () =>
        refuse(
          `${label}: the token cannot read the reverse zone that holds ${ptr}, so the provider cannot check whether Technitium would also delete a PTR record there. Give the token View permission on that zone. Nothing was deleted.`,
        ),
    }),
  );
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const RecordProvider = () =>
  Provider.effect(
    Record,
    Effect.sync(() => {
      // Writes to the same name are serialized within the process: concurrent writes to one
      // record set could otherwise each pass their checks and then change each other's records.
      const locks = new Map<string, Semaphore.Semaphore>();
      const exclusive =
        (zone: string, ...names: string[]) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
          [...new Set(names)]
            .sort()
            .map((name) => {
              const key = `${zone} ${name}`;
              const lock = locks.get(key) ?? Semaphore.makeUnsafe(1);
              locks.set(key, lock);
              return lock;
            })
            .reduce((inner, lock) => Semaphore.withPermit(lock)(inner), effect);

      /** Re-reads the record after a write and fails unless the server stored exactly `want`. */
      const verify = (
        want: Desired,
        owner: Owner,
        before: readonly NameRecords[],
        written: readonly Observed[],
      ) =>
        Effect.gen(function* () {
          const after = yield* observeName(want.zone, want.name);
          const record = after.records.find(
            (r) => r.type === want.type && r.comments === markedComment(r.comment, owner),
          );
          const label = `Technitium ${want.type} record "${want.name}"`;
          if (record === undefined)
            return yield* new TechnitiumRecordMismatch({
              message: `${label} is missing after the write.`,
            });
          const stored = {
            value: record.value,
            ttl: want.ttl === undefined ? undefined : record.ttl,
            disabled: record.disabled,
            comment: record.comment,
          };
          const expected = {
            value: want.value,
            ttl: want.ttl,
            disabled: want.disabled,
            comment: want.comment,
          };
          if (!deepEqual(stored, expected))
            return yield* new TechnitiumRecordMismatch({
              message: `${label}: the server stored ${JSON.stringify(stored)} instead of ${JSON.stringify(expected)}.`,
            });
          for (const set of before) {
            const now = set.name === want.name ? after : yield* observeName(set.zone, set.name);
            const others = [...written, record];
            if (!deepEqual(fingerprint(set.records, others), fingerprint(now.records, others)))
              return yield* new TechnitiumRecordMismatch({
                message: `${label}: other records at "${set.name}" changed during the write. Before: ${fingerprint(set.records, others).join("; ") || "none"}. After: ${fingerprint(now.records, others).join("; ") || "none"}.`,
              });
          }
          return toAttributes(want.zone, record, want.type);
        });

      /** The value parameters of a write: the record's address, or the alias target. */
      const valueParameters = (type: RecordType, value: string) =>
        type === "CNAME" ? { cname: value } : { ipAddress: value };

      const create = (want: Desired, owner: Owner, set: NameRecords) =>
        Effect.gen(function* () {
          const place = placement(set.records, want, undefined);
          if ("refused" in place) return yield* refuse(place.refused);
          yield* Technitium.zones.addRecord({
            zone: want.zone,
            domain: want.name,
            type: want.type,
            ...valueParameters(want.type, want.value),
            ...(place.ttl === undefined ? {} : { ttl: place.ttl }),
            comments: markedComment(want.comment, owner),
            // Never replace the record set, and never touch PTR, reverse zones or SVCB hints.
            overwrite: false,
            ...(want.type === "CNAME"
              ? {}
              : { ptr: false, createPtrZone: false, updateSvcbHints: false }),
          });
          if (want.disabled) {
            // Records cannot be created disabled; disable it with the same TTL and comment.
            const added = yield* observeName(want.zone, want.name);
            const record = added.records.find(
              (r) => r.type === want.type && r.comments === markedComment(want.comment, owner),
            );
            if (record === undefined)
              return yield* new TechnitiumRecordMismatch({
                message: `Technitium ${want.type} record "${want.name}" is missing after it was added.`,
              });
            yield* Technitium.zones.updateRecord({
              zone: want.zone,
              domain: want.name,
              type: want.type,
              ...valueParameters(want.type, want.value),
              ttl: record.ttl,
              disable: true,
              comments: markedComment(want.comment, owner),
              expiryTtl: 0,
              ...(want.type === "CNAME"
                ? {}
                : { ptr: false, createPtrZone: false, updateSvcbHints: false }),
            });
          }
          return yield* verify(want, owner, [set], []);
        });

      const update = (
        want: Desired,
        owner: Owner,
        set: NameRecords,
        current: Observed,
        adopting: boolean,
      ) =>
        Effect.gen(function* () {
          const label = `Technitium ${want.type} record "${current.name}"`;
          if (current.expiryTtl !== 0)
            return yield* refuse(
              `${label} expires automatically after ${current.expiryTtl} seconds, which the provider does not manage. Remove the expiry in the web console first.`,
            );
          const owned = ownership(current.marker, owner);
          // With state, only a record with this resource's marker is changed. Without the marker,
          // it may have been deleted and recreated in the web console; with another marker, it
          // belongs to another resource. Taking it over is explicit.
          if (owned !== "ours" && !adopting)
            return yield* refuse(
              `${label} ${owned === "unmarked" ? "has no marker of this resource, so it may have been recreated outside Alchemy" : `carries the marker of ${decodeURIComponent(current.marker?.path ?? "")}`}. Nothing was written. To manage it with this resource, add ${markerText(owner)} to its comment in the web console, or remove the resource from the stack for one deploy and declare it again with --adopt.`,
            );
          if (owned !== "ours") {
            const differences = adoptionDifferences(want, current);
            if (differences.length > 0)
              return yield* refuse(
                `${label} differs from the declaration, so it was not taken over: ${differences.join(", ")}. Adoption only adds the marker; make the declaration match the server first.`,
              );
          }
          const renaming = current.name !== want.name;
          const target = renaming ? yield* observeName(want.zone, want.name) : set;
          // In place, a new TTL also applies to the other records of the set; a rename joins
          // the target name's records.
          const place = renaming
            ? placement(target.records, want, undefined)
            : want.ttl !== undefined &&
                want.ttl !== current.ttl &&
                set.records.some((r) => r !== current && r.type === want.type)
              ? {
                  refused: `${label}: other ${want.type} records share this name, and Technitium applies a TTL change to all of them and resets their comments and disabled state. Change the TTL outside Alchemy or remove the other records first.`,
                }
              : placement(set.records, want, current);
          if ("refused" in place) return yield* refuse(place.refused);
          const ttl = place.ttl ?? current.ttl;
          const unchanged =
            !renaming &&
            current.value === want.value &&
            current.ttl === ttl &&
            current.disabled === want.disabled &&
            current.comments === markedComment(want.comment, owner);
          if (unchanged) return toAttributes(want.zone, current, want.type);
          yield* Technitium.zones.updateRecord({
            zone: want.zone,
            domain: current.name,
            type: want.type,
            ...(renaming ? { newDomain: want.name } : {}),
            ...(want.type === "CNAME"
              ? { cname: want.value }
              : {
                  ipAddress: current.value,
                  newIpAddress: want.value,
                  ptr: false,
                  createPtrZone: false,
                  updateSvcbHints: false,
                }),
            // Technitium resets every field the call leaves out, so all of them are sent.
            ttl,
            disable: want.disabled,
            comments: markedComment(want.comment, owner),
            expiryTtl: 0,
          });
          return yield* verify(want, owner, renaming ? [set, target] : [set], [current]);
        });

      return {
        stables: ["zone", "type"],
        read: Effect.fn(function* ({ fqn, instanceId, olds, output }) {
          const owner = yield* currentOwner(fqn, instanceId);
          const identity = output ?? (yield* validate(olds));
          const set = yield* observeName(identity.zone, identity.name);
          const record = yield* find(set, identity.type, owner, identity.value);
          if (record === undefined) return undefined;
          const attributes = toAttributes(identity.zone, record, identity.type);
          // Without state, only a record with this resource's marker is known to be ours. With
          // state, reconcile refuses to change a record without it.
          return output !== undefined || ownership(record.marker, owner) === "ours"
            ? attributes
            : Unowned(attributes);
        }),
        diff: Effect.fn(function* ({ olds, news }) {
          // Values from other resources (an address, for example) are compared in reconcile.
          if (!isResolved(news)) return { action: "update" as const };
          const before = yield* validate(olds);
          const after = yield* validate(news);
          if (before.zone !== after.zone || before.type !== after.type)
            return yield* new TechnitiumRecordInvalid({
              message: `Technitium record "${after.name}": zone and type cannot change (${before.zone} ${before.type} -> ${after.zone} ${after.type}). Declare a new resource instead.`,
            });
          return deepEqual(before, after)
            ? { action: "noop" as const }
            : { action: "update" as const };
        }),
        reconcile: Effect.fn(function* ({ fqn, instanceId, news, olds, output }) {
          const owner = yield* currentOwner(fqn, instanceId);
          const want = yield* validate(news);
          if (output !== undefined && (output.zone !== want.zone || output.type !== want.type))
            return yield* new TechnitiumRecordInvalid({
              message: `Technitium record "${want.name}": zone and type cannot change. Declare a new resource instead.`,
            });
          const from = output?.name ?? want.name;
          return yield* exclusive(
            want.zone,
            from,
            want.name,
          )(
            Effect.gen(function* () {
              // Without previous props, the engine is adopting the record.
              const adopting = olds === undefined;
              const set = yield* observeName(want.zone, from);
              const current = yield* find(set, want.type, owner, output?.value ?? want.value);
              if (current !== undefined) return yield* update(want, owner, set, current, adopting);
              if (from === want.name) return yield* create(want, owner, set);
              // A rename that was applied before its state was saved left the record at the new name.
              const target = yield* observeName(want.zone, want.name);
              const moved = yield* find(target, want.type, owner, want.value);
              return yield* moved === undefined
                ? create(want, owner, target)
                : update(want, owner, target, moved, adopting);
            }),
          );
        }),
        delete: Effect.fn(function* ({ fqn, instanceId, output }) {
          const owner = yield* currentOwner(fqn, instanceId);
          yield* exclusive(
            output.zone,
            output.name,
          )(
            Effect.gen(function* () {
              const set = yield* lookupName(output.zone, output.name);
              // A deleted zone takes its records with it.
              if (set === "no-zone") return;
              const current = yield* find(set, output.type, owner, output.value);
              if (current === undefined) return;
              if (ownership(current.marker, owner) !== "ours")
                return yield* refuse(
                  `Technitium ${output.type} record "${output.name}" (${current.value}) does not carry this resource's marker, so it was not deleted. ` +
                    (current.marker === undefined
                      ? "It may have been recreated or edited outside Alchemy."
                      : `It carries the marker of ${decodeURIComponent(current.marker.path)}.`),
                );
              if (output.type !== "CNAME")
                yield* checkNoPtr(output.name, output.type, current.value);
              yield* Technitium.zones.deleteRecord({
                zone: output.zone,
                domain: output.name,
                type: output.type,
                ...(output.type === "CNAME"
                  ? {}
                  : { ipAddress: current.value, updateSvcbHints: false }),
              });
              const after = yield* observeName(output.zone, output.name);
              if (
                after.records.some(
                  (r) => r.type === output.type && ownership(r.marker, owner) === "ours",
                )
              )
                return yield* new TechnitiumRecordMismatch({
                  message: `Technitium ${output.type} record "${output.name}" still exists after the delete.`,
                });
              if (
                !deepEqual(
                  fingerprint(set.records, [current]),
                  fingerprint(after.records, [current]),
                )
              )
                return yield* new TechnitiumRecordMismatch({
                  message: `Technitium ${output.type} record "${output.name}": other records at this name changed during the delete.`,
                });
            }),
          );
        }),
      };
    }),
  );
