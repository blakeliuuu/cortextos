/**
 * Daemon-side cron scheduler — mirrors agent CronCreate firing schedules
 * and records each fire to `state/<agent>/cron-state.json` independently.
 *
 * Why this exists:
 *  - Claude Code's CronCreate is in-process and dies on `--continue` restart.
 *    Agents recreate crons at boot, but cron-state.json (last_fire history)
 *    only gets written when an agent runs `cortextos bus update-cron-fire`.
 *    If the agent misses that step, or the session restarts, the state is
 *    lost and the daemon's gap-detection floods nudges.
 *  - This module decouples cron-state.json from agent compliance: the daemon
 *    runs its own timers matching each cron's schedule, and writes the
 *    state file when a fire is due. That way:
 *      (1) gap nudges stop firing falsely after restart
 *      (2) cron-state.json reflects the schedule, not the agent's diligence
 *      (3) the agent's own update-cron-fire calls remain compatible
 *         (they overwrite with the same timestamp; no harm)
 *
 * What this does NOT do:
 *  - Does not INJECT cron prompts (Claude Code's CronCreate still does that).
 *  - Does not parse arbitrary cron expressions — only the patterns used in
 *    cortextOS configs: `*`, `*\/N`, and fixed integers in each of the 5
 *    fields. Comma lists and ranges are unsupported and cause that cron to
 *    be skipped (logged) rather than misfiring.
 *
 * Lifecycle:
 *  - `new DaemonCronScheduler(stateDir, crons, log)` — register
 *  - `start()` — schedule first fire for each parseable cron
 *  - `stop()` — clear all timers (called on agent stop)
 */

import { join } from 'path';
import type { CronEntry } from '../types/index.js';
import { updateCronFire, parseDurationMs } from '../bus/cron-state.js';

type LogFn = (msg: string) => void;

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

type CronField = { kind: 'any' } | { kind: 'every'; step: number } | { kind: 'fixed'; value: number };

/**
 * Parse one of the 5 cron fields. Supports `*`, `*\/N`, and fixed integers.
 * Returns null if the field uses an unsupported pattern (comma lists, ranges).
 */
export function parseCronField(raw: string): CronField | null {
  const trimmed = raw.trim();
  if (trimmed === '*') return { kind: 'any' };
  const everyMatch = /^\*\/(\d+)$/.exec(trimmed);
  if (everyMatch) {
    const step = parseInt(everyMatch[1], 10);
    if (step > 0) return { kind: 'every', step };
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return { kind: 'fixed', value: parseInt(trimmed, 10) };
  }
  return null;
}

/**
 * Parse a 5-field cron expression. Returns null if any field is unsupported
 * (the caller should skip that cron rather than misfire).
 */
export function parseCronExpression(expr: string): ParsedCron | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseCronField(parts[0]);
  const hour = parseCronField(parts[1]);
  const dom = parseCronField(parts[2]);
  const month = parseCronField(parts[3]);
  const dow = parseCronField(parts[4]);
  if (!minute || !hour || !dom || !month || !dow) return null;
  return { minute, hour, dom, month, dow };
}

function fieldMatches(field: CronField, value: number): boolean {
  switch (field.kind) {
    case 'any': return true;
    case 'every': return value % field.step === 0;
    case 'fixed': return value === field.value;
  }
}

/**
 * Compute the next time at or after `from` that matches the cron expression.
 * Walks forward minute by minute up to 8 days; returns null if no match.
 *
 * Exported for unit testing.
 */
export function nextFireTime(parsed: ParsedCron, from: Date): Date | null {
  const cursor = new Date(from.getTime());
  // Round up to next whole minute (the cursor's seconds get cleared)
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  // Walk up to 8 days * 24h * 60m = 11_520 minutes. Catches weekly schedules.
  const maxIterations = 8 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    const month = cursor.getMonth() + 1; // 1-12
    const dom = cursor.getDate();
    const dow = cursor.getDay(); // 0-6, Sun=0
    const hour = cursor.getHours();
    const minute = cursor.getMinutes();
    if (
      fieldMatches(parsed.minute, minute) &&
      fieldMatches(parsed.hour, hour) &&
      fieldMatches(parsed.dom, dom) &&
      fieldMatches(parsed.month, month) &&
      fieldMatches(parsed.dow, dow)
    ) {
      return new Date(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

/**
 * Compute the cron's interval in milliseconds. Used to schedule the NEXT
 * fire after one fires, without re-parsing the expression. For interval-based
 * crons we use the explicit interval; for cron expressions we compute the
 * delta to the next fire from "now".
 */
function computeNextDelay(cron: CronEntry, fromMs: number): number | null {
  if (cron.interval) {
    const ms = parseDurationMs(cron.interval);
    if (!isNaN(ms) && ms > 0) return ms;
  }
  if (cron.cron) {
    const parsed = parseCronExpression(cron.cron);
    if (!parsed) return null;
    const next = nextFireTime(parsed, new Date(fromMs));
    if (!next) return null;
    return Math.max(1000, next.getTime() - fromMs);
  }
  return null;
}

export class DaemonCronScheduler {
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private stateDir: string,
    private agentName: string,
    private crons: CronEntry[],
    private log: LogFn,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const cron of this.crons) {
      if (cron.type && cron.type !== 'recurring') continue; // skip 'once' and 'disabled'
      this.scheduleNext(cron);
    }
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private scheduleNext(cron: CronEntry): void {
    if (!this.running) return;
    const delay = computeNextDelay(cron, Date.now());
    if (delay === null) {
      this.log(`cron-scheduler: skipping "${cron.name}" — unsupported cron expression "${cron.cron ?? cron.interval ?? ''}"`);
      return;
    }
    const timer = setTimeout(() => this.fire(cron), delay);
    this.timers.push(timer);
  }

  private fire(cron: CronEntry): void {
    if (!this.running) return;
    try {
      updateCronFire(this.stateDir, cron.name, cron.interval);
      this.log(`cron-scheduler: recorded mirror fire for "${cron.name}"`);
    } catch (err) {
      this.log(`cron-scheduler: failed to record fire for "${cron.name}": ${(err as Error).message}`);
    }
    // Schedule the next fire after this one
    this.scheduleNext(cron);
  }
}

/**
 * Convenience constructor — used by AgentProcess wiring.
 */
export function makeDaemonCronScheduler(
  ctxRoot: string,
  agentName: string,
  crons: CronEntry[] | undefined,
  log: LogFn,
): DaemonCronScheduler | null {
  if (!crons || crons.length === 0) return null;
  const stateDir = join(ctxRoot, 'state', agentName);
  return new DaemonCronScheduler(stateDir, agentName, crons, log);
}
