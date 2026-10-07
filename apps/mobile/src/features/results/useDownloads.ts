import { useCallback, useRef, useState } from 'react';
import type { MediaObject } from '@rs/shared';
import { useToast } from '../../design';
import { GalleryPermissionError, saveToGallery, shareMedia } from './downloads';

export type DownloadState = { kind: 'idle' } | { kind: 'saving'; current: number; total: number };

const PERMISSION_MESSAGE = 'Allow photo access in Settings to save to your gallery.';

function saveFailureMessage(error: unknown): string {
  return error instanceof GalleryPermissionError ? PERMISSION_MESSAGE : 'Could not save the file. Try again.';
}

// Save, save all and share, each ending in a toast (which carries the success or error haptic).
// One save runs at a time; "Download all" goes one file after the other and keeps going after a failure.
export function useDownloads() {
  const toast = useToast();
  const [state, setState] = useState<DownloadState>({ kind: 'idle' });
  const busy = useRef(false);

  const saveAll = useCallback(
    async (items: readonly MediaObject[]): Promise<void> => {
      if (busy.current || items.length === 0) return;
      busy.current = true;
      let saved = 0;
      let permissionDenied = false;
      try {
        for (const [index, media] of items.entries()) {
          setState({ kind: 'saving', current: index + 1, total: items.length });
          try {
            await saveToGallery(media);
            saved += 1;
          } catch (error) {
            if (error instanceof GalleryPermissionError) {
              permissionDenied = true;
              break;
            }
          }
        }
      } finally {
        busy.current = false;
        setState({ kind: 'idle' });
      }

      if (permissionDenied) toast.error(PERMISSION_MESSAGE);
      else if (saved === items.length) toast.success(items.length === 1 ? 'Saved to gallery' : `Saved ${items.length} items to gallery`);
      else if (saved === 0) toast.error('Could not save to the gallery. Try again.');
      else toast.error(`Saved ${saved} of ${items.length}. ${items.length - saved} could not be saved.`);
    },
    [toast],
  );

  const saveOne = useCallback(
    async (media: MediaObject): Promise<void> => {
      if (busy.current) return;
      busy.current = true;
      setState({ kind: 'saving', current: 1, total: 1 });
      try {
        await saveToGallery(media);
        toast.success('Saved to gallery');
      } catch (error) {
        toast.error(saveFailureMessage(error));
      } finally {
        busy.current = false;
        setState({ kind: 'idle' });
      }
    },
    [toast],
  );

  const share = useCallback(
    async (media: MediaObject): Promise<void> => {
      if (busy.current) return;
      busy.current = true;
      try {
        await shareMedia(media);
      } catch {
        toast.error('Could not share the file. Try again.');
      } finally {
        busy.current = false;
      }
    },
    [toast],
  );

  return { state, saveOne, saveAll, share };
}
