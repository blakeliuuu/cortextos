/**
 * B2 write-bridge — `cortextos bus brain-write` lets any cortextOS agent
 * capture content into the second-brain at `~/second-brain/`.
 *
 * Capture tool only — agents write NEW files, never modify existing ones.
 * Edits to vault content go through the validated brain commands
 * (`/process-brain-dump`, `/yt-pipeline`) inside a Claude session in
 * `~/second-brain/`. This bridge is for "drop a note in the inbox" flows.
 *
 * Guardrails:
 *  - Never overwrite an existing file (errors with EEXIST)
 *  - Never write outside the brain root (path traversal blocked)
 *  - PARA destination restricted to the 4 capture-eligible folders
 *    (04-archive excluded — agents don't archive)
 *  - Filename slugified from title; subfolder paths sanitized
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, normalize, relative, isAbsolute, resolve } from 'path';
import { homedir } from 'os';

export type ParaDestination = '00-inbox' | '01-projects' | '02-areas' | '03-resources';

export const VALID_PARA_DESTINATIONS: ReadonlyArray<ParaDestination> = [
  '00-inbox',
  '01-projects',
  '02-areas',
  '03-resources',
];

export interface BrainWriteOptions {
  /** Required: human-readable title. Used for frontmatter and slugified for filename. */
  title: string;
  /** Required: markdown body (without frontmatter — frontmatter is generated). */
  content: string;
  /** PARA destination. Default: '00-inbox' (capture-default). */
  destination?: ParaDestination;
  /** Optional subfolder under destination (e.g. 'quick-notes' under 00-inbox). */
  subfolder?: string;
  /** Tags for frontmatter. Default empty. */
  tags?: string[];
  /** Agent name recorded in frontmatter as `created_by_agent`. Default: process.env.CTX_AGENT_NAME or 'unknown'. */
  agentName?: string;
  /** Override the brain root (for testing or non-default installs). Default: ~/second-brain/. */
  brainRoot?: string;
}

export interface BrainWriteResult {
  path: string;
  slug: string;
  destination: ParaDestination;
  subfolder: string;
}

/**
 * Slugify a title into a filesystem-safe filename component.
 *  - lowercase
 *  - replace any non-alphanumeric run with a single '-'
 *  - trim leading/trailing '-'
 *  - cap at 80 chars
 *  - if result is empty (title was all punctuation), fall back to 'untitled'
 */
export function slugify(title: string): string {
  const lower = title.toLowerCase();
  const slug = lower
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, ''); // re-trim in case slice cut mid-dash run
  return slug || 'untitled';
}

/**
 * Validate that `subfolder` is a safe relative path inside the brain.
 * Rejects absolute paths and any '..' traversal.
 */
export function sanitizeSubfolder(input: string | undefined): string {
  if (!input || input.trim() === '') return '';
  if (isAbsolute(input)) {
    throw new Error(`brain-write: subfolder "${input}" must be relative (no leading slash)`);
  }
  // Reject ANY '..' segment before normalize collapses it. normalize()
  // helpfully resolves 'foo/../escape' to 'escape' which is technically
  // safe — but the user's intent was traversal, so we surface that.
  const segments = input.split(/[/\\]/);
  if (segments.some(s => s === '..')) {
    throw new Error(`brain-write: subfolder "${input}" contains path traversal (..)`);
  }
  const norm = normalize(input);
  // Defense-in-depth: even after segment check, reject anything that
  // somehow normalized to '..' or '.'-only.
  if (norm === '.' || norm === '..' || norm.startsWith('../') || norm.startsWith('..\\')) {
    throw new Error(`brain-write: subfolder "${input}" resolves to invalid path "${norm}"`);
  }
  // Strip leading './' if normalize left one
  return norm.replace(/^\.[\/\\]/, '');
}

/**
 * Build the frontmatter block. Order: title, date, tags, created_by_agent.
 * Uses YAML-flow-style tags (tags: [a, b, c]) to match the brain's
 * existing schema in ~/second-brain/REFERENCES.md.
 */
export function buildFrontmatter(opts: {
  title: string;
  date: string;
  tags: string[];
  agentName: string;
}): string {
  const tagList = opts.tags.length === 0
    ? '[]'
    : '[' + opts.tags.map(t => t.includes(' ') || t.includes(',') ? `"${t}"` : t).join(', ') + ']';
  // Escape title quotes for YAML safety
  const titleEscaped = opts.title.replace(/"/g, '\\"');
  // Trailing '---\n\n' so body content can start on its own line without
  // a leading blank-line dance.
  return [
    '---',
    `title: "${titleEscaped}"`,
    `date: ${opts.date}`,
    `tags: ${tagList}`,
    `created_by_agent: ${opts.agentName}`,
    '---',
    '',
    '',
  ].join('\n');
}

/**
 * Resolve and validate the absolute write path. Ensures it stays within
 * brainRoot (defends against any sneaky path-construction bug).
 */
function resolveSafePath(brainRoot: string, destination: ParaDestination, subfolder: string, filename: string): string {
  const dir = subfolder
    ? join(brainRoot, destination, subfolder)
    : join(brainRoot, destination);
  const fullPath = join(dir, filename);
  const resolved = resolve(fullPath);
  const resolvedRoot = resolve(brainRoot);
  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`brain-write: resolved path "${resolved}" escapes brain root "${resolvedRoot}"`);
  }
  return resolved;
}

/**
 * Capture a new markdown entry into the second-brain. Returns metadata about
 * what was written. Throws on:
 *  - empty title or content
 *  - invalid PARA destination
 *  - subfolder path traversal
 *  - file already exists at the resolved path (no-overwrite guardrail)
 */
export function brainWrite(options: BrainWriteOptions): BrainWriteResult {
  if (!options.title || options.title.trim() === '') {
    throw new Error('brain-write: title is required (non-empty string)');
  }
  if (!options.content || options.content === '') {
    throw new Error('brain-write: content is required (non-empty string)');
  }

  const destination = options.destination ?? '00-inbox';
  if (!VALID_PARA_DESTINATIONS.includes(destination)) {
    throw new Error(
      `brain-write: invalid destination "${destination}". Must be one of: ${VALID_PARA_DESTINATIONS.join(', ')}`,
    );
  }

  const subfolder = sanitizeSubfolder(options.subfolder);
  const slug = slugify(options.title);
  const filename = `${slug}.md`;
  const brainRoot = options.brainRoot ?? process.env.CTX_BRAIN_PATH ?? join(homedir(), 'second-brain');
  const fullPath = resolveSafePath(brainRoot, destination, subfolder, filename);

  if (existsSync(fullPath)) {
    throw new Error(`brain-write: file already exists at "${fullPath}". Capture tool never overwrites — pick a different title.`);
  }

  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const agentName = options.agentName ?? process.env.CTX_AGENT_NAME ?? 'unknown';
  const frontmatter = buildFrontmatter({
    title: options.title,
    date,
    tags: options.tags ?? [],
    agentName,
  });

  // Ensure target dir exists (creates intermediate subfolder dirs as needed,
  // but only inside brainRoot — already validated above).
  const targetDir = subfolder
    ? join(brainRoot, destination, subfolder)
    : join(brainRoot, destination);
  mkdirSync(targetDir, { recursive: true });

  // Trailing newline if content doesn't end with one
  const body = options.content.endsWith('\n') ? options.content : options.content + '\n';
  writeFileSync(fullPath, frontmatter + body, 'utf-8');

  return {
    path: fullPath,
    slug,
    destination,
    subfolder,
  };
}
