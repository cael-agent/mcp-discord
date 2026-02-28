import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  MAX_FILE_SIZE,
  downloadAttachments,
  formatFileSize,
  isSupportedType,
  sanitizeFilename,
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

test('formatFileSize() formats bytes, KB, and MB', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(500), '500 B');
  assert.equal(formatFileSize(1024), '1.0 KB');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(1048576), '1.0 MB');
  assert.equal(formatFileSize(26214400), '25.0 MB');
});

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
        url: 'https://example.com/note.md',
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
        url: 'https://example.com/archive.zip',
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
        url: 'https://example.com/big.txt',
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
        url: 'https://example.com/file.txt',
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
        url: 'https://example.com/ok.txt',
        filename: 'ok.txt',
        contentType: 'text/plain',
        size: 7,
      },
      {
        url: 'https://example.com/skip.zip',
        filename: 'skip.zip',
        contentType: 'application/zip',
        size: 100,
      },
      {
        url: 'https://example.com/too-big.txt',
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
        url: 'https://example.com/dup-1.txt',
        filename: 'dup.txt',
        contentType: 'text/plain',
        size: 10,
      },
      {
        url: 'https://example.com/dup-2.txt',
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
