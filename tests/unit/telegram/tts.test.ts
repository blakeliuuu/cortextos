import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveEngine, textToSpeech } from '../../../src/telegram/tts';

describe('resolveEngine', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('returns "openai" when CTX_TELEGRAM_TTS_ENGINE=openai', () => {
    process.env.CTX_TELEGRAM_TTS_ENGINE = 'openai';
    expect(resolveEngine()).toBe('openai');
  });

  it('returns "local" when CTX_TELEGRAM_TTS_ENGINE=local', () => {
    process.env.CTX_TELEGRAM_TTS_ENGINE = 'local';
    expect(resolveEngine()).toBe('local');
  });

  it('returns "openai" when OPENAI_API_KEY is set and no engine override', () => {
    delete process.env.CTX_TELEGRAM_TTS_ENGINE;
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(resolveEngine()).toBe('openai');
  });

  it('defaults to "local" when no env vars are set', () => {
    delete process.env.CTX_TELEGRAM_TTS_ENGINE;
    delete process.env.OPENAI_API_KEY;
    expect(resolveEngine()).toBe('local');
  });
});

describe('textToSpeech', () => {
  it('returns ok=false for empty text', async () => {
    const result = await textToSpeech('');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty text');
  });

  it('returns ok=false for whitespace-only text', async () => {
    const result = await textToSpeech('   ');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty text');
  });

  it('truncates text beyond 4000 chars', async () => {
    const logs: string[] = [];
    const longText = 'x'.repeat(5000);
    // Will fail because say/ffmpeg won't produce output in test env,
    // but we can verify truncation via log output
    await textToSpeech(longText, {
      engine: 'local',
      log: (line) => logs.push(line),
    });
    const engineLog = logs.find(l => l.includes('chars='));
    expect(engineLog).toContain('chars=4000');
  });
});
