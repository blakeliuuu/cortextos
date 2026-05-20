/**
 * Text-to-speech conversion for Telegram voice responses.
 *
 * Supports multiple engines:
 *   - local: macOS `say` command (free, no API, decent quality)
 *   - openai: OpenAI TTS API (paid, best quality, requires OPENAI_API_KEY)
 *
 * All engines produce .ogg opus files via ffmpeg, the format required by
 * Telegram's sendVoice API.
 *
 * Gated by CTX_TELEGRAM_TTS_ENABLED=1 at the call site (cli/bus.ts).
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type TtsEngine = 'openai' | 'local';

export interface TtsOptions {
  engine?: TtsEngine;
  voice?: string;
  log?: (line: string) => void;
}

export interface TtsResult {
  ok: boolean;
  oggPath?: string;
  reason?: string;
}

const DEFAULT_VOICES: Record<TtsEngine, string> = {
  openai: 'onyx',
  local: 'Samantha',
};

const MAX_TTS_CHARS = 4000;

export function resolveEngine(): TtsEngine {
  const env = process.env.CTX_TELEGRAM_TTS_ENGINE;
  if (env === 'openai' || env === 'local') return env;
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'local';
}

export async function textToSpeech(text: string, opts: TtsOptions = {}): Promise<TtsResult> {
  if (!text || !text.trim()) return { ok: false, reason: 'empty text' };

  const engine = opts.engine || resolveEngine();
  const log = opts.log || (() => {});
  const truncated = text.length > MAX_TTS_CHARS
    ? text.slice(0, MAX_TTS_CHARS)
    : text;

  log(`[tts] engine=${engine} chars=${truncated.length}`);

  switch (engine) {
    case 'openai':
      return ttsOpenAI(truncated, opts.voice || DEFAULT_VOICES.openai, log);
    case 'local':
      return ttsLocal(truncated, opts.voice || DEFAULT_VOICES.local, log);
    default:
      return { ok: false, reason: `unknown engine: ${engine}` };
  }
}

async function ttsLocal(text: string, voice: string, log: (s: string) => void): Promise<TtsResult> {
  const tmpDir = os.tmpdir();
  const id = `tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const aiffPath = path.join(tmpDir, `${id}.aiff`);
  const oggPath = path.join(tmpDir, `${id}.ogg`);
  const ffmpegBin = process.env.CTX_FFMPEG_BIN || 'ffmpeg';

  const sayResult = await runProcess('say', ['-v', voice, '-o', aiffPath, text], 30_000);
  if (!sayResult.ok) {
    log(`[tts] say failed: ${sayResult.reason}`);
    return { ok: false, reason: `say failed: ${sayResult.reason}` };
  }

  const ffmpegResult = await runProcess(ffmpegBin, [
    '-y', '-i', aiffPath,
    '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1',
    oggPath,
  ], 30_000);

  try { fs.unlinkSync(aiffPath); } catch { /* ignore */ }

  if (!ffmpegResult.ok) {
    log(`[tts] ffmpeg conversion failed: ${ffmpegResult.reason}`);
    return { ok: false, reason: `ffmpeg failed: ${ffmpegResult.reason}` };
  }

  if (!fs.existsSync(oggPath)) {
    return { ok: false, reason: 'ogg file not created' };
  }

  return { ok: true, oggPath };
}

async function ttsOpenAI(text: string, voice: string, log: (s: string) => void): Promise<TtsResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log('[tts] OPENAI_API_KEY not set — falling back to local');
    return ttsLocal(text, DEFAULT_VOICES.local, log);
  }

  const tmpDir = os.tmpdir();
  const id = `tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const mp3Path = path.join(tmpDir, `${id}.mp3`);
  const oggPath = path.join(tmpDir, `${id}.ogg`);
  const ffmpegBin = process.env.CTX_FFMPEG_BIN || 'ffmpeg';

  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice,
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const err = await response.text();
      log(`[tts] OpenAI API error: ${response.status} ${err}`);
      return { ok: false, reason: `OpenAI API ${response.status}` };
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(mp3Path, audioBuffer);
  } catch (err) {
    log(`[tts] OpenAI API request failed: ${err}`);
    return { ok: false, reason: `OpenAI request failed: ${err}` };
  }

  const ffmpegResult = await runProcess(ffmpegBin, [
    '-y', '-i', mp3Path,
    '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1',
    oggPath,
  ], 30_000);

  try { fs.unlinkSync(mp3Path); } catch { /* ignore */ }

  if (!ffmpegResult.ok) {
    log(`[tts] ffmpeg conversion failed: ${ffmpegResult.reason}`);
    return { ok: false, reason: `ffmpeg failed: ${ffmpegResult.reason}` };
  }

  if (!fs.existsSync(oggPath)) {
    return { ok: false, reason: 'ogg file not created' };
  }

  return { ok: true, oggPath };
}

interface ProcessResult {
  ok: boolean;
  reason?: string;
}

function runProcess(bin: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const settle = (r: ProcessResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    let proc;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (err) {
      return settle({ ok: false, reason: `spawn-error: ${(err as Error).message}` });
    }

    proc.on('error', (err) => settle({ ok: false, reason: `error: ${err.message}` }));
    proc.on('close', (code) => {
      if (code === 0) return settle({ ok: true });
      settle({ ok: false, reason: `exit-${code}` });
    });
    timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      settle({ ok: false, reason: 'timeout' });
    }, timeoutMs);
  });
}
