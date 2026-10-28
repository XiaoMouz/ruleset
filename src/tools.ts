// Locates external binaries. Override with env vars (SING_BOX, MIHOMO, XRAY, SURGE_CLI).
import { existsSync } from "node:fs";

const DEFAULTS: Record<string, string[]> = {
  SING_BOX: ["sing-box"],
  MIHOMO: ["mihomo"],
  XRAY: ["xray"],
  SURGE_CLI: ["surge-cli", "/Applications/Surge.app/Contents/Applications/surge-cli"],
};

export function findTool(name: keyof typeof DEFAULTS): string | null {
  const candidates = [process.env[name], ...DEFAULTS[name]].filter(Boolean) as string[];
  for (const c of candidates) {
    if (c.includes("/") ? existsSync(c) : Bun.which(c)) return c.includes("/") ? c : Bun.which(c)!;
  }
  return null;
}

export function requireTool(name: keyof typeof DEFAULTS): string {
  const path = findTool(name);
  if (!path) throw new Error(`${name} not found; install it or set the ${name} env var`);
  return path;
}

export function run(cmd: string[], opts: { allowFail?: boolean; env?: Record<string, string> } = {}) {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...opts.env } });
  const out = proc.stdout.toString() + proc.stderr.toString();
  if (proc.exitCode !== 0 && !opts.allowFail) {
    throw new Error(`${cmd.join(" ")} failed (${proc.exitCode}):\n${out}`);
  }
  return { code: proc.exitCode, out };
}
