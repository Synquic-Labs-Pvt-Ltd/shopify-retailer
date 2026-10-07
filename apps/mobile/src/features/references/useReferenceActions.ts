import { randomUUID } from 'expo-crypto';
import { useCallback } from 'react';
import { useMe } from '../../api/me';
import { useToast } from '../../design';
import { useDraftStore, type DraftReference } from '../../state/draft';
import { checkPreparedSize, remainingSlots, validateAsset, type ReferenceLimits } from './limits';
import type { PickedAsset } from './pickedAsset';
import { PermissionDeniedError, pickAssets, type PickSource } from './pickers';
import { prepareImage, prepareVideo, type PreparedFile } from './prepareMedia';
import { discardReference, enqueueUploads, retryUpload } from './uploadService';

// Where a new reference goes: every product (common) or one product.
export type ReferenceTarget = { kind: 'common' } | { kind: 'product'; productId: string };

function currentCount(target: ReferenceTarget): number {
  const state = useDraftStore.getState();
  return target.kind === 'common' ? state.commonRefs.length : (state.productRefs[target.productId]?.length ?? 0);
}

function roomFor(target: ReferenceTarget, limits: ReferenceLimits): number {
  return remainingSlots(target.kind === 'common' ? limits.maxCommon : limits.maxPerProduct, currentCount(target));
}

function limitMessage(target: ReferenceTarget, limits: ReferenceLimits): string {
  return target.kind === 'common'
    ? `You can add up to ${limits.maxCommon} common references.`
    : `Each product can have up to ${limits.maxPerProduct} references.`;
}

function newReference(asset: PickedAsset): DraftReference {
  return {
    clientId: randomUUID(),
    mediaId: null,
    mediaType: asset.mediaType,
    localUri: asset.uri,
    filename: asset.fileName,
    mimeType: asset.mimeType ?? (asset.mediaType === 'video' ? 'video/mp4' : 'image/jpeg'),
    fileSize: asset.fileSize ?? 0,
    durationSec: asset.durationSec,
    status: 'uploading',
    progress: 0,
    previewUrl: null,
    error: null,
  };
}

function insertReference(target: ReferenceTarget, ref: DraftReference): void {
  const draft = useDraftStore.getState();
  if (target.kind === 'common') draft.addCommonRef(ref);
  else draft.addProductRef(target.productId, ref);
}

// Converts the file and checks the size of what will really be uploaded. Throws a sentence for the user.
async function prepare(asset: PickedAsset, limits: ReferenceLimits): Promise<PreparedFile> {
  let prepared: PreparedFile;
  try {
    prepared = asset.mediaType === 'image' ? await prepareImage(asset) : await prepareVideo(asset);
  } catch {
    throw new Error(`${asset.mediaType === 'video' ? 'A video' : 'An image'} could not be processed.`);
  }
  const problem = checkPreparedSize(prepared.fileSize, asset.mediaType, limits);
  if (problem !== null) throw new Error(problem);
  return prepared;
}

function summarize(problems: readonly string[]): string {
  const [first] = problems;
  if (first === undefined) return '';
  return problems.length === 1 ? first : `${problems.length} files were skipped. ${first}`;
}

// The reference actions of the References screen: pick (camera or library), validate against the /me limits,
// convert, upload, retry and remove. Every outcome that needs the user's attention ends in one toast.
export function useReferenceActions() {
  const toast = useToast();
  const me = useMe();
  const limits = me.data?.generation.references;
  const refetchMe = me.refetch;

  const add = useCallback(
    async (source: PickSource, target: ReferenceTarget): Promise<void> => {
      if (limits === undefined) {
        toast.error('Generation settings are still loading. Try again in a moment.');
        void refetchMe();
        return;
      }
      const room = roomFor(target, limits);
      if (room === 0) {
        toast.error(limitMessage(target, limits));
        return;
      }

      let assets: PickedAsset[];
      try {
        assets = await pickAssets(source, { maxVideoSeconds: limits.maxVideoSeconds, remaining: room });
      } catch (error) {
        toast.error(error instanceof PermissionDeniedError ? error.message : 'Could not open the picker.');
        return;
      }
      if (assets.length === 0) return;

      const problems: string[] = [];
      // Re-read the room: the draft may have changed while the picker was open.
      const roomNow = roomFor(target, limits);
      if (assets.length > roomNow) problems.push(limitMessage(target, limits));
      const accepted: { asset: PickedAsset; ref: DraftReference }[] = [];
      for (const asset of assets.slice(0, roomNow)) {
        const problem = validateAsset(asset, limits);
        if (problem !== null) {
          problems.push(problem);
          continue;
        }
        const ref = newReference(asset);
        insertReference(target, ref);
        accepted.push({ asset, ref });
      }

      const settled = await Promise.all(
        accepted.map(async ({ asset, ref }): Promise<string | null> => {
          try {
            const prepared = await prepare(asset, limits);
            useDraftStore.getState().updateRef(ref.clientId, {
              localUri: prepared.uri,
              filename: prepared.fileName,
              mimeType: prepared.mimeType,
              fileSize: prepared.fileSize,
            });
            return ref.clientId;
          } catch (error) {
            discardReference(ref.clientId);
            problems.push(error instanceof Error ? error.message : 'A file could not be processed.');
            return null;
          }
        }),
      );
      const ready = settled.filter((id): id is string => id !== null);

      const failed = await enqueueUploads(ready);
      if (failed > 0) {
        toast.error(
          failed === 1
            ? 'An upload failed. Tap the red slot to retry.'
            : `${failed} uploads failed. Tap a red slot to retry.`,
        );
      } else if (problems.length > 0) {
        toast.error(summarize(problems));
      }
    },
    [limits, refetchMe, toast],
  );

  const retry = useCallback(
    async (clientId: string): Promise<void> => {
      if (!(await retryUpload(clientId))) toast.error('The upload failed again. Tap the slot to retry.');
    },
    [toast],
  );

  return { add, retry, remove: discardReference };
}
