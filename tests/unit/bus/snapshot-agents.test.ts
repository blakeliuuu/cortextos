import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { snapshotAgents, mirrorAgentStateToRepo } from '../../../src/bus/snapshot-agents.js';

describe('snapshot-agents', () => {
  let testDir: string;
  let frameworkRoot: string;
  let ctxRoot: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `snapshot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    frameworkRoot = join(testDir, 'cortextos');
    ctxRoot = join(testDir, '.cortextos', 'default');
    mkdirSync(frameworkRoot, { recursive: true });
    mkdirSync(ctxRoot, { recursive: true });

    // Set up a fake org with one agent
    const agentDir = join(frameworkRoot, 'orgs', 'testorg', 'agents', 'analyst');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ agent_name: 'analyst' }), 'utf-8');
    writeFileSync(join(agentDir, 'goals.json'), JSON.stringify({ focus: 'testing' }), 'utf-8');
    writeFileSync(join(agentDir, 'MEMORY.md'), '# Memory\n\nTest content.\n', 'utf-8');
    writeFileSync(join(agentDir, '.env'), 'BOT_TOKEN=secret123\nCHAT_ID=456\n', 'utf-8'); // should NOT be copied

    // Memory subdir
    mkdirSync(join(agentDir, 'memory'), { recursive: true });
    writeFileSync(join(agentDir, 'memory', '2026-05-01.md'), 'daily memory', 'utf-8');

    // Skills dir (should NOT be copied — framework-distributed)
    mkdirSync(join(agentDir, '.claude', 'skills', 'foo'), { recursive: true });
    writeFileSync(join(agentDir, '.claude', 'skills', 'foo', 'SKILL.md'), 'skill content', 'utf-8');

    // Org-level files
    const orgDir = join(frameworkRoot, 'orgs', 'testorg');
    writeFileSync(join(orgDir, 'context.json'), JSON.stringify({ name: 'testorg' }), 'utf-8');
    writeFileSync(join(orgDir, 'knowledge.md'), '# Org KB\n', 'utf-8');
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('initializes a git repo on first run', () => {
    const result = snapshotAgents({ frameworkRoot, ctxRoot, org: 'testorg' });
    const repoPath = join(ctxRoot, 'snapshots', 'testorg');
    expect(existsSync(join(repoPath, '.git'))).toBe(true);
    expect(result.repoPath).toBe(repoPath);
    expect(result.status).toBe('committed'); // since we wrote files in beforeEach
    expect(result.commitSha).toBeTruthy();
  });

  it('copies whitelisted per-agent files', () => {
    snapshotAgents({ frameworkRoot, ctxRoot, org: 'testorg' });
    const repoPath = join(ctxRoot, 'snapshots', 'testorg');
    expect(existsSync(join(repoPath, 'agents', 'analyst', 'config.json'))).toBe(true);
    expect(existsSync(join(repoPath, 'agents', 'analyst', 'goals.json'))).toBe(true);
    expect(existsSync(join(repoPath, 'agents', 'analyst', 'MEMORY.md'))).toBe(true);
    expect(existsSync(join(repoPath, 'agents', 'analyst', 'memory', '2026-05-01.md'))).toBe(true);
  });

  it('does NOT copy .env files (secrets)', () => {
    snapshotAgents({ frameworkRoot, ctxRoot, org: 'testorg' });
    const repoPath = join(ctxRoot, 'snapshots', 'testorg');
    expect(existsSync(join(repoPath, 'agents', 'analyst', '.env'))).toBe(false);
  });

  it('does NOT copy .claude/ skills dir (framework-distributed, not user state)', () => {
    snapshotAgents({ frameworkRoot, ctxRoot, org: 'testorg' });
    const repoPath = join(ctxRoot, 'snapshots', 'testorg');
    expect(existsSync(join(repoPath, 'agents', 'analyst', '.claude'))).toBe(false);
  });

  it('copies org-level files (context.json, knowledge.md)', () => {
    snapshotAgents({ frameworkRoot, ctxRoot, org: 'testorg' });
    const repoPath = join(ctxRoot, 'snapshots', 'testorg');
    expect(existsSync(join(repoPath, 'context.json'))).toBe(true);
    expect(existsSync(join(repoPath, 'knowledge.md'))).toBe(true);
  });

  it('returns no_changes on second snapshot if nothing changed', () => {
    snapshotAgents({ frameworkRoot, ctxRoot, org: 'testorg' });
    const second = snapshotAgents({ frameworkRoot, ctxRoot, org: 'testorg' });
    expect(second.status).toBe('no_changes');
    expect(second.commitSha).toBeUndefined();
  });

  it('creates a new commit when source files change', () => {
    const first = snapshotAgents({ frameworkRoot, ctxRoot, org: 'testorg' });
    expect(first.status).toBe('committed');
    const firstSha = first.commitSha;

    // Modify a source file
    const memPath = join(frameworkRoot, 'orgs', 'testorg', 'agents', 'analyst', 'MEMORY.md');
    writeFileSync(memPath, '# Memory\n\nUpdated content.\n', 'utf-8');

    const second = snapshotAgents({ frameworkRoot, ctxRoot, org: 'testorg' });
    expect(second.status).toBe('committed');
    expect(second.commitSha).not.toBe(firstSha);

    // Verify the new commit has the updated content
    const repoPath = join(ctxRoot, 'snapshots', 'testorg');
    const snapshotted = readFileSync(join(repoPath, 'agents', 'analyst', 'MEMORY.md'), 'utf-8');
    expect(snapshotted).toContain('Updated content');
  });

  it('reflects file deletions across snapshots', () => {
    snapshotAgents({ frameworkRoot, ctxRoot, org: 'testorg' });
    // Delete an agent in the source
    rmSync(join(frameworkRoot, 'orgs', 'testorg', 'agents', 'analyst'), { recursive: true });
    const second = snapshotAgents({ frameworkRoot, ctxRoot, org: 'testorg' });
    expect(second.status).toBe('committed'); // deletion is a change
    const repoPath = join(ctxRoot, 'snapshots', 'testorg');
    expect(existsSync(join(repoPath, 'agents', 'analyst'))).toBe(false);
  });

  it('does not modify source files (read-only mirror)', () => {
    const memPath = join(frameworkRoot, 'orgs', 'testorg', 'agents', 'analyst', 'MEMORY.md');
    const before = readFileSync(memPath, 'utf-8');
    snapshotAgents({ frameworkRoot, ctxRoot, org: 'testorg' });
    const after = readFileSync(memPath, 'utf-8');
    expect(after).toBe(before);
  });

  it('throws on missing org', () => {
    expect(() => snapshotAgents({ frameworkRoot, ctxRoot, org: '' })).toThrow(/org is required/);
  });

  it('throws on missing frameworkRoot', () => {
    expect(() =>
      snapshotAgents({ frameworkRoot: '/nonexistent/path/xxxx', ctxRoot, org: 'testorg' }),
    ).toThrow(/frameworkRoot does not exist/);
  });

  it('handles org with no agents directory gracefully (initialized status)', () => {
    rmSync(join(frameworkRoot, 'orgs', 'testorg', 'agents'), { recursive: true });
    rmSync(join(frameworkRoot, 'orgs', 'testorg', 'context.json'));
    rmSync(join(frameworkRoot, 'orgs', 'testorg', 'knowledge.md'));
    const result = snapshotAgents({ frameworkRoot, ctxRoot, org: 'testorg' });
    expect(['initialized', 'no_changes']).toContain(result.status);
  });

  it('mirrorAgentStateToRepo returns a positive count when files exist', () => {
    const repoPath = join(ctxRoot, 'snapshots-direct');
    mkdirSync(repoPath, { recursive: true });
    const count = mirrorAgentStateToRepo(frameworkRoot, 'testorg', repoPath);
    expect(count).toBeGreaterThan(0);
  });

  it('snapshot repo is reversible via git checkout', () => {
    const first = snapshotAgents({ frameworkRoot, ctxRoot, org: 'testorg' });
    const firstSha = first.commitSha!;

    // Modify and snapshot again
    const memPath = join(frameworkRoot, 'orgs', 'testorg', 'agents', 'analyst', 'MEMORY.md');
    writeFileSync(memPath, '# v2\n', 'utf-8');
    snapshotAgents({ frameworkRoot, ctxRoot, org: 'testorg' });

    // Check we can git checkout the first commit
    const repoPath = join(ctxRoot, 'snapshots', 'testorg');
    execFileSync('git', ['checkout', firstSha], { cwd: repoPath, stdio: 'pipe' });
    const restored = readFileSync(join(repoPath, 'agents', 'analyst', 'MEMORY.md'), 'utf-8');
    expect(restored).toContain('Test content');
    expect(restored).not.toContain('v2');
  });
});
