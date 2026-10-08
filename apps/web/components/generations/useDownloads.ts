import { useCallback, useRef, useState } from 'react';
import { downloadAll, downloadFile, type DownloadItem } from '@/lib/download';
import { showToast } from '@/lib/shopify';
import { downloadSummaryToast, singleDownloadToast } from './logic';

export interface BulkProgress {
  done: number;
  total: number;
}

// Single and bulk saves, one at a time, each ending in a toast. Both helpers in lib/download never throw.
export function useDownloads() {
  const [bulk, setBulk] = useState<BulkProgress | null>(null);
  const [savingOne, setSavingOne] = useState(false);
  const busy = useRef(false);

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

  const saveAll = useCallback(async (items: readonly DownloadItem[]): Promise<void> => {
    if (busy.current || items.length === 0) return;
    busy.current = true;
    try {
      const summary = await downloadAll(items, (done, total) => setBulk({ done, total }));
      const { message, isError } = downloadSummaryToast(summary);
      showToast(message, isError);
    } finally {
      busy.current = false;
      setBulk(null);
    }
  }, []);

  return { bulk, savingOne, saving: bulk !== null || savingOne, saveOne, saveAll };
}
