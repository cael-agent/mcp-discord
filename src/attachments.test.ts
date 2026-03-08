import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';

import {
  ALLOWED_HOSTS,
  MAX_FILE_SIZE,
  cleanupOldFiles,
  downloadAttachments,
  formatFileSize,
  isImageFile,
  isSupportedType,
  sanitizeFilename,
  validateMagicBytes,
  validateUrl,
} from './attachments.js';

function setMockFetch(t: TestContext, impl: typeof fetch): void {
  const originalFetch = global.fetch;
  global.fetch = impl;
  t.after(() => {
    global.fetch = originalFetch;
  });
}

async function makeTempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'attachments-test-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const CDN_BASE = 'https://cdn.discordapp.com/attachments/123/456';

// --- isSupportedType ---

test('isSupportedType() handles content-type and extension fallback', () => {
  const cases: Array<{
    contentType: string;
    filename: string;
    expected: boolean;
  }> = [
    { contentType: 'text/markdown', filename: 'README.md', expected: true },
    { contentType: 'text/plain', filename: 'notes.txt', expected: true },
    { contentType: 'image/png', filename: 'image.bin', expected: true },
    { contentType: 'application/pdf', filename: 'doc.pdf', expected: true },
    { contentType: 'application/zip', filename: 'archive.zip', expected: false },
    { contentType: 'application/octet-stream', filename: 'fallback.md', expected: true },
    { contentType: 'application/octet-stream', filename: 'program.exe', expected: false },
    { contentType: '', filename: 'data.json', expected: true },
    { contentType: '', filename: 'README', expected: false },
  ];

  for (const entry of cases) {
    assert.equal(
      isSupportedType(entry.contentType, entry.filename),
      entry.expected,
      `${entry.contentType} + ${entry.filename}`
    );
  }
});

test('isSupportedType() rejects SVG by content type', () => {
  assert.equal(isSupportedType('image/svg+xml', 'icon.svg'), false);
});

test('isSupportedType() rejects SVG by extension', () => {
  assert.equal(isSupportedType('application/octet-stream', 'icon.svg'), false);
});

// --- isImageFile ---

test('isImageFile() identifies image files', () => {
  assert.equal(isImageFile('photo.png', 'image/png'), true);
  assert.equal(isImageFile('photo.jpg', 'image/jpeg'), true);
  assert.equal(isImageFile('anim.gif', 'image/gif'), true);
  assert.equal(isImageFile('pic.webp', 'image/webp'), true);
  assert.equal(isImageFile('pic.bmp', 'image/bmp'), true);
});

test('isImageFile() rejects non-image files', () => {
  assert.equal(isImageFile('doc.txt', 'text/plain'), false);
  assert.equal(isImageFile('doc.pdf', 'application/pdf'), false);
});

test('isImageFile() rejects SVG', () => {
  assert.equal(isImageFile('icon.svg', 'image/svg+xml'), false);
  assert.equal(isImageFile('icon.svg', 'application/octet-stream'), false);
});

// --- sanitizeFilename ---

test('sanitizeFilename() normal filename passes through', () => {
  assert.equal(sanitizeFilename('report.pdf'), 'report.pdf');
});

test('sanitizeFilename() strips path traversal and separators', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'etcpasswd');
});

test('sanitizeFilename() strips null bytes', () => {
  assert.equal(sanitizeFilename('bad\0name.txt'), 'badname.txt');
});

test('sanitizeFilename() strips control characters', () => {
  assert.equal(sanitizeFilename('line\nbreak\tname.txt'), 'linebreakname.txt');
});

test('sanitizeFilename() returns unnamed when empty after sanitization', () => {
  assert.equal(sanitizeFilename('\0\x01\x02'), 'unnamed');
});

test('sanitizeFilename() truncates long names while preserving extension', () => {
  const input = `${'a'.repeat(250)}.json`;
  const output = sanitizeFilename(input);

  assert.equal(output.length, 200);
  assert.equal(output.endsWith('.json'), true);
});

test('sanitizeFilename() preserves unicode', () => {
  assert.equal(sanitizeFilename('日本語.txt'), '日本語.txt');
});

// --- formatFileSize ---

test('formatFileSize() formats bytes, KB, and MB', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(500), '500 B');
  assert.equal(formatFileSize(1024), '1.0 KB');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(1048576), '1.0 MB');
  assert.equal(formatFileSize(26214400), '25.0 MB');
});

// --- validateUrl ---

test('validateUrl() accepts Discord CDN hosts', () => {
  for (const host of ALLOWED_HOSTS) {
    assert.doesNotThrow(() => validateUrl(`https://${host}/attachments/123/456/file.png`));
  }
});

test('validateUrl() rejects non-Discord hosts', () => {
  assert.throws(
    () => validateUrl('https://evil.com/payload.png'),
    /not an allowed Discord CDN host/
  );
});

test('validateUrl() rejects malformed URLs', () => {
  assert.throws(() => validateUrl('not-a-url'));
});

// --- validateMagicBytes ---

test('validateMagicBytes() accepts valid PNG header', () => {
  const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  assert.doesNotThrow(() => validateMagicBytes(buffer, 'image/png'));
});

test('validateMagicBytes() accepts valid JPEG header', () => {
  const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  assert.doesNotThrow(() => validateMagicBytes(buffer, 'image/jpeg'));
});

test('validateMagicBytes() accepts valid GIF header', () => {
  const buffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  assert.doesNotThrow(() => validateMagicBytes(buffer, 'image/gif'));
});

test('validateMagicBytes() accepts valid WebP header', () => {
  const buffer = Buffer.alloc(16);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(100, 4);
  buffer.write('WEBP', 8);
  assert.doesNotThrow(() => validateMagicBytes(buffer, 'image/webp'));
});

test('validateMagicBytes() accepts valid BMP header', () => {
  const buffer = Buffer.from([0x42, 0x4d, 0x00, 0x00]);
  assert.doesNotThrow(() => validateMagicBytes(buffer, 'image/bmp'));
});

test('validateMagicBytes() rejects mismatched PNG header', () => {
  const buffer = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.throws(
    () => validateMagicBytes(buffer, 'image/png'),
    /file header does not match claimed type/
  );
});

test('validateMagicBytes() rejects buffer too small for type', () => {
  const buffer = Buffer.from([0x89, 0x50]);
  assert.throws(
    () => validateMagicBytes(buffer, 'image/png'),
    /file header does not match claimed type/
  );
});

test('validateMagicBytes() skips unknown content types', () => {
  const buffer = Buffer.from([0x00, 0x01, 0x02]);
  assert.doesNotThrow(() => validateMagicBytes(buffer, 'text/plain'));
  assert.doesNotThrow(() => validateMagicBytes(buffer, 'application/pdf'));
});

// --- cleanupOldFiles ---

test('cleanupOldFiles() deletes files older than max age', async (t) => {
  const dir = await makeTempDir(t);

  const oldFile = path.join(dir, 'old-file.png');
  const newFile = path.join(dir, 'new-file.png');
  await writeFile(oldFile, 'old');
  await writeFile(newFile, 'new');

  // Set old file's mtime to 8 days ago
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(oldFile, eightDaysAgo, eightDaysAgo);

  const deleted = await cleanupOldFiles(dir, 7 * 24 * 60 * 60 * 1000);
  assert.equal(deleted, 1);

  // Old file should be gone, new file should remain
  await assert.rejects(() => readFile(oldFile), { code: 'ENOENT' });
  const content = await readFile(newFile, 'utf8');
  assert.equal(content, 'new');
});

test('cleanupOldFiles() skips dotfiles', async (t) => {
  const dir = await makeTempDir(t);

  const dotFile = path.join(dir, '.tmp-something');
  await writeFile(dotFile, 'temp');
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(dotFile, eightDaysAgo, eightDaysAgo);

  const deleted = await cleanupOldFiles(dir, 7 * 24 * 60 * 60 * 1000);
  assert.equal(deleted, 0);
});

test('cleanupOldFiles() handles non-existent directory', async () => {
  const deleted = await cleanupOldFiles('/tmp/nonexistent-dir-' + Date.now());
  assert.equal(deleted, 0);
});

// --- downloadAttachments ---

test('downloadAttachments() downloads text file and includes textContent', async (t) => {
  const attachmentsDir = await makeTempDir(t);

  setMockFetch(t, async () =>
    new Response('hello from attachment', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })
  );

  const [result] = await downloadAttachments({
    messageId: 'm1',
    attachments: [
      {
        url: `${CDN_BASE}/note.md`,
        filename: 'note.md',
        contentType: 'text/markdown',
        size: 21,
      },
    ],
    attachmentsDir,
  });

  assert.ok(result);
  assert.equal(result.downloaded, true);
  assert.equal(result.localPath, path.join(attachmentsDir, 'm1-note.md'));
  assert.equal(result.textContent, 'hello from attachment');
  assert.equal(result.isImage, false);

  const written = await readFile(result.localPath, 'utf8');
  assert.equal(written, 'hello from attachment');
});

test('downloadAttachments() skips unsupported file types', async (t) => {
  const attachmentsDir = await makeTempDir(t);
  let called = false;

  setMockFetch(t, async () => {
    called = true;
    throw new Error('fetch should not be called');
  });

  const [result] = await downloadAttachments({
    messageId: 'm2',
    attachments: [
      {
        url: `${CDN_BASE}/archive.zip`,
        filename: 'archive.zip',
        contentType: 'application/zip',
        size: 100,
      },
    ],
    attachmentsDir,
  });

  assert.ok(result);
  assert.equal(called, false);
  assert.equal(result.downloaded, false);
  assert.equal(result.reason, 'unsupported file type: application/zip');
  assert.equal(result.localPath, '');
});

test('downloadAttachments() skips oversized files', async (t) => {
  const attachmentsDir = await makeTempDir(t);
  let called = false;

  setMockFetch(t, async () => {
    called = true;
    throw new Error('fetch should not be called');
  });

  const [result] = await downloadAttachments({
    messageId: 'm3',
    attachments: [
      {
        url: `${CDN_BASE}/big.txt`,
        filename: 'big.txt',
        contentType: 'text/plain',
        size: MAX_FILE_SIZE + 1,
      },
    ],
    attachmentsDir,
  });

  assert.ok(result);
  assert.equal(called, false);
  assert.equal(result.downloaded, false);
  assert.equal(result.reason, 'exceeds 25 MB size limit');
});

test('downloadAttachments() handles network errors', async (t) => {
  const attachmentsDir = await makeTempDir(t);

  setMockFetch(t, async () => {
    throw new Error('network unreachable');
  });

  const [result] = await downloadAttachments({
    messageId: 'm4',
    attachments: [
      {
        url: `${CDN_BASE}/file.txt`,
        filename: 'file.txt',
        contentType: 'text/plain',
        size: 10,
      },
    ],
    attachmentsDir,
  });

  assert.ok(result);
  assert.equal(result.downloaded, false);
  assert.equal(result.reason, 'download failed: network unreachable');
  assert.equal(result.localPath, '');
});

test('downloadAttachments() handles mixed success and skips', async (t) => {
  const attachmentsDir = await makeTempDir(t);
  let fetchCalls = 0;

  setMockFetch(t, async () => {
    fetchCalls += 1;
    return new Response('ok file', { status: 200 });
  });

  const results = await downloadAttachments({
    messageId: 'm5',
    attachments: [
      {
        url: `${CDN_BASE}/ok.txt`,
        filename: 'ok.txt',
        contentType: 'text/plain',
        size: 7,
      },
      {
        url: `${CDN_BASE}/skip.zip`,
        filename: 'skip.zip',
        contentType: 'application/zip',
        size: 100,
      },
      {
        url: `${CDN_BASE}/too-big.txt`,
        filename: 'too-big.txt',
        contentType: 'text/plain',
        size: MAX_FILE_SIZE + 2,
      },
    ],
    attachmentsDir,
  });

  assert.equal(fetchCalls, 1);
  assert.equal(results.length, 3);
  assert.equal(results[0]?.downloaded, true);
  assert.equal(results[1]?.downloaded, false);
  assert.equal(results[1]?.reason, 'unsupported file type: application/zip');
  assert.equal(results[2]?.downloaded, false);
  assert.equal(results[2]?.reason, 'exceeds 25 MB size limit');
});

test('downloadAttachments() handles filename collisions with numeric suffixes', async (t) => {
  const attachmentsDir = await makeTempDir(t);
  const payloads = ['first file', 'second file'];

  setMockFetch(t, async () =>
    new Response(payloads.shift() ?? '', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })
  );

  const results = await downloadAttachments({
    messageId: 'm6',
    attachments: [
      {
        url: `${CDN_BASE}/dup-1.txt`,
        filename: 'dup.txt',
        contentType: 'text/plain',
        size: 10,
      },
      {
        url: `${CDN_BASE}/dup-2.txt`,
        filename: 'dup.txt',
        contentType: 'text/plain',
        size: 11,
      },
    ],
    attachmentsDir,
  });

  assert.equal(results.length, 2);
  assert.equal(results[0]?.downloaded, true);
  assert.equal(results[1]?.downloaded, true);
  assert.equal(path.basename(results[0]?.localPath ?? ''), 'm6-dup.txt');
  assert.equal(path.basename(results[1]?.localPath ?? ''), 'm6-dup-2.txt');

  const first = await readFile(results[0]!.localPath, 'utf8');
  const second = await readFile(results[1]!.localPath, 'utf8');
  assert.equal(first, 'first file');
  assert.equal(second, 'second file');
});

// --- URL validation in download pipeline ---

test('downloadAttachments() rejects non-Discord CDN URLs', async (t) => {
  const attachmentsDir = await makeTempDir(t);

  setMockFetch(t, async () => {
    throw new Error('fetch should not be called');
  });

  const [result] = await downloadAttachments({
    messageId: 'm7',
    attachments: [
      {
        url: 'https://evil.com/payload.txt',
        filename: 'payload.txt',
        contentType: 'text/plain',
        size: 10,
      },
    ],
    attachmentsDir,
  });

  assert.ok(result);
  assert.equal(result.downloaded, false);
  assert.ok(result.reason?.includes('not an allowed Discord CDN host'));
});

// --- SVG rejection in download pipeline ---

test('downloadAttachments() rejects SVG files', async (t) => {
  const attachmentsDir = await makeTempDir(t);

  const [result] = await downloadAttachments({
    messageId: 'm8',
    attachments: [
      {
        url: `${CDN_BASE}/icon.svg`,
        filename: 'icon.svg',
        contentType: 'image/svg+xml',
        size: 100,
      },
    ],
    attachmentsDir,
  });

  assert.ok(result);
  assert.equal(result.downloaded, false);
  assert.equal(result.reason, 'unsupported file type: image/svg+xml');
});

// --- Actual download size verification ---

test('downloadAttachments() rejects when actual download exceeds size limit', async (t) => {
  const attachmentsDir = await makeTempDir(t);

  // Metadata says 10 bytes, but actual download is over 25 MB
  const bigBuffer = Buffer.alloc(MAX_FILE_SIZE + 1, 'x');
  setMockFetch(t, async () =>
    new Response(new Uint8Array(bigBuffer), { status: 200, headers: { 'Content-Type': 'text/plain' } })
  );

  const [result] = await downloadAttachments({
    messageId: 'm9',
    attachments: [
      {
        url: `${CDN_BASE}/sneaky.txt`,
        filename: 'sneaky.txt',
        contentType: 'text/plain',
        size: 10,
      },
    ],
    attachmentsDir,
  });

  assert.ok(result);
  assert.equal(result.downloaded, false);
  assert.ok(result.reason?.includes('actual download size exceeds 25 MB limit'));
});

// --- Magic byte validation in download pipeline ---

test('downloadAttachments() rejects image with mismatched magic bytes', async (t) => {
  const attachmentsDir = await makeTempDir(t);

  // Claim PNG content type but send JPEG-like data
  const fakeBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  setMockFetch(t, async () =>
    new Response(new Uint8Array(fakeBuffer), { status: 200, headers: { 'Content-Type': 'image/png' } })
  );

  const [result] = await downloadAttachments({
    messageId: 'm10',
    attachments: [
      {
        url: `${CDN_BASE}/fake.png`,
        filename: 'fake.png',
        contentType: 'image/png',
        size: fakeBuffer.length,
      },
    ],
    attachmentsDir,
  });

  assert.ok(result);
  assert.equal(result.downloaded, false);
  assert.ok(result.reason?.includes('file header does not match claimed type'));
});

// --- Image download with sharp processing ---

test('downloadAttachments() processes images with sharp and sets isImage', async (t) => {
  const attachmentsDir = await makeTempDir(t);

  // Create a valid 2x2 PNG via sharp
  const pngBuffer = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();

  setMockFetch(t, async () =>
    new Response(new Uint8Array(pngBuffer), { status: 200, headers: { 'Content-Type': 'image/png' } })
  );

  const [result] = await downloadAttachments({
    messageId: 'm11',
    attachments: [
      {
        url: `${CDN_BASE}/photo.png`,
        filename: 'photo.png',
        contentType: 'image/png',
        size: pngBuffer.length,
      },
    ],
    attachmentsDir,
  });

  assert.ok(result);
  assert.equal(result.downloaded, true);
  assert.equal(result.isImage, true);
  assert.equal(result.textContent, undefined);

  // Verify the saved file is a valid image
  const savedBuffer = await readFile(result.localPath);
  const metadata = await sharp(savedBuffer).metadata();
  assert.ok(metadata.width);
  assert.ok(metadata.height);
});

test('downloadAttachments() resizes large images to max dimension', async (t) => {
  const attachmentsDir = await makeTempDir(t);

  // Create a 2000x1000 PNG
  const largePng = await sharp({
    create: { width: 2000, height: 1000, channels: 3, background: { r: 0, g: 128, b: 255 } },
  })
    .png()
    .toBuffer();

  setMockFetch(t, async () =>
    new Response(new Uint8Array(largePng), { status: 200, headers: { 'Content-Type': 'image/png' } })
  );

  const [result] = await downloadAttachments({
    messageId: 'm12',
    attachments: [
      {
        url: `${CDN_BASE}/big-photo.png`,
        filename: 'big-photo.png',
        contentType: 'image/png',
        size: largePng.length,
      },
    ],
    attachmentsDir,
  });

  assert.ok(result);
  assert.equal(result.downloaded, true);

  const savedBuffer = await readFile(result.localPath);
  const metadata = await sharp(savedBuffer).metadata();
  assert.ok(metadata.width! <= 1024, `width ${metadata.width} should be <= 1024`);
  assert.ok(metadata.height! <= 1024, `height ${metadata.height} should be <= 1024`);
});
