import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseCronField,
  parseCronExpression,
  nextFireTime,
  DaemonCronScheduler,
  makeDaemonCronScheduler,
} from '../../../src/daemon/cron-scheduler.js';
import type { CronEntry } from '../../../src/types/index.js';

describe('cron-scheduler: parseCronField', () => {
  it('parses *', () => {
    expect(parseCronField('*')).toEqual({ kind: 'any' });
  });
  it('parses */N', () => {
    expect(parseCronField('*/5')).toEqual({ kind: 'every', step: 5 });
    expect(parseCronField('*/4')).toEqual({ kind: 'every', step: 4 });
  });
  it('parses fixed integer', () => {
    expect(parseCronField('7')).toEqual({ kind: 'fixed', value: 7 });
    expect(parseCronField('0')).toEqual({ kind: 'fixed', value: 0 });
    expect(parseCronField('59')).toEqual({ kind: 'fixed', value: 59 });
  });
  it('returns null for unsupported patterns (commas, ranges)', () => {
    expect(parseCronField('1,3,5')).toBeNull();
    expect(parseCronField('9-17')).toBeNull();
    expect(parseCronField('*/0')).toBeNull(); // step must be positive
    expect(parseCronField('garbage')).toBeNull();
  });
  it('trims whitespace', () => {
    expect(parseCronField('  7  ')).toEqual({ kind: 'fixed', value: 7 });
  });
});

describe('cron-scheduler: parseCronExpression', () => {
  it('parses standard 5-field expressions used in cortextos configs', () => {
    expect(parseCronExpression('7 */4 * * *')).toEqual({
      minute: { kind: 'fixed', value: 7 },
      hour: { kind: 'every', step: 4 },
      dom: { kind: 'any' },
      month: { kind: 'any' },
      dow: { kind: 'any' },
    });
    expect(parseCronExpression('37 22 * * *')).not.toBeNull();
    expect(parseCronExpression('13 23 * * 0')).not.toBeNull();
    expect(parseCronExpression('0 8 * * 0')).not.toBeNull();
  });
  it('returns null for wrong field count', () => {
    expect(parseCronExpression('* * * *')).toBeNull(); // 4 fields
    expect(parseCronExpression('* * * * * *')).toBeNull(); // 6 fields
    expect(parseCronExpression('')).toBeNull();
  });
  it('returns null for unsupported patterns in any field', () => {
    expect(parseCronExpression('1,3 * * * *')).toBeNull();
    expect(parseCronExpression('* 9-17 * * *')).toBeNull();
  });
});

describe('cron-scheduler: nextFireTime', () => {
  it('every-4-hour at :07 from a known time', () => {
    const parsed = parseCronExpression('7 */4 * * *')!;
    // Start at 2026-05-01 14:30 UTC — next fire should be 16:07 UTC (every 4h matches 16:07)
    // Actually the */4 pattern matches hour 0,4,8,12,16,20. At 14:30 the next match is 16:07.
    const from = new Date('2026-05-01T14:30:00Z');
    const next = nextFireTime(parsed, from)!;
    // Note: nextFireTime uses local-time field semantics (Date.getMinutes/getHours).
    // We can't assert UTC strictly but we can verify the minute is 7 and hour % 4 === 0.
    expect(next.getMinutes()).toBe(7);
    expect(next.getHours() % 4).toBe(0);
    // And it's strictly in the future
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  it('daily at fixed hour:minute', () => {
    const parsed = parseCronExpression('37 22 * * *')!;
    const from = new Date(2026, 4, 1, 10, 0); // 2026-05-01 10:00 LOCAL
    const next = nextFireTime(parsed, from)!;
    expect(next.getHours()).toBe(22);
    expect(next.getMinutes()).toBe(37);
    // Same day (10:00 < 22:37)
    expect(next.getDate()).toBe(1);
  });

  it('rolls to next day if current time is past today\'s fire', () => {
    const parsed = parseCronExpression('37 22 * * *')!;
    const from = new Date(2026, 4, 1, 23, 0); // past 22:37
    const next = nextFireTime(parsed, from)!;
    expect(next.getHours()).toBe(22);
    expect(next.getMinutes()).toBe(37);
    expect(next.getDate()).toBe(2); // next day
  });

  it('weekly cron (Sundays only)', () => {
    const parsed = parseCronExpression('13 23 * * 0')!;
    // Pick a known Monday — May 4 2026 is a Monday
    const from = new Date(2026, 4, 4, 10, 0); // Mon 2026-05-04 10:00
    const next = nextFireTime(parsed, from)!;
    // Next Sunday is 2026-05-10
    expect(next.getDay()).toBe(0);
    expect(next.getHours()).toBe(23);
    expect(next.getMinutes()).toBe(13);
  });

  it('returns null if no match within 8 days', () => {
    // An unsupported field returns null from parseCronExpression, but if we
    // construct an impossible parsed object directly, nextFireTime should
    // gracefully return null. Use month=13 (impossible).
    const impossible = {
      minute: { kind: 'any' as const },
      hour: { kind: 'any' as const },
      dom: { kind: 'any' as const },
      month: { kind: 'fixed' as const, value: 13 },
      dow: { kind: 'any' as const },
    };
    expect(nextFireTime(impossible, new Date())).toBeNull();
  });
});

describe('cron-scheduler: DaemonCronScheduler integration', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `cron-sched-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(stateDir, { recursive: true });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes cron-state.json on first fire of an interval cron', () => {
    const crons: CronEntry[] = [
      { name: 'heartbeat', type: 'recurring', interval: '4h', prompt: 'Read HEARTBEAT.md' },
    ];
    const logs: string[] = [];
    const sched = new DaemonCronScheduler(stateDir, 'test', crons, (m) => logs.push(m));
    sched.start();

    // Advance past the 4h interval
    vi.advanceTimersByTime(4 * 60 * 60 * 1000 + 100);

    const cronStatePath = join(stateDir, 'cron-state.json');
    expect(existsSync(cronStatePath)).toBe(true);
    const state = JSON.parse(readFileSync(cronStatePath, 'utf-8'));
    expect(state.crons).toHaveLength(1);
    expect(state.crons[0].name).toBe('heartbeat');
    expect(state.crons[0].interval).toBe('4h');
    expect(state.crons[0].last_fire).toBeTruthy();
    sched.stop();
  });

  it('skips crons with unsupported cron expressions but does not throw', () => {
    const crons: CronEntry[] = [
      { name: 'badone', type: 'recurring', cron: '1,3,5 * * * *', prompt: 'x' }, // comma list
      { name: 'goodone', type: 'recurring', interval: '4h', prompt: 'y' },
    ];
    const logs: string[] = [];
    const sched = new DaemonCronScheduler(stateDir, 'test', crons, (m) => logs.push(m));
    sched.start();

    // The bad one should have been logged as skipped
    expect(logs.some(l => l.includes('badone') && l.includes('unsupported'))).toBe(true);

    // Advance to fire the good one
    vi.advanceTimersByTime(4 * 60 * 60 * 1000 + 100);
    const state = JSON.parse(readFileSync(join(stateDir, 'cron-state.json'), 'utf-8'));
    expect(state.crons.find((c: { name: string }) => c.name === 'goodone')).toBeTruthy();
    expect(state.crons.find((c: { name: string }) => c.name === 'badone')).toBeFalsy();
    sched.stop();
  });

  it('stop() clears all timers — no further writes after stop', () => {
    const crons: CronEntry[] = [
      { name: 'heartbeat', type: 'recurring', interval: '4h', prompt: 'x' },
    ];
    const sched = new DaemonCronScheduler(stateDir, 'test', crons, () => {});
    sched.start();
    sched.stop();
    vi.advanceTimersByTime(4 * 60 * 60 * 1000 + 100);
    // No fire happened
    expect(existsSync(join(stateDir, 'cron-state.json'))).toBe(false);
  });

  it('skips disabled and once-type crons', () => {
    const crons: CronEntry[] = [
      { name: 'oneShot', type: 'once', fire_at: '2099-01-01T00:00:00Z', prompt: 'x' },
      { name: 'disabledOne', type: 'disabled', interval: '4h', prompt: 'y' },
    ];
    const sched = new DaemonCronScheduler(stateDir, 'test', crons, () => {});
    sched.start();
    vi.advanceTimersByTime(5 * 60 * 60 * 1000);
    expect(existsSync(join(stateDir, 'cron-state.json'))).toBe(false);
    sched.stop();
  });
});

describe('cron-scheduler: makeDaemonCronScheduler factory', () => {
  it('returns null when crons is undefined or empty', () => {
    expect(makeDaemonCronScheduler('/tmp/x', 'agent', undefined, () => {})).toBeNull();
    expect(makeDaemonCronScheduler('/tmp/x', 'agent', [], () => {})).toBeNull();
  });

  it('returns a scheduler instance when crons is non-empty', () => {
    const crons: CronEntry[] = [{ name: 'h', type: 'recurring', interval: '4h', prompt: 'x' }];
    const sched = makeDaemonCronScheduler('/tmp/x', 'agent', crons, () => {});
    expect(sched).not.toBeNull();
  });
});
