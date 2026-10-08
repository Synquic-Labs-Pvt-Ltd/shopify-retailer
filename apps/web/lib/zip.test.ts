import { describe, expect, it } from 'vitest';
import { ZIP_MAX_BYTES, ZIP_MAX_FILES, ZipError, ZipWriter, crc32, dosDateTime } from './zip';
import { parseZip } from './zipTestkit';

const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
const asText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

// A blob that claims a size without holding the bytes, to cross the size limit without 3.5 GB of memory.
class HugeBlob extends Blob {
  override get size(): number {
    return ZIP_MAX_BYTES;
  }
}

async function reason(promise: Promise<unknown>): Promise<ZipError['reason'] | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof ZipError) return error.reason;
    throw error;
  }
}

describe('crc32', () => {
  it('matches the known check values', () => {
    expect(crc32(text(''))).toBe(0);
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(text('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
    expect(crc32(new Uint8Array(32))).toBe(0x190a55ad);
  });

  it('continues a running checksum chunk by chunk', () => {
    const data = new Uint8Array(100_000).map((_, index) => (index * 31 + 7) & 0xff);
    const whole = crc32(data);
    const chunked = crc32(data.subarray(65_536), crc32(data.subarray(0, 65_536)));
    expect(chunked).toBe(whole);
    expect(whole).toBeGreaterThan(0);
    expect(whole).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('dosDateTime', () => {
  it('packs local time with a 2 second resolution and the date from 1980', () => {
    const stamp = dosDateTime(new Date(2026, 2, 10, 15, 45, 31));
    expect(stamp.time).toBe((15 << 11) | (45 << 5) | 15);
    expect(stamp.date).toBe(((2026 - 1980) << 9) | (3 << 5) | 10);
  });

  it('never goes before 1980', () => {
    expect(dosDateTime(new Date(1970, 0, 1)).date >> 9).toBe(0);
  });
});

describe('ZipWriter', () => {
  it('writes an empty archive as just the end record', async () => {
    const blob = new ZipWriter().finish();
    expect(blob.type).toBe('application/zip');
    expect(blob.size).toBe(22);
    const zip = await parseZip(blob);
    expect(zip.entries).toEqual([]);
    expect(zip.endOffset).toBe(0);
  });

  it('stores a file with its name, size, CRC and data', async () => {
    const writer = new ZipWriter();
    await writer.add('Lamp/Lamp-image-1.jpg', text('hello zip'));
    const zip = await parseZip(writer.finish());
    expect(zip.entries).toHaveLength(1);
    const [entry] = zip.entries;
    expect(entry).toMatchObject({
      name: 'Lamp/Lamp-image-1.jpg',
      method: 0,
      flags: 0x0800,
      size: 9,
      compressedSize: 9,
      crc: crc32(text('hello zip')),
      offset: 0,
    });
    expect(asText(entry?.data ?? new Uint8Array())).toBe('hello zip');
  });

  it('lays the entries out one after the other, each local header at the offset the directory names', async () => {
    const writer = new ZipWriter();
    await writer.add('a/one.txt', text('1'));
    await writer.add('b/two.txt', text('22'));
    await writer.add('b/empty.txt', text(''));
    const zip = await parseZip(writer.finish());
    expect(zip.entries.map((entry) => entry.name)).toEqual(['a/one.txt', 'b/two.txt', 'b/empty.txt']);
    // 30 byte header + name + data
    expect(zip.entries.map((entry) => entry.offset)).toEqual([0, 30 + 9 + 1, 40 + 30 + 9 + 2]);
    expect(zip.entries.map((entry) => asText(entry.data))).toEqual(['1', '22', '']);
    expect(zip.entries[2]).toMatchObject({ size: 0, crc: 0 });
    expect(zip.directoryOffset).toBe(40 + 41 + 41);
    expect(writer.fileCount).toBe(3);
  });

  it('reads blobs, also bigger than 64 KB, in chunks and records the right CRC and size', async () => {
    const big = new Uint8Array(200_000).map((_, index) => (index * 13 + 5) & 0xff);
    const writer = new ZipWriter();
    await writer.add('media/big.mp4', new Blob([big.subarray(0, 70_000), big.subarray(70_000)]));
    await writer.add('media/small.jpg', new Blob([text('small')]));
    const zip = await parseZip(writer.finish());
    const [first, second] = zip.entries;
    expect(first?.size).toBe(200_000);
    expect(first?.crc).toBe(crc32(big));
    expect(first?.data).toEqual(big);
    expect(second?.offset).toBe(30 + 'media/big.mp4'.length + 200_000);
    expect(asText(second?.data ?? new Uint8Array())).toBe('small');
  });

  it('names files in UTF-8 and says so in the flags', async () => {
    const writer = new ZipWriter();
    await writer.add('Café/日本語-1.jpg', text('x'));
    await writer.add('Ünïcode/emoji-\u{1F600}.png', text('y'));
    const zip = await parseZip(writer.finish());
    expect(zip.entries.map((entry) => entry.name)).toEqual(['Café/日本語-1.jpg', 'Ünïcode/emoji-\u{1F600}.png']);
    expect(zip.entries.every((entry) => (entry.flags & 0x0800) !== 0)).toBe(true);
  });

  it('rejects two files with the same path', async () => {
    const writer = new ZipWriter();
    await writer.add('a/x.jpg', text('1'));
    expect(await reason(writer.add('a/x.jpg', text('2')))).toBe('duplicate_name');
    expect(writer.fileCount).toBe(1);
    // The same file name in another folder is fine.
    await writer.add('b/x.jpg', text('3'));
    expect((await parseZip(writer.finish())).entries).toHaveLength(2);
  });

  it('rejects names that could escape the extraction folder', async () => {
    const writer = new ZipWriter();
    for (const name of ['', '/etc/passwd', '../x.jpg', 'a/../../x.jpg', 'a//b.jpg', './x.jpg', 'a\\b.jpg', 'dir/']) {
      expect(await reason(writer.add(name, text('x')))).toBe('invalid_name');
    }
    expect(writer.fileCount).toBe(0);
  });

  it('refuses more than 65535 files', async () => {
    const writer = new ZipWriter();
    const empty = new Uint8Array(0);
    for (let index = 0; index < ZIP_MAX_FILES; index += 1) await writer.add(`f/${index}`, empty);
    expect(writer.fileCount).toBe(ZIP_MAX_FILES);
    expect(await reason(writer.add('f/one-too-many', empty))).toBe('too_many_files');
    const zip = await parseZip(writer.finish());
    expect(zip.entries).toHaveLength(ZIP_MAX_FILES);
  });

  it('refuses files beyond 3.5 GB in all with a clear message', async () => {
    const writer = new ZipWriter();
    await writer.add('a/small.jpg', text('x'));
    const error = await writer.add('a/huge.mp4', new HugeBlob()).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ZipError);
    expect((error as ZipError).reason).toBe('too_large');
    expect((error as ZipError).message).toMatch(/3\.5 GB/);
    // The rejected file left no trace: the archive is still valid.
    const zip = await parseZip(writer.finish());
    expect(zip.entries.map((entry) => entry.name)).toEqual(['a/small.jpg']);
  });
});
