// A zip reader for the unit tests of lib/zip.ts and lib/download.ts. It reads the bytes the way an unzip tool does
// (end record, central directory, local headers) and throws on anything that is not a valid STORE archive. Not
// imported by app code.

export interface ParsedEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  time: number;
  date: number;
  // Where this file's local header starts.
  offset: number;
  data: Uint8Array;
}

export interface ParsedZip {
  entries: ParsedEntry[];
  directoryOffset: number;
  directorySize: number;
  // Where the end record starts.
  endOffset: number;
  byteLength: number;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function expectSignature(view: DataView, offset: number, signature: number, what: string): void {
  if (offset < 0 || offset + 4 > view.byteLength || view.getUint32(offset, true) !== signature) {
    throw new Error(`No ${what} signature at ${offset}`);
  }
}

export async function parseZip(blob: Blob): Promise<ParsedZip> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const endOffset = bytes.length - 22;
  expectSignature(view, endOffset, 0x06054b50, 'end record');
  const total = view.getUint16(endOffset + 10, true);
  if (view.getUint16(endOffset + 8, true) !== total) throw new Error('Entry counts differ');
  if (view.getUint16(endOffset + 4, true) !== 0 || view.getUint16(endOffset + 6, true) !== 0) throw new Error('Multi disk');
  if (view.getUint16(endOffset + 20, true) !== 0) throw new Error('Unexpected archive comment');
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  if (directoryOffset + directorySize !== endOffset) throw new Error('The directory does not end at the end record');

  const entries: ParsedEntry[] = [];
  let at = directoryOffset;
  for (let index = 0; index < total; index += 1) {
    expectSignature(view, at, 0x02014b50, 'central header');
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const entry = {
      name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      time: view.getUint16(at + 12, true),
      date: view.getUint16(at + 14, true),
      crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true),
    };

    // The local header must say the same, and the data follows its name and extra field.
    const local = entry.offset;
    expectSignature(view, local, 0x04034b50, 'local header');
    const localName = decoder.decode(bytes.subarray(local + 30, local + 30 + view.getUint16(local + 26, true)));
    if (localName !== entry.name) throw new Error(`Local header names ${localName}, directory ${entry.name}`);
    if (view.getUint32(local + 14, true) !== entry.crc) throw new Error('Local and central CRC differ');
    if (view.getUint32(local + 18, true) !== entry.compressedSize) throw new Error('Local and central size differ');
    if (view.getUint16(local + 6, true) !== entry.flags) throw new Error('Local and central flags differ');
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    entries.push({ ...entry, data: bytes.slice(dataStart, dataStart + entry.compressedSize) });

    at += 46 + nameLength + extraLength + commentLength;
  }
  if (at !== endOffset) throw new Error('The directory has more bytes than its entries');
  return { entries, directoryOffset, directorySize, endOffset, byteLength: bytes.length };
}
