import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArchiveFile } from '@/lib/archive';
import { downloadFile, downloadZip, type DownloadItem } from '@/lib/download';
import { showToast } from '@/lib/shopify';
import { archiveToast, singleDownloadToast, type ArchiveProgress } from './logic';

// Single saves and zips, one at a time, each ending in a toast. Both helpers in lib/download never throw. A zip in
// progress is abandoned when the page is left.
export function useDownloads() {
  const [archive, setArchive] = useState<ArchiveProgress | null>(null);
  const [savingOne, setSavingOne] = useState(false);
  const busy = useRef(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const saveOne = useCallback(async (item: DownloadItem): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setSavingOne(true);
    try {
      const { message, isError } = singleDownloadToast(await downloadFile(item.url, item.filename));
      showToast(message, isError);
    } finally {
      busy.current = false;
      setSavingOne(false);
    }
  }, []);

  const saveArchive = useCallback(async (scope: string, files: readonly ArchiveFile[], name: string): Promise<void> => {
    if (busy.current || files.length === 0) return;
    busy.current = true;
    const abort = new AbortController();
    controller.current = abort;
    setArchive({ scope, done: 0, total: files.length });
    try {
      const result = await downloadZip(files, name, {
        signal: abort.signal,
        onProgress: (done, total) => setArchive({ scope, done, total }),
      });
      const toast = archiveToast(result, name);
      if (toast !== null) showToast(toast.message, toast.isError);
    } finally {
      busy.current = false;
      controller.current = null;
      setArchive(null);
    }
  }, []);

  return { archive, savingOne, saving: archive !== null || savingOne, saveOne, saveArchive };
}
