import { endpoints } from '@/lib/api/endpoints';
import { useDraftStore } from '@/lib/state/draft';
import { fileRegistry } from '@/lib/state/fileRegistry';
import type { ReferenceTarget } from '@/lib/state/draftTypes';
import { addFiles, type AddFilesResult } from './addFiles';
import { browserImageDecoder } from './browserImage';
import { browserVideoLoader } from './browserVideo';
import type { ReferenceLimits } from './limits';
import { defaultTransport } from './transports';
import { createUploadService, type UploadService } from './uploadService';

// The app-wide wiring: the persisted draft store, the in-memory file registry, the typed endpoints and the
// browser adapters. Pages use these; tests build their own with the create* factories.
export const uploadService: UploadService = createUploadService({
  draft: useDraftStore,
  files: fileRegistry,
  api: endpoints.media,
  transport: defaultTransport,
});

// Validates, prepares and uploads the picked files for a target (see addFiles).
export function addReferenceFiles(
  target: ReferenceTarget,
  picked: readonly File[],
  limits: ReferenceLimits,
): Promise<AddFilesResult> {
  return addFiles(target, picked, limits, {
    draft: useDraftStore,
    files: fileRegistry,
    uploads: uploadService,
    images: browserImageDecoder,
    videos: browserVideoLoader,
  });
}
