import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  brainWrite,
  slugify,
  sanitizeSubfolder,
  buildFrontmatter,
  VALID_PARA_DESTINATIONS,
} from '../../../src/bus/brain-write.js';

describe('brain-write: slugify', () => {
  it('lowercases and replaces spaces', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('collapses multiple non-alphanum chars into single dash', () => {
    expect(slugify('hello!!!world  -- foo')).toBe('hello-world-foo');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugify('  ---hello---  ')).toBe('hello');
  });

  it('handles unicode by stripping (no-alphanum policy)', () => {
    expect(slugify('café résumé 你好')).toBe('caf-r-sum');
  });

  it('caps slug at 80 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });

  it('returns "untitled" for all-punctuation input', () => {
    expect(slugify('!!!---***')).toBe('untitled');
    expect(slugify('   ')).toBe('untitled');
  });
});

describe('brain-write: sanitizeSubfolder', () => {
  it('returns empty string for undefined or empty input', () => {
    expect(sanitizeSubfolder(undefined)).toBe('');
    expect(sanitizeSubfolder('')).toBe('');
    expect(sanitizeSubfolder('   ')).toBe('');
  });

  it('accepts simple relative paths', () => {
    expect(sanitizeSubfolder('quick-notes')).toBe('quick-notes');
    expect(sanitizeSubfolder('ai-knowledge/claude-code')).toBe('ai-knowledge/claude-code');
  });

  it('strips ./ prefix', () => {
    expect(sanitizeSubfolder('./quick-notes')).toBe('quick-notes');
  });

  it('rejects absolute paths', () => {
    expect(() => sanitizeSubfolder('/etc')).toThrow(/must be relative/);
    expect(() => sanitizeSubfolder('/Users/jarvis/anywhere')).toThrow(/must be relative/);
  });

  it('rejects path traversal with ..', () => {
    expect(() => sanitizeSubfolder('../escape')).toThrow(/path traversal/);
    expect(() => sanitizeSubfolder('foo/../escape')).toThrow(/path traversal/);
    expect(() => sanitizeSubfolder('foo/..')).toThrow(/path traversal/);
  });
});

describe('brain-write: buildFrontmatter', () => {
  it('emits ordered fields with YAML escaping', () => {
    const fm = buildFrontmatter({
      title: 'Hello "World"',
      date: '2026-05-01',
      tags: ['ai', 'consulting'],
      agentName: 'analyst',
    });
    expect(fm).toContain('---\n');
    expect(fm).toContain('title: "Hello \\"World\\""');
    expect(fm).toContain('date: 2026-05-01');
    expect(fm).toContain('tags: [ai, consulting]');
    expect(fm).toContain('created_by_agent: analyst');
    expect(fm.endsWith('---\n\n')).toBe(true);
  });

  it('handles empty tags as []', () => {
    const fm = buildFrontmatter({
      title: 't',
      date: '2026-05-01',
      tags: [],
      agentName: 'analyst',
    });
    expect(fm).toContain('tags: []');
  });

  it('quotes tags that contain spaces or commas', () => {
    const fm = buildFrontmatter({
      title: 't',
      date: '2026-05-01',
      tags: ['ai-tools', 'multi word', 'has,comma'],
      agentName: 'analyst',
    });
    expect(fm).toContain('tags: [ai-tools, "multi word", "has,comma"]');
  });
});

describe('brain-write: VALID_PARA_DESTINATIONS', () => {
  it('includes the 4 capture-eligible PARA folders only (no 04-archive)', () => {
    expect(VALID_PARA_DESTINATIONS).toEqual(['00-inbox', '01-projects', '02-areas', '03-resources']);
    expect(VALID_PARA_DESTINATIONS).not.toContain('04-archive');
    expect(VALID_PARA_DESTINATIONS).not.toContain('_config');
  });
});

describe('brain-write: brainWrite (integration)', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = join(tmpdir(), `brainwrite-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testRoot, { recursive: true });
    // Pre-create the PARA dirs so tests don't need to
    for (const dest of VALID_PARA_DESTINATIONS) {
      mkdirSync(join(testRoot, dest), { recursive: true });
    }
  });

  afterEach(() => {
    try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes a new file with frontmatter at the default 00-inbox', () => {
    const r = brainWrite({
      title: 'My First Capture',
      content: 'Some content here.',
      brainRoot: testRoot,
      agentName: 'analyst',
    });
    expect(r.destination).toBe('00-inbox');
    expect(r.slug).toBe('my-first-capture');
    expect(existsSync(r.path)).toBe(true);

    const content = readFileSync(r.path, 'utf-8');
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain('title: "My First Capture"');
    expect(content).toContain('created_by_agent: analyst');
    expect(content).toContain('Some content here.');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('respects custom destination + subfolder', () => {
    const r = brainWrite({
      title: 'Idea Note',
      content: 'body',
      destination: '02-areas',
      subfolder: 'ai-knowledge/claude-code',
      brainRoot: testRoot,
    });
    expect(r.path).toContain('02-areas/ai-knowledge/claude-code/idea-note.md');
    expect(existsSync(r.path)).toBe(true);
  });

  it('refuses to overwrite an existing file', () => {
    brainWrite({ title: 'Note', content: 'first', brainRoot: testRoot });
    expect(() =>
      brainWrite({ title: 'Note', content: 'second', brainRoot: testRoot }),
    ).toThrow(/already exists/);
  });

  it('rejects empty title and empty content', () => {
    expect(() => brainWrite({ title: '', content: 'x', brainRoot: testRoot })).toThrow(/title is required/);
    expect(() => brainWrite({ title: '   ', content: 'x', brainRoot: testRoot })).toThrow(/title is required/);
    expect(() => brainWrite({ title: 't', content: '', brainRoot: testRoot })).toThrow(/content is required/);
  });

  it('rejects invalid PARA destination', () => {
    expect(() =>
      brainWrite({
        title: 't',
        content: 'x',
        // @ts-expect-error intentional invalid
        destination: '04-archive',
        brainRoot: testRoot,
      }),
    ).toThrow(/invalid destination/);
    expect(() =>
      brainWrite({
        title: 't',
        content: 'x',
        // @ts-expect-error intentional invalid
        destination: '_config',
        brainRoot: testRoot,
      }),
    ).toThrow(/invalid destination/);
  });

  it('rejects subfolder with path traversal', () => {
    expect(() =>
      brainWrite({
        title: 't',
        content: 'x',
        subfolder: '../escape',
        brainRoot: testRoot,
      }),
    ).toThrow(/path traversal/);
  });

  it('records the agent name from CTX_AGENT_NAME if not passed', () => {
    const prev = process.env.CTX_AGENT_NAME;
    process.env.CTX_AGENT_NAME = 'cron-runner';
    try {
      const r = brainWrite({ title: 'env capture', content: 'body', brainRoot: testRoot });
      const content = readFileSync(r.path, 'utf-8');
      expect(content).toContain('created_by_agent: cron-runner');
    } finally {
      if (prev === undefined) delete process.env.CTX_AGENT_NAME;
      else process.env.CTX_AGENT_NAME = prev;
    }
  });

  it('falls back to "unknown" agent if env not set and not passed', () => {
    const prev = process.env.CTX_AGENT_NAME;
    delete process.env.CTX_AGENT_NAME;
    try {
      const r = brainWrite({ title: 'no agent', content: 'body', brainRoot: testRoot });
      const content = readFileSync(r.path, 'utf-8');
      expect(content).toContain('created_by_agent: unknown');
    } finally {
      if (prev !== undefined) process.env.CTX_AGENT_NAME = prev;
    }
  });

  it('creates intermediate subfolder dirs as needed', () => {
    const r = brainWrite({
      title: 'deep',
      content: 'body',
      destination: '01-projects',
      subfolder: 'a/b/c/d',
      brainRoot: testRoot,
    });
    expect(existsSync(r.path)).toBe(true);
    expect(r.path).toContain('01-projects/a/b/c/d/deep.md');
  });

  it('appends trailing newline if content does not end with one', () => {
    const r = brainWrite({ title: 'no-newline', content: 'no newline at end', brainRoot: testRoot });
    const content = readFileSync(r.path, 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
    // body line "no newline at end\n" — exactly one trailing newline (no double)
    expect(content.endsWith('no newline at end\n')).toBe(true);
  });

  it('preserves single trailing newline when content already ends with one', () => {
    const r = brainWrite({ title: 'with-newline', content: 'has newline\n', brainRoot: testRoot });
    const content = readFileSync(r.path, 'utf-8');
    expect(content.endsWith('has newline\n')).toBe(true);
    expect(content.endsWith('has newline\n\n')).toBe(false); // no double-newline
  });
});
