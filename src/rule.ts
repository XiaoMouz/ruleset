// Source rules are written in Surge syntax, without a policy:
//   TYPE,VALUE[,option...]   e.g. IP-CIDR,10.0.0.0/8,no-resolve
//   AND|OR|NOT,((...),(...))
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export const RULE_TYPES = [
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "IP-CIDR",
  "IP-CIDR6",
  "IP-ASN",
  "PROCESS-NAME",
  "USER-AGENT",
  "URL-REGEX",
  "AND",
  "OR",
  "NOT",
] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const LOGICAL_TYPES: readonly RuleType[] = ["AND", "OR", "NOT"];

export interface Rule {
  type: RuleType;
  value: string;
  options: string[];
  line: number;
}

export interface RuleSet {
  name: string;
  file: string;
  rules: Rule[];
}

export function parseRuleSet(file: string): RuleSet {
  const name = basename(file, ".list");
  const rules: Rule[] = [];
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const text = raw.trim();
      if (!text || text.startsWith("#") || text.startsWith("//")) return;
      const comma = text.indexOf(",");
      const type = (comma < 0 ? text : text.slice(0, comma)).toUpperCase();
      if (!RULE_TYPES.includes(type as RuleType)) {
        throw new Error(`${file}:${i + 1}: unknown rule type "${type}"`);
      }
      const rest = comma < 0 ? "" : text.slice(comma + 1);
      if (!rest) throw new Error(`${file}:${i + 1}: missing value`);
      if (LOGICAL_TYPES.includes(type as RuleType)) {
        rules.push({ type: type as RuleType, value: rest, options: [], line: i + 1 });
        return;
      }
      const [value, ...options] = rest.split(",").map((s) => s.trim());
      if ((type === "IP-CIDR" || type === "IP-CIDR6") && !parseCidr(value)) {
        throw new Error(`${file}:${i + 1}: invalid CIDR "${value}"`);
      }
      rules.push({ type: type as RuleType, value, options, line: i + 1 });
    });
  return { name, file, rules };
}

export function loadRuleSets(dir: string): RuleSet[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".list"))
    .sort()
    .map((f) => parseRuleSet(join(dir, f)));
}

export function formatSurge(rule: Rule, policy?: string): string {
  if (LOGICAL_TYPES.includes(rule.type)) {
    return [rule.type, rule.value, ...(policy ? [policy] : [])].join(",");
  }
  return [rule.type, rule.value, ...(policy ? [policy] : []), ...rule.options].join(",");
}

// --- CIDR helpers (shared by the v2ray encoder and the reference matcher) ---

export interface Cidr {
  bytes: Uint8Array;
  prefix: number;
}

export function parseCidr(text: string): Cidr | null {
  const slash = text.lastIndexOf("/");
  const addr = slash < 0 ? text : text.slice(0, slash);
  const bytes = addr.includes(":") ? parseIPv6(addr) : parseIPv4(addr);
  if (!bytes) return null;
  const max = bytes.length * 8;
  const prefix = slash < 0 ? max : Number(text.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { bytes, prefix };
}

export function parseIPv4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out = parts.map(Number);
  if (out.some((n, i) => !/^\d{1,3}$/.test(parts[i]) || n > 255)) return null;
  return Uint8Array.from(out);
}

export function parseIPv6(text: string): Uint8Array | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/i.test(groups[i])) return null;
    const n = parseInt(groups[i], 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

export function cidrContains(cidr: Cidr, ip: Uint8Array): boolean {
  if (cidr.bytes.length !== ip.length) return false;
  for (let bit = 0; bit < cidr.prefix; bit++) {
    const mask = 0x80 >> bit % 8;
    if ((cidr.bytes[bit >> 3] & mask) !== (ip[bit >> 3] & mask)) return false;
  }
  return true;
}

export function formatIp(bytes: Uint8Array): string {
  if (bytes.length === 4) return Array.from(bytes).join(".");
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  // RFC 5952: compress the longest run (2+) of zero groups
  let best = { start: -1, len: 1 };
  for (let i = 0; i < 8; ) {
    let j = i;
    while (j < 8 && groups[j] === "0") j++;
    if (j - i > best.len) best = { start: i, len: j - i };
    i = j === i ? i + 1 : j;
  }
  if (best.start < 0) return groups.join(":");
  return `${groups.slice(0, best.start).join(":")}::${groups.slice(best.start + best.len).join(":")}`;
}
