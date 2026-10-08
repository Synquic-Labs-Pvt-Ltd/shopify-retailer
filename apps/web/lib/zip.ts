// A small zip writer for the browser: STORE method only (no compression, the outputs are jpg and mp4 files that
// are compressed already), no zip64. The archive is assembled from Blob parts, so the browser can keep the file
// data outside the JS heap, and every file is read once, in chunks, only to compute its CRC.
//
// Layout (APPNOTE 4.3): [local header + data] per file, then the central directory, then the end record.

export const ZIP_MAX_FILES = 0xffff;
// Offsets and sizes are 32 bit without zip64. 3.5 GB leaves room for the headers and the directory.
export const ZIP_MAX_BYTES = 3.5 * 1024 * 1024 * 1024;

export class ZipError extends Error {
  readonly reason: 'too_many_files' | 'too_large' | 'duplicate_name' | 'invalid_name';

  constructor(reason: ZipError['reason'], message: string) {
    super(message);
    this.name = 'ZipError';
    this.reason = reason;
  }
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const VERSION = 20;
// Bit 11: the file names are UTF-8.
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_RECORD_SIZE = 22;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

// CRC-32 (IEEE, the one zip uses) of `bytes`. Pass the result for the previous chunk as `previous` to continue a
// running checksum: crc32(b, crc32(a)) equals crc32(a followed by b).
export function crc32(bytes: Uint8Array, previous = 0): number {
  let crc = ~previous >>> 0;
  for (let i = 0; i < bytes.length; i += 1) crc = (CRC_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  return ~crc >>> 0;
}

async function crc32OfBlob(blob: Blob): Promise<number> {
  const reader = blob.stream().getReader();
  let crc = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return crc;
    crc = crc32(value, crc);
  }
}

// MS-DOS date and time of a zip entry (local time, 2 second resolution, from 1980).
export function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

interface Entry {
  nameBytes: Uint8Array<ArrayBuffer>;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

const encoder = new TextEncoder();

function headerView(length: number): { bytes: Uint8Array<ArrayBuffer>; view: DataView } {
  const bytes = new Uint8Array(length);
  return { bytes, view: new DataView(bytes.buffer) };
}

export class ZipWriter {
  private readonly parts: BlobPart[] = [];
  private readonly entries: Entry[] = [];
  private readonly names = new Set<string>();
  private offset = 0;
  // What the central directory and the end record will take, kept up to date to check the size limit.
  private directoryBytes = END_RECORD_SIZE;

  get fileCount(): number {
    return this.entries.length;
  }

  // Bytes of everything written so far, headers included (the directory not yet).
  get size(): number {
    return this.offset;
  }

  // Appends one file. `name` is the path inside the archive with `/` between folders. Files are added one at a
  // time: the data is read once for its CRC and then only referenced.
  async add(name: string, data: Blob | Uint8Array<ArrayBuffer>, modified: Date = new Date()): Promise<void> {
    const invalid =
      name === '' || name.includes('\\') || name.split('/').some((part) => part === '' || part === '..' || part === '.');
    if (invalid) {
      throw new ZipError('invalid_name', `Invalid file name in the archive: "${name}"`);
    }
    if (this.names.has(name)) throw new ZipError('duplicate_name', `Two files are named "${name}"`);
    if (this.entries.length >= ZIP_MAX_FILES) {
      throw new ZipError('too_many_files', `A zip can hold at most ${ZIP_MAX_FILES} files`);
    }
    const nameBytes = encoder.encode(name);
    const size = data instanceof Blob ? data.size : data.byteLength;
    // Each entry costs a local header and a central directory header, both carrying the name.
    const overhead = LOCAL_HEADER_SIZE + nameBytes.length + CENTRAL_HEADER_SIZE + nameBytes.length;
    if (this.offset + this.directoryBytes + size + overhead > ZIP_MAX_BYTES) {
      throw new ZipError('too_large', 'The files are too large for one zip (3.5 GB at most)');
    }

    const crc = data instanceof Blob ? await crc32OfBlob(data) : crc32(data);
    const stamp = dosDateTime(modified);
    const { bytes, view } = headerView(LOCAL_HEADER_SIZE);
    view.setUint32(0, LOCAL_SIGNATURE, true);
    view.setUint16(4, VERSION, true);
    view.setUint16(6, FLAG_UTF8, true);
    view.setUint16(8, METHOD_STORE, true);
    view.setUint16(10, stamp.time, true);
    view.setUint16(12, stamp.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);

    this.entries.push({ nameBytes, crc, size, offset: this.offset, time: stamp.time, date: stamp.date });
    this.names.add(name);
    this.parts.push(bytes, nameBytes, data);
    this.offset += LOCAL_HEADER_SIZE + nameBytes.length + size;
    this.directoryBytes += CENTRAL_HEADER_SIZE + nameBytes.length;
  }

  // The finished archive: the files, the central directory and the end record. An archive without files is
  // valid (just the end record).
  finish(): Blob {
    const directory: Uint8Array<ArrayBuffer>[] = [];
    let directorySize = 0;
    for (const entry of this.entries) {
      const { bytes, view } = headerView(CENTRAL_HEADER_SIZE);
      view.setUint32(0, CENTRAL_SIGNATURE, true);
      view.setUint16(4, VERSION, true);
      view.setUint16(6, VERSION, true);
      view.setUint16(8, FLAG_UTF8, true);
      view.setUint16(10, METHOD_STORE, true);
      view.setUint16(12, entry.time, true);
      view.setUint16(14, entry.date, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, entry.size, true);
      view.setUint32(24, entry.size, true);
      view.setUint16(28, entry.nameBytes.length, true);
      // 30 extra length, 32 comment length, 34 disk number, 36 internal attributes, 38 external attributes: zero.
      view.setUint32(42, entry.offset, true);
      directory.push(bytes, entry.nameBytes);
      directorySize += CENTRAL_HEADER_SIZE + entry.nameBytes.length;
    }
    const end = headerView(END_RECORD_SIZE);
    end.view.setUint32(0, END_SIGNATURE, true);
    end.view.setUint16(8, this.entries.length, true);
    end.view.setUint16(10, this.entries.length, true);
    end.view.setUint32(12, directorySize, true);
    end.view.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...directory, end.bytes], { type: 'application/zip' });
  }
}
