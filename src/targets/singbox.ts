import type { Projection } from "./index";

// Version 2 is understood by sing-box 1.10+ and keeps domain_suffix compact in .srs.
export const SINGBOX_RULESET_VERSION = 2;

// Fields inside one headless rule are AND-ed across groups (destination vs process),
// so each group gets its own rule; rules in a rule-set are OR-ed.
export function renderSingBox({ kept }: Projection): string {
  const pick = (type: string) => kept.filter((r) => r.type === type).map((r) => r.value);
  const dest: Record<string, string[]> = {
    domain: pick("DOMAIN"),
    domain_suffix: pick("DOMAIN-SUFFIX"),
    domain_keyword: pick("DOMAIN-KEYWORD"),
    ip_cidr: [...pick("IP-CIDR"), ...pick("IP-CIDR6")],
  };
  const rules: Record<string, string[]>[] = [];
  const destRule = Object.fromEntries(Object.entries(dest).filter(([, v]) => v.length));
  if (Object.keys(destRule).length) rules.push(destRule);
  const processes = pick("PROCESS-NAME");
  if (processes.length) rules.push({ process_name: processes });
  return JSON.stringify({ version: SINGBOX_RULESET_VERSION, rules }, null, 2) + "\n";
}
