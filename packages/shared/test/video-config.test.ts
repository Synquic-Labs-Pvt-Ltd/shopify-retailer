import { describe, expect, it } from 'vitest';
import { VIDEO_MODES, defaultGenerationConfig, generationConfigSchema, videoConfigSchema } from '../src';

const { mode: _mode, ...videoWithoutMode } = defaultGenerationConfig.video;

describe('video.mode', () => {
  it('lists the two modes and defaults to reference_images', () => {
    expect(VIDEO_MODES).toEqual(['reference_images', 'image_to_video']);
    expect(defaultGenerationConfig.video.mode).toBe('reference_images');
  });

  it('applies the default when mode is missing', () => {
    expect(videoConfigSchema.parse(videoWithoutMode).mode).toBe('reference_images');
    const config = generationConfigSchema.parse({ ...defaultGenerationConfig, video: videoWithoutMode });
    expect(config.video.mode).toBe('reference_images');
    expect(config).toEqual(defaultGenerationConfig);
  });

  it('accepts both modes', () => {
    for (const mode of VIDEO_MODES) {
      expect(videoConfigSchema.safeParse({ ...defaultGenerationConfig.video, mode }).success).toBe(true);
    }
  });

  it('rejects an invalid mode and unknown video keys', () => {
    expect(videoConfigSchema.safeParse({ ...defaultGenerationConfig.video, mode: 'text_to_video' }).success).toBe(false);
    expect(videoConfigSchema.safeParse({ ...defaultGenerationConfig.video, mode: null }).success).toBe(false);
    expect(videoConfigSchema.safeParse({ ...defaultGenerationConfig.video, extra: true }).success).toBe(false);
    expect(generationConfigSchema.safeParse({ ...defaultGenerationConfig, video: { ...defaultGenerationConfig.video, mode: 'x' } }).success).toBe(false);
  });
});

describe('video.durationSeconds by mode', () => {
  const video = (overrides: Record<string, unknown>) => videoConfigSchema.safeParse({ ...defaultGenerationConfig.video, ...overrides });

  it('requires 8 seconds in reference_images mode', () => {
    expect(video({ durationSeconds: 8 }).success).toBe(true);
    expect(video({ durationSeconds: 6 }).success).toBe(false);
    expect(video({ durationSeconds: 4 }).success).toBe(false);
  });

  it('allows 4, 6 and 8 seconds in image_to_video mode, and nothing else', () => {
    for (const durationSeconds of [4, 6, 8]) expect(video({ mode: 'image_to_video', durationSeconds }).success).toBe(true);
    for (const durationSeconds of [5, 7, 10, 0]) expect(video({ mode: 'image_to_video', durationSeconds }).success).toBe(false);
  });

  it('allows 1080p only with 8 seconds', () => {
    expect(video({ mode: 'image_to_video', durationSeconds: 8, resolution: '1080p' }).success).toBe(true);
    expect(video({ mode: 'image_to_video', durationSeconds: 6, resolution: '1080p' }).success).toBe(false);
  });

  it('applies the same rules inside the full config', () => {
    const base = { ...defaultGenerationConfig, video: { ...defaultGenerationConfig.video, mode: 'image_to_video' as const, durationSeconds: 6 as const } };
    expect(generationConfigSchema.safeParse(base).success).toBe(true);
    expect(generationConfigSchema.safeParse({ ...base, video: { ...base.video, mode: 'reference_images' } }).success).toBe(false);
  });
});
