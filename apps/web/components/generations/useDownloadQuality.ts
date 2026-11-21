import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_DOWNLOAD_QUALITY,
  DOWNLOAD_QUALITY_STORAGE_KEY,
  parseDownloadQuality,
  type DownloadQuality,
} from '@/lib/download-quality';

// The merchant's choice between standard (web JPEG) and original files, kept in this browser. The page always starts
// on the default and reads the saved choice after it has mounted, so the server and the browser render the same thing.
// A blocked or full storage (an embedded iframe can have either) only means the choice is not remembered.
export function useDownloadQuality(): readonly [DownloadQuality, (next: DownloadQuality) => void] {
  const [quality, setQuality] = useState<DownloadQuality>(DEFAULT_DOWNLOAD_QUALITY);

  useEffect(() => {
    try {
      setQuality(parseDownloadQuality(window.localStorage.getItem(DOWNLOAD_QUALITY_STORAGE_KEY)));
    } catch {
      // Keep the default.
    }
  }, []);

  const choose = useCallback((next: DownloadQuality) => {
    setQuality(next);
    try {
      window.localStorage.setItem(DOWNLOAD_QUALITY_STORAGE_KEY, next);
    } catch {
      // The choice applies to this visit only.
    }
  }, []);

  return [quality, choose];
}
