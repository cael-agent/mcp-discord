export interface TrackedMention {
  messageId: string;
  channelId: string;
  channelName: string;
  author: string;
  content: string;
  timestamp: number;
}

export type ChannelMap = Record<string, string>;

type ClampOptions = {
  fieldName: string;
  defaultValue: number;
  min: number;
  max: number;
};

const SNOWFLAKE_RE = /^\d{17,20}$/;

export const DEFAULT_MESSAGE_LIMIT = 20;
export const MAX_MESSAGE_LIMIT = 50;
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MAX_TIMEOUT_SECONDS = 3600;
export const MAX_MENTION_AGE_MS = 48 * 60 * 60 * 1000;
export const MAX_DISCORD_MESSAGE_LENGTH = 2000;
export const MAX_DISCORD_FILE_SIZE_BYTES = 25 * 1024 * 1024;

export function resolveChannelId(input: string, channelMap: ChannelMap): string {
  const value = input.trim();
  if (!value) {
    throw new Error('channel must not be empty');
  }

  const normalized = value.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(channelMap, normalized)) {
    return channelMap[normalized];
  }

  if (SNOWFLAKE_RE.test(value)) {
    return value;
  }

  const available = Object.keys(channelMap).sort();
  throw new Error(`Unknown channel "${value}". Available channels: ${available.join(', ')}`);
}

export function clampPositiveInt(rawValue: unknown, options: ClampOptions): number {
  const { fieldName, defaultValue, min, max } = options;

  if (rawValue === undefined || rawValue === null) {
    return defaultValue;
  }

  if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
    throw new Error(`${fieldName} must be a number`);
  }

  const rounded = Math.floor(rawValue);
  if (rounded < min) {
    throw new Error(`${fieldName} must be at least ${min}`);
  }

  if (rounded > max) {
    return max;
  }

  return rounded;
}

export function clampMessageLimit(rawValue: unknown): number {
  return clampPositiveInt(rawValue, {
    fieldName: 'limit',
    defaultValue: DEFAULT_MESSAGE_LIMIT,
    min: 1,
    max: MAX_MESSAGE_LIMIT,
  });
}

export function clampTimeoutSeconds(rawValue: unknown): number {
  return clampPositiveInt(rawValue, {
    fieldName: 'timeout_seconds',
    defaultValue: DEFAULT_TIMEOUT_SECONDS,
    min: 1,
    max: MAX_TIMEOUT_SECONDS,
  });
}

export function parseHexColor(rawValue: unknown): number | undefined {
  if (rawValue === undefined || rawValue === null) {
    return undefined;
  }

  if (typeof rawValue !== 'string') {
    throw new Error('color must be a string');
  }

  const value = rawValue.trim();
  if (!value) {
    throw new Error('color must not be empty');
  }

  const normalized = value.startsWith('#') ? value.slice(1) : value;
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error('color must be a 6-digit hex value like #5865F2');
  }

  return Number.parseInt(normalized, 16);
}

export function requireString(rawValue: unknown, fieldName: string): string {
  if (typeof rawValue !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} must not be empty`);
  }

  return trimmed;
}

export function validateDiscordMessageText(rawValue: unknown, fieldName: string): string {
  if (typeof rawValue !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  if (!rawValue.trim()) {
    throw new Error(`${fieldName} must not be empty`);
  }

  if (rawValue.length > MAX_DISCORD_MESSAGE_LENGTH) {
    throw new Error(`${fieldName} exceeds Discord's ${MAX_DISCORD_MESSAGE_LENGTH} character limit`);
  }

  return rawValue;
}

export class MentionTracker {
  private mentions: TrackedMention[] = [];

  constructor(private readonly maxAgeMs: number = MAX_MENTION_AGE_MS) {}

  addMention(mention: TrackedMention, now = Date.now()): void {
    this.cleanup(now);
    this.mentions.push(mention);
  }

  getMentions(since?: string): TrackedMention[] {
    let sinceTimestamp = Number.NEGATIVE_INFINITY;

    if (since !== undefined) {
      const parsed = new Date(since);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error('since must be a valid ISO 8601 timestamp');
      }

      sinceTimestamp = parsed.getTime();
    }

    return this.mentions
      .filter((mention) => mention.timestamp >= sinceTimestamp)
      .sort((left, right) => left.timestamp - right.timestamp);
  }

  private cleanup(now: number): void {
    const cutoff = now - this.maxAgeMs;
    this.mentions = this.mentions.filter((mention) => mention.timestamp >= cutoff);
  }
}
