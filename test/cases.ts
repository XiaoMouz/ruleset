// Test cases: hand-written ones plus samples generated from every rule set.
import { cidrContains, formatIp, parseCidr, parseIPv4, parseIPv6, type Rule, type RuleSet, type RuleType } from "../src/rule";

export interface Case {
  set: string;
  input: string; // domain or IP address
  match: boolean;
  // Rule type that makes it match; a target that dropped this type expects no match.
  via?: RuleType;
  note?: string;
}

// Hand-written cases. Add one whenever a rule change should be pinned down.
export const MANUAL: Case[] = [
  { set: "Claude-domains", input: "claude.ai", match: true },
  { set: "Claude-domains", input: "api.anthropic.com", match: true },
  { set: "Claude-domains", input: "notclaude.ai", match: false },
  { set: "Openai-domains", input: "chatgpt.com", match: true },
  { set: "YouTube-domains", input: "www.youtube.com", match: true },
  { set: "Direct-network", input: "192.168.1.1", match: true },
  { set: "Direct-network", input: "8.8.8.8", match: false },
];

const PER_TYPE = 3;
const NEGATIVE_DOMAIN = "ruleset-negative-probe.invalid";
const NEGATIVE_IP = "198.51.100.77"; // TEST-NET-2

// Reference matcher used to sanity-check generated cases and fill in `via`.
export function referenceMatch(set: RuleSet, input: string): RuleType | undefined {
  const ip = parseIPv4(input) ?? parseIPv6(input);
  for (const r of set.rules) {
    if (ip) {
      if ((r.type === "IP-CIDR" || r.type === "IP-CIDR6") && cidrContains(parseCidr(r.value)!, ip)) return r.type;
      continue;
    }
    const host = input.toLowerCase();
    const v = r.value.toLowerCase();
    if (r.type === "DOMAIN" && host === v) return r.type;
    if (r.type === "DOMAIN-SUFFIX" && (host === v || host.endsWith(`.${v}`))) return r.type;
    if (r.type === "DOMAIN-KEYWORD" && host.includes(v)) return r.type;
  }
  return undefined;
}

function samples(rule: Rule): string[] {
  switch (rule.type) {
    case "DOMAIN":
      return [rule.value];
    case "DOMAIN-SUFFIX":
      return [rule.value, `probe.${rule.value}`];
    case "DOMAIN-KEYWORD":
      return [`x${rule.value}y.probe.test`.replace(/\.\./g, ".")];
    case "IP-CIDR":
    case "IP-CIDR6": {
      const c = parseCidr(rule.value)!;
      const host = Uint8Array.from(c.bytes);
      // first usable address inside the network
      if (c.prefix < host.length * 8) host[host.length - 1] |= 1;
      return [formatIp(host)];
    }
    default:
      return [];
  }
}

export function generateCases(sets: RuleSet[]): Case[] {
  const cases: Case[] = [];
  for (const set of sets) {
    const taken = new Map<RuleType, number>();
    for (const rule of set.rules) {
      const n = taken.get(rule.type) ?? 0;
      if (n >= PER_TYPE) continue;
      const inputs = samples(rule);
      if (!inputs.length) continue;
      taken.set(rule.type, n + 1);
      for (const input of inputs) cases.push({ set: set.name, input, match: true, via: referenceMatch(set, input) });
    }
    for (const input of [NEGATIVE_DOMAIN, NEGATIVE_IP]) {
      if (!referenceMatch(set, input)) cases.push({ set: set.name, input, match: false });
    }
  }
  return cases;
}

export function allCases(sets: RuleSet[]): Case[] {
  const byName = new Map(sets.map((s) => [s.name, s]));
  const manual = MANUAL.map((c) => {
    const set = byName.get(c.set);
    if (!set) throw new Error(`manual case refers to unknown set ${c.set}`);
    const via = referenceMatch(set, c.input);
    if (Boolean(via) !== c.match) {
      throw new Error(`manual case ${c.set} ${c.input}: expected match=${c.match}, source rules say ${!!via}`);
    }
    return { ...c, via };
  });
  return [...manual, ...generateCases(sets)];
}
