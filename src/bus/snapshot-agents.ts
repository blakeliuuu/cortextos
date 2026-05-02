/**
 * Hourly git snapshot of agent workspace state. Mirrors per-agent state
 * (config.json, goals.json, MEMORY.md, memory/, baselines/, outputs/,
 * IDENTITY.md, etc.) into a local git repo at:
 *
 *   $CTX_ROOT/snapshots/<org>/
 *
 * Why a separate repo (vs. committing into the cortextos framework repo
 * directly): orgs/ is gitignored at the framework level — it contains
 * user state that shouldn't be shipped with the framework. We need
 * version control on agent state regardless. The snapshot repo is local
 * only (never pushed) and provides reversible point-in-time history of
 * goals, memory, and config edits.
 *
 * Whitelist-based copy: we mirror only the textual config/memory/output
 * artifacts. We DO NOT mirror:
 *   - `.env` files (contain BOT_TOKEN, secrets)
 *   - `.claude/` (framework-distributed skills, not user state)
 *   - `.git/` (would be a nested repo)
 *   - `node_modules/`
 *
 * Reversibility: source files are never modified — only read and copied.
 * The snapshot repo is the only thing changed. Restoration is `git
 * checkout <sha>` in the snapshot repo, then manual copy back if needed.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from 'fs';
import { join } from 'path';

export interface SnapshotAgentsOptions {
  /** Framework root (where orgs/ lives). Default from CTX_FRAMEWORK_ROOT. */
  frameworkRoot: string;
  /** Runtime root (where the snapshots/ dir is created). Default from CTX_ROOT. */
  ctxRoot: string;
  /** Org to snapshot. Default from CTX_ORG. */
  org: string;
}

export interface SnapshotResult {
  repoPath: string;
  status: 'committed' | 'no_changes' | 'initialized';
  commitSha?: string;
  message?: string;
}

const PER_AGENT_FILES = [
  'config.json',
  'goals.json',
  'MEMORY.md',
  'IDENTITY.md',
  'GOALS.md',
  'USER.md',
  'SOUL.md',
  'GUARDRAILS.md',
  'CLAUDE.md',
  'AGENTS.md',
  'HEARTBEAT.md',
  'SYSTEM.md',
  'TOOLS.md',
];

const PER_AGENT_DIRS = ['memory', 'baselines', 'outputs', 'experiments'];

const ORG_FILES = ['context.json', 'goals.json', 'knowledge.md'];

function copyDirRecursive(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      copyFileSync(s, d);
    }
  }
}

function safeCopyFile(src: string, dst: string): void {
  if (existsSync(src) && statSync(src).isFile()) {
    mkdirSync(join(dst, '..'), { recursive: true });
    copyFileSync(src, dst);
  }
}

function gitInitIfMissing(repoPath: string): boolean {
  if (existsSync(join(repoPath, '.git'))) return false;
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'snapshot@cortextos.local'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'cortextos-snapshot'], { cwd: repoPath, stdio: 'pipe' });
  return true;
}

/**
 * Mirror agent state into the snapshot repo. Returns the count of files
 * copied so callers can log volume metrics. Exposed for unit testing.
 */
export function mirrorAgentStateToRepo(
  frameworkRoot: string,
  org: string,
  repoPath: string,
): number {
  let copied = 0;
  const sourceOrgDir = join(frameworkRoot, 'orgs', org);
  if (!existsSync(sourceOrgDir)) return 0;

  // Mirror per-agent state
  const sourceAgentsDir = join(sourceOrgDir, 'agents');
  if (existsSync(sourceAgentsDir)) {
    const targetAgentsDir = join(repoPath, 'agents');
    // Clear the target agents dir first so deletions in source propagate
    if (existsSync(targetAgentsDir)) rmSync(targetAgentsDir, { recursive: true, force: true });
    mkdirSync(targetAgentsDir, { recursive: true });

    for (const entry of readdirSync(sourceAgentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const agentName = entry.name;
      const srcDir = join(sourceAgentsDir, agentName);
      const dstDir = join(targetAgentsDir, agentName);
      mkdirSync(dstDir, { recursive: true });

      for (const f of PER_AGENT_FILES) {
        const src = join(srcDir, f);
        const dst = join(dstDir, f);
        if (existsSync(src) && statSync(src).isFile()) {
          copyFileSync(src, dst);
          copied++;
        }
      }
      for (const d of PER_AGENT_DIRS) {
        const src = join(srcDir, d);
        if (existsSync(src) && statSync(src).isDirectory()) {
          copyDirRecursive(src, join(dstDir, d));
          copied++;
        }
      }
    }
  }

  // Mirror org-level state
  for (const f of ORG_FILES) {
    const src = join(sourceOrgDir, f);
    const dst = join(repoPath, f);
    safeCopyFile(src, dst);
    if (existsSync(dst)) copied++;
  }

  return copied;
}

/**
 * Take a snapshot of the org's agent state. Idempotent — if no files have
 * changed since the last snapshot, returns status='no_changes' and does
 * not create an empty commit.
 */
export function snapshotAgents(options: SnapshotAgentsOptions): SnapshotResult {
  if (!options.org || options.org.trim() === '') {
    throw new Error('snapshot-agents: org is required');
  }
  if (!existsSync(options.frameworkRoot)) {
    throw new Error(`snapshot-agents: frameworkRoot does not exist: ${options.frameworkRoot}`);
  }

  const repoPath = join(options.ctxRoot, 'snapshots', options.org);
  const initialized = gitInitIfMissing(repoPath);

  mirrorAgentStateToRepo(options.frameworkRoot, options.org, repoPath);

  // Stage everything that changed
  execFileSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'pipe' });

  // Detect if there are staged changes (git diff --cached --quiet exits 0 if nothing)
  let hasChanges = false;
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: repoPath, stdio: 'pipe' });
  } catch {
    hasChanges = true;
  }

  if (!hasChanges) {
    return {
      repoPath,
      status: initialized ? 'initialized' : 'no_changes',
      message: initialized ? 'Repo initialized; no agent state to commit yet' : 'No state changes since last snapshot',
    };
  }

  const timestamp = new Date().toISOString();
  execFileSync(
    'git',
    ['commit', '-m', `snapshot: ${timestamp}`],
    { cwd: repoPath, stdio: 'pipe' },
  );
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8' }).trim();

  return {
    repoPath,
    status: 'committed',
    commitSha: sha,
    message: `Committed snapshot at ${timestamp}`,
  };
}
