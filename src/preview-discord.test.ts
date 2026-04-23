import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTHOR_MAX,
  DEFAULT_PER_CHANNEL_LIMIT,
  MAX_PER_CHANNEL_LIMIT,
  MAX_PREVIEW_OUTPUT_CHARS,
  MIN_PER_CHANNEL_LIMIT,
  PREVIEW_TEXT_MAX,
  buildPreviewOutput,
  formatPreviewMessage,
  isBotMessage,
  orderChannelGroups,
  truncateAuthor,
  truncatePreviewText,
  type PreviewChannelGroup,
  type PreviewMessageInput,
} from './preview-discord.js';

function makeMessage(overrides: Partial<PreviewMessageInput> = {}): PreviewMessageInput {
  return {
    id: '100000000000000001',
    authorUsername: 'james',
    authorIsBot: false,
    webhookId: null,
    content: 'hello world',
    createdAt: new Date('2026-04-23T18:58:00.000Z'),
    hasAttachments: false,
    replyToMessageId: null,
    replyToUsername: null,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<PreviewChannelGroup> = {}): PreviewChannelGroup {
  const humanMessages = overrides.humanMessages ?? [
    makeMessage({ id: '100000000000000010', content: 'first', createdAt: new Date('2026-04-23T18:55:00.000Z') }),
    makeMessage({ id: '100000000000000011', content: 'second', createdAt: new Date('2026-04-23T18:58:00.000Z') }),
  ];

  return {
    channelId: '1470158584552755220',
    channelName: 'cael',
    humanMessages,
    totalHumanNew: humanMessages.length,
    botMessageCount: 0,
    newestHumanTimestampMs: humanMessages[humanMessages.length - 1]?.createdAt.getTime() ?? 0,
    ...overrides,
  };
}

test('preview discord constants match the preview-first contract', () => {
  assert.equal(MAX_PREVIEW_OUTPUT_CHARS, 10_000);
  assert.equal(DEFAULT_PER_CHANNEL_LIMIT, 3);
  assert.equal(MAX_PER_CHANNEL_LIMIT, 10);
  assert.equal(MIN_PER_CHANNEL_LIMIT, 1);
  assert.equal(PREVIEW_TEXT_MAX, 100);
  assert.equal(AUTHOR_MAX, 16);
});

test('isBotMessage returns true for author.bot', () => {
  assert.equal(isBotMessage(makeMessage({ authorIsBot: true })), true);
});

test('isBotMessage returns true for webhook messages', () => {
  assert.equal(isBotMessage(makeMessage({ webhookId: 'webhook-1' })), true);
});

test('isBotMessage returns false for human non-webhook messages', () => {
  assert.equal(isBotMessage(makeMessage()), false);
});

test('truncatePreviewText collapses whitespace and trims', () => {
  assert.equal(
    truncatePreviewText('  line1\nline2\t\t indented   line3  ', 100),
    'line1 line2 indented line3',
  );
});

test('truncatePreviewText truncates with an ellipsis at the max length', () => {
  const raw = `  ${'x'.repeat(120)}  `;
  const result = truncatePreviewText(raw, 100);

  assert.equal(result.length, 100);
  assert.equal(result, `${'x'.repeat(99)}…`);
});

test('truncatePreviewText passes short strings through unchanged after normalization', () => {
  assert.equal(truncatePreviewText('short text', 100), 'short text');
});

test('truncatePreviewText renders placeholder for empty or whitespace-only input', () => {
  assert.equal(truncatePreviewText(' \n\t ', 100), '(no text)');
  assert.equal(truncatePreviewText('', 100), '(no text)');
});

test('truncateAuthor leaves short usernames unchanged', () => {
  assert.equal(truncateAuthor('short_name', 16), 'short_name');
});

test('truncateAuthor truncates usernames longer than 16 chars with an ellipsis', () => {
  assert.equal(truncateAuthor('abcdefghijklmnopq', 16), 'abcdefghijklmno…');
});

test('formatPreviewMessage renders a plain text line with the expected field spacing', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-04-23T19:00:00.000Z'),
  });
  t.after(() => t.mock.timers.reset());

  assert.equal(formatPreviewMessage(makeMessage()), '  2m ago  james  hello world');
});

test('formatPreviewMessage appends the attachment icon when present', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-04-23T19:00:00.000Z'),
  });
  t.after(() => t.mock.timers.reset());

  assert.equal(
    formatPreviewMessage(makeMessage({ hasAttachments: true })),
    '  2m ago  james  hello world 📎',
  );
});

test('formatPreviewMessage appends reply metadata with username when available', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-04-23T19:00:00.000Z'),
  });
  t.after(() => t.mock.timers.reset());

  assert.equal(
    formatPreviewMessage(
      makeMessage({ replyToMessageId: '100000000000000099', replyToUsername: 'paula' }),
    ),
    '  2m ago  james  hello world ↳ @paula',
  );
});

test('formatPreviewMessage appends a bare reply marker when the replied username is unavailable', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-04-23T19:00:00.000Z'),
  });
  t.after(() => t.mock.timers.reset());

  assert.equal(
    formatPreviewMessage(
      makeMessage({ replyToMessageId: '100000000000000099', replyToUsername: null }),
    ),
    '  2m ago  james  hello world ↳',
  );
});

test('formatPreviewMessage renders placeholder text when message content is empty', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-04-23T19:00:00.000Z'),
  });
  t.after(() => t.mock.timers.reset());

  assert.equal(
    formatPreviewMessage(makeMessage({ content: ' \n\t ' })),
    '  2m ago  james  (no text)',
  );
});

test('formatPreviewMessage truncates long content to 100 characters with an ellipsis', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-04-23T19:00:00.000Z'),
  });
  t.after(() => t.mock.timers.reset());

  const content = 'x'.repeat(120);

  assert.equal(
    formatPreviewMessage(makeMessage({ content })),
    `  2m ago  james  ${'x'.repeat(99)}…`,
  );
});

test('formatPreviewMessage truncates long author usernames to 16 characters with an ellipsis', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-04-23T19:00:00.000Z'),
  });
  t.after(() => t.mock.timers.reset());

  assert.equal(
    formatPreviewMessage(makeMessage({ authorUsername: 'abcdefghijklmnopq' })),
    '  2m ago  abcdefghijklmno…  hello world',
  );
});

test('formatPreviewMessage collapses internal whitespace onto a single line', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-04-23T19:00:00.000Z'),
  });
  t.after(() => t.mock.timers.reset());

  assert.equal(
    formatPreviewMessage(makeMessage({ content: 'line1\nline2\tindented' })),
    '  2m ago  james  line1 line2 indented',
  );
});

test('orderChannelGroups sorts groups by newest human message timestamp descending', () => {
  const oldest = makeGroup({
    channelName: 'general',
    newestHumanTimestampMs: 1_000,
  });
  const newest = makeGroup({
    channelName: 'cael',
    newestHumanTimestampMs: 3_000,
  });
  const middle = makeGroup({
    channelName: 'tool-requests',
    newestHumanTimestampMs: 2_000,
  });

  assert.deepEqual(
    orderChannelGroups([oldest, newest, middle]).map((group) => group.channelName),
    ['cael', 'tool-requests', 'general'],
  );
});

test('buildPreviewOutput returns the no-messages string for an empty group list', () => {
  assert.equal(buildPreviewOutput([], { maxChars: 10_000 }), 'No new Discord messages.');
});

test('buildPreviewOutput renders grouped blocks with the expected header and blank-line separators', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-04-23T19:00:00.000Z'),
  });
  t.after(() => t.mock.timers.reset());

  const first = makeGroup({
    channelName: 'cael',
    humanMessages: [
      makeMessage({ id: '1', content: 'hello there', createdAt: new Date('2026-04-23T18:58:00.000Z') }),
      makeMessage({ id: '2', authorUsername: 'paula', content: 'second line', createdAt: new Date('2026-04-23T18:59:00.000Z') }),
    ],
    totalHumanNew: 2,
    newestHumanTimestampMs: Date.parse('2026-04-23T18:59:00.000Z'),
  });
  const second = makeGroup({
    channelName: 'general',
    humanMessages: [
      makeMessage({ id: '3', content: 'ping', createdAt: new Date('2026-04-23T18:56:00.000Z') }),
      makeMessage({ id: '4', authorUsername: 'alex', content: 'pong', createdAt: new Date('2026-04-23T18:57:00.000Z') }),
    ],
    totalHumanNew: 2,
    newestHumanTimestampMs: Date.parse('2026-04-23T18:57:00.000Z'),
  });

  const expected = [
    '[Discord preview | 4 new across 2 channels]',
    '#cael (2 new)',
    '  2m ago  james  hello there',
    '  1m ago  paula  second line',
    '',
    '#general (2 new)',
    '  4m ago  james  ping',
    '  3m ago  alex  pong',
  ].join('\n');

  assert.equal(buildPreviewOutput([first, second], { maxChars: 10_000 }), expected);
});

test('buildPreviewOutput appends a per-channel overflow footer when visible items were truncated', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-04-23T19:00:00.000Z'),
  });
  t.after(() => t.mock.timers.reset());

  const group = makeGroup({
    humanMessages: [
      makeMessage({ id: '1', content: 'first', createdAt: new Date('2026-04-23T18:50:00.000Z') }),
      makeMessage({ id: '2', content: 'second', createdAt: new Date('2026-04-23T18:55:00.000Z') }),
      makeMessage({ id: '3', content: 'third', createdAt: new Date('2026-04-23T18:58:00.000Z') }),
    ],
    totalHumanNew: 5,
  });

  const result = buildPreviewOutput([group], { maxChars: 10_000 });
  assert.match(result, /\n  \(\+2 more — use read_channel\)$/);
});

test('buildPreviewOutput appends a bot suppression footer when bots were hidden', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-04-23T19:00:00.000Z'),
  });
  t.after(() => t.mock.timers.reset());

  const group = makeGroup({ botMessageCount: 3 });

  const result = buildPreviewOutput([group], { maxChars: 10_000 });
  assert.match(result, /\n  \(\+3 bot posts hidden\)$/);
});

test('buildPreviewOutput renders overflow before the bot-suppression footer when both apply', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-04-23T19:00:00.000Z'),
  });
  t.after(() => t.mock.timers.reset());

  const group = makeGroup({
    totalHumanNew: 4,
    humanMessages: [
      makeMessage({ id: '1', content: 'first', createdAt: new Date('2026-04-23T18:55:00.000Z') }),
      makeMessage({ id: '2', content: 'second', createdAt: new Date('2026-04-23T18:58:00.000Z') }),
    ],
    botMessageCount: 5,
  });

  const result = buildPreviewOutput([group], { maxChars: 10_000 });
  assert.ok(result.includes('  (+2 more — use read_channel)\n  (+5 bot posts hidden)'));
});

test('buildPreviewOutput enforces the total size cap by dropping channels from the end and appending a footer', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-04-23T19:00:00.000Z'),
  });
  t.after(() => t.mock.timers.reset());

  const groups = Array.from({ length: 20 }, (_, index) =>
    makeGroup({
      channelId: `channel-${index}`,
      channelName: `chan-${index}`,
      humanMessages: [
        makeMessage({
          id: `m-${index}-1`,
          content: `message ${index} ${'x'.repeat(400)}`,
          createdAt: new Date(`2026-04-23T18:${String(59 - index).padStart(2, '0')}:00.000Z`),
        }),
      ],
      totalHumanNew: 1,
      newestHumanTimestampMs: Date.parse(`2026-04-23T18:${String(59 - index).padStart(2, '0')}:00.000Z`),
    }),
  );

  const result = buildPreviewOutput(groups, { maxChars: 1_000 });

  assert.ok(result.length <= 10_000);
  assert.match(result, /\n\(\+\d+ channels not shown\)$/);
  assert.match(result, /#chan-0 \(1 new\)/);
});

test('buildPreviewOutput skips channels that have no visible human messages even if bot posts were hidden', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-04-23T19:00:00.000Z'),
  });
  t.after(() => t.mock.timers.reset());

  const result = buildPreviewOutput([
    makeGroup({
      channelName: 'bots-only',
      humanMessages: [],
      totalHumanNew: 0,
      botMessageCount: 4,
      newestHumanTimestampMs: 0,
    }),
  ], { maxChars: 10_000 });

  assert.equal(result, 'No new Discord messages.');
});
