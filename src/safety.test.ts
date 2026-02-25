import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { TrackedMention } from './helpers.js';
import { formatMentionsText, formatMessagesText, sanitizeAndFormat } from './index.js';
import { sanitize } from './safety-client.js';

function setMockFetch(
  t: TestContext,
  impl: typeof fetch
): void {
  const originalFetch = global.fetch;
  global.fetch = impl;
  t.after(() => {
    global.fetch = originalFetch;
  });
}

test('sanitize() sends correct request to /sanitize endpoint', async (t) => {
  let capturedUrl: string | undefined;
  let capturedBody: unknown;

  setMockFetch(t, async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;

    return new Response(JSON.stringify({ ok: true, data: { posts: [] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  await sanitize({
    content: 'test',
    schema: 'socialFeedBatch',
    context: 'test',
    source: 'test:source',
  });

  assert.equal(capturedUrl, 'http://safety-sidecar:3100/sanitize');
  assert.deepEqual(capturedBody, {
    content: 'test',
    schema: 'socialFeedBatch',
    context: 'test',
    source: 'test:source',
  });
});

test('sanitize() returns data on success', async (t) => {
  setMockFetch(t, async () =>
    new Response(JSON.stringify({ ok: true, data: { posts: [] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );

  const result = await sanitize({
    content: 'test',
    schema: 'socialFeedBatch',
    context: 'test',
    source: 'test:source',
  });

  assert.deepEqual(result, { ok: true, data: { posts: [] } });
});

test('sanitize() returns error on sidecar failure', async (t) => {
  setMockFetch(t, async () =>
    new Response(JSON.stringify({ ok: false, error: 'integrity check failed' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );

  const result = await sanitize({
    content: 'test',
    schema: 'socialFeedBatch',
    context: 'test',
    source: 'test:source',
  });

  assert.deepEqual(result, { ok: false, error: 'integrity check failed' });
});

test('sanitize() returns error when sidecar is unreachable', async (t) => {
  setMockFetch(t, async () => {
    throw new Error('ECONNREFUSED');
  });

  const result = await sanitize({
    content: 'test',
    schema: 'socialFeedBatch',
    context: 'test',
    source: 'test:source',
  });

  assert.deepEqual(result, {
    ok: false,
    error: 'Safety sidecar unreachable: ECONNREFUSED',
  });
});

test('formatMessagesText() formats messages correctly', () => {
  const messages = [
    {
      author: { username: 'alice' },
      content: 'Hello everyone',
      createdAt: new Date('2026-02-25T10:00:00.000Z'),
      attachments: new Map<string, { name: string | null; contentType: string | null }>(),
    },
    {
      author: { username: 'bob' },
      content: 'Hey alice! Check this out',
      createdAt: new Date('2026-02-25T10:01:00.000Z'),
      attachments: new Map<string, { name: string | null; contentType: string | null }>(),
    },
  ];

  const output = formatMessagesText(messages);

  assert.equal(
    output,
    '[2026-02-25T10:00:00.000Z] alice: Hello everyone\n[2026-02-25T10:01:00.000Z] bob: Hey alice! Check this out'
  );
});

test('formatMessagesText() returns empty string for empty array', () => {
  assert.equal(formatMessagesText([]), '');
});

test('formatMessagesText() includes attachment info', () => {
  const messages = [
    {
      author: { username: 'bob' },
      content: 'Check this image',
      createdAt: new Date('2026-02-25T10:01:00.000Z'),
      attachments: new Map<string, { name: string | null; contentType: string | null }>([
        ['1', { name: 'image.png', contentType: 'image/png' }],
      ]),
    },
  ];

  const output = formatMessagesText(messages);

  assert.equal(
    output,
    '[2026-02-25T10:01:00.000Z] bob: Check this image\n  Attachment: image.png (image/png)'
  );
});

test('formatMentionsText() formats mentions correctly', () => {
  const mentions: TrackedMention[] = [
    {
      messageId: '1',
      channelId: '10',
      channelName: 'general',
      author: 'alice',
      content: 'Hey bot',
      timestamp: Date.parse('2026-02-25T10:00:00.000Z'),
    },
    {
      messageId: '2',
      channelId: '11',
      channelName: 'cael',
      author: 'bob',
      content: 'Need help',
      timestamp: Date.parse('2026-02-25T10:01:00.000Z'),
    },
  ];

  const output = formatMentionsText(mentions);

  assert.equal(
    output,
    '[2026-02-25T10:00:00.000Z] alice in #general: Hey bot\n[2026-02-25T10:01:00.000Z] bob in #cael: Need help'
  );
});

test('formatMentionsText() returns empty string for empty array', () => {
  assert.equal(formatMentionsText([]), '');
});

test('sanitizeAndFormat() returns sanitized data on success', async (t) => {
  const sidecarData = { posts: [] };
  setMockFetch(t, async () =>
    new Response(JSON.stringify({ ok: true, data: sidecarData }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );

  const result = await sanitizeAndFormat({
    content: 'raw',
    schema: 'socialFeedBatch',
    context: 'ctx',
    source: 'source',
  });

  assert.deepEqual(result, {
    content: [{ type: 'text', text: JSON.stringify(sidecarData) }],
  });
});

test('sanitizeAndFormat() returns error text when sidecar returns error', async (t) => {
  setMockFetch(t, async () =>
    new Response(JSON.stringify({ ok: false, error: 'blocked' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );

  const result = await sanitizeAndFormat({
    content: 'raw',
    schema: 'socialFeedBatch',
    context: 'ctx',
    source: 'source',
  });

  assert.deepEqual(result, {
    content: [{ type: 'text', text: '[Safety: blocked]' }],
    isError: true,
  });
});

test('sanitizeAndFormat() returns error when sidecar unreachable', async (t) => {
  setMockFetch(t, async () => {
    throw new Error('ECONNREFUSED');
  });

  const result = await sanitizeAndFormat({
    content: 'raw',
    schema: 'socialFeedBatch',
    context: 'ctx',
    source: 'source',
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /^\[Safety: Safety sidecar unreachable: /);
});

test('fail-closed: raw content never returned on sidecar failure', async (t) => {
  setMockFetch(t, async () => {
    throw new Error('ECONNREFUSED');
  });

  const result = await sanitizeAndFormat({
    content: 'SECRET_RAW_CONTENT',
    schema: 'socialFeedBatch',
    context: 'ctx',
    source: 'source',
  });

  assert.equal(result.isError, true);
  assert.equal((result.content[0]?.text ?? '').includes('SECRET_RAW_CONTENT'), false);
});
