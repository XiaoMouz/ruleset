import type { Rule } from "../rule";
import type { Projection } from "./index";

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

// Classical provider: works for every kept rule type.
export function renderClashClassical({ set, kept }: Projection): string {
  const lines = kept.map((r) => `  - ${quote([r.type, r.value, ...r.options].join(","))}`);
  return `# ${set.name}\npayload:\n${lines.join("\n")}\n`;
}

// mrs only supports pure domain or pure ipcidr providers.
export type MrsBehavior = "domain" | "ipcidr";

export function mrsBehavior(kept: Rule[]): MrsBehavior | null {
  if (kept.length === 0) return null;
  if (kept.every((r) => r.type === "DOMAIN" || r.type === "DOMAIN-SUFFIX")) return "domain";
  if (kept.every((r) => r.type === "IP-CIDR" || r.type === "IP-CIDR6")) return "ipcidr";
  return null;
}

export function renderClashMrsSource(kept: Rule[], behavior: MrsBehavior): string {
  const items = kept.map((r) =>
    behavior === "ipcidr" ? r.value : r.type === "DOMAIN-SUFFIX" ? `+.${r.value}` : r.value,
  );
  return `payload:\n${items.map((v) => `  - ${quote(v)}`).join("\n")}\n`;
}
