import { z } from 'zod';
import { FAKE_JPEG } from '../../../src/modules/ai/fake-media';
import { graphqlData, jpegSize } from './stub-http';
import type { StagedTarget, StubFile, StubShop, StubState, UserError } from './stub-state';

const CDN_HOST = 'https://cdn.shopify.com';
const IMAGE_UPLOAD_URL = 'https://shopify-staged-uploads.storage.googleapis.com/';
const VIDEO_UPLOAD_URL = 'https://shopify-video-production-core-originals.s3.amazonaws.com/';
// Duration Shopify reports for every video, in milliseconds.
export const STUB_VIDEO_DURATION_MS = 12_500;

const stagedVariables = z.object({
  input: z
    .array(
      z.object({
        resource: z.enum(['IMAGE', 'VIDEO']),
        filename: z.string().min(1),
        mimeType: z.string().min(1),
        fileSize: z.string().regex(/^\d+$/),
        httpMethod: z.literal('POST'),
      }),
    )
    .min(1),
});

const fileCreateVariables = z.object({
  files: z
    .array(z.object({ originalSource: z.string(), contentType: z.enum(['IMAGE', 'VIDEO']), filename: z.string(), alt: z.string() }))
    .min(1),
});

const statusVariables = z.object({ ids: z.array(z.string()) });
const deleteVariables = z.object({ fileIds: z.array(z.string()) });

export function stagedUploadsCreate(state: StubState, shop: StubShop, rawVariables: Record<string, unknown>): Response {
  const { input } = stagedVariables.parse(rawVariables);
  const mismatched = input.find((item) => !item.mimeType.startsWith(item.resource === 'IMAGE' ? 'image/' : 'video/'));
  if (mismatched !== undefined) {
    const userErrors: UserError[] = [{ field: ['input'], message: `${mismatched.mimeType} is not a ${mismatched.resource}` }];
    return graphqlData({ stagedUploadsCreate: { stagedTargets: [], userErrors } });
  }

  const stagedTargets = input.map((item) => {
    const n = ++state.counter;
    const key = `tmp/${shop.number}/${n}/${item.filename}`;
    const url = item.resource === 'IMAGE' ? IMAGE_UPLOAD_URL : VIDEO_UPLOAD_URL;
    const parameters = [
      { name: 'Content-Type', value: item.mimeType },
      { name: 'success_action_status', value: '201' },
      { name: 'acl', value: 'private' },
      { name: 'key', value: key },
      { name: 'policy', value: `policy-${n}` },
      { name: 'x-goog-signature', value: `signature-${n}` },
    ];
    const target: StagedTarget = {
      key,
      url,
      resourceUrl: `${url}${key}`,
      parameters,
      resource: item.resource,
      filename: item.filename,
      mimeType: item.mimeType,
      fileSize: Number(item.fileSize),
      received: null,
    };
    shop.stagedByKey.set(key, target);
    return { url: target.url, resourceUrl: target.resourceUrl, parameters };
  });
  return graphqlData({ stagedUploadsCreate: { stagedTargets, userErrors: [] } });
}

function findStaged(shop: StubShop, resourceUrl: string): StagedTarget | undefined {
  return [...shop.stagedByKey.values()].find((target) => target.resourceUrl === resourceUrl);
}

export function fileCreate(state: StubState, shop: StubShop, rawVariables: Record<string, unknown>): Response {
  const { files } = fileCreateVariables.parse(rawVariables);

  const rejection = files.flatMap((file) => state.knobs.fileCreateRejection?.(file) ?? []);
  if (rejection.length > 0) return graphqlData({ fileCreate: { files: null, userErrors: rejection } });

  const invalid: UserError[] = [];
  const created = files.flatMap((file, index) => {
    const staged = findStaged(shop, file.originalSource);
    if (staged === undefined || staged.resource !== file.contentType) {
      invalid.push({ field: ['files', String(index), 'originalSource'], message: 'Invalid source: the staged upload does not exist', code: 'INVALID' });
      return [];
    }
    const n = ++state.counter;
    const mediaType = file.contentType === 'VIDEO' ? 'video' : 'image';
    const record: StubFile = {
      gid: `gid://shopify/${mediaType === 'video' ? 'Video' : 'MediaImage'}/${n}`,
      mediaType,
      filename: file.filename,
      alt: file.alt,
      resourceUrl: file.originalSource,
      cdnUrl:
        mediaType === 'video'
          ? `${CDN_HOST}/videos/c/vp/${n}abc/HD-1080p-7.2Mbps-${n}.mp4`
          : `${CDN_HOST}/s/files/1/${shop.number}/files/${file.filename}?v=${n}`,
      bytes: staged.received?.bytes ?? null,
      statusQueries: 0,
      failure: null,
    };
    shop.files.set(record.gid, record);
    return [{ id: record.gid }];
  });
  if (invalid.length > 0) return graphqlData({ fileCreate: { files: null, userErrors: invalid } });
  return graphqlData({ fileCreate: { files: created, userErrors: [] } });
}

function videoSources(file: StubFile) {
  const base = file.cdnUrl.slice(0, file.cdnUrl.lastIndexOf('/'));
  return [
    { url: file.cdnUrl, mimeType: 'video/mp4', format: 'mp4', width: 1080, height: 1920 },
    { url: `${base}/SD-480p-0.9Mbps.mp4`, mimeType: 'video/mp4', format: 'mp4', width: 480, height: 854 },
    { url: `${base}/playlist.m3u8`, mimeType: 'application/x-mpegURL', format: 'm3u8', width: 1080, height: 1920 },
  ];
}

function posterUrl(file: StubFile): string {
  return `${file.cdnUrl.slice(0, file.cdnUrl.lastIndexOf('/'))}/preview.jpg`;
}

// A file is served by the CDN once Shopify has processed it.
function registerCdn(state: StubState, file: StubFile): void {
  if (file.bytes === null) return;
  const put = (url: string, type: string, content: Uint8Array): void => {
    state.cdn.set(new URL(url).pathname, { bytes: content, type });
  };
  put(file.cdnUrl, file.mediaType === 'video' ? 'video/mp4' : 'image/jpeg', file.bytes);
  if (file.mediaType === 'video') {
    for (const source of videoSources(file)) if (source.format === 'mp4') put(source.url, 'video/mp4', file.bytes);
    put(posterUrl(file), 'image/jpeg', FAKE_JPEG);
  }
}

function statusNode(state: StubState, file: StubFile) {
  file.statusQueries += 1;
  if (file.bytes === null) {
    file.failure = { code: 'INVALID_IMAGE_SOURCE_URL', message: 'The staged upload was empty or never received' };
  }
  const base = { id: file.gid, fileErrors: file.failure === null ? [] : [file.failure] };
  if (file.failure !== null) return { ...base, fileStatus: 'FAILED' };
  if (file.statusQueries <= state.knobs.processingQueries(file)) {
    return {
      ...base,
      fileStatus: file.statusQueries === 1 ? 'UPLOADED' : 'PROCESSING',
      image: null,
      duration: null,
      preview: null,
      sources: [],
      originalSource: null,
    };
  }
  registerCdn(state, file);
  if (file.mediaType === 'image') {
    const size = file.bytes === null ? null : jpegSize(file.bytes);
    return { ...base, fileStatus: 'READY', image: { url: file.cdnUrl, width: size?.width ?? null, height: size?.height ?? null } };
  }
  return {
    ...base,
    fileStatus: 'READY',
    duration: STUB_VIDEO_DURATION_MS,
    preview: { image: { url: posterUrl(file) } },
    sources: videoSources(file),
    originalSource: { url: `${CDN_HOST}/videos/c/vp/original.mov`, mimeType: 'video/quicktime', width: 1080, height: 1920 },
  };
}

// Files that do not exist (another shop's gid, or deleted) come back as null.
export function fileStatus(state: StubState, shop: StubShop, rawVariables: Record<string, unknown>): Response {
  const { ids } = statusVariables.parse(rawVariables);
  return graphqlData({
    nodes: ids.map((id) => {
      const file = shop.files.get(id);
      return file === undefined ? null : statusNode(state, file);
    }),
  });
}

export function fileDelete(state: StubState, shop: StubShop, rawVariables: Record<string, unknown>): Response {
  const { fileIds } = deleteVariables.parse(rawVariables);
  const deletedFileIds: string[] = [];
  const userErrors: UserError[] = [];
  for (const id of fileIds) {
    const file = shop.files.get(id);
    if (file === undefined) {
      userErrors.push({ field: ['fileIds'], message: 'File does not exist', code: 'FILE_DOES_NOT_EXIST' });
      continue;
    }
    shop.files.delete(id);
    state.cdn.delete(new URL(file.cdnUrl).pathname);
    deletedFileIds.push(id);
  }
  return graphqlData({ fileDelete: { deletedFileIds, userErrors } });
}
