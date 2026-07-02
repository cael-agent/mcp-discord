import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { ChannelMap } from './helpers.js';
import { MessageChannelCache } from './message-cache.js';
import {
  runCheckNewMessages,
  type JsonRpcResponse,
  type MinimalCheckNewMessagesAttachment,
  type MinimalCheckNewMessagesMessage,
  type MinimalCheckNewMessagesTextChannel,
  type MinimalDiscord,
  type RunCheckNewMessagesOptions,
} from './check-new-messages-runtime.js';

const GUILD_ID = '147000000000000000';
const LOGS_CHANNEL_ID = '1471816703834063023';
const CHANNEL_MAP: ChannelMap = {
  cael: '1470158584552755220',
  general: '1471816633944244379',
  'tool-requests': '1471816682527002686',
  logs: LOGS_CHANNEL_ID,
};

type FetchCall = {
  channelId: string;
  options: { limit?: number; after?: string };
};

type ChannelFixture = {
  id: string;
  name: string;
  messages: MinimalCheckNewMessagesMessage[];
  fetchError?: Error;
  textBased?: boolean;
};

type SanitizeInput = Parameters<RunCheckNewMessagesOptions['sanitizeAndFormat']>[0];

function snowflakeFromDate(date: Date): string {
  const discordEpoch = 1420070400000n;
  return String((BigInt(date.getTime()) - discordEpoch) << 22n);
}

function makeAttachment(
  overrides: Partial<MinimalCheckNewMessagesAttachment> = {},
): MinimalCheckNewMessagesAttachment {
  return {
    name: overrides.name ?? 'report.txt',
    contentType: overrides.contentType ?? 'text/plain',
    size: overrides.size ?? 1536,
  };
}

function makeMessage(
  overrides: Partial<MinimalCheckNewMessagesMessage> & {
    mentionedUserIds?: string[];
    attachmentsList?: MinimalCheckNewMessagesAttachment[];
  } = {},
): MinimalCheckNewMessagesMessage {
  const createdAt = overrides.createdAt ?? new Date('2026-04-23T18:58:00.000Z');
  const mentionedUserIds = new Set(overrides.mentionedUserIds ?? []);
  const attachmentsList = overrides.attachmentsList ?? [];

  return {
    id: overrides.id ?? snowflakeFromDate(createdAt),
    author: {
      id: overrides.author?.id ?? 'user-1',
      username: overrides.author?.username ?? 'james',
    },
    content: overrides.content ?? 'hello world',
    createdAt,
    createdTimestamp: overrides.createdTimestamp ?? createdAt.getTime(),
    attachments: overrides.attachments ?? {
      values: function* values() {
        yield* attachmentsList;
      },
    },
    mentions: overrides.mentions ?? {
      has: (id: string) => mentionedUserIds.has(id),
    },
  };
}

function makeDiscord(
  fixtures: ChannelFixture[],
  options: { botUserId?: string; fetchCalls?: FetchCall[] } = {},
): MinimalDiscord {
  const channels = new Map<string, MinimalCheckNewMessagesTextChannel>(
    fixtures.map((fixture) => {
      const channel: MinimalCheckNewMessagesTextChannel = {
        id: fixture.id,
        name: fixture.name,
        isTextBased: () => fixture.textBased ?? true,
        messages: {
          fetch: async (fetchOptions: { limit?: number; after?: string }) => {
            options.fetchCalls?.push({ channelId: fixture.id, options: { ...fetchOptions } });
            if (fixture.fetchError) {
              throw fixture.fetchError;
            }

            const after = fetchOptions.after ? BigInt(fetchOptions.after) : undefined;
            const visible = fixture.messages
              .filter((message) => after === undefined || BigInt(message.id) > after)
              .sort((left, right) => left.createdTimestamp - right.createdTimestamp);
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

async function makeTmpDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'check-new-messages-test-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeStateFile(filePath: string, channels: Record<string, string>): Promise<string> {
  const raw = JSON.stringify({ channels }, null, 2);
  await writeFile(filePath, raw, 'utf-8');
  return raw;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function successSanitize(
  calls: SanitizeInput[],
  response: JsonRpcResponse = { content: [{ type: 'text', text: '{"ok":true}' }] },
): RunCheckNewMessagesOptions['sanitizeAndFormat'] {
  return async (input) => {
    calls.push(input);
    return response;
  };
}

function failureSanitize(calls: SanitizeInput[] = []): RunCheckNewMessagesOptions['sanitizeAndFormat'] {
  return async (input) => {
    calls.push(input);
    return { content: [{ type: 'text', text: '[Safety: boom]' }], isError: true };
  };
}

function baseOptions(
  overrides: Partial<RunCheckNewMessagesOptions>,
): RunCheckNewMessagesOptions {
  return {
    args: {},
    discord: makeDiscord([]),
    guildId: GUILD_ID,
    channelMap: CHANNEL_MAP,
    logsChannelId: LOGS_CHANNEL_ID,
    messageChannelCache: new MessageChannelCache(),
    stateFilePath: path.join(tmpdir(), 'unused-highwater.json'),
    sanitizeAndFormat: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
    ...overrides,
  };
}

test('sidecar failure returns without changing a pre-seeded highwater file', async (t) => {
  const dir = await makeTmpDir(t);
  const stateFilePath = path.join(dir, 'highwater.json');
  const existing = await writeStateFile(stateFilePath, {
    [CHANNEL_MAP.cael]: snowflakeFromDate(new Date('2026-04-23T18:57:00.000Z')),
  });

  await runCheckNewMessages(baseOptions({
    args: { channel: 'cael' },
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [
          makeMessage({ content: 'new but unsafe to mark read', createdAt: new Date('2026-04-23T18:58:00.000Z') }),
        ],
      },
    ]),
    stateFilePath,
    sanitizeAndFormat: failureSanitize(),
  }));

  assert.equal(await readFile(stateFilePath, 'utf-8'), existing);
});

test('sidecar success advances highwater to newest ids per channel', async (t) => {
  const dir = await makeTmpDir(t);
  const stateFilePath = path.join(dir, 'highwater.json');
  await writeStateFile(stateFilePath, {
    [CHANNEL_MAP.cael]: snowflakeFromDate(new Date('2026-04-23T18:57:00.000Z')),
  });
  const caelNewest = makeMessage({ content: 'cael newest', createdAt: new Date('2026-04-23T18:59:00.000Z') });
  const generalNewest = makeMessage({ content: 'general newest', createdAt: new Date('2026-04-23T18:58:30.000Z') });

  await runCheckNewMessages(baseOptions({
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [
          makeMessage({ content: 'cael older', createdAt: new Date('2026-04-23T18:58:00.000Z') }),
          caelNewest,
        ],
      },
      {
        id: CHANNEL_MAP.general,
        name: 'general',
        messages: [generalNewest],
      },
    ]),
    stateFilePath,
    sanitizeAndFormat: successSanitize([]),
  }));

  const saved = JSON.parse(await readFile(stateFilePath, 'utf-8')) as { channels: Record<string, string> };
  assert.equal(saved.channels[CHANNEL_MAP.cael], caelNewest.id);
  assert.equal(saved.channels[CHANNEL_MAP.general], generalNewest.id);
});

test('failure then retry re-fetches with the same after value', async (t) => {
  const dir = await makeTmpDir(t);
  const stateFilePath = path.join(dir, 'highwater.json');
  const storedHighwater = snowflakeFromDate(new Date('2026-04-23T18:57:00.000Z'));
  await writeStateFile(stateFilePath, { [CHANNEL_MAP.cael]: storedHighwater });
  const fetchCalls: FetchCall[] = [];
  const discord = makeDiscord([
    {
      id: CHANNEL_MAP.cael,
      name: 'cael',
      messages: [
        makeMessage({ content: 'retry me', createdAt: new Date('2026-04-23T18:58:00.000Z') }),
      ],
    },
  ], { fetchCalls });
  const opts = baseOptions({
    args: { channel: 'cael' },
    discord,
    stateFilePath,
    sanitizeAndFormat: failureSanitize(),
  });

  await runCheckNewMessages(opts);
  await runCheckNewMessages(opts);

  assert.deepEqual(fetchCalls.map((call) => call.options), [
    { after: storedHighwater, limit: 100 },
    { after: storedHighwater, limit: 100 },
  ]);
});

test('no new messages returns the exact empty response and leaves state absent', async (t) => {
  const dir = await makeTmpDir(t);
  const stateFilePath = path.join(dir, 'highwater.json');

  const result = await runCheckNewMessages(baseOptions({
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [],
      },
    ]),
    stateFilePath,
    sanitizeAndFormat: successSanitize([]),
  }));

  assert.deepEqual(result, {
    content: [{ type: 'text', text: JSON.stringify({ channels: [], total_new_messages: 0 }) }],
  });
  assert.equal(await pathExists(stateFilePath), false);
});

test('first run with messages creates highwater file with newest ids', async (t) => {
  const dir = await makeTmpDir(t);
  const stateFilePath = path.join(dir, 'highwater.json');
  const newest = makeMessage({ content: 'first run newest', createdAt: new Date('2026-04-23T18:59:00.000Z') });

  await runCheckNewMessages(baseOptions({
    args: { channel: 'cael' },
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [
          makeMessage({ content: 'first run older', createdAt: new Date('2026-04-23T18:58:00.000Z') }),
          newest,
        ],
      },
    ]),
    stateFilePath,
    sanitizeAndFormat: successSanitize([]),
  }));

  const saved = JSON.parse(await readFile(stateFilePath, 'utf-8')) as { channels: Record<string, string> };
  assert.equal(saved.channels[CHANNEL_MAP.cael], newest.id);
});

test('sidecar failure response is returned verbatim', async (t) => {
  const dir = await makeTmpDir(t);
  const failureResponse: JsonRpcResponse = {
    content: [{ type: 'text', text: '[Safety: boom]' }],
    isError: true,
  };

  const result = await runCheckNewMessages(baseOptions({
    args: { channel: 'cael' },
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [
          makeMessage({ content: 'unsafe delivery failure', createdAt: new Date('2026-04-23T18:58:00.000Z') }),
        ],
      },
    ]),
    stateFilePath: path.join(dir, 'highwater.json'),
    sanitizeAndFormat: async () => failureResponse,
  }));

  assert.equal(result, failureResponse);
});

test('sanitize input format pins headers, msg ids, self tag, and attachments', async (t) => {
  const dir = await makeTmpDir(t);
  const sanitizeCalls: SanitizeInput[] = [];
  const originalDateNow = Date.now;
  Date.now = () => Date.parse('2026-04-23T19:00:00.000Z');
  t.after(() => {
    Date.now = originalDateNow;
  });
  const message = makeMessage({
    author: { id: 'cael-bot-user', username: 'cael' },
    content: 'see attached',
    createdAt: new Date('2026-04-23T18:58:00.000Z'),
    attachmentsList: [makeAttachment({ name: 'report.txt', contentType: 'text/plain', size: 1536 })],
  });

  await runCheckNewMessages(baseOptions({
    args: { channel: 'cael' },
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [message],
      },
    ], { botUserId: 'cael-bot-user' }),
    stateFilePath: path.join(dir, 'highwater.json'),
    sanitizeAndFormat: successSanitize(sanitizeCalls),
  }));

  assert.equal(sanitizeCalls.length, 1);
  assert.deepEqual(
    {
      schema: sanitizeCalls[0].schema,
      context: sanitizeCalls[0].context,
      source: sanitizeCalls[0].source,
    },
    {
      schema: 'socialFeedBatch',
      context: 'New Discord messages across 1 channel(s)',
      source: 'discord:check_new_messages',
    },
  );
  assert.match(sanitizeCalls[0].content, /^#cael \(1 new\):/);
  assert.match(sanitizeCalls[0].content, new RegExp(`\\[2m ago\\] \\[msg:${message.id}\\] cael \\(you\\): see attached`));
  assert.match(sanitizeCalls[0].content, /Attachment: report\.txt \(text\/plain, 1\.5 KB\)/);
});

test('since param uses synthetic snowflake after with limit 100', async (t) => {
  const dir = await makeTmpDir(t);
  const fetchCalls: FetchCall[] = [];
  const since = '2026-04-23T18:57:00.000Z';
  const expectedAfter = snowflakeFromDate(new Date(since));

  await runCheckNewMessages(baseOptions({
    args: { channel: 'cael', since },
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [
          makeMessage({ content: 'new after since', createdAt: new Date('2026-04-23T18:58:00.000Z') }),
        ],
      },
    ], { fetchCalls }),
    stateFilePath: path.join(dir, 'highwater.json'),
    sanitizeAndFormat: successSanitize([]),
  }));

  assert.deepEqual(fetchCalls.map((call) => call.options), [
    { after: expectedAfter, limit: 100 },
  ]);
});

test('explicit channel scans only that channel while all-channel mode excludes logs', async (t) => {
  const dir = await makeTmpDir(t);
  const explicitFetchCalls: FetchCall[] = [];
  await runCheckNewMessages(baseOptions({
    args: { channel: 'general' },
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [makeMessage({ content: 'ignore explicit', createdAt: new Date('2026-04-23T18:58:00.000Z') })],
      },
      {
        id: CHANNEL_MAP.general,
        name: 'general',
        messages: [makeMessage({ content: 'include explicit', createdAt: new Date('2026-04-23T18:58:30.000Z') })],
      },
      {
        id: LOGS_CHANNEL_ID,
        name: 'logs',
        messages: [makeMessage({ content: 'ignore logs', createdAt: new Date('2026-04-23T18:59:00.000Z') })],
      },
    ], { fetchCalls: explicitFetchCalls }),
    stateFilePath: path.join(dir, 'explicit-highwater.json'),
    sanitizeAndFormat: successSanitize([]),
  }));
  assert.deepEqual(explicitFetchCalls.map((call) => call.channelId), [CHANNEL_MAP.general]);

  const allFetchCalls: FetchCall[] = [];
  await runCheckNewMessages(baseOptions({
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [makeMessage({ content: 'include cael', createdAt: new Date('2026-04-23T18:58:00.000Z') })],
      },
      {
        id: CHANNEL_MAP.general,
        name: 'general',
        messages: [makeMessage({ content: 'include general', createdAt: new Date('2026-04-23T18:58:30.000Z') })],
      },
      {
        id: LOGS_CHANNEL_ID,
        name: 'logs',
        messages: [makeMessage({ content: 'exclude logs', createdAt: new Date('2026-04-23T18:59:00.000Z') })],
      },
    ], { fetchCalls: allFetchCalls }),
    stateFilePath: path.join(dir, 'all-highwater.json'),
    sanitizeAndFormat: successSanitize([]),
  }));
  assert.deepEqual(allFetchCalls.map((call) => call.channelId).sort(), [
    CHANNEL_MAP.cael,
    CHANNEL_MAP.general,
  ].sort());
});

test('messageChannelCache is populated even when sidecar fails', async (t) => {
  const dir = await makeTmpDir(t);
  const cache = new MessageChannelCache();
  const message = makeMessage({ content: 'cache before sanitize', createdAt: new Date('2026-04-23T18:58:00.000Z') });

  await runCheckNewMessages(baseOptions({
    args: { channel: 'cael' },
    discord: makeDiscord([
      {
        id: CHANNEL_MAP.cael,
        name: 'cael',
        messages: [message],
      },
    ]),
    messageChannelCache: cache,
    stateFilePath: path.join(dir, 'highwater.json'),
    sanitizeAndFormat: failureSanitize(),
  }));

  assert.equal(cache.get(message.id), CHANNEL_MAP.cael);
});
