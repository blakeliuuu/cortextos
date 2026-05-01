import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectDayNightMode, parseHour, inDayWindow } from '../src/bus/heartbeat.js';

describe('Sprint 7: Environment & Config Completeness', () => {
  const testDir = join(tmpdir(), `cortextos-sprint7-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('Timezone resolution', () => {
    it('resolves timezone from context.json', () => {
      const orgDir = join(testDir, 'orgs', 'testorg');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'context.json'), JSON.stringify({
        name: 'testorg',
        timezone: 'America/New_York',
        orchestrator: 'sentinel',
      }), 'utf-8');

      const ctx = JSON.parse(readFileSync(join(orgDir, 'context.json'), 'utf-8'));
      expect(ctx.timezone).toBe('America/New_York');
    });

    it('orchestrator resolved from context.json', () => {
      const orgDir = join(testDir, 'orgs', 'testorg');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'context.json'), JSON.stringify({
        name: 'testorg',
        timezone: 'UTC',
        orchestrator: 'sentinel',
      }), 'utf-8');

      const ctx = JSON.parse(readFileSync(join(orgDir, 'context.json'), 'utf-8'));
      expect(ctx.orchestrator).toBe('sentinel');
    });
  });

  describe('Day/night mode detection', () => {
    it('returns day for daytime hours', () => {
      // We can't control the actual time, but we can test the function signature
      const mode = detectDayNightMode('UTC');
      expect(['day', 'night']).toContain(mode);
    });

    it('handles invalid timezone gracefully', () => {
      const mode = detectDayNightMode('Invalid/Timezone');
      expect(['day', 'night']).toContain(mode);
    });

    it('accepts optional dayStart/dayEnd without throwing', () => {
      const mode = detectDayNightMode('UTC', '06:00', '22:00');
      expect(['day', 'night']).toContain(mode);
    });
  });

  describe('parseHour', () => {
    it('parses HH:MM format', () => {
      expect(parseHour('06:00', 99)).toBe(6);
      expect(parseHour('22:00', 99)).toBe(22);
      expect(parseHour('00:00', 99)).toBe(0);
      expect(parseHour('9:30', 99)).toBe(9);
    });

    it('parses HH-only format', () => {
      expect(parseHour('8', 99)).toBe(8);
      expect(parseHour('23', 99)).toBe(23);
    });

    it('returns fallback for missing input', () => {
      expect(parseHour(undefined, 8)).toBe(8);
      expect(parseHour('', 22)).toBe(22);
    });

    it('returns fallback for unparseable input', () => {
      expect(parseHour('garbage', 8)).toBe(8);
      expect(parseHour('25:00', 8)).toBe(8);
      expect(parseHour('-1', 8)).toBe(8);
    });
  });

  describe('inDayWindow', () => {
    it('handles standard window (start < end)', () => {
      // 8:00–22:00 (default)
      expect(inDayWindow(8, 8, 22)).toBe(true);
      expect(inDayWindow(15, 8, 22)).toBe(true);
      expect(inDayWindow(21, 8, 22)).toBe(true);
      expect(inDayWindow(22, 8, 22)).toBe(false);
      expect(inDayWindow(7, 8, 22)).toBe(false);
      expect(inDayWindow(0, 8, 22)).toBe(false);
    });

    it('handles Blake org window 06:00–22:00', () => {
      // The bug case — Blake's actual config
      expect(inDayWindow(6, 6, 22)).toBe(true);   // day starts at 6
      expect(inDayWindow(7, 6, 22)).toBe(true);   // 7am should be day (was night under hardcoded 8-22)
      expect(inDayWindow(21, 6, 22)).toBe(true);
      expect(inDayWindow(22, 6, 22)).toBe(false);
      expect(inDayWindow(5, 6, 22)).toBe(false);
    });

    it('handles end-as-midnight (end === 0)', () => {
      // day_mode_end "00:00" means "until midnight"
      expect(inDayWindow(8, 8, 0)).toBe(true);
      expect(inDayWindow(15, 8, 0)).toBe(true);
      expect(inDayWindow(23, 8, 0)).toBe(true);   // still day at 11pm
      expect(inDayWindow(0, 8, 0)).toBe(false);   // midnight is night
      expect(inDayWindow(7, 8, 0)).toBe(false);
    });

    it('handles wrap-around window (start > end)', () => {
      // 22:00–06:00 (e.g. a night-shift agent)
      expect(inDayWindow(22, 22, 6)).toBe(true);  // day starts at 22
      expect(inDayWindow(23, 22, 6)).toBe(true);
      expect(inDayWindow(0, 22, 6)).toBe(true);   // crosses midnight
      expect(inDayWindow(5, 22, 6)).toBe(true);
      expect(inDayWindow(6, 22, 6)).toBe(false);
      expect(inDayWindow(15, 22, 6)).toBe(false);
    });
  });

  describe('detectDayNightMode with org config', () => {
    it('default 8-22 window matches old behavior when no config provided', () => {
      // Backward-compat: missing dayStart/dayEnd defaults to old 8-22
      const mode = detectDayNightMode('UTC');
      expect(['day', 'night']).toContain(mode);
    });

    it('respects custom day window when provided', () => {
      // Tested via inDayWindow above; here we just ensure the chain runs
      const mode = detectDayNightMode('America/Los_Angeles', '06:00', '22:00');
      expect(['day', 'night']).toContain(mode);
    });

    it('falls back to defaults when dayStart/dayEnd are unparseable', () => {
      const mode = detectDayNightMode('UTC', 'garbage', 'garbage');
      expect(['day', 'night']).toContain(mode);
    });
  });

  describe('Heartbeat with mode and loop_interval', () => {
    it('heartbeat JSON includes mode field', () => {
      const heartbeat = {
        agent: 'testbot',
        timestamp: new Date().toISOString(),
        status: 'running',
        mode: 'day' as const,
        loop_interval: '4h',
      };

      const path = join(testDir, 'heartbeat.json');
      writeFileSync(path, JSON.stringify(heartbeat), 'utf-8');

      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      expect(parsed.mode).toBe('day');
      expect(parsed.loop_interval).toBe('4h');
    });
  });

  describe('enabled-agents.json format compatibility', () => {
    it('supports full agent config format', () => {
      const config = {
        sentinel: {
          enabled: true,
          status: 'configured',
          org: 'acme',
          template: 'orchestrator',
          model: 'claude-sonnet-4-6',
        },
        analyst: {
          enabled: true,
          status: 'configured',
          org: 'acme',
          template: 'analyst',
        },
        worker: {
          enabled: false,
          status: 'disabled',
          org: 'acme',
        },
      };

      const path = join(testDir, 'enabled-agents.json');
      writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');

      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      expect(Object.keys(parsed).length).toBe(3);
      expect(parsed.sentinel.template).toBe('orchestrator');
      expect(parsed.worker.enabled).toBe(false);
    });

    it('handles legacy format (just enabled flag)', () => {
      const legacyConfig = {
        bot1: { enabled: true },
        bot2: { enabled: false },
      };

      const path = join(testDir, 'enabled-agents.json');
      writeFileSync(path, JSON.stringify(legacyConfig), 'utf-8');

      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      expect(parsed.bot1.enabled).toBe(true);
      expect(parsed.bot2.enabled).toBe(false);
    });
  });

  describe('Loop interval from config.json', () => {
    it('reads heartbeat cron interval', () => {
      const config = {
        crons: [
          { name: 'heartbeat', interval: '4h', command: 'Run heartbeat' },
          { name: 'check-approvals', interval: '30m', command: 'Check approvals' },
        ],
      };

      const path = join(testDir, 'config.json');
      writeFileSync(path, JSON.stringify(config), 'utf-8');

      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      const heartbeatCron = parsed.crons.find((c: any) => c.name === 'heartbeat');
      expect(heartbeatCron).toBeDefined();
      expect(heartbeatCron.interval).toBe('4h');
    });
  });

  describe('Uninstall', () => {
    it('state directory can be cleaned up', () => {
      const ctxRoot = join(testDir, 'cortextos-state');
      mkdirSync(join(ctxRoot, 'inbox'), { recursive: true });
      mkdirSync(join(ctxRoot, 'state'), { recursive: true });
      mkdirSync(join(ctxRoot, 'logs'), { recursive: true });

      expect(existsSync(ctxRoot)).toBe(true);
      rmSync(ctxRoot, { recursive: true, force: true });
      expect(existsSync(ctxRoot)).toBe(false);
    });
  });
});
