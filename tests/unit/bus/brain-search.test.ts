import { describe, it, expect } from 'vitest';
import {
  parseBrainSearchOutput,
  formatBrainSearchResults,
  brainSearch,
  type BrainSearchResult,
} from '../../../src/bus/brain-search.js';

describe('brain-search: parseBrainSearchOutput', () => {
  const validResult: BrainSearchResult = {
    docid: '#abc123',
    score: 0.93,
    file: 'qmd://vault/01-projects/example/brief.md',
    title: 'Example Brief',
    context: 'Active project work',
    snippet: '@@ -1,4 @@ (0 before, 5 after)\n---\ntitle: Example',
  };

  it('parses a clean JSON array (no leading text)', () => {
    const stdout = JSON.stringify([validResult]);
    const parsed = parseBrainSearchOutput(stdout);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].file).toBe(validResult.file);
    expect(parsed[0].score).toBeCloseTo(0.93);
  });

  it('strips qmd status lines before the JSON array', () => {
    const stdout =
      'Expanding query... (2.8s)\n' +
      '├─ agent integration\n' +
      'Searching 2 queries...\n' +
      'Embedding 2 queries... (505ms)\n' +
      'Reranking 34 chunks... (13.9s)\n' +
      JSON.stringify([validResult]);
    const parsed = parseBrainSearchOutput(stdout);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('Example Brief');
  });

  it('returns empty array for empty result list', () => {
    const stdout = '[]';
    const parsed = parseBrainSearchOutput(stdout);
    expect(parsed).toEqual([]);
  });

  it('handles multi-result arrays', () => {
    const r2 = { ...validResult, docid: '#def456', score: 0.52, file: 'qmd://vault/02-areas/other.md' };
    const stdout = JSON.stringify([validResult, r2]);
    const parsed = parseBrainSearchOutput(stdout);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].score).toBeCloseTo(0.52);
  });

  it('throws when no JSON array is present', () => {
    expect(() => parseBrainSearchOutput('Expanding query...\nno JSON here\n')).toThrow(/did not contain a JSON array/);
  });

  it('throws when the stdout is empty', () => {
    expect(() => parseBrainSearchOutput('')).toThrow(/did not contain a JSON array/);
  });

  it('throws when JSON is malformed', () => {
    expect(() => parseBrainSearchOutput('[ {"docid": "#x"')).toThrow(/failed JSON parse/);
  });

  it('throws when JSON is not an array (e.g. object instead)', () => {
    expect(() => parseBrainSearchOutput('{"docid": "#x"}')).toThrow(/did not contain a JSON array/);
  });
});

describe('brain-search: formatBrainSearchResults', () => {
  const sample: BrainSearchResult = {
    docid: '#abc',
    score: 0.93,
    file: 'qmd://vault/01-projects/brief.md',
    title: 'Example',
    context: 'Active project',
    snippet: 'A snippet of content from the matched file with whitespace preserved.',
  };

  it('formats a single result with score percentage', () => {
    const out = formatBrainSearchResults([sample]);
    expect(out).toContain('[93%]');
    expect(out).toContain('qmd://vault/01-projects/brief.md');
    expect(out).toContain('Title:   Example');
    expect(out).toContain('Context: Active project');
  });

  it('returns "(no matches)" for empty array', () => {
    expect(formatBrainSearchResults([])).toBe('(no matches)');
  });

  it('formats multiple results with separators', () => {
    const r2 = { ...sample, docid: '#def', score: 0.5, file: 'qmd://vault/other.md', title: 'Other' };
    const out = formatBrainSearchResults([sample, r2]);
    expect(out).toContain('[93%]');
    expect(out).toContain('[50%]');
    expect(out.split('\n').length).toBeGreaterThan(8);
  });

  it('truncates long snippets at 240 chars with ellipsis', () => {
    const longSnippet = 'x'.repeat(500);
    const r = { ...sample, snippet: longSnippet };
    const out = formatBrainSearchResults([r]);
    // truncated content should not contain all 500 chars
    expect(out).toContain('…');
  });

  it('collapses internal whitespace in snippet display', () => {
    const r = { ...sample, snippet: 'line one\nline two\n\nline three' };
    const out = formatBrainSearchResults([r]);
    // No raw newlines in the snippet line of output
    expect(out).toMatch(/Snippet: line one line two line three/);
  });
});

describe('brain-search: brainSearch (integration with binary)', () => {
  // These tests gate on having the qmd binary available — they smoke test
  // the real pipeline. Skip cleanly if qmd is not installed in the test env.
  const haveQmd = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execFileSync } = require('child_process');
      execFileSync('qmd', ['--help'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!haveQmd)('returns results from a real qmd query', () => {
    const results = brainSearch('agent integration', { maxResults: 2 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('file');
    expect(results[0]).toHaveProperty('score');
    expect(results[0]).toHaveProperty('snippet');
  }, 30_000);

  it('rejects empty query string', () => {
    expect(() => brainSearch('', {})).toThrow(/non-empty/);
    expect(() => brainSearch('   ', {})).toThrow(/non-empty/);
  });

  it('throws a clear error when qmd binary is missing', () => {
    expect(() =>
      brainSearch('test', { qmdBin: '/nonexistent/path/to/qmd-fake' }),
    ).toThrow(/qmd binary not found|qmd .* subprocess failed/);
  });
});
