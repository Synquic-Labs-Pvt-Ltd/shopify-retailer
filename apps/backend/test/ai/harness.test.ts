import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseHarnessArgs, runHarness } from '../../scripts/harness-local';
import { FAKE_JPEG } from '../../src/modules/ai/fake-media';

const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rs-harness-test-'));
  cleanups.push(dir);
  return dir;
}

function productFolder(): string {
  const dir = join(tempDir(), 'lamp');
  mkdirSync(dir);
  writeFileSync(join(dir, '1-front.jpg'), FAKE_JPEG);
  writeFileSync(join(dir, '2-side.jpg'), FAKE_JPEG);
  writeFileSync(join(dir, 'notes.txt'), 'ignored');
  return dir;
}

const quiet = { log: () => undefined, pollIntervalMs: 1, env: {} };

describe('harness-local', () => {
  it('runs plan, image and video through the fake provider and writes the outputs', async () => {
    const outDir = join(tempDir(), 'out');
    const result = await runHarness({ ...quiet, productsDir: productFolder(), outDir, images: 2, videos: 1 });

    expect(result.failures).toEqual([]);
    expect(result.planSource).toBe('planner');
    expect(result.outDir).toBe(outDir);
    expect(result.files).toEqual(
      expect.arrayContaining(['plan.json', 'image-1.jpg', 'image-2.jpg', 'video-1.mp4', 'prompts/image-1.txt', 'prompts/video-1.txt', 'summary.json']),
    );
    expect(new Set(readdirSync(outDir))).toEqual(new Set(['plan.json', 'image-1.jpg', 'image-2.jpg', 'video-1.mp4', 'prompts', 'summary.json']));
    expect([...readFileSync(join(outDir, 'image-1.jpg'))]).toEqual([...FAKE_JPEG]);
    expect(readFileSync(join(outDir, 'video-1.mp4')).subarray(4, 8).toString('ascii')).toBe('ftyp');
    expect(readFileSync(join(outDir, 'prompts', 'image-1.txt'), 'utf8')).toContain('Create one photorealistic lifestyle photograph');
    expect(JSON.parse(readFileSync(join(outDir, 'plan.json'), 'utf8'))).toMatchObject({ planSource: 'planner', plan: { imageShots: [{}, {}], videoShots: [{}] } });
  });

  it('uses the config counts by default and honours --no-video', async () => {
    const result = await runHarness({ ...quiet, productsDir: productFolder(), outDir: join(tempDir(), 'out'), skipVideo: true });
    expect(result.files).toContain('image-2.jpg');
    expect(result.files).not.toContain('video-1.mp4');
  });

  it('accepts a references folder with images, videos and other files', async () => {
    const refs = tempDir();
    writeFileSync(join(refs, 'mood.jpg'), FAKE_JPEG);
    writeFileSync(join(refs, 'motion.mp4'), new Uint8Array([0, 0, 0, 8, 102, 114, 101, 101]));
    writeFileSync(join(refs, 'readme.md'), 'x');
    const result = await runHarness({ ...quiet, productsDir: productFolder(), refsDir: refs, outDir: join(tempDir(), 'out'), images: 1, videos: 0 });
    expect(result.failures).toEqual([]);
    expect(result.files).toContain('image-1.jpg');
  });

  it('falls back to the deterministic plan and records failures when the provider is unusable', async () => {
    const messages: string[] = [];
    const result = await runHarness({ ...quiet, log: (line) => messages.push(line), productsDir: productFolder(), outDir: join(tempDir(), 'out'), provider: 'vertex', images: 1, videos: 1 });
    expect(result.planSource).toBe('fallback');
    expect(result.files).toContain('plan.json');
    expect(result.failures.length).toBeGreaterThanOrEqual(3);
    expect(result.failures.join('\n')).toContain('auth_error');
    expect(messages.join('\n')).toMatch(/using the deterministic fallback plan/);
  });

  it('rejects a folder without images', async () => {
    const empty = tempDir();
    await expect(runHarness({ ...quiet, productsDir: empty })).rejects.toThrow(/No product images/);
  });
});

describe('parseHarnessArgs', () => {
  it('parses values and flags', () => {
    expect(parseHarnessArgs(['--products', 'p', '--refs', 'r', '--provider', 'aistudio', '--images', '3', '--videos', '0', '--no-video', '--latency-ms', '5', '--out', 'o', '--title', 'T'])).toEqual({
      productsDir: 'p',
      refsDir: 'r',
      provider: 'aistudio',
      images: 3,
      videos: 0,
      skipVideo: true,
      latencyMs: 5,
      outDir: 'o',
      title: 'T',
    });
  });

  it('defaults to the fake provider', () => {
    expect(parseHarnessArgs(['--products', 'p']).provider).toBe('fake');
  });

  it('rejects bad input', () => {
    expect(() => parseHarnessArgs([])).toThrow(/--products/);
    expect(() => parseHarnessArgs(['--products', 'p', '--provider', 'nope'])).toThrow(/Unknown provider/);
    expect(() => parseHarnessArgs(['--products', 'p', '--images', 'x'])).toThrow(/non-negative integer/);
    expect(() => parseHarnessArgs(['--products'])).toThrow(/Missing value/);
    expect(() => parseHarnessArgs(['stray'])).toThrow(/Unexpected argument/);
  });
});
