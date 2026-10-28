// Validates dist/ with each client's own tooling and checks that sample domains / IPs
// match the rule sets they should.
//
//   bun run test                      # every runner whose tool is installed (surge-local excluded)
//   bun run test sing-box mihomo      # only these; a missing tool is an error
//   bun run test:surge                # surge-cli -c on this Mac
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOGICAL_TYPES, loadRuleSets, parseRuleSet } from "../src/rule";
import { SUPPORTED, type Target } from "../src/targets";
import { v2rayTag } from "../src/targets/v2ray";
import { findTool, run } from "../src/tools";
import { allCases, type Case } from "./cases";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const TMP = join(ROOT, ".tmp", "test");
mkdirSync(TMP, { recursive: true });

const sets = loadRuleSets(join(ROOT, "rules"));
const cases = allCases(sets);
const report = JSON.parse(readFileSync(join(DIST, "report.json"), "utf8"));

type Result = { failures: string[]; checked: number; note?: string };
type Runner = { target: Target; tool?: Parameters<typeof findTool>[0]; run: (tool: string) => Promise<Result> };

const expected = (c: Case, target: Target) => c.match && (!c.via || SUPPORTED[target].has(c.via));
const casesFor = (set: string) => cases.filter((c) => c.set === set);
const describe = (c: Case, target: Target, got: boolean) =>
  `${c.set}: ${c.input} expected ${expected(c, target) ? "match" : "no match"}, got ${got ? "match" : "no match"}`;

// ---------- Surge ----------

function surgeProfile(name: string, skipLogical: boolean) {
  const set = parseRuleSet(join(DIST, "surge/rules", `${name}.list`));
  const lines = set.rules
    .filter((r) => !(skipLogical && LOGICAL_TYPES.includes(r.type)))
    .map((r) =>
      LOGICAL_TYPES.includes(r.type)
        ? `${r.type},${r.value},DIRECT`
        : [r.type, r.value, "DIRECT", ...r.options].join(","),
    );
  return { profile: `[General]\n[Rule]\n${lines.join("\n")}\nFINAL,DIRECT\n`, skipped: set.rules.length - lines.length };
}

const SURGE_API = "https://services.nssurge.com/v1/config/validate";

async function surgeApi(): Promise<Result> {
  const failures: string[] = [];
  let skipped = 0;
  const queue = [...sets];
  const worker = async () => {
    for (let set = queue.shift(); set; set = queue.shift()) {
      // The validation service throws NSRangeException on any AND/OR/NOT rule, even valid ones.
      const { profile, skipped: s } = surgeProfile(set.name, true);
      skipped += s;
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await fetch(SURGE_API, { method: "POST", headers: { "Content-Type": "text/plain" }, body: profile });
          const body = (await res.json()) as { valid: boolean; error?: { message: string } };
          if (!body.valid) failures.push(`${set.name}: ${body.error?.message}`);
          break;
        } catch (e) {
          if (attempt >= 3) {
            failures.push(`${set.name}: request failed: ${e}`);
            break;
          }
          await Bun.sleep(1000 * attempt);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return { failures, checked: sets.length, note: skipped ? `${skipped} logical rule(s) skipped (service bug)` : undefined };
}

async function surgeLocal(cli: string): Promise<Result> {
  const failures: string[] = [];
  for (const set of sets) {
    const file = join(TMP, `surge-${set.name}.conf`);
    writeFileSync(file, surgeProfile(set.name, false).profile);
    const { code, out } = run([cli, "-c", file], { allowFail: true });
    if (code !== 0) failures.push(`${set.name}: ${out.trim()}`);
  }
  return { failures, checked: sets.length };
}

// ---------- sing-box ----------

async function singBox(bin: string): Promise<Result> {
  const failures: string[] = [];
  let checked = 0;
  for (const set of sets) {
    const srs = join(DIST, "sing-box", `${set.name}.srs`);
    if (!existsSync(srs)) continue;
    for (const c of casesFor(set.name)) {
      const got = run([bin, "rule-set", "match", "-f", "binary", srs, c.input]).out.includes("match");
      checked++;
      if (got !== expected(c, "sing-box")) failures.push(describe(c, "sing-box", got));
    }
  }
  return { failures, checked };
}

// ---------- proxy-based runners (mihomo, Xray) ----------
// Start the client with one HTTP inbound per rule set, send each sample through the
// matching inbound and read the routing decision from the client's log.

interface Probe {
  port: number;
  label: string;
  target: Target;
  cases: Case[];
}

async function probeThroughProxy(
  cmd: string[],
  env: Record<string, string>,
  probes: Probe[],
  isHit: (logChunk: string) => boolean,
): Promise<Result> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  let log = "";
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) log += decoder.decode(chunk);
  };
  pump(proc.stdout);
  pump(proc.stderr);

  const failures: string[] = [];
  let checked = 0;
  try {
    await waitForPort(probes[0].port, () => log);
    // Listening isn't the same as routing; wait until a throwaway request shows up in the log.
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt++) {
      const warm = new AbortController();
      fetch("https://warmup.invalid/", { proxy: `http://127.0.0.1:${probes[0].port}`, signal: warm.signal }).catch(() => {});
      ready = (await waitFor(() => (log.includes("warmup.invalid") ? true : null), 500)) ?? false;
      warm.abort();
    }
    if (!ready) throw new Error(`client never routed the warm-up request:\n${log.slice(-2000)}`);
    for (const probe of probes) {
      for (const c of probe.cases) {
        const offset = log.length;
        const ip = c.input.includes(":") ? `[${c.input}]` : c.input;
        const url = /^[\d.]+$/.test(c.input) || c.input.includes(":") ? `http://${ip}/` : `https://${c.input}/`;
        // Only the routing log matters, so don't wait for the request itself.
        const abort = new AbortController();
        fetch(url, { proxy: `http://127.0.0.1:${probe.port}`, signal: abort.signal }).catch(() => {});
        const chunk = await waitFor(() => {
          const text = log.slice(offset);
          return text.includes(c.input) ? text : null;
        }, 3000);
        abort.abort();
        checked++;
        if (chunk === null) {
          failures.push(`${probe.label}: ${c.input} produced no routing log`);
          continue;
        }
        const got = isHit(chunk);
        if (got !== expected(c, probe.target)) failures.push(`${probe.label} ${describe(c, probe.target, got)}`);
      }
    }
  } finally {
    proc.kill();
    await proc.exited;
  }
  return { failures, checked };
}

async function waitFor<T>(fn: () => T | null, timeoutMs = 2000): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== null || Date.now() > end) return v;
    await Bun.sleep(10);
  }
}

async function waitForPort(port: number, log: () => string) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try {
      const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
      s.end();
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error(`client did not start listening on ${port}:\n${log()}`);
}

const BASE_PORT = 21000;

async function mihomo(bin: string): Promise<Result> {
  const listeners: string[] = [];
  const providers: string[] = [];
  const subRules: string[] = [];
  const probes: Probe[] = [];
  const add = (name: string, label: string, provider: string) => {
    const i = probes.length;
    listeners.push(`  - {name: in${i}, type: http, listen: 127.0.0.1, port: ${BASE_PORT + i}, rule: sub${i}}`);
    providers.push(`  p${i}: ${provider}`);
    subRules.push(`  sub${i}:\n    - RULE-SET,p${i},REJECT,no-resolve\n    - MATCH,REJECT`);
    probes.push({ port: BASE_PORT + i, label, target: "clash", cases: casesFor(name) });
  };
  for (const set of sets) {
    const yaml = join(DIST, "clash", `${set.name}.yaml`);
    if (!existsSync(yaml)) continue;
    add(set.name, `${set.name}.yaml`, `{type: file, behavior: classical, format: yaml, path: '${yaml}'}`);
    const behavior = report.clashMrs[set.name];
    if (behavior) {
      add(set.name, `${set.name}.mrs`, `{type: file, behavior: ${behavior}, format: mrs, path: '${join(DIST, "clash", `${set.name}.mrs`)}'}`);
    }
  }
  const config = [
    "mode: rule",
    "log-level: info",
    "ipv6: true",
    `listeners:\n${listeners.join("\n")}`,
    `rule-providers:\n${providers.join("\n")}`,
    `sub-rules:\n${subRules.join("\n")}`,
    "rules:\n  - MATCH,REJECT",
  ].join("\n");
  const dir = join(TMP, "mihomo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.yaml"), config + "\n");
  // mihomo only reads provider files under its home dir or SAFE_PATHS
  const env = { SAFE_PATHS: DIST };
  run([bin, "-t", "-d", dir, "-f", join(dir, "config.yaml")], { env });
  return probeThroughProxy([bin, "-d", dir, "-f", join(dir, "config.yaml")], env, probes, (chunk) =>
    /match RuleSet\(p\d+\)/.test(chunk),
  );
}

async function xray(bin: string): Promise<Result> {
  const tags = report.v2rayTags as { site: string[]; ip: string[] };
  const inbounds: object[] = [];
  const rules: object[] = [];
  const probes: Probe[] = [];
  for (const set of sets) {
    const tag = v2rayTag(set.name);
    const hasSite = tags.site.includes(tag);
    const hasIp = tags.ip.includes(tag);
    if (!hasSite && !hasIp) continue;
    const i = probes.length;
    inbounds.push({ tag: `in${i}`, listen: "127.0.0.1", port: BASE_PORT + i, protocol: "http" });
    if (hasSite) rules.push({ inboundTag: [`in${i}`], domain: [`ext:ruleset-site.dat:${tag}`], outboundTag: "hit" });
    if (hasIp) rules.push({ inboundTag: [`in${i}`], ip: [`ext:ruleset-ip.dat:${tag}`], outboundTag: "hit" });
    probes.push({ port: BASE_PORT + i, label: set.name, target: "v2ray", cases: casesFor(set.name) });
  }
  const config = {
    log: { loglevel: "info" },
    inbounds,
    outbounds: [
      { tag: "miss", protocol: "blackhole" },
      { tag: "hit", protocol: "blackhole" },
    ],
    routing: { domainStrategy: "AsIs", rules },
  };
  const file = join(TMP, "xray.json");
  writeFileSync(file, JSON.stringify(config, null, 2));
  const env = { XRAY_LOCATION_ASSET: join(DIST, "v2ray") };
  const test = Bun.spawnSync([bin, "run", "-test", "-c", file], { env: { ...process.env, ...env } });
  if (test.exitCode !== 0) throw new Error(`xray -test failed:\n${test.stdout}${test.stderr}`);
  return probeThroughProxy([bin, "run", "-c", file], env, probes, (chunk) => chunk.includes("detour [hit]"));
}

// ---------- main ----------

const RUNNERS: Record<string, Runner> = {
  "surge-api": { target: "surge", run: surgeApi },
  "surge-local": { target: "surge", tool: "SURGE_CLI", run: surgeLocal },
  "sing-box": { target: "sing-box", tool: "SING_BOX", run: singBox },
  mihomo: { target: "clash", tool: "MIHOMO", run: mihomo },
  xray: { target: "v2ray", tool: "XRAY", run: xray },
};

const requested = process.argv.slice(2);
const names = requested.length ? requested : Object.keys(RUNNERS).filter((n) => n !== "surge-local");
let failed = false;
console.log(`${cases.length} cases across ${sets.length} rule sets`);
for (const name of names) {
  const runner = RUNNERS[name];
  if (!runner) throw new Error(`unknown runner ${name}; choose from ${Object.keys(RUNNERS).join(", ")}`);
  const tool = runner.tool ? findTool(runner.tool) : "";
  if (tool === null) {
    if (requested.length) {
      console.log(`✗ ${name}: ${runner.tool} not found`);
      failed = true;
    } else console.log(`- ${name}: skipped (${runner.tool} not found)`);
    continue;
  }
  const started = Date.now();
  const { failures, checked, note } = await runner.run(tool);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${failures.length ? "✗" : "✓"} ${name}: ${checked} checked, ${failures.length} failed (${secs}s)${note ? `, ${note}` : ""}`);
  for (const f of failures.slice(0, 30)) console.log(`    ${f}`);
  if (failures.length > 30) console.log(`    … ${failures.length - 30} more`);
  if (failures.length) failed = true;
}
process.exit(failed ? 1 : 0);
