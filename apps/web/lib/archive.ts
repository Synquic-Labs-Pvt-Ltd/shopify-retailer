import { sanitizeFilename } from './download-policy';

// Pure rules of "Download as .zip": which file lands in which folder under which name, and how the archive is named.

export interface ArchiveSource {
  url: string;
  filename: string;
}

// The files of one product; they share a folder in the archive.
export interface ArchiveGroup {
  title: string;
  files: readonly ArchiveSource[];
}

export interface ArchiveFile {
  url: string;
  // Path inside the zip: "{folder}/{file name}".
  path: string;
}

const MAX_FOLDER_LENGTH = 60;
// Names Windows will not create as a file or folder.
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

// A folder (or archive) name from a product title: letters and digits of any script, dot, dash and underscore;
// everything else, spaces and path characters included, becomes one dash. No leading dot or dash (no hidden folder,
// no ".."), no trailing dot (Windows drops it), at most 60 characters.
export function archiveFolderName(title: string, fallback = 'product'): string {
  const collapsed = title
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '');
  const cleaned = [...collapsed].slice(0, MAX_FOLDER_LENGTH).join('').replace(/[-.]+$/, '');
  if (cleaned === '') return fallback;
  return RESERVED_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
}

interface UniqueOptions {
  // Put the number before the file extension: "a.jpg" -> "a-2.jpg". Off for folders, where a dot is part of the name.
  extension?: boolean;
}

// `name`, or `name-2`, `name-3`... when it is taken already. Names are compared case-insensitively, because the
// archive is usually opened on Windows or macOS. The returned name is added to `taken`.
export function uniqueName(name: string, taken: Set<string>, { extension = true }: UniqueOptions = {}): string {
  const dot = name.lastIndexOf('.');
  const split = extension && dot > 0 && name.length - dot <= 9 ? dot : name.length;
  const base = name.slice(0, split);
  const suffix = name.slice(split);
  let candidate = name;
  for (let number = 2; taken.has(candidate.toLowerCase()); number += 1) candidate = `${base}-${number}${suffix}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

// Every file in a folder named after its product. Equal product titles get numbered folders, equal file names within
// a product numbered files. Products without files are left out.
export function planArchive(groups: readonly ArchiveGroup[]): ArchiveFile[] {
  const folders = new Set<string>();
  const files: ArchiveFile[] = [];
  groups.forEach((group, index) => {
    if (group.files.length === 0) return;
    const folder = uniqueName(archiveFolderName(group.title, `product-${index + 1}`), folders, { extension: false });
    const names = new Set<string>();
    for (const file of group.files) {
      files.push({ url: file.url, path: `${folder}/${uniqueName(sanitizeFilename(file.filename, 'file'), names)}` });
    }
  });
  return files;
}

// "retailer-studio-a1b2c3.zip": the last 6 characters of the batch id, as in the stored file names (the first 8 characters
// of an id are a timestamp, so batches made close together share their start).
export function batchArchiveName(batchId: string): string {
  return `retailer-studio-${sanitizeFilename(batchId.slice(-6), 'batch')}.zip`;
}

// "Linen-camp-collar-shirt.zip"
export function productArchiveName(title: string): string {
  return `${archiveFolderName(title)}.zip`;
}

// The last part of an archive path.
export function archiveFileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
