import { z } from 'zod';
import type { MediaType, UploadParameter } from '@rs/shared';
import { AppError } from '../../core/errors';
import type { ShopifyAdminClient } from '../shopify';

// Admin GraphQL calls for Shopify Files (SPEC 8.6). Verified against the 2026-10 reference:
// stagedUploadsCreate (resource IMAGE or VIDEO, fileSize as a string, required for VIDEO),
// fileCreate (originalSource is the staged resourceUrl), nodes(ids) for fileStatus and fileDelete.

const STAGED_UPLOADS_CREATE = /* GraphQL */ `
  mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FILE_CREATE = /* GraphQL */ `
  mutation FileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const FILE_STATUS = /* GraphQL */ `
  query FileStatus($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on File {
        id
        fileStatus
        fileErrors {
          code
          message
        }
      }
      ... on MediaImage {
        image {
          url
          width
          height
        }
      }
      ... on Video {
        duration
        preview {
          image {
            url
          }
        }
        sources {
          url
          mimeType
          format
          width
          height
        }
        originalSource {
          url
          mimeType
          width
          height
        }
      }
    }
  }
`;

const FILE_DELETE = /* GraphQL */ `
  mutation FileDelete($fileIds: [ID!]!) {
    fileDelete(fileIds: $fileIds) {
      deletedFileIds
      userErrors {
        field
        message
        code
      }
    }
  }
`;

async function callAdmin<T>(
  admin: ShopifyAdminClient,
  shopId: string,
  query: string,
  variables: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const { data } = await admin.query<unknown>(shopId, query, variables);
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw AppError.internal('Unexpected response from Shopify', parsed.error);
  return parsed.data;
}

const userErrorSchema = z.object({ field: z.array(z.string()).nullable().optional(), message: z.string(), code: z.string().nullable().optional() });

function describeUserErrors(errors: z.infer<typeof userErrorSchema>[]): string {
  return errors.map((error) => (error.code === null || error.code === undefined ? error.message : `${error.code}: ${error.message}`)).join('; ');
}

// stagedUploadsCreate ---------------------------------------------------------------------------

export interface StagedUploadInput {
  filename: string;
  mimeType: string;
  mediaType: MediaType;
  fileSize: number;
}

export interface StagedTarget {
  url: string;
  resourceUrl: string;
  parameters: UploadParameter[];
}

const stagedUploadsSchema = z.object({
  stagedUploadsCreate: z.object({
    stagedTargets: z
      .array(
        z.object({
          url: z.string().nullable(),
          resourceUrl: z.string().nullable(),
          parameters: z.array(z.object({ name: z.string(), value: z.string() })),
        }),
      )
      .nullable(),
    userErrors: z.array(userErrorSchema),
  }),
});

// One target per input, in the same order. Throws an internal AppError if Shopify refuses.
export async function stageUploads(admin: ShopifyAdminClient, shopId: string, inputs: StagedUploadInput[]): Promise<StagedTarget[]> {
  const input = inputs.map((item) => ({
    resource: item.mediaType === 'video' ? 'VIDEO' : 'IMAGE',
    filename: item.filename,
    mimeType: item.mimeType,
    fileSize: String(item.fileSize),
    httpMethod: 'POST',
  }));
  const { stagedUploadsCreate } = await callAdmin(admin, shopId, STAGED_UPLOADS_CREATE, { input }, stagedUploadsSchema);
  const targets = stagedUploadsCreate.stagedTargets ?? [];
  if (stagedUploadsCreate.userErrors.length > 0) {
    throw AppError.internal(`Shopify rejected the staged upload: ${describeUserErrors(stagedUploadsCreate.userErrors)}`);
  }
  if (targets.length !== inputs.length) throw AppError.internal('Shopify returned an unexpected number of staged targets');
  return targets.map((target) => {
    if (target.url === null || target.resourceUrl === null) throw AppError.internal('Shopify returned an incomplete staged target');
    return { url: target.url, resourceUrl: target.resourceUrl, parameters: target.parameters };
  });
}

// fileCreate ------------------------------------------------------------------------------------

export interface NewFile {
  originalSource: string;
  mediaType: MediaType;
  filename: string;
  alt: string;
}

export type CreateFileResult = { ok: true; fileGid: string } | { ok: false; code: string; message: string };

const fileCreateSchema = z.object({
  fileCreate: z.object({
    files: z.array(z.object({ id: z.string() })).nullable(),
    userErrors: z.array(userErrorSchema),
  }),
});

const MAX_ALT_LENGTH = 512;

// userErrors (invalid file, unsupported type, and so on) come back as { ok: false }. Everything else throws.
export async function createFile(admin: ShopifyAdminClient, shopId: string, file: NewFile): Promise<CreateFileResult> {
  const files = [
    {
      originalSource: file.originalSource,
      contentType: file.mediaType === 'video' ? 'VIDEO' : 'IMAGE',
      filename: file.filename,
      alt: file.alt.slice(0, MAX_ALT_LENGTH),
    },
  ];
  const { fileCreate } = await callAdmin(admin, shopId, FILE_CREATE, { files }, fileCreateSchema);
  if (fileCreate.userErrors.length > 0) {
    return { ok: false, code: fileCreate.userErrors[0]?.code ?? 'INVALID', message: describeUserErrors(fileCreate.userErrors) };
  }
  const created = fileCreate.files?.[0];
  if (created === undefined) throw AppError.internal('Shopify did not return the created file');
  return { ok: true, fileGid: created.id };
}

// fileStatus ------------------------------------------------------------------------------------

export type FileState =
  | { status: 'processing' }
  | { status: 'failed'; code: string; message: string }
  | {
      status: 'ready';
      url: string;
      previewUrl: string | null;
      width: number | null;
      height: number | null;
      durationSec: number | null;
    };

export interface FileTarget {
  fileGid: string;
  mediaType: MediaType;
}

const sourceSchema = z.object({
  url: z.string(),
  mimeType: z.string().nullable().optional(),
  format: z.string().nullable().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
});

const fileNodeSchema = z.object({
  id: z.string(),
  fileStatus: z.enum(['UPLOADED', 'PROCESSING', 'READY', 'FAILED']),
  fileErrors: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
  image: z
    .object({ url: z.string(), width: z.number().nullable().optional(), height: z.number().nullable().optional() })
    .nullable()
    .optional(),
  // Video.duration is in milliseconds and null until the file is READY.
  duration: z.number().nullable().optional(),
  preview: z.object({ image: z.object({ url: z.string() }).nullable() }).nullable().optional(),
  sources: z.array(sourceSchema).optional(),
  originalSource: sourceSchema.nullable().optional(),
});

type FileNode = z.infer<typeof fileNodeSchema>;
type VideoSource = z.infer<typeof sourceSchema>;

function positiveInt(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isInteger(value) && value > 0 ? value : null;
}

function isMp4(source: VideoSource): boolean {
  return source.format?.toLowerCase() === 'mp4' || source.mimeType?.toLowerCase() === 'video/mp4';
}

// The largest mp4 rendition, else the original file. The m3u8 playlist is never used.
function pickVideoSource(node: FileNode): VideoSource | null {
  const area = (source: VideoSource) => (source.width ?? 0) * (source.height ?? 0);
  const mp4 = (node.sources ?? []).filter(isMp4).sort((a, b) => area(b) - area(a))[0];
  return mp4 ?? node.originalSource ?? null;
}

function readyState(node: FileNode, mediaType: MediaType): FileState {
  if (mediaType === 'image') {
    const url = node.image?.url ?? node.preview?.image?.url;
    if (url === undefined) return { status: 'processing' };
    return {
      status: 'ready',
      url,
      previewUrl: url,
      width: positiveInt(node.image?.width),
      height: positiveInt(node.image?.height),
      durationSec: null,
    };
  }
  const source = pickVideoSource(node);
  if (source === null) return { status: 'processing' };
  return {
    status: 'ready',
    url: source.url,
    previewUrl: node.preview?.image?.url ?? null,
    width: positiveInt(source.width),
    height: positiveInt(source.height),
    durationSec: node.duration === null || node.duration === undefined ? null : Math.round(node.duration) / 1000,
  };
}

function toFileState(node: FileNode, mediaType: MediaType): FileState {
  if (node.fileStatus === 'FAILED') {
    const error = node.fileErrors?.[0];
    return { status: 'failed', code: error?.code ?? 'UNKNOWN', message: error?.message ?? 'Shopify could not process the file' };
  }
  return node.fileStatus === 'READY' ? readyState(node, mediaType) : { status: 'processing' };
}

const fileStatusSchema = z.object({ nodes: z.array(z.unknown()) });

// A file that Shopify no longer returns (the merchant deleted it) is reported as failed with FILE_MISSING.
export async function queryFileStates(admin: ShopifyAdminClient, shopId: string, targets: FileTarget[]): Promise<Map<string, FileState>> {
  const states = new Map<string, FileState>();
  if (targets.length === 0) return states;
  const { nodes } = await callAdmin(admin, shopId, FILE_STATUS, { ids: targets.map((target) => target.fileGid) }, fileStatusSchema);
  const found = new Map<string, FileNode>();
  for (const node of nodes) {
    const parsed = fileNodeSchema.safeParse(node);
    if (parsed.success) found.set(parsed.data.id, parsed.data);
  }
  for (const target of targets) {
    const node = found.get(target.fileGid);
    states.set(
      target.fileGid,
      node === undefined ? { status: 'failed', code: 'FILE_MISSING', message: 'The file no longer exists in Shopify' } : toFileState(node, target.mediaType),
    );
  }
  return states;
}

// fileDelete ------------------------------------------------------------------------------------

const fileDeleteSchema = z.object({
  fileDelete: z.object({ userErrors: z.array(userErrorSchema) }),
});

// A file that is already gone counts as deleted. A file with a pending operation is "in use" (409),
// because Shopify refuses to delete it until the operation ends.
export async function deleteFile(admin: ShopifyAdminClient, shopId: string, fileGid: string): Promise<void> {
  const { fileDelete } = await callAdmin(admin, shopId, FILE_DELETE, { fileIds: [fileGid] }, fileDeleteSchema);
  const errors = fileDelete.userErrors.filter((error) => error.code !== 'FILE_DOES_NOT_EXIST');
  if (errors.length === 0) return;
  if (errors.some((error) => error.code === 'FILE_LOCKED' || error.code === 'MEDIA_CANNOT_BE_MODIFIED')) {
    throw AppError.inUse('The file is still being processed. Try again in a moment.');
  }
  throw AppError.internal(`Shopify could not delete the file: ${describeUserErrors(errors)}`);
}
