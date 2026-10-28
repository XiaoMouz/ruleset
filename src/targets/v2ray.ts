// Encodes v2ray/Xray geosite.dat and geoip.dat (protobuf) without a protobuf dependency.
//
//   GeoSiteList { repeated GeoSite entry = 1; }
//   GeoSite     { string country_code = 1; repeated Domain domain = 2; }
//   Domain      { Type type = 1; string value = 2; }   Type: Plain=0 Regex=1 Domain=2 Full=3
//   GeoIPList   { repeated GeoIP entry = 1; }
//   GeoIP       { string country_code = 1; repeated CIDR cidr = 2; }
//   CIDR        { bytes ip = 1; uint32 prefix = 2; }
import { parseCidr } from "../rule";
import type { Projection } from "./index";

const DOMAIN_TYPE = { "DOMAIN-KEYWORD": 0, "DOMAIN-SUFFIX": 2, DOMAIN: 3 } as const;

// Tags are what users write after `ext:<file>:`; Xray upper-cases both sides when looking up.
export const v2rayTag = (setName: string) => setName.toLowerCase();

export function encodeGeoSite(projections: Projection[]): Uint8Array | null {
  const entries = projections.flatMap(({ set, kept }) => {
    const domains = kept.filter((r) => r.type in DOMAIN_TYPE);
    if (!domains.length) return [];
    return [
      message([
        string(1, v2rayTag(set.name).toUpperCase()),
        ...domains.map((r) =>
          embedded(2, message([varintField(1, DOMAIN_TYPE[r.type as keyof typeof DOMAIN_TYPE]), string(2, r.value)])),
        ),
      ]),
    ];
  });
  return entries.length ? message(entries.map((e) => embedded(1, e))) : null;
}

export function encodeGeoIp(projections: Projection[]): Uint8Array | null {
  const entries = projections.flatMap(({ set, kept }) => {
    const cidrs = kept.filter((r) => r.type === "IP-CIDR" || r.type === "IP-CIDR6");
    if (!cidrs.length) return [];
    return [
      message([
        string(1, v2rayTag(set.name).toUpperCase()),
        ...cidrs.map((r) => {
          const c = parseCidr(r.value)!;
          return embedded(2, message([bytes(1, c.bytes), varintField(2, c.prefix)]));
        }),
      ]),
    ];
  });
  return entries.length ? message(entries.map((e) => embedded(1, e))) : null;
}

export function v2rayTags(projections: Projection[]) {
  const site: string[] = [];
  const ip: string[] = [];
  for (const { set, kept } of projections) {
    if (kept.some((r) => r.type in DOMAIN_TYPE)) site.push(v2rayTag(set.name));
    if (kept.some((r) => r.type === "IP-CIDR" || r.type === "IP-CIDR6")) ip.push(v2rayTag(set.name));
  }
  return { site, ip };
}

// --- minimal protobuf writer ---

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

const encoder = new TextEncoder();
const key = (field: number, wire: number) => varint((field << 3) | wire);
const varintField = (field: number, n: number) => Uint8Array.from([...key(field, 0), ...varint(n)]);
const bytes = (field: number, data: Uint8Array) =>
  concat([Uint8Array.from([...key(field, 2), ...varint(data.length)]), data]);
const string = (field: number, s: string) => bytes(field, encoder.encode(s));
const embedded = bytes;
const message = concat;

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
