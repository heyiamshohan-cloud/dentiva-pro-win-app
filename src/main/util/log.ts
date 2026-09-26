// Dentiva Pro - production logging. Never logs secrets or patient-sensitive payloads.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

const SENSITIVE = /password|secret|token|hash|credential/i;

let logFile: string | null = null;

export function initLogging(file: string): void {
  logFile = file;
  mkdirSync(dirname(file), { recursive: true });
}

function scrub(v: unknown, depth = 0): unknown {
  if (v == null || depth > 4) return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? '[redacted]' : scrub(val, depth + 1);
    }
    return out;
  }
  return v;
}

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const safe = meta ? (scrub(meta) as Record<string, unknown>) : undefined;
  const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...(safe ? { meta: safe } : {}) });
  if (logFile) {
    try {
      appendFileSync(logFile, line + '\n');
    } catch {
      // logging must never break the app
    }
  }
  if (process.env.DENTIVA_DEBUG) {
    (level === 'error' ? console.error : console.log)(`[${level}] ${message}`, safe ?? '');
  }
}

export const logger = {
  info: (m: string, meta?: Record<string, unknown>) => log('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => log('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => log('error', m, meta),
};
