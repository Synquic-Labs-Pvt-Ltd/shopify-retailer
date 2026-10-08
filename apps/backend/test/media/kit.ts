import { Types } from 'mongoose';
import { pino } from 'pino';
import { defaultGenerationConfig, type GenerationConfig, type MediaType, type UploadFileRequest } from '@rs/shared';
import { AppError } from '../../src/core/errors';
import type { ShopifyAdminClient } from '../../src/modules/shopify';
import { createMediaModule, type MediaModule, type MediaModuleOptions } from '../../src/modules/media';

export const silentLogger = pino({ level: 'silent' });
export const SHOP_ID = 'a'.repeat(24);
export const OTHER_SHOP_ID = 'c'.repeat(24);
export const USER_ID = 'b'.repeat(24);

export interface TestClock {
  now: () => Date;
  advance(ms: number): void;
  sleep: (ms: number) => Promise<void>;
}

// sleep() advances the clock instead of waiting, so a 10 minute poll takes no real time.
export function createClock(start = '2026-10-07T12:00:00.000Z'): TestClock {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance(ms) {
      current += ms;
    },
    sleep(ms) {
      current += ms;
      return Promise.resolve();
    },
  };
}

export interface RecordedCall {
  shopId: string;
  operation: 'StagedUploadsCreate' | 'FileCreate' | 'FileStatus' | 'FileDelete' | 'FileUpdate';
  variables: Record<string, unknown>;
}

interface FakeFile {
  gid: string;
  mediaType: MediaType;
  filename: string;
  status: 'UPLOADED' | 'PROCESSING' | 'READY' | 'FAILED';
  errors: { code: string; message: string }[];
  queriesUntilReady: number | null;
}

export interface VideoRendition {
  url: string;
  format: string;
  mimeType: string;
  width: number;
  height: number;
}

type UserError = { field: string[] | null; message: string; code?: string };

// A Shopify Files backend in memory: staged targets, files with a status, delete.
export class FakeShopify {
  readonly calls: RecordedCall[] = [];
  readonly files = new Map<string, FakeFile>();
  readonly deleted: string[] = [];
  // File gid -> the product gids it was added to (fileUpdate referencesToAdd).
  readonly references = new Map<string, Set<string>>();
  fileUpdateUserErrors: UserError[] = [];
  // Shopify refuses the mutation for lack of an access scope.
  denyFileUpdate = false;
  // Makes fileUpdate throw this (a shop-level failure such as a login that is needed).
  failFileUpdateWith: Error | null = null;
  stagedUserErrors: UserError[] = [];
  fileCreateUserErrors: UserError[] = [];
  fileDeleteUserErrors: UserError[] = [];
  // When set, the next status query throws instead of answering.
  failNextStatusQueries = 0;
  failFileCreate = false;
  // Files that become READY after this many status queries (null: stay PROCESSING until set by the test).
  defaultQueriesUntilReady: number | null = null;
  // What such a file becomes once its queries are used up.
  resolveAs: 'READY' | 'FAILED' = 'READY';
  failureError = { code: 'IMAGE_PROCESSING_FAILURE', message: 'The image could not be processed.' };
  videoSources: VideoRendition[] = [
    { url: 'https://cdn.shopify.com/videos/c/vp/x/HD-1080p.mp4', format: 'mp4', mimeType: 'video/mp4', width: 1080, height: 1920 },
    { url: 'https://cdn.shopify.com/videos/c/vp/x/SD-480p.mp4', format: 'mp4', mimeType: 'video/mp4', width: 480, height: 854 },
    { url: 'https://cdn.shopify.com/videos/c/vp/x/playlist.m3u8', format: 'm3u8', mimeType: 'application/x-mpegURL', width: 1080, height: 1920 },
  ];
  private counter = 0;

  readonly admin: ShopifyAdminClient = {
    query: async <TData>(shopId: string, query: string, variables: Record<string, unknown> = {}) => {
      const data = this.handle(shopId, query, variables);
      return { data: data as TData, cost: null };
    },
  };

  count(operation: RecordedCall['operation']): number {
    return this.calls.filter((call) => call.operation === operation).length;
  }

  last(operation: RecordedCall['operation']): RecordedCall {
    const call = [...this.calls].reverse().find((candidate) => candidate.operation === operation);
    if (call === undefined) throw new Error(`no ${operation} call`);
    return call;
  }

  setReady(gid: string): void {
    this.file(gid).status = 'READY';
  }

  setFailed(gid: string, code = 'IMAGE_PROCESSING_FAILURE', message = 'File could not be processed'): void {
    const file = this.file(gid);
    file.status = 'FAILED';
    file.errors = [{ code, message }];
  }

  remove(gid: string): void {
    this.files.delete(gid);
  }

  gids(): string[] {
    return [...this.files.keys()];
  }

  private file(gid: string): FakeFile {
    const file = this.files.get(gid);
    if (file === undefined) throw new Error(`unknown file ${gid}`);
    return file;
  }

  private handle(shopId: string, query: string, variables: Record<string, unknown>): unknown {
    if (query.includes('mutation StagedUploadsCreate')) return this.record(shopId, 'StagedUploadsCreate', variables, () => this.stagedUploadsCreate(variables));
    if (query.includes('mutation FileCreate')) return this.record(shopId, 'FileCreate', variables, () => this.fileCreate(variables));
    if (query.includes('query FileStatus')) return this.record(shopId, 'FileStatus', variables, () => this.fileStatus(variables));
    if (query.includes('mutation FileDelete')) return this.record(shopId, 'FileDelete', variables, () => this.fileDelete(variables));
    if (query.includes('mutation FileUpdate')) return this.record(shopId, 'FileUpdate', variables, () => this.fileUpdate(variables));
    throw new Error(`unexpected query: ${query}`);
  }

  private record(shopId: string, operation: RecordedCall['operation'], variables: Record<string, unknown>, run: () => unknown): unknown {
    this.calls.push({ shopId, operation, variables });
    return run();
  }

  private stagedUploadsCreate(variables: Record<string, unknown>): unknown {
    const inputs = variables.input as { filename: string; resource: string }[];
    if (this.stagedUserErrors.length > 0) return { stagedUploadsCreate: { stagedTargets: [], userErrors: this.stagedUserErrors } };
    const stagedTargets = inputs.map((input) => {
      const n = ++this.counter;
      return {
        url: `https://staging.example/${input.resource.toLowerCase()}/${n}`,
        resourceUrl: `https://staging.example/files/${n}/${input.filename}`,
        parameters: [
          { name: 'key', value: `tmp/${n}/${input.filename}` },
          { name: 'policy', value: `policy-${n}` },
        ],
      };
    });
    return { stagedUploadsCreate: { stagedTargets, userErrors: [] } };
  }

  private fileCreate(variables: Record<string, unknown>): unknown {
    if (this.failFileCreate) throw new Error('network down');
    if (this.fileCreateUserErrors.length > 0) return { fileCreate: { files: null, userErrors: this.fileCreateUserErrors } };
    const inputs = variables.files as { contentType: string; filename: string }[];
    const files = inputs.map((input) => {
      const n = ++this.counter;
      const mediaType: MediaType = input.contentType === 'VIDEO' ? 'video' : 'image';
      const gid = `gid://shopify/${mediaType === 'video' ? 'Video' : 'MediaImage'}/${n}`;
      this.files.set(gid, { gid, mediaType, filename: input.filename, status: 'UPLOADED', errors: [], queriesUntilReady: this.defaultQueriesUntilReady });
      return { id: gid };
    });
    return { fileCreate: { files, userErrors: [] } };
  }

  private fileStatus(variables: Record<string, unknown>): unknown {
    if (this.failNextStatusQueries > 0) {
      this.failNextStatusQueries -= 1;
      throw new Error('Shopify is unavailable');
    }
    const ids = variables.ids as string[];
    return { nodes: ids.map((id) => this.statusNode(id)) };
  }

  private statusNode(gid: string): unknown {
    const file = this.files.get(gid);
    if (file === undefined) return null;
    if (file.queriesUntilReady !== null && file.status !== 'READY' && file.status !== 'FAILED') {
      file.queriesUntilReady -= 1;
      if (file.queriesUntilReady <= 0) {
        file.status = this.resolveAs;
        if (this.resolveAs === 'FAILED') file.errors = [this.failureError];
      }
    }
    const base = { id: gid, fileStatus: file.status, fileErrors: file.errors };
    const ready = file.status === 'READY';
    if (file.mediaType === 'image') {
      return { ...base, image: ready ? { url: `https://cdn.shopify.com/s/files/1/rs/${file.filename}`, width: 1536, height: 2048 } : null };
    }
    return {
      ...base,
      duration: ready ? 8_000 : null,
      preview: { image: ready ? { url: `https://cdn.shopify.com/s/files/1/rs/${file.filename}.jpg` } : null },
      sources: ready ? this.videoSources : [],
      originalSource: ready ? { url: 'https://cdn.shopify.com/original.mov', mimeType: 'video/quicktime', width: 1080, height: 1920 } : null,
    };
  }

  private fileUpdate(variables: Record<string, unknown>): unknown {
    if (this.failFileUpdateWith !== null) throw this.failFileUpdateWith;
    if (this.denyFileUpdate) throw AppError.forbidden('Shopify denied access to the requested data');
    if (this.fileUpdateUserErrors.length > 0) return { fileUpdate: { files: null, userErrors: this.fileUpdateUserErrors } };
    const inputs = variables.files as { id: string; referencesToAdd: string[] }[];
    for (const input of inputs) {
      const products = this.references.get(input.id) ?? new Set<string>();
      for (const product of input.referencesToAdd) products.add(product);
      this.references.set(input.id, products);
    }
    return { fileUpdate: { files: inputs.map((input) => ({ id: input.id })), userErrors: [] } };
  }

  private fileDelete(variables: Record<string, unknown>): unknown {
    if (this.fileDeleteUserErrors.length > 0) return { fileDelete: { deletedFileIds: [], userErrors: this.fileDeleteUserErrors } };
    const ids = variables.fileIds as string[];
    const userErrors: UserError[] = [];
    for (const id of ids) {
      if (this.files.delete(id)) this.deleted.push(id);
      else userErrors.push({ field: ['fileIds'], message: 'File does not exist.', code: 'FILE_DOES_NOT_EXIST' });
    }
    return { fileDelete: { deletedFileIds: ids, userErrors } };
  }
}

export function testConfig(overrides: Partial<GenerationConfig> = {}): GenerationConfig {
  return { ...defaultGenerationConfig, ...overrides };
}

export interface MediaKit {
  media: MediaModule;
  shopify: FakeShopify;
  clock: TestClock;
  fetchCalls: { url: string; form: FormData }[];
}

export interface KitOptions {
  config?: GenerationConfig;
  isMediaInUse?: MediaModuleOptions['isMediaInUse'];
  fetchImpl?: typeof fetch;
  requireAuth?: MediaModuleOptions['requireAuth'];
}

export function createKit(options: KitOptions = {}): MediaKit {
  const shopify = new FakeShopify();
  const clock = createClock();
  const fetchCalls: { url: string; form: FormData }[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    if (!(init?.body instanceof FormData)) throw new Error('expected a FormData body');
    fetchCalls.push({ url: String(input), form: init.body });
    return new Response(null, { status: 201 });
  };
  const media = createMediaModule({
    admin: shopify.admin,
    requireAuth: options.requireAuth ?? ((_req, _res, next) => next()),
    getConfig: () => options.config ?? defaultGenerationConfig,
    logger: silentLogger,
    fetchImpl: options.fetchImpl ?? recordingFetch,
    now: clock.now,
    sleep: clock.sleep,
    ...(options.isMediaInUse === undefined ? {} : { isMediaInUse: options.isMediaInUse }),
  });
  return { media, shopify, clock, fetchCalls };
}

export function imageFile(clientId: string, overrides: Partial<UploadFileRequest> = {}): UploadFileRequest {
  return { clientId, filename: `${clientId}.jpg`, mimeType: 'image/jpeg', fileSize: 1_000_000, scope: 'common', ...overrides };
}

export function videoFile(clientId: string, overrides: Partial<UploadFileRequest> = {}): UploadFileRequest {
  return { clientId, filename: `${clientId}.mp4`, mimeType: 'video/mp4', fileSize: 8_000_000, durationSec: 12, scope: 'common', ...overrides };
}

export function newObjectId(): string {
  return new Types.ObjectId().toHexString();
}
