/**
 * B1 read-bridge — wraps `qmd` semantic search so any cortextOS agent can
 * query the second-brain via `cortextos bus brain-search "<query>"`.
 *
 * The brain at ~/second-brain/ is the canonical org memory layer (chromadb
 * deferred indefinitely on macOS Tahoe — see ~/cortextos/orgs/<org>/agents/
 * <agent>/MEMORY.md and the troubleshooting KB cluster 7). qmd indexes the
 * vault locally and exposes hybrid/lexical/vector search.
 *
 * This wrapper makes qmd available as a bus command so:
 *  - any agent can `cortextos bus brain-search "..."` from any working dir
 *  - results come back as JSON (parseable) or text (human-readable)
 *  - no MCP plumbing required — qmd standalone CLI is the contract surface
 *
 * Lifecycle:
 *  1. Agent calls `cortextos bus brain-search "<query>"`
 *  2. CLI command calls `brainSearch(query, opts)`
 *  3. brainSearch shells to `qmd <mode> <query> --json -n <max>`
 *  4. parseBrainSearchOutput strips the leading status text qmd writes
 *     before the JSON array, parses, and returns BrainSearchResult[]
 */

import { execFileSync } from 'child_process';

export interface BrainSearchResult {
  docid: string;
  score: number;
  file: string;
  title: string;
  context: string;
  snippet: string;
}

export type BrainSearchMode = 'query' | 'search' | 'vsearch';

export interface BrainSearchOptions {
  /** 'query' = hybrid (default, recommended); 'search' = BM25 lexical only; 'vsearch' = vector only */
  mode?: BrainSearchMode;
  /** Max results (default 5) */
  maxResults?: number;
  /** Path to qmd binary (default: CTX_QMD_BIN env var, falls back to 'qmd' in PATH) */
  qmdBin?: string;
  /** Timeout in ms for the qmd subprocess (default 60_000) */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESULTS = 5;

/**
 * Parse a qmd subprocess stdout buffer into BrainSearchResult[]. qmd emits
 * status lines ("Expanding query…", "Reranking…", etc.) before the JSON
 * array on stdout. We strip everything before the first '['.
 *
 * Exported for unit testing without invoking the qmd binary.
 */
export function parseBrainSearchOutput(stdout: string): BrainSearchResult[] {
  const jsonStart = stdout.indexOf('[');
  if (jsonStart === -1) {
    throw new Error(`brain-search: qmd output did not contain a JSON array. Got: ${stdout.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(jsonStart));
  } catch (err) {
    throw new Error(`brain-search: qmd output failed JSON parse: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`brain-search: qmd output was not an array (got ${typeof parsed})`);
  }
  return parsed as BrainSearchResult[];
}

/**
 * Run a brain-search query. Spawns `qmd <mode> <query> --json -n <max>`
 * with stderr suppressed so status lines don't pollute stdout — qmd emits
 * "Expanding query… / Reranking…" to stderr, the JSON array to stdout.
 *
 * Throws on:
 *  - qmd binary not found (ENOENT)
 *  - qmd subprocess non-zero exit
 *  - qmd output not parseable as JSON
 */
export function brainSearch(
  query: string,
  options: BrainSearchOptions = {},
): BrainSearchResult[] {
  if (!query || query.trim() === '') {
    throw new Error('brain-search: query must be a non-empty string');
  }

  const mode: BrainSearchMode = options.mode ?? 'query';
  const max = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const qmdBin = options.qmdBin ?? process.env.CTX_QMD_BIN ?? 'qmd';
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const args = [mode, query, '--json', '-n', String(max)];

  let stdout: string;
  try {
    stdout = execFileSync(qmdBin, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'], // suppress stderr (qmd status lines)
      timeout,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new Error(
        `brain-search: qmd binary not found at "${qmdBin}". Install qmd (https://github.com/...) or set CTX_QMD_BIN to its path.`,
      );
    }
    throw new Error(`brain-search: qmd ${mode} subprocess failed: ${e.message ?? err}`);
  }

  return parseBrainSearchOutput(stdout);
}

/**
 * Format an array of search results as human-readable text. Used by the CLI
 * when --format text is passed.
 */
export function formatBrainSearchResults(results: BrainSearchResult[]): string {
  if (results.length === 0) return '(no matches)';
  const lines: string[] = [];
  for (const r of results) {
    const pct = (r.score * 100).toFixed(0);
    lines.push(`[${pct}%] ${r.file}`);
    lines.push(`  Title:   ${r.title}`);
    lines.push(`  Context: ${r.context}`);
    const snippet = r.snippet.replace(/\s+/g, ' ').slice(0, 240);
    lines.push(`  Snippet: ${snippet}${r.snippet.length > 240 ? '…' : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}
