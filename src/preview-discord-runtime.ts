import type { ChannelMap } from './helpers.js';
import {
  clampPositiveInt,
  parseOptionalTimestamp,
  requireString,
  resolveChannelId,
} from './helpers.js';
import {
  loadHighwater,
  saveHighwater,
  updateMultipleHighwaters,
} from './highwater.js';
import { MessageChannelCache } from './message-cache.js';
import {
  buildPreviewOutput,
  DEFAULT_PER_CHANNEL_LIMIT,
  isBotMessage,
  MAX_PER_CHANNEL_LIMIT,
  MAX_PREVIEW_OUTPUT_CHARS,
  MIN_PER_CHANNEL_LIMIT,
  type PreviewChannelGroup,
  type PreviewMessageInput,
} from './preview-discord.js';

export interface MinimalDiscordMessage {
  id: string;
  author: {
    id?: string;
    username: string;
    bot: boolean;
  };
  webhookId: string | null;
  content: string;
  createdAt: Date;
  createdTimestamp?: number;
  attachments: {
    size: number;
    values?: () => Iterable<unknown>;
  };
  mentions: {
    repliedUser?: {
      username: string;
    } | null;
  };
  reference?: {
    messageId?: string | null;
  } | null;
}

export interface MinimalDiscordChannel {
  id: string;
  name?: string | null;
  isTextBased(): boolean;
}

export interface MinimalDiscordTextChannel extends MinimalDiscordChannel {
  messages: {
    fetch: (options: { limit?: number; after?: string }) => Promise<Map<string, MinimalDiscordMessage>>;
  };
}

export interface MinimalDiscordGuild {
  channels: {
    fetch: () => Promise<Map<string, MinimalDiscordChannel | null>>;
  };
}

export interface MinimalDiscord {
  channels: {
    fetch: (id: string) => Promise<MinimalDiscordChannel | null>;
  };
  guilds: {
    fetch: (id: string) => Promise<MinimalDiscordGuild>;
  };
  user?: {
    id?: string;
  } | null;
}

export interface RunPreviewDiscordOptions {
  args: Record<string, unknown>;
  discord: MinimalDiscord;
  guildId: string;
  channelMap: ChannelMap;
  logsChannelId: string;
  messageChannelCache: MessageChannelCache;
  stateFilePath: string;
  maxChars?: number;
  now?: () => number;
  buildOutput?: typeof buildPreviewOutput;
}

const DISCORD_EPOCH_MS = 1420070400000n;
const FETCH_LIMIT = 100;
const FIRST_RUN_LIMIT = 25;

function isFetchableTextChannel(channel: MinimalDiscordChannel | null): channel is MinimalDiscordTextChannel {
  return channel !== null && channel.isTextBased() && 'messages' in channel;
}

async function withMockNow<T>(now: (() => number) | undefined, fn: () => Promise<T>): Promise<T> {
  if (!now) {
    return fn();
  }

  const originalDateNow = Date.now;
  Date.now = now;

  try {
    return await fn();
  } finally {
    Date.now = originalDateNow;
  }
}

export async function runPreviewDiscord(opts: RunPreviewDiscordOptions): Promise<{ text: string }> {
  const maxChars = opts.maxChars ?? MAX_PREVIEW_OUTPUT_CHARS;
  let channelsToScan: Array<{ id: string; name: string }>;

  if (opts.args.channel !== undefined) {
    const channelInput = requireString(opts.args.channel, 'channel');
    const channelId = resolveChannelId(channelInput, opts.channelMap);
    const channel = await opts.discord.channels.fetch(channelId);
    channelsToScan = [{ id: channelId, name: channel?.name ?? channelId }];
  } else {
    const guild = await opts.discord.guilds.fetch(opts.guildId);
    const fetchedChannels = await guild.channels.fetch();
    channelsToScan = [...fetchedChannels.values()]
      .filter((channel): channel is MinimalDiscordChannel => channel !== null)
      .filter((channel) => channel.isTextBased())
      .filter((channel) => channel.id !== opts.logsChannelId)
      .map((channel) => ({
        id: channel.id,
        name: channel.name ?? channel.id,
      }));
  }

  const sinceTimestamp = parseOptionalTimestamp(opts.args.since, 'since');
  const limit = clampPositiveInt(opts.args.limit, {
    fieldName: 'limit',
    defaultValue: DEFAULT_PER_CHANNEL_LIMIT,
    min: MIN_PER_CHANNEL_LIMIT,
    max: MAX_PER_CHANNEL_LIMIT,
  });

  let state = await loadHighwater(opts.stateFilePath);
  const updates: Record<string, string> = {};
  const groups: PreviewChannelGroup[] = [];

  for (const { id, name } of channelsToScan) {
    let channel: MinimalDiscordChannel | null;

    try {
      channel = await opts.discord.channels.fetch(id);
      if (!isFetchableTextChannel(channel)) {
        continue;
      }
    } catch {
      continue;
    }

    const fetchOptions: { limit: number; after?: string } = { limit: FIRST_RUN_LIMIT };
    if (sinceTimestamp !== undefined) {
      fetchOptions.after = String((BigInt(sinceTimestamp) - DISCORD_EPOCH_MS) << 22n);
      fetchOptions.limit = FETCH_LIMIT;
    } else if (state.channels[id]) {
      fetchOptions.after = state.channels[id];
      fetchOptions.limit = FETCH_LIMIT;
    }

    let fetched: Map<string, MinimalDiscordMessage>;
    try {
      fetched = await channel.messages.fetch(fetchOptions);
    } catch {
      continue;
    }

    const messages = [...fetched.values()].sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    );

    if (messages.length === 0) {
      continue;
    }

    opts.messageChannelCache.setMany(
      messages.map((message) => ({ messageId: message.id, channelId: id })),
    );

    const previewMessages: PreviewMessageInput[] = messages.map((message) => ({
      id: message.id,
      authorUsername: message.author?.username ?? 'unknown',
      authorIsBot: message.author?.bot === true,
      webhookId: message.webhookId ?? null,
      content: message.content ?? '',
      createdAt: message.createdAt,
      hasAttachments: (message.attachments?.size ?? 0) > 0,
      replyToMessageId: message.reference?.messageId ?? null,
      replyToUsername: message.mentions?.repliedUser?.username ?? null,
    }));

    const humans = previewMessages.filter((message) => !isBotMessage(message));
    const bots = previewMessages.length - humans.length;
    const visible = humans.slice(-limit);

    const newestId = messages[messages.length - 1].id;
    const existingId = state.channels[id];
    if (existingId === undefined || BigInt(newestId) > BigInt(existingId)) {
      updates[id] = newestId;
    }

    groups.push({
      channelId: id,
      channelName: name,
      humanMessages: visible,
      totalHumanNew: humans.length,
      botMessageCount: bots,
      newestHumanTimestampMs:
        visible.length > 0 ? visible[visible.length - 1].createdAt.getTime() : 0,
    });
  }

  const buildOutput = opts.buildOutput ?? buildPreviewOutput;
  const text = await withMockNow(opts.now, async () => buildOutput(groups, { maxChars }));

  if (Object.keys(updates).length > 0) {
    state = updateMultipleHighwaters(state, updates);
    await saveHighwater(opts.stateFilePath, state);
  }

  return { text };
}
