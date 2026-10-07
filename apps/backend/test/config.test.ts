import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultGenerationConfig, generationConfigSchema } from '@rs/shared';
import {
  ConfigError,
  DEFAULT_CONFIG_PATH,
  DEFAULT_PROMPTS_DIR,
  PROMPT_NAMES,
  createConfigService,
  hashPrompt,
  type ConfigService,
} from '../src/core/config';
import { createLogger } from '../src/core/logger';

const logger = createLogger('silent');
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Fixture {
  configPath: string;
  promptsDir: string;
}

function createFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'rs-config-'));
  const promptsDir = join(dir, 'prompts');
  mkdirSync(promptsDir);
  const configPath = join(dir, 'generation.config.json');
  writeFileSync(configPath, JSON.stringify(defaultGenerationConfig, null, 2));
  for (const name of PROMPT_NAMES) writeFileSync(join(promptsDir, `${name}.md`), `Template ${name} {{value}}\n`);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { configPath, promptsDir };
}

function open(fixture: Fixture, options: { watch?: boolean; debounceMs?: number } = {}): ConfigService {
  const service = createConfigService({ logger, ...fixture, watch: options.watch ?? false, debounceMs: options.debounceMs });
  cleanups.unshift(() => service.close());
  return service;
}

describe('shipped defaults', () => {
  it('generation.config.json is valid and equals defaultGenerationConfig', () => {
    const parsed = generationConfigSchema.parse(JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf8')));
    expect(parsed).toEqual(defaultGenerationConfig);
  });

  it('loads through the service with the shipped prompts', () => {
    const service = createConfigService({ logger, watch: false });
    expect(service.get().outputs).toEqual({ imagesPerProduct: 2, videosPerProduct: 1 });
    expect(service.getPrompt('planner.system').text).toContain('{{imageCount}}');
    expect(service.getPrompt('image.user').text).toContain('{{shot.prompt}}');
    expect(service.getPrompt('video.user').text).toContain('{{shot.cameraMove}}');
    expect(DEFAULT_PROMPTS_DIR).toContain('prompts');
  });
});

describe('config loader', () => {
  it('loads a valid config and prompts', () => {
    const service = open(createFixture());
    expect(service.get().models.image).toBe('gemini-2.5-flash-image');
    const prompt = service.getPrompt('image.user');
    expect(prompt.text).toBe('Template image.user {{value}}');
    expect(prompt.version).toBe(hashPrompt('Template image.user {{value}}'));
    expect(prompt.version).toMatch(/^[0-9a-f]{12}$/);
    expect(service.getPromptVersions().image).toBe(prompt.version);
  });

  it('fails at boot on an invalid config', () => {
    const fixture = createFixture();
    writeFileSync(fixture.configPath, JSON.stringify({ ...defaultGenerationConfig, provider: 'nope' }));
    expect(() => createConfigService({ logger, ...fixture, watch: false })).toThrow(ConfigError);
  });

  it('rejects unknown keys so typos are not silently ignored', () => {
    const fixture = createFixture();
    writeFileSync(fixture.configPath, JSON.stringify({ ...defaultGenerationConfig, outputz: {} }));
    expect(() => createConfigService({ logger, ...fixture, watch: false })).toThrow(/outputz/);
  });

  it('keeps the last good config when a reload is invalid', () => {
    const fixture = createFixture();
    const service = open(fixture);
    const errorSpy = vi.spyOn(logger, 'error');

    writeFileSync(fixture.configPath, JSON.stringify({ ...defaultGenerationConfig, outputs: { imagesPerProduct: 99, videosPerProduct: 1 } }));
    const invalidShape = service.reload();
    expect(invalidShape.ok).toBe(false);
    expect(service.get().outputs.imagesPerProduct).toBe(2);

    writeFileSync(fixture.configPath, '{ not json');
    const invalidJson = service.reload();
    expect(invalidJson.ok).toBe(false);
    expect(service.get().outputs.imagesPerProduct).toBe(2);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('reloads a valid change on demand', () => {
    const fixture = createFixture();
    const service = open(fixture);
    writeFileSync(fixture.configPath, JSON.stringify({ ...defaultGenerationConfig, outputs: { imagesPerProduct: 3, videosPerProduct: 0 } }));
    expect(service.reload().ok).toBe(true);
    expect(service.get().outputs).toEqual({ imagesPerProduct: 3, videosPerProduct: 0 });
  });

  it('hot reload picks up a config change from the file watcher', async () => {
    const fixture = createFixture();
    const service = open(fixture, { watch: true, debounceMs: 25 });
    writeFileSync(fixture.configPath, JSON.stringify({ ...defaultGenerationConfig, outputs: { imagesPerProduct: 4, videosPerProduct: 2 } }));
    await vi.waitFor(
      () => {
        expect(service.get().outputs).toEqual({ imagesPerProduct: 4, videosPerProduct: 2 });
      },
      { timeout: 5000, interval: 25 },
    );
  });

  it('hot reload picks up a prompt change and changes its version', async () => {
    const fixture = createFixture();
    const service = open(fixture, { watch: true, debounceMs: 25 });
    const before = service.getPrompt('planner.system').version;
    writeFileSync(join(fixture.promptsDir, 'planner.system.md'), 'A different planner prompt\n');
    await vi.waitFor(
      () => {
        expect(service.getPrompt('planner.system').text).toBe('A different planner prompt');
      },
      { timeout: 5000, interval: 25 },
    );
    expect(service.getPrompt('planner.system').version).not.toBe(before);
  });
});
