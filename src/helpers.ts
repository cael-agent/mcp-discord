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
export const VALID_BUTTON_STYLES = ['primary', 'secondary', 'success', 'danger'] as const;
export type ButtonStyleName = (typeof VALID_BUTTON_STYLES)[number];
export type ButtonInput = {
  id: string;
  label: string;
  style: ButtonStyleName;
};

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

export function parseOptionalTimestamp(rawValue: unknown, fieldName = 'since'): number | undefined {
  if (rawValue === undefined || rawValue === null) {
    return undefined;
  }

  if (typeof rawValue !== 'string') {
    throw new Error(`${fieldName} must be an ISO 8601 timestamp string`);
  }

  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${fieldName} must be a valid ISO 8601 timestamp`);
  }

  return parsed.getTime();
}

export function validateButtons(buttons: unknown): ButtonInput[] {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    throw new Error('buttons must be a non-empty array');
  }

  if (buttons.length > 5) {
    throw new Error('buttons must have at most 5 entries (Discord limit)');
  }

  const seenIds = new Set<string>();
  const validated: ButtonInput[] = [];

  for (const button of buttons) {
    if (typeof button !== 'object' || button === null) {
      throw new Error('each button must be an object with id, label, and style');
    }

    const { id, label, style } = button as Record<string, unknown>;

    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('each button must have a non-empty string id');
    }

    if (id.length > 100) {
      throw new Error(`button id "${id.slice(0, 20)}..." exceeds 100 character limit`);
    }

    const normalizedId = id.trim();
    if (seenIds.has(normalizedId)) {
      throw new Error(`duplicate button id: "${normalizedId}"`);
    }
    seenIds.add(normalizedId);

    if (typeof label !== 'string' || label.trim() === '') {
      throw new Error('each button must have a non-empty string label');
    }

    if (label.length > 80) {
      throw new Error(`button label "${label.slice(0, 20)}..." exceeds 80 character limit`);
    }

    if (typeof style !== 'string' || !VALID_BUTTON_STYLES.includes(style as ButtonStyleName)) {
      throw new Error(`button style must be one of: ${VALID_BUTTON_STYLES.join(', ')}`);
    }

    validated.push({ id: normalizedId, label, style: style as ButtonStyleName });
  }

  return validated;
}

export type EmbedFieldInput = {
  name: string;
  value: string;
  inline: boolean;
};

export function validateEmbedFields(rawFields: unknown): EmbedFieldInput[] | undefined {
  if (rawFields === undefined || rawFields === null) {
    return undefined;
  }

  if (!Array.isArray(rawFields)) {
    throw new Error('fields must be an array');
  }

  if (rawFields.length > 25) {
    throw new Error('fields must have at most 25 entries (Discord limit)');
  }

  const validated: EmbedFieldInput[] = [];

  for (const field of rawFields) {
    if (typeof field !== 'object' || field === null) {
      throw new Error('each field must be an object with name and value');
    }

    const { name, value, inline } = field as Record<string, unknown>;

    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error('each field must have a non-empty string name');
    }

    if (name.length > 256) {
      throw new Error(`field name "${name.slice(0, 20)}..." exceeds 256 character limit`);
    }

    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error('each field must have a non-empty string value');
    }

    if (value.length > 1024) {
      throw new Error(`field value for "${name.slice(0, 20)}" exceeds 1024 character limit`);
    }

    if (inline !== undefined && typeof inline !== 'boolean') {
      throw new Error('field inline must be a boolean');
    }

    validated.push({ name, value, inline: inline === true });
  }

  return validated;
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
