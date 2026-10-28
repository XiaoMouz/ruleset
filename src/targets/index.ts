import type { Rule, RuleSet, RuleType } from "../rule";

export type Target = "surge" | "clash" | "sing-box" | "v2ray";
export const TARGETS: Target[] = ["surge", "clash", "sing-box", "v2ray"];

// Rule types each target can express. Everything else is dropped for that target
// and listed in the build report.
export const SUPPORTED: Record<Target, ReadonlySet<RuleType>> = {
  surge: new Set<RuleType>([
    "DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6", "IP-ASN",
    "PROCESS-NAME", "USER-AGENT", "URL-REGEX", "AND", "OR", "NOT",
  ]),
  // mihomo supports logical rules too, but only when every sub-rule is supported;
  // none of ours qualify yet, so keep it simple and drop them.
  clash: new Set<RuleType>([
    "DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6", "IP-ASN", "PROCESS-NAME",
  ]),
  "sing-box": new Set<RuleType>([
    "DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6", "PROCESS-NAME",
  ]),
  v2ray: new Set<RuleType>(["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6"]),
};

export interface Projection {
  set: RuleSet;
  kept: Rule[];
  dropped: Rule[];
}

export function project(set: RuleSet, target: Target): Projection {
  const supported = SUPPORTED[target];
  const kept: Rule[] = [];
  const dropped: Rule[] = [];
  for (const rule of set.rules) (supported.has(rule.type) ? kept : dropped).push(rule);
  return { set, kept, dropped };
}

export const isDomainRule = (r: Rule) =>
  r.type === "DOMAIN" || r.type === "DOMAIN-SUFFIX" || r.type === "DOMAIN-KEYWORD";
export const isIpRule = (r: Rule) => r.type === "IP-CIDR" || r.type === "IP-CIDR6";
