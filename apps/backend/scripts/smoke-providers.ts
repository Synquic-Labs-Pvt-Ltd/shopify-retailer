/**
 * Provider smoke test (SPEC section 20 and 24).
 *
 * One minimal call per configured model, over raw REST so the full error body
 * is always visible. Prints status, a classified summary and the raw body on
 * failure. Never prints image or video bytes.
 *
 * Usage (from apps/backend, once the toolchain is clean):
 *   tsx scripts/smoke-providers.ts                  provider from config
 *   tsx scripts/smoke-providers.ts --provider aistudio
 *   tsx scripts/smoke-providers.ts --only planner,image
 *   tsx scripts/smoke-providers.ts --video-probe    also GET the Veo model resource (free)
 *   tsx scripts/smoke-providers.ts --video-submit   also submit one Veo job (COSTS MONEY)
 *
 * Env: GOOGLE_CLOUD_PROJECT, GOOGLE_APPLICATION_CREDENTIALS (vertex),
 *      GEMINI_API_KEY (aistudio), GENERATION_CONFIG_PATH (optional).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleAuth } from 'google-auth-library';

type Provider = 'vertex' | 'aistudio';
type Target = 'planner' | 'image' | 'video';

interface SmokeConfig {
  provider: string;
  models: { planner: string; image: string; video: string };
  locations?: { planner?: string; image?: string; video?: string };
  image: { aspectRatio: string };
  video: { aspectRatio: string; durationSeconds: number; resolution: string };
}

interface Result {
  target: Target;
  model: string;
  ok: boolean;
  detail: string;
}

const BODY_LIMIT = 4096;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : 'true';
}

function loadConfig(): SmokeConfig {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = process.env.GENERATION_CONFIG_PATH ?? resolve(here, '../config/generation.config.json');
  return JSON.parse(readFileSync(path, 'utf8')) as SmokeConfig;
}

function truncate(text: string): string {
  return text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}... [truncated ${text.length - BODY_LIMIT} chars]` : text;
}

/** Pull the fields the queue classifier will rely on out of a Google error body. */
function summariseError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: number; status?: string; message?: string; details?: Array<Record<string, unknown>> };
    };
    const err = parsed.error;
    if (!err) return `HTTP ${status}`;
    const parts = [`HTTP ${status}`, `status=${err.status ?? '?'}`];
    for (const d of err.details ?? []) {
      const type = String(d['@type'] ?? '').split('.').pop();
      if (type === 'ErrorInfo') parts.push(`reason=${String(d.reason ?? '?')}`);
      if (type === 'RetryInfo') parts.push(`retryDelay=${String(d.retryDelay ?? '?')}`);
      if (type === 'QuotaFailure') {
        const violations = (d.violations as Array<Record<string, unknown>> | undefined) ?? [];
        parts.push(`quota=${violations.map((v) => String(v.quotaId ?? v.quotaMetric ?? '?')).join(',') || '?'}`);
      }
    }
    return parts.join(' ');
  } catch {
    return `HTTP ${status} (non-JSON body)`;
  }
}

async function call(url: string, init: RequestInit): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  return { status: res.status, text: await res.text() };
}

function vertexBase(location: string, project: string): string {
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models`;
}

interface Backend {
  headers(): Promise<Record<string, string>>;
  generateContentUrl(model: string, target: Target): string;
  videoUrl(model: string, method: string): string;
  modelResourceUrl(model: string): string;
}

async function makeBackend(provider: Provider, cfg: SmokeConfig): Promise<Backend> {
  if (provider === 'aistudio') {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is not set');
    const base = 'https://generativelanguage.googleapis.com/v1beta/models';
    return {
      headers: async () => ({ 'content-type': 'application/json', 'x-goog-api-key': key }),
      generateContentUrl: (model) => `${base}/${model}:generateContent`,
      videoUrl: (model, method) => `${base}/${model}:${method}`,
      modelResourceUrl: (model) => `${base}/${model}`,
    };
  }
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT is not set');
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set (path to the service-account JSON)');
  }
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const loc = (t: Target): string => cfg.locations?.[t] ?? 'us-central1';
  return {
    headers: async () => {
      const token = await auth.getAccessToken();
      if (!token) throw new Error('could not obtain a Google access token');
      return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    },
    generateContentUrl: (model, target) => `${vertexBase(loc(target), project)}/${model}:generateContent`,
    videoUrl: (model, method) => `${vertexBase(loc('video'), project)}/${model}:${method}`,
    modelResourceUrl: (model) => `${vertexBase(loc('video'), project)}/${model}`,
  };
}

async function smokePlanner(b: Backend, cfg: SmokeConfig): Promise<Result> {
  const model = cfg.models.planner;
  const { status, text } = await call(b.generateContentUrl(model, 'planner'), {
    method: 'POST',
    headers: await b.headers(),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Reply with a JSON object {"ok": true} and nothing else.' }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 64, temperature: 0 },
    }),
  });
  if (status !== 200) return { target: 'planner', model, ok: false, detail: `${summariseError(status, text)}\n${truncate(text)}` };
  const out = (JSON.parse(text) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
    .candidates?.[0]?.content?.parts?.[0]?.text;
  return { target: 'planner', model, ok: Boolean(out), detail: out ? `text ok: ${out.slice(0, 80)}` : 'HTTP 200 but no text part' };
}

async function smokeImage(b: Backend, cfg: SmokeConfig): Promise<Result> {
  const model = cfg.models.image;
  const { status, text } = await call(b.generateContentUrl(model, 'image'), {
    method: 'POST',
    headers: await b.headers(),
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Photorealistic photo of a plain white ceramic mug on a light wooden table, soft window light.' }],
        },
      ],
      generationConfig: {
        responseModalities: ['IMAGE', 'TEXT'],
        imageConfig: { aspectRatio: cfg.image.aspectRatio },
      },
    }),
  });
  if (status !== 200) return { target: 'image', model, ok: false, detail: `${summariseError(status, text)}\n${truncate(text)}` };
  const parts =
    (JSON.parse(text) as { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }> })
      .candidates?.[0];
  const img = parts?.content?.parts?.find((p) => p.inlineData?.data);
  if (!img?.inlineData?.data) {
    return { target: 'image', model, ok: false, detail: `HTTP 200 but no image part (finishReason=${parts?.finishReason ?? '?'})` };
  }
  const bytes = Math.floor((img.inlineData.data.length * 3) / 4);
  return { target: 'image', model, ok: true, detail: `image ok: ${img.inlineData.mimeType ?? '?'} ~${bytes} bytes` };
}

async function smokeVideo(b: Backend, cfg: SmokeConfig, submit: boolean): Promise<Result> {
  const model = cfg.models.video;
  const probe = await call(b.modelResourceUrl(model), { method: 'GET', headers: await b.headers() });
  const probeNote =
    probe.status === 200
      ? 'model resource reachable'
      : `model resource GET: ${summariseError(probe.status, probe.text)} (some providers do not expose this; not conclusive)`;
  if (!submit) return { target: 'video', model, ok: probe.status === 200, detail: `${probeNote}. No job submitted (pass --video-submit to spend credits).` };

  const { status, text } = await call(b.videoUrl(model, 'predictLongRunning'), {
    method: 'POST',
    headers: await b.headers(),
    body: JSON.stringify({
      instances: [{ prompt: 'Slow push-in on a white ceramic mug on a wooden table, soft window light, no text.' }],
      parameters: {
        aspectRatio: cfg.video.aspectRatio,
        durationSeconds: cfg.video.durationSeconds,
        resolution: cfg.video.resolution,
        sampleCount: 1,
      },
    }),
  });
  if (status !== 200) return { target: 'video', model, ok: false, detail: `${summariseError(status, text)}\n${truncate(text)}` };
  const name = (JSON.parse(text) as { name?: string }).name;
  return { target: 'video', model, ok: Boolean(name), detail: name ? `submitted, operation=${name} (poll it; it is billed)` : 'HTTP 200 but no operation name' };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const provider = (arg('provider') ?? cfg.provider) as string;
  if (provider !== 'vertex' && provider !== 'aistudio') {
    throw new Error(`provider "${provider}" has no real backend to smoke test (use vertex or aistudio)`);
  }
  const only = new Set<Target>(((arg('only') ?? 'planner,image') as string).split(',') as Target[]);
  if (arg('video-probe') || arg('video-submit')) only.add('video');

  const backend = await makeBackend(provider, cfg);
  console.log(`provider=${provider} planner=${cfg.models.planner} image=${cfg.models.image} video=${cfg.models.video}`);

  const results: Result[] = [];
  if (only.has('planner')) results.push(await smokePlanner(backend, cfg));
  if (only.has('image')) results.push(await smokeImage(backend, cfg));
  if (only.has('video')) results.push(await smokeVideo(backend, cfg, Boolean(arg('video-submit'))));

  for (const r of results) console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.target} (${r.model}): ${r.detail}`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
