import { formatRelativeTime } from './relative-time.js';

export const MAX_PREVIEW_OUTPUT_CHARS = 10_000;
export const DEFAULT_PER_CHANNEL_LIMIT = 3;
export const MAX_PER_CHANNEL_LIMIT = 10;
export const MIN_PER_CHANNEL_LIMIT = 1;
export const PREVIEW_TEXT_MAX = 100;
export const AUTHOR_MAX = 16;

export interface PreviewMessageInput {
  id: string;
  authorUsername: string;
  authorIsBot: boolean;
  webhookId: string | null;
  content: string;
  createdAt: Date;
  hasAttachments: boolean;
  replyToMessageId: string | null;
  replyToUsername: string | null;
}

export interface PreviewChannelGroup {
  channelId: string;
  channelName: string;
  humanMessages: PreviewMessageInput[];
  totalHumanNew: number;
  botMessageCount: number;
  newestHumanTimestampMs: number;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateWithEllipsis(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max - 1)}…`;
}

function renderGroupBlock(group: PreviewChannelGroup): string {
  const lines = [
    `#${group.channelName} (${group.totalHumanNew} new)`,
    ...group.humanMessages.map((message) => formatPreviewMessage(message)),
  ];

  const hiddenHumanCount = Math.max(0, group.totalHumanNew - group.humanMessages.length);
  if (hiddenHumanCount > 0) {
    lines.push(`  (+${hiddenHumanCount} more — use read_channel)`);
  }

  if (group.botMessageCount > 0) {
    lines.push(`  (+${group.botMessageCount} bot posts hidden)`);
  }

  return lines.join('\n');
}

function renderPreview(groups: PreviewChannelGroup[]): string {
  const totalHumanNew = groups.reduce((sum, group) => sum + group.totalHumanNew, 0);
  const blocks = groups.map((group) => renderGroupBlock(group));
  const header = `[Discord preview | ${totalHumanNew} new across ${groups.length} channels]`;

  if (blocks.length === 0) {
    return header;
  }

  return `${header}\n${blocks.join('\n\n')}`;
}

function renderWithFooter(groups: PreviewChannelGroup[], droppedCount: number): string {
  const rendered = renderPreview(groups);
  if (droppedCount > 0) {
    return `${rendered}\n\n(+${droppedCount} channels not shown)`;
  }

  return rendered;
}

export function formatPreviewMessage(msg: PreviewMessageInput): string {
  const relativeTime = formatRelativeTime(msg.createdAt);
  const author = truncateAuthor(msg.authorUsername, AUTHOR_MAX);
  const previewText = truncatePreviewText(msg.content, PREVIEW_TEXT_MAX);
  const suffixes: string[] = [];

  if (msg.hasAttachments) {
    suffixes.push('📎');
  }

  if (msg.replyToMessageId) {
    suffixes.push(msg.replyToUsername ? `↳ @${msg.replyToUsername}` : '↳');
  }

  const suffix = suffixes.length > 0 ? ` ${suffixes.join(' ')}` : '';
  return `  ${relativeTime}  ${author}  ${previewText}${suffix}`;
}

export function isBotMessage(msg: PreviewMessageInput): boolean {
  return msg.authorIsBot || msg.webhookId != null;
}

export function buildPreviewOutput(
  groups: PreviewChannelGroup[],
  opts: { maxChars: number },
): string {
  const visibleGroups = orderChannelGroups(groups.filter((group) => group.humanMessages.length > 0));

  if (visibleGroups.length === 0) {
    return 'No new Discord messages.';
  }

  let shownGroups = visibleGroups.slice();
  let droppedCount = 0;

  while (shownGroups.length > 0 && renderWithFooter(shownGroups, droppedCount).length > opts.maxChars) {
    shownGroups = shownGroups.slice(0, -1);
    droppedCount += 1;
  }

  return renderWithFooter(shownGroups, droppedCount);
}

export function orderChannelGroups(groups: PreviewChannelGroup[]): PreviewChannelGroup[] {
  return groups
    .slice()
    .sort((left, right) => right.newestHumanTimestampMs - left.newestHumanTimestampMs);
}

export function truncatePreviewText(text: string, max: number): string {
  const normalized = normalizeText(text);
  if (!normalized) {
    return '(no text)';
  }

  return truncateWithEllipsis(normalized, max);
}

export function truncateAuthor(username: string, max: number): string {
  const normalized = normalizeText(username);
  return truncateWithEllipsis(normalized, max);
}
