import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { ChannelMap } from './helpers.js';
import { MessageChannelCache } from './message-cache.js';
import { runPreviewDiscord, type MinimalDiscord, type MinimalDiscordMessage } from './preview-discord-runtime.js';

// These tests drive the preview-discord runtime module that the index.ts switch
// will call in the implementation turn. They intentionally avoid the current
// inline switch to keep the TDD surface injectable and isolated.

const GUILD_ID = '147000000000000000';
const LOGS_CHANNEL_ID = '1471816703834063023';
const CHANNEL_MAP: ChannelMap = {
  cael: '1470158584552755220',
  general: '1471816633944244379',
  'tool-requests': '1471816682527002686',
  logs: LOGS_CHANNEL_ID,
};

type ChannelFixture = {
  id: string;
  name: string;
  messages: MinimalDiscordMessage[];
  fetchError?: Error;
};

function snowflakeFromDate(date: Date): string {
  const discordEpoch = 1420070400000n;
  return String((BigInt(date.getTime()) - discordEpoch) << 22n);
}

function makeMessage(overrides: Partial<MinimalDiscordMessage> = {}): MinimalDiscordMessage {
  const createdAt = overrides.createdAt ?? new Date('2026-04-23T18:58:00.000Z');

  return {
    id: overrides.id ?? snowflakeFromDate(createdAt),
    author: {
      id: overrides.author?.id ?? 'user-1',
      username: overrides.author?.username ?? 'james',
      bot: overrides.author?.bot ?? false,
    },
    webhookId: overrides.webhookId ?? null,
    content: overrides.content ?? 'hello world',
    createdAt,
    createdTimestamp: overrides.createdTimestamp ?? createdAt.getTime(),
    attachments: overrides.attachments ?? { size: 0, values: function* values() {} },
    mentions: overrides.mentions ?? {},
    reference: overrides.reference ?? null,
  };
}

function makeDiscord(fixtures: ChannelFixture[], options: { botUserId?: string } = {}): MinimalDiscord {
  const channels = new Map(
    fixtures.map((fixture) => {
      const channel = {
        id: fixture.id,
        name: fixture.name,
        isTextBased: () => true,
        messages: {
          fetch: async (fetchOptions: { limit?: number; after?: string }) => {
            if (fixture.fetchError) {
              throw fixture.fetchError;
            }

            const after = fetchOptions.after ? BigInt(fetchOptions.after) : undefined;
            const visible = fixture.messages
              .filter((message) => after === undefined || BigInt(message.id) > after)
              .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
            const limited = fetchOptions.limit === undefined
              ? visible
              : visible.slice(Math.max(0, visible.length - fetchOptions.limit));

            return new Map(limited.map((message) => [message.id, message]));
          },
        },
      };

      return [fixture.id, channel];
    }),
  );

  return {
    channels: {
      fetch: async (id: string) => channels.get(id) ?? null,
    },
    guilds: {
      fetch: async (_guildId: string) => ({
        channels: {
          fetch: async () => new Map([...channels.entries()]),
        },
      }),
    },
    user: {
      id: options.botUserId ?? 'cael-bot-user',
    },
  };
}

function setMockFetch(t: TestContext, impl: typeof fetch): { calls: Array<{ url: string; init?: RequestInit }> } {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const normalizedUrl =
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    calls.push({ url: normalizedUrl, init });
    return impl(url, init);
  }) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
  });

  return { calls };
}

async function makeTmpDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'preview-discord-test-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeStateFile(filePath: string, channels: Record<string, string>): Promise<string> {
  const raw = JSON.stringify({ channels }, null, 2);
  await writeFile(filePath, raw, 'utf-8');
  return raw;
}

test('runPreviewDiscord makes zero sidecar calls for a happy-path preview', async (t) => {
  const dir = await makeTmpDir(t);
  const stateFilePath = path.join(dir, 'preview-highwater.json');
  const fetchSpy = setMockFetch(t, async (url) => {
    const urlString = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (/\/sanitize|\/prefilter/.test(urlString)) {
      throw new Error(`preview_discord must not call the sidecar: ${urlString}`);
    }
    return new Response('{}', { status: 200 });
  });

  const discord = makeDiscord([
    {
      id: CHANNEL_MAP.cael,
      name: 'cael',
      messages: [
        makeMessage({ content: 'hello from james', createdAt: new Date('2026-04-23T18:58:00.000Z') }),
      ],
    },
  ]);

  const result = await runPreviewDiscord({
    args: {},
    discord,
    guildId: GUILD_ID,
    channelMap: CHANNEL_MAP,
    logsChannelId: LOGS_CHANNEL_ID,
    messageChannelCache: new MessageChannelCache(),
    stateFilePath,
    now: () => Date.parse('2026-04-23T19:00:00.000Z'),
  });

  assert.match(result.text, /^\[Discord preview \| 1 new across 1 channels\]/);
  assert.deepEqual(fetchSpy.calls, []);
});

test('preview-discord build output does not statically import safety-client', async () => {
  const previewModule = await readFile(new URL('./preview-discord.js', import.meta.url), 'utf-8');
  assert.equal(previewModule.includes('safety-client'), false);

  const runtimeModule = await readFile(new URL('./preview-discord-runtime.js', import.meta.url), 'utf-8');
  assert.equal(runtimeModule.includes('safety-client'), false);
});

test('bot messages are cached but suppressed from preview output with a hidden-count footer', async (t) => {
  const dir = await makeTmpDir(t);
  const cache = new MessageChannelCache();
  const botOne = makeMessage({
    author: { id: 'bot-1', username: 'relay-bot', bot: true },
    content: 'bot payload one',
    createdAt: new Date('2026-04-23T18:54:00.000Z'),
  });
  const botTwo = makeMessage({
    author: { id: 'bot-2', username: 'relay-bot', bot: true },
    content: 'bot payload two',
    createdAt: new Date('2026-04-23T18:55:00.000Z'),
  });
  const botThree = makeMessage({
    author: { id: 'bot-3', username: 'relay-bot', bot: true },
    content: 'bot payload three',
    createdAt: new Date('2026-04-23T18:56:00.000Z'),
  });

  const result = await runPreviewDiscord({
    args: {},
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [
          makeMessage({ content: 'human one', createdAt: new Date('2026-04-23T18:57:00.000Z') }),
          botOne,
          makeMessage({ content: 'human two', createdAt: new Date('2026-04-23T18:58:00.000Z') }),
          botTwo,
          botThree,
        ],
      },
    ]),
    guildId: GUILD_ID,
    channelMap: CHANNEL_MAP,
    logsChannelId: LOGS_CHANNEL_ID,
    messageChannelCache: cache,
    stateFilePath: path.join(dir, 'preview-highwater.json'),
    now: () => Date.parse('2026-04-23T19:00:00.000Z'),
  });

  assert.match(result.text, /human one/);
  assert.match(result.text, /human two/);
  assert.doesNotMatch(result.text, /bot payload one|bot payload two|bot payload three/);
  assert.match(result.text, /\(\+3 bot posts hidden\)/);
  assert.equal(cache.get(botOne.id), CHANNEL_MAP.cael);
  assert.equal(cache.get(botTwo.id), CHANNEL_MAP.cael);
  assert.equal(cache.get(botThree.id), CHANNEL_MAP.cael);
});

test('self-authored bot messages are suppressed but still cached', async (t) => {
  const dir = await makeTmpDir(t);
  const cache = new MessageChannelCache();
  const selfBotMessage = makeMessage({
    author: { id: 'cael-bot-user', username: 'cael', bot: true },
    content: 'self bot post',
  });

  const result = await runPreviewDiscord({
    args: {},
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [
          selfBotMessage,
          makeMessage({ content: 'visible human message', createdAt: new Date('2026-04-23T18:59:00.000Z') }),
        ],
      },
    ], { botUserId: 'cael-bot-user' }),
    guildId: GUILD_ID,
    channelMap: CHANNEL_MAP,
    logsChannelId: LOGS_CHANNEL_ID,
    messageChannelCache: cache,
    stateFilePath: path.join(dir, 'preview-highwater.json'),
    now: () => Date.parse('2026-04-23T19:00:00.000Z'),
  });

  assert.doesNotMatch(result.text, /self bot post/);
  assert.match(result.text, /\(\+1 bot posts hidden\)/);
  assert.equal(cache.get(selfBotMessage.id), CHANNEL_MAP.cael);
});

test('logs channel is excluded when channel is omitted', async (t) => {
  const dir = await makeTmpDir(t);

  const result = await runPreviewDiscord({
    args: {},
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [
          makeMessage({ content: 'keep me', createdAt: new Date('2026-04-23T18:59:00.000Z') }),
        ],
      },
      {
        id: LOGS_CHANNEL_ID,
        name: 'logs',
        messages: [
          makeMessage({ content: 'ignore me', createdAt: new Date('2026-04-23T18:58:00.000Z') }),
        ],
      },
    ]),
    guildId: GUILD_ID,
    channelMap: CHANNEL_MAP,
    logsChannelId: LOGS_CHANNEL_ID,
    messageChannelCache: new MessageChannelCache(),
    stateFilePath: path.join(dir, 'preview-highwater.json'),
    now: () => Date.parse('2026-04-23T19:00:00.000Z'),
  });

  assert.match(result.text, /keep me/);
  assert.doesNotMatch(result.text, /ignore me/);
  assert.doesNotMatch(result.text, /#logs/);
});

test('single-channel mode only fetches the selected channel and ignores logs exclusion', async (t) => {
  const dir = await makeTmpDir(t);

  const result = await runPreviewDiscord({
    args: { channel: 'cael' },
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [
          makeMessage({ content: 'from cael', createdAt: new Date('2026-04-23T18:59:00.000Z') }),
        ],
      },
      {
        id: LOGS_CHANNEL_ID,
        name: 'logs',
        messages: [
          makeMessage({ content: 'from logs', createdAt: new Date('2026-04-23T18:58:00.000Z') }),
        ],
      },
    ]),
    guildId: GUILD_ID,
    channelMap: CHANNEL_MAP,
    logsChannelId: LOGS_CHANNEL_ID,
    messageChannelCache: new MessageChannelCache(),
    stateFilePath: path.join(dir, 'preview-highwater.json'),
    now: () => Date.parse('2026-04-23T19:00:00.000Z'),
  });

  assert.match(result.text, /from cael/);
  assert.doesNotMatch(result.text, /from logs/);
});

test('since override uses a synthetic snowflake floor without regressing stored highwater', async (t) => {
  const dir = await makeTmpDir(t);
  const stateFilePath = path.join(dir, 'preview-highwater.json');
  const existingHighwaterTimestamp = new Date('2026-04-23T18:59:30.000Z');
  await writeStateFile(stateFilePath, {
    [CHANNEL_MAP.cael]: snowflakeFromDate(existingHighwaterTimestamp),
  });

  const olderButAfterSince = makeMessage({
    content: 'older than stored highwater but newer than since',
    createdAt: new Date('2026-04-23T18:58:30.000Z'),
  });

  await runPreviewDiscord({
    args: { since: '2026-04-23T18:58:00.000Z', channel: 'cael' },
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [olderButAfterSince],
      },
    ]),
    guildId: GUILD_ID,
    channelMap: CHANNEL_MAP,
    logsChannelId: LOGS_CHANNEL_ID,
    messageChannelCache: new MessageChannelCache(),
    stateFilePath,
    now: () => Date.parse('2026-04-23T19:00:00.000Z'),
  });

  const rawState = JSON.parse(await readFile(stateFilePath, 'utf-8')) as { channels: Record<string, string> };
  assert.equal(rawState.channels[CHANNEL_MAP.cael], snowflakeFromDate(existingHighwaterTimestamp));
});

test('limit values above 10 are clamped to 10 visible items per channel', async (t) => {
  const dir = await makeTmpDir(t);
  const messages = Array.from({ length: 12 }, (_, index) =>
    makeMessage({
      content: `message-${index + 1}`,
      createdAt: new Date(`2026-04-23T18:${String(48 + index).padStart(2, '0')}:00.000Z`),
    }),
  );

  const result = await runPreviewDiscord({
    args: { channel: 'cael', limit: 15 },
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages,
      },
    ]),
    guildId: GUILD_ID,
    channelMap: CHANNEL_MAP,
    logsChannelId: LOGS_CHANNEL_ID,
    messageChannelCache: new MessageChannelCache(),
    stateFilePath: path.join(dir, 'preview-highwater.json'),
    now: () => Date.parse('2026-04-23T19:00:00.000Z'),
  });

  assert.equal((result.text.match(/message-/g) ?? []).length, 10);
  assert.match(result.text, /\(\+2 more — use read_channel\)/);
});

test('empty result returns the exact no-messages text', async (t) => {
  const dir = await makeTmpDir(t);

  const result = await runPreviewDiscord({
    args: {},
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [],
      },
    ]),
    guildId: GUILD_ID,
    channelMap: CHANNEL_MAP,
    logsChannelId: LOGS_CHANNEL_ID,
    messageChannelCache: new MessageChannelCache(),
    stateFilePath: path.join(dir, 'preview-highwater.json'),
    now: () => Date.parse('2026-04-23T19:00:00.000Z'),
  });

  assert.deepEqual(result, { text: 'No new Discord messages.' });
});

test('preview highwater persists newest ids per channel across calls', async (t) => {
  const dir = await makeTmpDir(t);
  const stateFilePath = path.join(dir, 'preview-highwater.json');
  const firstMessage = makeMessage({
    content: 'first run message',
    createdAt: new Date('2026-04-23T18:58:00.000Z'),
  });
  const secondMessage = makeMessage({
    content: 'second run message',
    createdAt: new Date('2026-04-23T18:59:00.000Z'),
  });

  const discord = makeDiscord([
    {
      id: CHANNEL_MAP.cael,
      name: 'cael',
      messages: [firstMessage, secondMessage],
    },
  ]);

  const firstResult = await runPreviewDiscord({
    args: { channel: 'cael' },
    discord,
    guildId: GUILD_ID,
    channelMap: CHANNEL_MAP,
    logsChannelId: LOGS_CHANNEL_ID,
    messageChannelCache: new MessageChannelCache(),
    stateFilePath,
    now: () => Date.parse('2026-04-23T19:00:00.000Z'),
  });

  assert.match(firstResult.text, /first run message/);
  assert.match(firstResult.text, /second run message/);

  const saved = JSON.parse(await readFile(stateFilePath, 'utf-8')) as { channels: Record<string, string> };
  assert.equal(saved.channels[CHANNEL_MAP.cael], secondMessage.id);

  const secondResult = await runPreviewDiscord({
    args: { channel: 'cael' },
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [
          firstMessage,
          secondMessage,
          makeMessage({
            content: 'third run message',
            createdAt: new Date('2026-04-23T18:59:30.000Z'),
          }),
        ],
      },
    ]),
    guildId: GUILD_ID,
    channelMap: CHANNEL_MAP,
    logsChannelId: LOGS_CHANNEL_ID,
    messageChannelCache: new MessageChannelCache(),
    stateFilePath,
    now: () => Date.parse('2026-04-23T19:01:00.000Z'),
  });

  assert.doesNotMatch(secondResult.text, /first run message/);
  assert.doesNotMatch(secondResult.text, /second run message/);
  assert.match(secondResult.text, /third run message/);
});

test('preview highwater is unchanged when build output throws', async (t) => {
  const dir = await makeTmpDir(t);
  const stateFilePath = path.join(dir, 'preview-highwater.json');
  const existing = await writeStateFile(stateFilePath, {
    [CHANNEL_MAP.cael]: snowflakeFromDate(new Date('2026-04-23T18:57:00.000Z')),
  });

  await assert.rejects(
    runPreviewDiscord({
      args: { channel: 'cael' },
      discord: makeDiscord([
        {
          id: CHANNEL_MAP.cael,
          name: 'cael',
          messages: [
            makeMessage({ content: 'do not mark read before output', createdAt: new Date('2026-04-23T18:58:00.000Z') }),
          ],
        },
      ]),
      guildId: GUILD_ID,
      channelMap: CHANNEL_MAP,
      logsChannelId: LOGS_CHANNEL_ID,
      messageChannelCache: new MessageChannelCache(),
      stateFilePath,
      now: () => Date.parse('2026-04-23T19:00:00.000Z'),
      buildOutput: () => {
        throw new Error('preview render failed');
      },
    }),
    /preview render failed/,
  );

  assert.equal(await readFile(stateFilePath, 'utf-8'), existing);
});

test('runPreviewDiscord enforces the 10k total output cap and drops channels from the end', async (t) => {
  const dir = await makeTmpDir(t);
  const fixtures = Array.from({ length: 25 }, (_, index) => ({
    id: `1479999999999999${String(index).padStart(2, '0')}`,
    name: `chan-${index}`,
    messages: [
      makeMessage({
        content: `channel-${index} ${'x'.repeat(600)}`,
        createdAt: new Date(`2026-04-23T18:${String(59 - index).padStart(2, '0')}:00.000Z`),
      }),
    ],
  }));

  const result = await runPreviewDiscord({
    args: {},
    discord: makeDiscord(fixtures),
    guildId: GUILD_ID,
    channelMap: { ...CHANNEL_MAP, ...Object.fromEntries(fixtures.map((fixture) => [fixture.name, fixture.id])) },
    logsChannelId: LOGS_CHANNEL_ID,
    messageChannelCache: new MessageChannelCache(),
    stateFilePath: path.join(dir, 'preview-highwater.json'),
    maxChars: 1_000,
    now: () => Date.parse('2026-04-23T19:00:00.000Z'),
  });

  assert.ok(result.text.length <= 10_000);
  assert.match(result.text, /\n\(\+\d+ channels not shown\)$/);
  assert.match(result.text, /#chan-0/);
});

test('channel fetch errors are skipped and do not crash the preview', async (t) => {
  const dir = await makeTmpDir(t);

  const result = await runPreviewDiscord({
    args: {},
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [
          makeMessage({ content: 'good channel message', createdAt: new Date('2026-04-23T18:59:00.000Z') }),
        ],
      },
      {
        id: CHANNEL_MAP.general,
        name: 'general',
        messages: [],
        fetchError: new Error('Missing Access'),
      },
    ]),
    guildId: GUILD_ID,
    channelMap: CHANNEL_MAP,
    logsChannelId: LOGS_CHANNEL_ID,
    messageChannelCache: new MessageChannelCache(),
    stateFilePath: path.join(dir, 'preview-highwater.json'),
    now: () => Date.parse('2026-04-23T19:00:00.000Z'),
  });

  assert.match(result.text, /good channel message/);
  assert.doesNotMatch(result.text, /#general/);
});

test('reply previews render the replied username when mentions.repliedUser is available', async (t) => {
  const dir = await makeTmpDir(t);

  const result = await runPreviewDiscord({
    args: { channel: 'cael' },
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [
          makeMessage({
            content: 'reply body',
            createdAt: new Date('2026-04-23T18:58:00.000Z'),
            reference: { messageId: '147000000000000099' },
            mentions: { repliedUser: { username: 'paula' } },
          }),
        ],
      },
    ]),
    guildId: GUILD_ID,
    channelMap: CHANNEL_MAP,
    logsChannelId: LOGS_CHANNEL_ID,
    messageChannelCache: new MessageChannelCache(),
    stateFilePath: path.join(dir, 'preview-highwater.json'),
    now: () => Date.parse('2026-04-23T19:00:00.000Z'),
  });

  assert.match(result.text, /↳ @paula/);
});
