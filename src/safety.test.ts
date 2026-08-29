import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { Response } from 'undici';

import type { TrackedMention } from './helpers.js';
import { formatMentionsText, formatMessagesText, sanitizeAndFormat } from './index.js';
import { __setSidecarFetchForTests, sanitize } from './safety-client.js';

// safety-client.ts calls undici's `fetch`, which lives in a different realm from
// globalThis.fetch: reassigning the global does not intercept it. Swap the
// module's own transport seam instead, and always restore it afterwards.
function setMockFetch(
  t: TestContext,
  impl: Parameters<typeof __setSidecarFetchForTests>[0]
): void {
  const restore = __setSidecarFetchForTests(impl);
  t.after(() => {
    restore();
  });
}

function freezeNow(t: TestContext): void {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-02-27T12:00:00.000Z'),
  });
  t.after(() => t.mock.timers.reset());
}

test('sanitize() sends correct request to /sanitize endpoint', async (t) => {
  let capturedUrl: string | undefined;
  let capturedBody: unknown;

  setMockFetch(t, async (url, init) => {
    capturedUrl = typeof url === 'string' ? url : 'href' in url ? url.href : url.url;
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
    throw Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 172.18.0.2:3100'), { code: 'ECONNREFUSED' }),
    });
  });

  const result = await sanitize({
    content: 'test',
    schema: 'socialFeedBatch',
    context: 'test',
    source: 'test:source',
  });

  assert.deepEqual(result, {
    ok: false,
    error: 'Safety sidecar unreachable (ECONNREFUSED): fetch failed',
  });
});

test('formatMessagesText() formats messages correctly', (t) => {
  freezeNow(t);

  const messages = [
    {
      id: '1',
      author: { username: 'alice' },
      content: 'Hello everyone',
      createdAt: new Date('2026-02-25T10:00:00.000Z'),
      attachments: new Map<string, { name: string | null; contentType: string | null; size?: number }>(),
    },
    {
      id: '2',
      author: { username: 'bob' },
      content: 'Hey alice! Check this out',
      createdAt: new Date('2026-02-25T10:01:00.000Z'),
      attachments: new Map<string, { name: string | null; contentType: string | null; size?: number }>(),
    },
  ];

  const output = formatMessagesText(messages);

  assert.equal(
    output,
    '[2d ago] [msg:1] alice: Hello everyone\n[2d ago] [msg:2] bob: Hey alice! Check this out'
  );
});

test('formatMessagesText() returns empty string for empty array', () => {
  assert.equal(formatMessagesText([]), '');
});

test('formatMessagesText() includes attachment info', (t) => {
  freezeNow(t);

  const messages = [
    {
      id: '2',
      author: { username: 'bob' },
      content: 'Check this image',
      createdAt: new Date('2026-02-25T10:01:00.000Z'),
      attachments: new Map<string, { name: string | null; contentType: string | null; size?: number }>([
        ['1', { name: 'image.png', contentType: 'image/png', size: 12345 }],
      ]),
    },
  ];

  const output = formatMessagesText(messages);

  assert.equal(
    output,
    '[2d ago] [msg:2] bob: Check this image\n  Attachment: image.png (image/png, 12.1 KB)'
  );
});

test('formatMentionsText() formats mentions correctly', (t) => {
  freezeNow(t);

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
    '[2d ago] alice in #general: Hey bot\n[2d ago] bob in #cael: Need help'
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
    throw Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 172.18.0.2:3100'), { code: 'ECONNREFUSED' }),
    });
  });

  const result = await sanitizeAndFormat({
    content: 'raw',
    schema: 'socialFeedBatch',
    context: 'ctx',
    source: 'source',
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /^\[Safety: Safety sidecar unreachable \(ECONNREFUSED\): /);
});

test('fail-closed: raw content never returned on sidecar failure', async (t) => {
  setMockFetch(t, async () => {
    throw Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 172.18.0.2:3100'), { code: 'ECONNREFUSED' }),
    });
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
