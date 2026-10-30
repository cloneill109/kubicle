import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  home: string;
  port: number;
  payloadCap: number;
  approvalWaitMs: number;
  quietMs: number;
  lostMs: number;
  expireMs: number;
  bannerMs: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const port = Number(env.AGENT_OFFICE_PORT);
  return {
    home: env.AGENT_OFFICE_HOME || join(homedir(), '.agent-office'),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 4317,
    payloadCap: 4096,
    approvalWaitMs: 120_000,
    quietMs: 300_000,
    lostMs: 1_800_000,
    expireMs: 86_400_000,
    bannerMs: 600_000,
  };
}

export function ensureHome(cfg: Config): void {
  mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
  chmodSync(cfg.home, 0o700);
}
