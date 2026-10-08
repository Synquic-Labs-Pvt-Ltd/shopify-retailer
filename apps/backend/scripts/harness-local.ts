/**
 * Local generation harness (SPEC 20, Track C).
 *
 * Runs plan -> image -> video for ONE product through a chosen provider and writes everything to a
 * temp folder. No queue, database or Shopify involved. The fake provider is the default and spends nothing.
 *
 * Usage (from the repo root or apps/backend):
 *   pnpm -F @rs/backend exec tsx scripts/harness-local.ts --products <dir> [options]
 *
 *   --products <dir>    required. Folder of product images (jpg, png, webp), featured image first by file name.
 *   --refs <dir>        optional. Style references: images (jpg, png, webp) and videos (mp4, mov).
 *   --provider <name>   fake (default), vertex or aistudio. Real providers cost money and need credentials:
 *                       GOOGLE_CLOUD_PROJECT + GOOGLE_APPLICATION_CREDENTIALS (vertex), GEMINI_API_KEY (aistudio),
 *                       read from the environment or apps/backend/.env.
 *   --out <dir>         output folder. Default: a new folder under the OS temp dir.
 *   --title <text>      product title for the plan. Default: the products folder name.
 *   --images <n>        image shots to generate. Default: outputs.imagesPerProduct from the config.
 *   --videos <n>        video shots to generate. Default: outputs.videosPerProduct from the config.
 *   --no-video          skip the video step even when videos > 0.
 *   --video-mode <m>    reference_images or image_to_video. Default: video.mode from the config. In
 *                       image_to_video mode the first product image is the first frame (and durationSeconds
 *                       may be 4, 6 or 8 in the config); in reference_images mode up to 3 product images are
 *                       sent as Veo reference assets (8 seconds).
 *   --latency-ms <n>    fake provider latency. Default 0 here (the config default is 3000).
 *
 * Output: plan.json, image-<n>.<ext>, video-<n>.mp4, prompts/*.txt and summary.json. Exit code 1 when any
 * step failed. Failed provider calls print the classified error and the raw response body.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VIDEO_MODES,
  createCreativePlanSchema,
  videoConfigSchema,
  type AiProviderName,
  type CreativePlan,
  type GenerationConfig,
  type ProductSnapshot,
  type VideoMode,
} from '@rs/shared';
import { createConfigService, type ConfigService } from '../src/core/config';
import { loadDotEnv, parseEnv, type Env } from '../src/core/env';
import { createLogger } from '../src/core/logger';
import {
  buildFallbackPlan,
  buildImageParts,
  buildPlannerParts,
  createAiModule,
  renderImagePrompt,
  renderPlannerSystemPrompt,
  renderVideoPrompt,
  type ClassifiedError,
  type ImageInput,
  type ReferenceVideoInput,
  type VideoSubmitRequest,
} from '../src/modules/ai';

export interface HarnessOptions {
  productsDir: string;
  refsDir?: string;
  outDir?: string;
  provider?: AiProviderName;
  title?: string;
  images?: number;
  videos?: number;
  skipVideo?: boolean;
  videoMode?: VideoMode;
  latencyMs?: number;
  // Test hooks.
  env?: Pick<Env, 'GOOGLE_CLOUD_PROJECT' | 'GEMINI_API_KEY'>;
  pollIntervalMs?: number;
  log?: (line: string) => void;
}

export interface HarnessResult {
  outDir: string;
  planSource: 'planner' | 'fallback';
  files: string[];
  failures: string[];
}

const IMAGE_MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const VIDEO_MIME: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime' };
const IMAGE_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const INLINE_VIDEO_LIMIT_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = { plan: 90_000, image: 150_000, submit: 60_000, poll: 30_000 };

function listFiles(dir: string): string[] {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort();
}

function loadImages(dir: string): ImageInput[] {
  return listFiles(dir).flatMap((path) => {
    const mimeType = IMAGE_MIME[extname(path).toLowerCase()];
    return mimeType === undefined ? [] : [{ mimeType, data: new Uint8Array(readFileSync(path)) }];
  });
}

function loadVideos(dir: string, log: (line: string) => void): ReferenceVideoInput[] {
  const videos: ReferenceVideoInput[] = [];
  for (const path of listFiles(dir)) {
    const mimeType = VIDEO_MIME[extname(path).toLowerCase()];
    if (mimeType === undefined) continue;
    if (statSync(path).size > INLINE_VIDEO_LIMIT_BYTES) {
      log(`skipping reference video ${basename(path)}: larger than 20 MB (the harness has no public URL to pass instead)`);
      continue;
    }
    videos.push({ mimeType, data: new Uint8Array(readFileSync(path)) });
  }
  return videos;
}

function describeError(error: ClassifiedError): string {
  const lines = [`${error.kind}: ${error.message}`];
  if (error.retryDelayMs !== null) lines.push(`  retryDelayMs=${error.retryDelayMs}`);
  if (error.rawBody !== null) lines.push(`  raw body: ${error.rawBody}`);
  return lines.join('\n');
}

const VEO_MAX_REFERENCE_IMAGES = 3;

// Reference mode sends up to 3 product images as reference assets; image-to-video sends the first as the first frame.
export function videoImageInputs(config: GenerationConfig, productImages: ImageInput[]): Pick<VideoSubmitRequest, 'referenceImages' | 'startImage'> {
  const first = productImages[0];
  if (config.video.mode === 'image_to_video' && first !== undefined) return { referenceImages: [], startImage: first };
  return { referenceImages: productImages.slice(0, VEO_MAX_REFERENCE_IMAGES) };
}

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function applyOverrides(config: GenerationConfig, options: HarnessOptions): GenerationConfig {
  const provider = options.provider ?? 'fake';
  const video = { ...config.video, mode: options.videoMode ?? config.video.mode };
  const checked = videoConfigSchema.safeParse(video);
  if (!checked.success) {
    throw new Error(`Invalid video settings for mode ${video.mode}: ${checked.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  return {
    ...config,
    provider,
    video,
    outputs: {
      imagesPerProduct: options.images ?? config.outputs.imagesPerProduct,
      videosPerProduct: options.skipVideo === true ? 0 : (options.videos ?? config.outputs.videosPerProduct),
    },
    fake: { ...config.fake, latencyMs: options.latencyMs ?? 0 },
  };
}

export async function runHarness(options: HarnessOptions): Promise<HarnessResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const productImages = loadImages(options.productsDir);
  if (productImages.length === 0) throw new Error(`No product images (jpg, png, webp) found in ${options.productsDir}`);
  const referenceImages = options.refsDir === undefined ? [] : loadImages(options.refsDir);
  const referenceVideos = options.refsDir === undefined ? [] : loadVideos(options.refsDir, log);

  const logger = createLogger('warn');
  const configService: ConfigService = createConfigService({ logger, watch: false, ...(process.env.GENERATION_CONFIG_PATH ? { configPath: process.env.GENERATION_CONFIG_PATH } : {}) });
  const config = applyOverrides(configService.get(), options);
  const env = options.env ?? parseEnv();
  const ai = createAiModule({ env, logger, getConfig: () => config });
  const provider = ai.getProvider(config.provider);

  const outDir = options.outDir ?? mkdtempSync(join(tmpdir(), 'rs-harness-'));
  mkdirSync(join(outDir, 'prompts'), { recursive: true });
  const files: string[] = [];
  const failures: string[] = [];
  const write = (name: string, data: string | Uint8Array): void => {
    writeFileSync(join(outDir, name), data);
    files.push(name);
  };

  const counts = { imageCount: config.outputs.imagesPerProduct, videoCount: config.outputs.videosPerProduct };
  const snapshot: ProductSnapshot = {
    title: options.title ?? basename(resolve(options.productsDir)),
    handle: 'harness-product',
    descriptionText: '',
    productType: '',
    vendor: '',
    tags: [],
    options: [],
    featuredImageUrl: null,
    imageUrls: [],
  };

  log(`provider=${config.provider} images=${counts.imageCount} videos=${counts.videoCount} videoMode=${config.video.mode} out=${outDir}`);

  // 1. Plan. A failed or invalid plan falls back to the deterministic plan, as the generation module does.
  const systemPrompt = renderPlannerSystemPrompt(configService.getPrompt('planner.system').text, counts, config);
  const planResult = await provider.plan({
    model: config.models.planner,
    location: config.locations.planner,
    signal: AbortSignal.timeout(TIMEOUT_MS.plan),
    systemPrompt,
    parts: buildPlannerParts({ snapshot, productImages, productVideos: [], referenceImages, referenceVideos, counts }, config),
    ...counts,
    temperature: config.ai.planner.temperature,
  });

  let plan: CreativePlan | null = null;
  let planSource: HarnessResult['planSource'] = 'planner';
  if (planResult.ok) {
    const parsed = createCreativePlanSchema(counts).safeParse(planResult.value.json);
    if (parsed.success) plan = parsed.data;
    else failures.push(`plan: planner output failed validation: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  } else {
    failures.push(`plan: ${describeError(planResult.error)}`);
  }
  if (plan === null) {
    log('plan failed, using the deterministic fallback plan');
    plan = buildFallbackPlan(snapshot, counts, config);
    planSource = 'fallback';
  }
  write('plan.json', JSON.stringify({ planSource, plan }, null, 2));
  log(`plan ready (${planSource}): ${plan.imageShots.length} image shots, ${plan.videoShots.length} video shots`);

  // 2. Images.
  const imageTemplate = configService.getPrompt('image.user').text;
  for (const [index, shot] of plan.imageShots.entries()) {
    const prompt = renderImagePrompt(imageTemplate, plan, shot, config);
    write(`prompts/image-${index + 1}.txt`, prompt);
    const result = await provider.generateImage({
      model: config.models.image,
      location: config.locations.image,
      signal: AbortSignal.timeout(TIMEOUT_MS.image),
      parts: buildImageParts({ productImages, styleReferences: referenceImages, prompt }, config),
      aspectRatio: config.image.aspectRatio,
      imageSize: config.image.imageSize,
      outputMimeType: config.image.outputMimeType,
    });
    if (!result.ok) {
      failures.push(`image ${index + 1}: ${describeError(result.error)}`);
      continue;
    }
    write(`image-${index + 1}.${IMAGE_EXT[result.value.mimeType] ?? 'bin'}`, result.value.bytes);
    log(`image ${index + 1} written (${result.value.bytes.length} bytes, ${result.value.mimeType}): ${shot.title}`);
  }

  // 3. Videos: submit, then poll until done or the configured maximum wait.
  const videoTemplate = configService.getPrompt('video.user').text;
  const pollIntervalMs = options.pollIntervalMs ?? (config.provider === 'fake' ? 50 : config.queue.videoPollIntervalMs);
  for (const [index, shot] of plan.videoShots.entries()) {
    const prompt = renderVideoPrompt(videoTemplate, plan, shot);
    write(`prompts/video-${index + 1}.txt`, prompt);
    const target = { model: config.models.video, location: config.locations.video };
    const submitted = await provider.submitVideo({
      ...target,
      signal: AbortSignal.timeout(TIMEOUT_MS.submit),
      prompt,
      negativePrompt: config.video.negativePrompt,
      ...videoImageInputs(config, productImages),
      durationSeconds: config.video.durationSeconds,
      aspectRatio: config.video.aspectRatio,
      resolution: config.video.resolution,
      generateAudio: config.video.generateAudio,
      personGeneration: config.video.personGeneration,
      sampleCount: 1,
    });
    if (!submitted.ok) {
      failures.push(`video ${index + 1} submit: ${describeError(submitted.error)}`);
      continue;
    }
    log(`video ${index + 1} submitted: ${submitted.value.operationName}`);

    const deadline = Date.now() + config.queue.videoMaxWaitMinutes * 60_000;
    let finished = false;
    while (!finished && Date.now() < deadline) {
      await sleep(pollIntervalMs);
      const polled = await provider.pollVideo({ ...target, signal: AbortSignal.timeout(TIMEOUT_MS.poll), operationName: submitted.value.operationName });
      if (!polled.ok) {
        failures.push(`video ${index + 1} poll: ${describeError(polled.error)}`);
        finished = true;
      } else if (polled.value.done) {
        write(`video-${index + 1}.mp4`, polled.value.video.bytes);
        log(`video ${index + 1} written (${polled.value.video.bytes.length} bytes, ${polled.value.video.mimeType}): ${shot.title}`);
        finished = true;
      }
    }
    if (!finished) failures.push(`video ${index + 1}: not done after ${config.queue.videoMaxWaitMinutes} minutes`);
  }

  write('summary.json', JSON.stringify({ provider: config.provider, planSource, files, failures }, null, 2));
  log(failures.length === 0 ? 'done, no failures' : `done with ${failures.length} failure(s):\n${failures.join('\n')}`);
  return { outDir, planSource, files, failures };
}

function isVideoMode(value: string): value is VideoMode {
  return (VIDEO_MODES as readonly string[]).includes(value);
}

export function parseHarnessArgs(argv: string[]): HarnessOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) throw new Error(`Unexpected argument "${arg ?? ''}"`);
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (name === 'no-video') flags.add(name);
    else if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for --${name}`);
    else {
      values.set(name, next);
      i += 1;
    }
  }
  const productsDir = values.get('products');
  if (productsDir === undefined) throw new Error('--products <dir> is required (see the usage in this file header)');
  const provider = values.get('provider') ?? 'fake';
  if (provider !== 'fake' && provider !== 'vertex' && provider !== 'aistudio') throw new Error(`Unknown provider "${provider}"`);
  const number = (name: string): number | undefined => {
    const raw = values.get(name);
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${name} must be a non-negative integer`);
    return parsed;
  };
  const refsDir = values.get('refs');
  const outDir = values.get('out');
  const title = values.get('title');
  const images = number('images');
  const videos = number('videos');
  const latencyMs = number('latency-ms');
  const videoMode = values.get('video-mode');
  if (videoMode !== undefined && !isVideoMode(videoMode)) {
    throw new Error(`--video-mode must be one of ${VIDEO_MODES.join(', ')}`);
  }
  return {
    productsDir,
    provider,
    skipVideo: flags.has('no-video'),
    ...(refsDir === undefined ? {} : { refsDir }),
    ...(outDir === undefined ? {} : { outDir }),
    ...(title === undefined ? {} : { title }),
    ...(images === undefined ? {} : { images }),
    ...(videos === undefined ? {} : { videos }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(videoMode === undefined ? {} : { videoMode }),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotEnv();
  runHarness(parseHarnessArgs(process.argv.slice(2)))
    .then((result) => {
      if (result.failures.length > 0) process.exitCode = 1;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
