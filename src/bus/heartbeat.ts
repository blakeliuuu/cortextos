import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Heartbeat, BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

/**
 * Update heartbeat for the current agent.
 * Writes to: {ctxRoot}/state/{agent}/heartbeat.json
 * Matches bash update-heartbeat.sh format exactly.
 */
export function updateHeartbeat(
  paths: BusPaths,
  agentName: string,
  status: string,
  options?: {
    org?: string;
    timezone?: string;
    dayStart?: string;
    dayEnd?: string;
    loopInterval?: string;
    currentTask?: string;
    displayName?: string;
  },
): void {
  ensureDir(paths.stateDir);

  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const mode = detectDayNightMode(
    options?.timezone ?? 'UTC',
    options?.dayStart,
    options?.dayEnd,
  );

  const heartbeat: Heartbeat = {
    agent: agentName,
    org: options?.org ?? '',
    ...(options?.displayName ? { display_name: options.displayName } : {}),
    status,
    current_task: options?.currentTask ?? '',
    mode,
    last_heartbeat: ts,
    loop_interval: options?.loopInterval ?? '',
  };

  atomicWriteSync(
    join(paths.stateDir, 'heartbeat.json'),
    JSON.stringify(heartbeat),
  );
}

/**
 * Parse "HH:MM" or "HH" into the hour integer 0-23.
 * Returns the fallback if the input is missing or unparseable.
 * "00:00" parses as 0 (midnight); inDayWindow handles it as end-of-day.
 */
export function parseHour(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const m = /^(\d{1,2})(?::\d{1,2})?$/.exec(input.trim());
  if (!m) return fallback;
  const h = parseInt(m[1], 10);
  return (h >= 0 && h <= 23) ? h : fallback;
}

/**
 * True if `hour` (0-23) falls inside [start, end).
 * - Standard window: start < end, e.g. 8..22 → 8 <= hour < 22
 * - Wrap-around window: start > end, e.g. 22..6 → hour >= 22 || hour < 6
 * - End-as-midnight: end === 0 means "until midnight" → hour >= start (anything from start through 23 is "day")
 */
export function inDayWindow(hour: number, start: number, end: number): boolean {
  if (end === 0) return hour >= start;
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/**
 * Detect day/night mode based on timezone and optional org day window.
 * Defaults to 8:00–22:00 if dayStart/dayEnd are not provided.
 * Accepts "HH" or "HH:MM" for start/end (e.g. "06:00", "22:00", "00:00" for midnight).
 */
export function detectDayNightMode(
  timezone: string,
  dayStart?: string,
  dayEnd?: string,
): 'day' | 'night' {
  const startH = parseHour(dayStart, 8);
  const endH = parseHour(dayEnd, 22);
  try {
    const now = new Date();
    const formatted = now.toLocaleString('en-US', { timeZone: timezone, hour12: false, hour: '2-digit' });
    const hour = parseInt(formatted, 10);
    return inDayWindow(hour, startH, endH) ? 'day' : 'night';
  } catch {
    // Fallback to UTC
    const hour = new Date().getUTCHours();
    return inDayWindow(hour, startH, endH) ? 'day' : 'night';
  }
}

/**
 * Read all agent heartbeats.
 * Scans state/ directory for agent subdirs containing heartbeat.json.
 * Matches dashboard heartbeat path: state/{agent}/heartbeat.json
 */
export function readAllHeartbeats(paths: BusPaths): Heartbeat[] {
  const heartbeats: Heartbeat[] = [];
  const stateDir = join(paths.ctxRoot, 'state');
  let agentDirs: string[];
  try {
    agentDirs = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }

  for (const agent of agentDirs) {
    const hbPath = join(stateDir, agent, 'heartbeat.json');
    try {
      const content = readFileSync(hbPath, 'utf-8');
      heartbeats.push(JSON.parse(content));
    } catch {
      // Skip agents without heartbeat
    }
  }

  return heartbeats;
}
