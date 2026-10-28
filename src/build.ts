// Builds every target into dist/. Usage: bun run build
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatSurge, loadRuleSets, type RuleType } from "./rule";
import { project, TARGETS, type Projection, type Target } from "./targets";
import { mrsBehavior, renderClashClassical, renderClashMrsSource } from "./targets/clash";
import { renderSingBox } from "./targets/singbox";
import { renderSurge } from "./targets/surge";
import { encodeGeoIp, encodeGeoSite, v2rayTags } from "./targets/v2ray";
import { requireTool, run } from "./tools";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const TMP = join(ROOT, ".tmp", "build");

const sets = loadRuleSets(join(ROOT, "rules"));
rmSync(DIST, { recursive: true, force: true });
rmSync(TMP, { recursive: true, force: true });
for (const dir of ["surge/rules", "clash", "sing-box", "v2ray"]) mkdirSync(join(DIST, dir), { recursive: true });
mkdirSync(TMP, { recursive: true });

const projections = Object.fromEntries(
  TARGETS.map((t) => [t, sets.map((s) => project(s, t))]),
) as Record<Target, Projection[]>;

// Surge
for (const p of projections.surge) writeFileSync(join(DIST, "surge/rules", `${p.set.name}.list`), renderSurge(p));
cpSync(join(ROOT, "scripts"), join(DIST, "surge/scripts"), { recursive: true });

// Clash (mihomo): classical yaml for everything, plus .mrs when the set is pure domain / ipcidr
const mihomo = requireTool("MIHOMO");
const mrs: Record<string, string> = {};
for (const p of projections.clash) {
  if (!p.kept.length) continue;
  writeFileSync(join(DIST, "clash", `${p.set.name}.yaml`), renderClashClassical(p));
  const behavior = mrsBehavior(p.kept);
  if (!behavior) continue;
  const src = join(TMP, `${p.set.name}.${behavior}.yaml`);
  writeFileSync(src, renderClashMrsSource(p.kept, behavior));
  run([mihomo, "convert-ruleset", behavior, "yaml", src, join(DIST, "clash", `${p.set.name}.mrs`)]);
  mrs[p.set.name] = behavior;
}

// sing-box: source json + compiled srs
const singBox = requireTool("SING_BOX");
for (const p of projections["sing-box"]) {
  if (!p.kept.length) continue;
  const json = join(DIST, "sing-box", `${p.set.name}.json`);
  writeFileSync(json, renderSingBox(p));
  run([singBox, "rule-set", "compile", "--output", join(DIST, "sing-box", `${p.set.name}.srs`), json]);
}

// v2ray / Xray: one dat per kind, one tag per set
const site = encodeGeoSite(projections.v2ray);
const ip = encodeGeoIp(projections.v2ray);
if (site) writeFileSync(join(DIST, "v2ray", "ruleset-site.dat"), site);
if (ip) writeFileSync(join(DIST, "v2ray", "ruleset-ip.dat"), ip);

// Report: what each target had to drop
const report = {
  sets: sets.map((s) => s.name),
  clashMrs: mrs,
  v2rayTags: v2rayTags(projections.v2ray),
  dropped: Object.fromEntries(
    TARGETS.map((t) => [
      t,
      projections[t]
        .filter((p) => p.dropped.length)
        .map((p) => ({ set: p.set.name, rules: p.dropped.map((r) => formatSurge(r)) })),
    ]),
  ),
};
writeFileSync(join(DIST, "report.json"), JSON.stringify(report, null, 2) + "\n");

const summary = TARGETS.map((t) => {
  const byType = new Map<RuleType, number>();
  for (const p of projections[t]) for (const r of p.dropped) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
  const parts = [...byType].map(([type, n]) => `${type}×${n}`).join(", ");
  return `${t.padEnd(8)} kept ${projections[t].reduce((n, p) => n + p.kept.length, 0)}, dropped ${parts || "nothing"}`;
});
console.log(`Built ${sets.length} rule sets into dist/\n${summary.join("\n")}`);
