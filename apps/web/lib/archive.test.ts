import { describe, expect, it } from 'vitest';
import {
  archiveFileName,
  archiveFolderName,
  batchArchiveName,
  planArchive,
  productArchiveName,
  uniqueName,
} from './archive';

describe('archiveFolderName', () => {
  it('turns a title into a safe folder name', () => {
    expect(archiveFolderName('Linen camp-collar shirt')).toBe('Linen-camp-collar-shirt');
    expect(archiveFolderName('Mug (set of 2) / blue!')).toBe('Mug-set-of-2-blue');
    expect(archiveFolderName('  Spaced   out  ')).toBe('Spaced-out');
  });

  it('keeps letters of any script and accents', () => {
    expect(archiveFolderName('Crème brûlée')).toBe('Crème-brûlée');
    expect(archiveFolderName('日本語 バッグ')).toBe('日本語-バッグ');
  });

  it('cannot climb out of the archive or hide', () => {
    expect(archiveFolderName('../../etc/passwd')).toBe('etc-passwd');
    expect(archiveFolderName('..')).toBe('product');
    expect(archiveFolderName('.hidden')).toBe('hidden');
    expect(archiveFolderName('C:\\Windows\\System32')).toBe('C-Windows-System32');
    expect(archiveFolderName('a/b\\c')).toBe('a-b-c');
    expect(archiveFolderName('a..b')).toBe('a.b');
    for (const title of ['../x', '/abs', '.dot', 'a/../b', '\\\\server\\share']) {
      const name = archiveFolderName(title);
      expect(name).not.toMatch(/[/\\]/);
      expect(name.startsWith('.')).toBe(false);
      expect(name).not.toBe('..');
    }
  });

  it('drops a trailing dot or dash and avoids names Windows reserves', () => {
    expect(archiveFolderName('Shirt.')).toBe('Shirt');
    expect(archiveFolderName('Shirt - ')).toBe('Shirt');
    expect(archiveFolderName('CON')).toBe('_CON');
    expect(archiveFolderName('nul')).toBe('_nul');
    expect(archiveFolderName('LPT1')).toBe('_LPT1');
    expect(archiveFolderName('console')).toBe('console');
  });

  it('falls back when nothing is left, and cuts a long title at 60 characters', () => {
    expect(archiveFolderName('???')).toBe('product');
    expect(archiveFolderName('', 'product-3')).toBe('product-3');
    const long = archiveFolderName('x'.repeat(200));
    expect(long).toHaveLength(60);
    expect(archiveFolderName(`${'y'.repeat(59)}-tail`)).toBe('y'.repeat(59));
  });

  it('does not cut a character in two', () => {
    const name = archiveFolderName('\u{1F600}'.repeat(5) + 'é'.repeat(100));
    expect([...name].length).toBeLessThanOrEqual(60);
    expect(name).not.toMatch(/\uFFFD/);
  });
});

describe('uniqueName', () => {
  it('returns the name when it is free and remembers it', () => {
    const taken = new Set<string>();
    expect(uniqueName('a.jpg', taken)).toBe('a.jpg');
    expect(taken.has('a.jpg')).toBe(true);
  });

  it('numbers a name that is taken, before the extension', () => {
    const taken = new Set<string>();
    expect(['a.jpg', 'a.jpg', 'a.jpg'].map((name) => uniqueName(name, taken))).toEqual(['a.jpg', 'a-2.jpg', 'a-3.jpg']);
  });

  it('compares case-insensitively, as Windows and macOS do', () => {
    const taken = new Set<string>();
    expect(uniqueName('Mug.JPG', taken)).toBe('Mug.JPG');
    expect(uniqueName('mug.jpg', taken)).toBe('mug-2.jpg');
  });

  it('treats a dot in a folder name as part of the name', () => {
    const taken = new Set<string>();
    expect(uniqueName('v2.0', taken, { extension: false })).toBe('v2.0');
    expect(uniqueName('v2.0', taken, { extension: false })).toBe('v2.0-2');
  });

  it('numbers a name without an extension', () => {
    const taken = new Set<string>();
    expect([uniqueName('file', taken), uniqueName('file', taken)]).toEqual(['file', 'file-2']);
  });
});

describe('planArchive', () => {
  const file = (filename: string) => ({ url: `https://cdn.shopify.com/${filename}`, filename });

  it('puts the files of each product in a folder named after it', () => {
    const plan = planArchive([
      { title: 'Linen shirt', files: [file('shirt-1.jpg'), file('shirt-2.mp4')] },
      { title: 'Tote bag', files: [file('tote-1.jpg')] },
    ]);
    expect(plan.map((entry) => entry.path)).toEqual([
      'Linen-shirt/shirt-1.jpg',
      'Linen-shirt/shirt-2.mp4',
      'Tote-bag/tote-1.jpg',
    ]);
    expect(plan[0]?.url).toBe('https://cdn.shopify.com/shirt-1.jpg');
  });

  it('numbers folders of products with the same title and files with the same name', () => {
    const plan = planArchive([
      { title: 'Mug', files: [file('a.jpg'), file('a.jpg')] },
      { title: 'mug', files: [file('a.jpg')] },
    ]);
    expect(plan.map((entry) => entry.path)).toEqual(['Mug/a.jpg', 'Mug/a-2.jpg', 'mug-2/a.jpg']);
  });

  it('makes every path unique and safe, whatever the names', () => {
    const plan = planArchive([
      { title: '../..', files: [file('../evil.jpg'), file('.hidden'), file('dir/inner.jpg'), file('')] },
      { title: '..', files: [file('x.jpg')] },
      { title: '', files: [file('x.jpg')] },
    ]);
    const paths = plan.map((entry) => entry.path);
    expect(new Set(paths.map((path) => path.toLowerCase())).size).toBe(paths.length);
    for (const path of paths) {
      expect(path.split('/')).toHaveLength(2);
      expect(path).not.toMatch(/\.\.|\\|^\/|^\./);
      expect(path.split('/').every((part) => part !== '' && !part.startsWith('.'))).toBe(true);
    }
  });

  it('leaves out products without files and numbers the fallback folder by position', () => {
    const plan = planArchive([
      { title: 'Empty', files: [] },
      { title: '???', files: [file('a.jpg')] },
    ]);
    expect(plan.map((entry) => entry.path)).toEqual(['product-2/a.jpg']);
    expect(planArchive([])).toEqual([]);
  });
});

describe('archive names', () => {
  it('names the batch zip after the first 6 characters of its id', () => {
    expect(batchArchiveName('65f1c0a9b2d3e4f5a6b7c8d9')).toBe('retailer-studio-b7c8d9.zip');
    expect(batchArchiveName('abc')).toBe('retailer-studio-abc.zip');
    expect(batchArchiveName('../../x/yz')).not.toContain('/');
  });

  it('names the product zip after its title', () => {
    expect(productArchiveName('Linen camp-collar shirt')).toBe('Linen-camp-collar-shirt.zip');
    expect(productArchiveName('../../x')).toBe('x.zip');
    expect(productArchiveName('???')).toBe('product.zip');
  });

  it('reads the file name off a path', () => {
    expect(archiveFileName('Mug/Mug-image-1.jpg')).toBe('Mug-image-1.jpg');
    expect(archiveFileName('plain.jpg')).toBe('plain.jpg');
  });
});
