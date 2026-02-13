#!/usr/bin/env node

import { stat } from 'node:fs/promises';
import path from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ActivityType,
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  type Message,
  type PresenceStatusData,
  type TextBasedChannel,
} from 'discord.js';

import {
  clampMessageLimit,
  clampTimeoutSeconds,
  MAX_DISCORD_FILE_SIZE_BYTES,
  MentionTracker,
  parseHexColor,
  requireString,
  resolveChannelId,
  validateDiscordMessageText,
  type TrackedMention,
} from './helpers.js';
import { tools } from './tools/index.js';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error('Error: DISCORD_TOKEN environment variable is required');
  process.exit(1);
}

const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
if (!DISCORD_GUILD_ID) {
  console.error('Error: DISCORD_GUILD_ID environment variable is required');
  process.exit(1);
}

const CHANNEL_MAP: Record<string, string> = {
  cael: process.env.DISCORD_CHANNEL_CAEL || '1470158584552755220',
  general: process.env.DISCORD_CHANNEL_GENERAL || '1471816633944244379',
  'tool-requests': process.env.DISCORD_CHANNEL_TOOL_REQUESTS || '1471816682527002686',
  logs: process.env.DISCORD_CHANNEL_LOGS || '1471816703834063023',
};

type PendingQuestion = {
  messageId: string;
  channelId: string;
  timestamp: number;
  question: string;
};

type StoredReply = {
  reply: string;
  author: string;
  timestamp: number;
};

type JsonRpcResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

type SendableMessageChannel = TextBasedChannel & {
  send: (options: unknown) => Promise<Message>;
  messages: {
    fetch: (options: unknown) => Promise<unknown>;
  };
};

const STATUS_VALUES = new Set<PresenceStatusData>(['online', 'idle', 'dnd', 'invisible']);
const ACTIVITY_TYPE_MAP = {
  playing: ActivityType.Playing,
  watching: ActivityType.Watching,
  listening: ActivityType.Listening,
  competing: ActivityType.Competing,
} as const;

const NOTIFICATION_EMOJI: Record<'info' | 'success' | 'warning' | 'error', string> = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  error: '❌',
};

const pendingQuestions = new Map<string, PendingQuestion>();
const replies = new Map<string, StoredReply>();
const mentionTracker = new MentionTracker();

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

discord.on('messageCreate', (message) => {
  if (message.author.bot) {
    return;
  }

  const referencedId = message.reference?.messageId;
  if (referencedId && pendingQuestions.has(referencedId)) {
    replies.set(referencedId, {
      reply: message.content,
      author: message.author.username,
      timestamp: message.createdTimestamp,
    });
  }

  if (discord.user && message.mentions.has(discord.user)) {
    const channelName =
      message.channel.type === ChannelType.DM
        ? 'dm'
        : 'name' in message.channel && typeof message.channel.name === 'string'
          ? message.channel.name
          : 'unknown';

    const trackedMention: TrackedMention = {
      messageId: message.id,
      channelId: message.channelId,
      channelName,
      author: message.author.username,
      content: message.content,
      timestamp: message.createdTimestamp,
    };

    mentionTracker.addMention(trackedMention, message.createdTimestamp);
  }
});

function toResponse(payload: unknown): JsonRpcResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

function toErrorResponse(error: unknown): JsonRpcResponse {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

function asRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') {
    return {};
  }

  return input as Record<string, unknown>;
}

function parseOptionalString(rawValue: unknown, fieldName: string): string | undefined {
  if (rawValue === undefined || rawValue === null) {
    return undefined;
  }

  if (typeof rawValue !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  const trimmed = rawValue.trim();
  return trimmed || undefined;
}

function parseStatus(rawValue: unknown): PresenceStatusData {
  const status = requireString(rawValue, 'status').toLowerCase();
  if (!STATUS_VALUES.has(status as PresenceStatusData)) {
    throw new Error('status must be one of: online, idle, dnd, invisible');
  }

  return status as PresenceStatusData;
}

function parseNotificationType(rawValue: unknown): 'info' | 'success' | 'warning' | 'error' {
  if (rawValue === undefined || rawValue === null) {
    return 'info';
  }

  const value = requireString(rawValue, 'type').toLowerCase();
  if (value !== 'info' && value !== 'success' && value !== 'warning' && value !== 'error') {
    throw new Error('type must be one of: info, success, warning, error');
  }

  return value;
}

function parseActivityType(
  rawValue: unknown
): keyof typeof ACTIVITY_TYPE_MAP {
  if (rawValue === undefined || rawValue === null) {
    return 'playing';
  }

  const value = requireString(rawValue, 'activity_type').toLowerCase();
  if (!(value in ACTIVITY_TYPE_MAP)) {
    throw new Error('activity_type must be one of: playing, watching, listening, competing');
  }

  return value as keyof typeof ACTIVITY_TYPE_MAP;
}

function toSendableMessageChannel(channel: TextBasedChannel): SendableMessageChannel {
  const candidate = channel as Partial<SendableMessageChannel>;

  if (typeof candidate.send !== 'function') {
    throw new Error(`Channel ${channel.id} does not support sending messages`);
  }

  if (!candidate.messages || typeof candidate.messages.fetch !== 'function') {
    throw new Error(`Channel ${channel.id} does not support reading messages`);
  }

  return channel as SendableMessageChannel;
}

async function fetchTextChannelByInput(rawChannel: unknown): Promise<SendableMessageChannel> {
  const channelInput = requireString(rawChannel, 'channel');
  const channelId = resolveChannelId(channelInput, CHANNEL_MAP);

  const channel = await discord.channels.fetch(channelId);
  if (!channel) {
    throw new Error(`Channel not found: ${channelId}`);
  }

  if (!channel.isTextBased()) {
    throw new Error(`Channel ${channelId} is not text-based`);
  }

  return toSendableMessageChannel(channel);
}

async function fetchMessageFromChannel(
  rawChannel: unknown,
  rawMessageId: unknown
): Promise<{ channel: SendableMessageChannel; message: Message }> {
  const channel = await fetchTextChannelByInput(rawChannel);
  const messageId = requireString(rawMessageId, 'message_id');

  const message = (await channel.messages.fetch(messageId)) as Message;
  if (!message) {
    throw new Error(`Message not found: ${messageId}`);
  }

  return { channel, message };
}

async function parseAndValidateImagePath(rawImagePath: unknown): Promise<string> {
  const imagePath = requireString(rawImagePath, 'image_path');

  if (!path.isAbsolute(imagePath)) {
    throw new Error('image_path must be an absolute path');
  }

  let details;
  try {
    details = await stat(imagePath);
  } catch {
    throw new Error(`image_path does not exist: ${imagePath}`);
  }

  if (!details.isFile()) {
    throw new Error(`image_path is not a file: ${imagePath}`);
  }

  if (details.size > MAX_DISCORD_FILE_SIZE_BYTES) {
    throw new Error('image file exceeds Discord 25MB upload limit');
  }

  return imagePath;
}

function formatMessages(messages: Message[]): unknown[] {
  return messages.map((message) => ({
    message_id: message.id,
    author: message.author.username,
    author_id: message.author.id,
    content: message.content,
    timestamp: message.createdAt.toISOString(),
    attachments: [...message.attachments.values()].map((attachment) => attachment.url),
    embeds: message.embeds
      .map((embed) => ({
        title: embed.title ?? undefined,
        description: embed.description ?? undefined,
        url: embed.url ?? undefined,
      }))
      .filter((embed) => embed.title || embed.description || embed.url),
    is_reply_to: message.reference?.messageId ?? undefined,
  }));
}

function consumeReply(messageId: string): StoredReply | undefined {
  const reply = replies.get(messageId);
  if (!reply) {
    return undefined;
  }

  pendingQuestions.delete(messageId);
  replies.delete(messageId);
  return reply;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const server = new Server(
  {
    name: 'mcp-discord-cael',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = asRecord(request.params.arguments);

  try {
    switch (name) {
      case 'send_message': {
        const channel = await fetchTextChannelByInput(args.channel);
        const text = validateDiscordMessageText(args.text, 'text');

        const sent = await channel.send(text);
        return toResponse({ success: true, message_id: sent.id });
      }

      case 'send_dm': {
        const userId = requireString(args.user_id, 'user_id');
        const text = validateDiscordMessageText(args.text, 'text');

        const user = await discord.users.fetch(userId);
        const sent = await user.send(text);

        return toResponse({ success: true, message_id: sent.id });
      }

      case 'send_embed': {
        const channel = await fetchTextChannelByInput(args.channel);
        const title = requireString(args.title, 'title');
        const description = requireString(args.description, 'description');
        const url = parseOptionalString(args.url, 'url');
        const imageUrl = parseOptionalString(args.image_url, 'image_url');
        const color = parseHexColor(args.color);

        const embed = new EmbedBuilder().setTitle(title).setDescription(description);
        if (url) {
          embed.setURL(url);
        }
        if (imageUrl) {
          embed.setImage(imageUrl);
        }
        if (color !== undefined) {
          embed.setColor(color);
        }

        const sent = await channel.send({ embeds: [embed] });
        return toResponse({ success: true, message_id: sent.id });
      }

      case 'send_image': {
        const channel = await fetchTextChannelByInput(args.channel);
        const imagePath = await parseAndValidateImagePath(args.image_path);
        const caption =
          args.caption === undefined ? undefined : validateDiscordMessageText(args.caption, 'caption');

        const attachment = new AttachmentBuilder(imagePath);
        const sent = await channel.send({
          content: caption,
          files: [attachment],
        });

        return toResponse({ success: true, message_id: sent.id });
      }

      case 'reply': {
        const channel = await fetchTextChannelByInput(args.channel);
        const messageId = requireString(args.message_id, 'message_id');
        const text = validateDiscordMessageText(args.text, 'text');

        const sent = await channel.send({
          content: text,
          reply: {
            messageReference: messageId,
          },
        });

        return toResponse({ success: true, message_id: sent.id });
      }

      case 'read_channel': {
        const channel = await fetchTextChannelByInput(args.channel);
        const limit = clampMessageLimit(args.limit);

        const fetched = (await channel.messages.fetch({ limit })) as Map<string, Message>;
        const messages = [...fetched.values()].sort(
          (left, right) => left.createdTimestamp - right.createdTimestamp
        );

        return toResponse(formatMessages(messages));
      }

      case 'read_dms': {
        const userId = requireString(args.user_id, 'user_id');
        const limit = clampMessageLimit(args.limit);

        const user = await discord.users.fetch(userId);
        const dmChannel = await user.createDM();
        const fetched = await dmChannel.messages.fetch({ limit });
        const messages = [...fetched.values()].sort(
          (left, right) => left.createdTimestamp - right.createdTimestamp
        );

        return toResponse(formatMessages(messages));
      }

      case 'react': {
        const { message } = await fetchMessageFromChannel(args.channel, args.message_id);
        const emoji = requireString(args.emoji, 'emoji');

        await message.react(emoji);
        return toResponse({ success: true });
      }

      case 'create_thread': {
        const { message } = await fetchMessageFromChannel(args.channel, args.message_id);
        const threadName = requireString(args.name, 'name');

        if (!message.guildId) {
          throw new Error('Threads can only be created from guild messages');
        }

        const thread = await message.startThread({ name: threadName });
        return toResponse({ success: true, thread_id: thread.id });
      }

      case 'set_status': {
        const status = parseStatus(args.status);
        const activityText = parseOptionalString(args.activity_text, 'activity_text');

        if (!discord.user) {
          throw new Error('Discord client is not ready');
        }

        if (!activityText) {
          await discord.user.setPresence({ status });
          return toResponse({ success: true });
        }

        const activityType = parseActivityType(args.activity_type);
        await discord.user.setPresence({
          status,
          activities: [
            {
              name: activityText,
              type: ACTIVITY_TYPE_MAP[activityType],
            },
          ],
        });

        return toResponse({ success: true });
      }

      case 'list_channels': {
        const guild = await discord.guilds.fetch(DISCORD_GUILD_ID);
        const fetchedChannels = await guild.channels.fetch();

        const results = [...fetchedChannels.values()]
          .filter((channel): channel is NonNullable<typeof channel> => channel !== null)
          .filter((channel) => channel.isTextBased())
          .map((channel) => {
            const rawChannel = channel as any;

            let category: string | null = null;
            if (
              rawChannel.parent?.type === ChannelType.GuildCategory &&
              typeof rawChannel.parent.name === 'string'
            ) {
              category = rawChannel.parent.name;
            } else if (
              rawChannel.parent?.parent?.type === ChannelType.GuildCategory &&
              typeof rawChannel.parent.parent.name === 'string'
            ) {
              category = rawChannel.parent.parent.name;
            }

            const topic = typeof rawChannel.topic === 'string' ? rawChannel.topic : null;
            const name = typeof rawChannel.name === 'string' ? rawChannel.name : channel.id;

            return {
              id: channel.id,
              name,
              category,
              topic,
            };
          })
          .sort((left, right) => left.name.localeCompare(right.name));

        return toResponse(results);
      }

      case 'check_mentions': {
        const sinceRaw = args.since;
        if (sinceRaw !== undefined && typeof sinceRaw !== 'string') {
          throw new Error('since must be an ISO 8601 timestamp string');
        }

        const mentions = mentionTracker.getMentions(sinceRaw);
        return toResponse(mentions);
      }

      case 'send_question': {
        const channel = await fetchTextChannelByInput(args.channel ?? 'general');
        const question = validateDiscordMessageText(args.question, 'question');

        const sent = await channel.send(question);

        pendingQuestions.set(sent.id, {
          messageId: sent.id,
          channelId: channel.id,
          timestamp: Date.now(),
          question,
        });

        return toResponse({
          success: true,
          message_id: sent.id,
          hint: 'Use check_reply or wait_for_reply with this message_id',
        });
      }

      case 'check_reply': {
        const messageId = requireString(args.message_id, 'message_id');

        if (!pendingQuestions.has(messageId)) {
          return toResponse({ error: 'Unknown message_id - was this question sent in this session?' });
        }

        const reply = consumeReply(messageId);
        if (!reply) {
          return toResponse({
            has_reply: false,
            waiting_since: pendingQuestions.get(messageId)?.timestamp,
          });
        }

        return toResponse({
          has_reply: true,
          reply: reply.reply,
          author: reply.author,
          timestamp: reply.timestamp,
        });
      }

      case 'wait_for_reply': {
        const messageId = requireString(args.message_id, 'message_id');
        const timeoutSeconds = clampTimeoutSeconds(args.timeout_seconds);

        if (!pendingQuestions.has(messageId)) {
          return toResponse({ error: 'Unknown message_id' });
        }

        const startedAt = Date.now();
        const pollMs = 2_000;

        while (Date.now() - startedAt < timeoutSeconds * 1000) {
          if (!pendingQuestions.has(messageId)) {
            return toResponse({ error: 'Unknown message_id' });
          }

          const reply = consumeReply(messageId);
          if (reply) {
            return toResponse({
              has_reply: true,
              reply: reply.reply,
              author: reply.author,
              timestamp: reply.timestamp,
            });
          }

          await sleep(pollMs);
        }

        return toResponse({
          has_reply: false,
          timed_out: true,
          waited_seconds: timeoutSeconds,
        });
      }

      case 'send_notification': {
        const channel = await fetchTextChannelByInput(args.channel ?? 'logs');
        const message = validateDiscordMessageText(args.message, 'message');
        const type = parseNotificationType(args.type);

        await channel.send(`${NOTIFICATION_EMOJI[type]} ${message}`);
        return toResponse({ success: true });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return toErrorResponse(error);
  }
});

async function main(): Promise<void> {
  await discord.login(DISCORD_TOKEN);
  console.error(`Discord bot logged in as ${discord.user?.tag ?? 'unknown'}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Discord MCP server running');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
