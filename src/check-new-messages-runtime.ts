import type { ChannelMap } from './helpers.js';
import {
  formatMessagePreview,
  parseOptionalTimestamp,
  requireString,
  resolveChannelId,
} from './helpers.js';
import { formatFileSize } from './attachments.js';
import {
  getChannelHighwater,
  loadHighwater,
  saveHighwater,
  updateMultipleHighwaters,
} from './highwater.js';
import type { MessageChannelCache } from './message-cache.js';
import type {
  MinimalDiscordChannel,
  MinimalDiscordGuild,
} from './preview-discord-runtime.js';
import { formatRelativeTime } from './relative-time.js';

export type JsonRpcResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export interface MinimalCheckNewMessagesAttachment {
  name?: string | null;
  contentType?: string | null;
  size: number;
}

export interface MinimalCheckNewMessagesMessage {
  id: string;
  author: {
    id?: string;
    username: string;
  };
  content: string;
  createdAt: Date;
  createdTimestamp: number;
  attachments: {
    values: () => Iterable<MinimalCheckNewMessagesAttachment>;
  };
  mentions: {
    has?: (id: string) => boolean;
  };
}

export interface MinimalCheckNewMessagesTextChannel extends MinimalDiscordChannel {
  messages: {
    fetch: (options: { limit?: number; after?: string }) => Promise<Map<string, MinimalCheckNewMessagesMessage>>;
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

export interface RunCheckNewMessagesOptions {
  args: Record<string, unknown>;
  discord: MinimalDiscord;
  guildId: string;
  channelMap: ChannelMap;
  logsChannelId: string;
  messageChannelCache: MessageChannelCache;
  stateFilePath: string;
  sanitizeAndFormat: (opts: {
    content: string;
    schema: string;
    context: string;
    source: string;
  }) => Promise<JsonRpcResponse>;
}

const DISCORD_EPOCH_MS = 1420070400000n;
const CHECK_NEW_MESSAGES_LIMIT = 100;
const FIRST_RUN_LIMIT = 25;

type MessageSummary = {
  message_id: string;
  channel: { name: string; id: string };
  author: string;
  timestamp: string;
  preview: string;
  attachments: Array<{ filename: string; contentType: string; size: number }>;
  mentions_bot: boolean;
  is_self: boolean;
};

type ChannelGroup = {
  channel: { name: string; id: string };
  message_count: number;
  messages: MessageSummary[];
};

function toResponse(payload: unknown): JsonRpcResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

function isFetchableTextChannel(
  channel: MinimalDiscordChannel | null,
): channel is MinimalCheckNewMessagesTextChannel {
  return channel !== null && channel.isTextBased() && 'messages' in channel;
}

function channelName(channel: MinimalDiscordChannel, fallback: string): string {
  return typeof channel.name === 'string' ? channel.name : fallback;
}

function snowflakeFromTimestamp(timestampMs: number): string {
  return String((BigInt(timestampMs) - DISCORD_EPOCH_MS) << 22n);
}

function buildSidecarText(groups: ChannelGroup[]): string {
  const textParts: string[] = [];

  for (const group of groups) {
    textParts.push(`#${group.channel.name} (${group.message_count} new):`);
    for (const msg of group.messages) {
      const selfTag = msg.is_self ? ' (you)' : '';
      textParts.push(`  [${formatRelativeTime(msg.timestamp)}] [msg:${msg.message_id}] ${msg.author}${selfTag}: ${msg.preview}`);
      for (const att of msg.attachments) {
        textParts.push(`    Attachment: ${att.filename} (${att.contentType}, ${formatFileSize(att.size)})`);
      }
    }
  }

  return textParts.join('\n');
}

export async function runCheckNewMessages(
  opts: RunCheckNewMessagesOptions,
): Promise<JsonRpcResponse> {
  const sinceTimestamp = parseOptionalTimestamp(opts.args.since, 'since');
  const state = await loadHighwater(opts.stateFilePath);
  let channelsToCheck: Array<{ id: string; name: string }>;

  if (opts.args.channel !== undefined) {
    const channelInput = requireString(opts.args.channel, 'channel');
    const channelId = resolveChannelId(channelInput, opts.channelMap);
    const channel = await opts.discord.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    if (!channel.isTextBased()) {
      throw new Error(`Channel ${channelId} is not text-based`);
    }

    if (!isFetchableTextChannel(channel)) {
      throw new Error(`Channel ${channelId} does not support reading messages`);
    }

    channelsToCheck = [{ id: channel.id, name: channelName(channel, channel.id) }];
  } else {
    const guild = await opts.discord.guilds.fetch(opts.guildId);
    const fetchedChannels = await guild.channels.fetch();
    channelsToCheck = [...fetchedChannels.values()]
      .filter((channel): channel is MinimalDiscordChannel => channel !== null)
      .filter((channel) => channel.isTextBased())
      .filter((channel) => channel.id !== opts.logsChannelId)
      .map((channel) => ({
        id: channel.id,
        name: channelName(channel, channel.id),
      }));
  }

  const groups: ChannelGroup[] = [];
  const highwaterUpdates: Record<string, string> = {};
  const botUserId = opts.discord.user?.id;

  for (const { id: channelId, name: nameFromList } of channelsToCheck) {
    try {
      const channel = await opts.discord.channels.fetch(channelId);
      if (!isFetchableTextChannel(channel)) {
        continue;
      }

      const highwater = getChannelHighwater(state, channelId);
      let fetchOptions: { limit?: number; after?: string };
      if (sinceTimestamp !== undefined) {
        fetchOptions = {
          after: snowflakeFromTimestamp(sinceTimestamp),
          limit: CHECK_NEW_MESSAGES_LIMIT,
        };
      } else if (highwater) {
        fetchOptions = { after: highwater, limit: CHECK_NEW_MESSAGES_LIMIT };
      } else {
        fetchOptions = { limit: FIRST_RUN_LIMIT };
      }

      const fetched = await channel.messages.fetch(fetchOptions);
      const messages = [...fetched.values()].sort(
        (left, right) => left.createdTimestamp - right.createdTimestamp,
      );

      if (messages.length === 0) {
        continue;
      }

      opts.messageChannelCache.setMany(
        messages.map((message) => ({ messageId: message.id, channelId })),
      );

      const newest = messages[messages.length - 1];
      highwaterUpdates[channelId] = newest.id;

      const channelDisplayName = channelName(channel, nameFromList);
      const summaries: MessageSummary[] = messages.map((message) => ({
        message_id: message.id,
        channel: { name: channelDisplayName, id: channelId },
        author: message.author.username,
        timestamp: message.createdAt.toISOString(),
        preview: formatMessagePreview(message.content),
        attachments: [...message.attachments.values()].map((attachment) => ({
          filename: attachment.name ?? 'unknown',
          contentType: attachment.contentType ?? 'unknown',
          size: attachment.size,
        })),
        mentions_bot: !!botUserId && message.mentions.has?.(botUserId) === true,
        is_self: !!botUserId && message.author.id === botUserId,
      }));

      groups.push({
        channel: { name: channelDisplayName, id: channelId },
        message_count: summaries.length,
        messages: summaries,
      });
    } catch {
      continue;
    }
  }

  if (groups.length === 0) {
    return toResponse({ channels: [], total_new_messages: 0 });
  }

  const response = await opts.sanitizeAndFormat({
    content: buildSidecarText(groups),
    schema: 'socialFeedBatch',
    context: `New Discord messages across ${groups.length} channel(s)`,
    source: 'discord:check_new_messages',
  });

  if (response.isError) {
    return response;
  }

  if (Object.keys(highwaterUpdates).length > 0) {
    const updatedState = updateMultipleHighwaters(state, highwaterUpdates);
    await saveHighwater(opts.stateFilePath, updatedState);
  }

  return response;
}
