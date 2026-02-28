import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.xml',
  '.html',
  '.css',
  '.js',
  '.ts',
  '.py',
  '.yaml',
  '.yml',
  '.toml',
  '.log',
  '.cfg',
  '.ini',
  '.sh',
  '.bash',
  '.env',
]);

export const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
]);

export const PDF_EXTENSIONS = new Set(['.pdf']);

export const MAX_FILE_SIZE = 25 * 1024 * 1024;

export type DownloadResult = {
  filename: string;
  localPath: string;
  size: number;
  contentType: string;
  downloaded: boolean;
  reason?: string;
  textContent?: string;
};

function normalizeContentType(contentType: string): string {
  return contentType.trim().toLowerCase();
}

function contentTypeWithoutParameters(contentType: string): string {
  return normalizeContentType(contentType).split(';', 1)[0]?.trim() ?? '';
}

function getExtension(filename: string): string {
  return path.extname(filename).toLowerCase();
}

function isTextFile(filename: string, contentType: string): boolean {
  const ext = getExtension(filename);
  const normalizedContentType = contentTypeWithoutParameters(contentType);
  return TEXT_EXTENSIONS.has(ext) || normalizedContentType.startsWith('text/');
}

export function isSupportedType(contentType: string, filename: string): boolean {
  const normalizedContentType = normalizeContentType(contentType);
  const baseContentType = contentTypeWithoutParameters(normalizedContentType);

  if (baseContentType && baseContentType !== 'application/octet-stream') {
    return (
      baseContentType.startsWith('text/') ||
      baseContentType.startsWith('image/') ||
      baseContentType === 'application/pdf'
    );
  }

  const extension = getExtension(filename);
  if (!extension) {
    return false;
  }

  return (
    TEXT_EXTENSIONS.has(extension) ||
    IMAGE_EXTENSIONS.has(extension) ||
    PDF_EXTENSIONS.has(extension)
  );
}

export function sanitizeFilename(filename: string): string {
  const sanitized = filename
    .replace(/\.\.[/\\]/g, '')
    .replace(/[\/\\]/g, '')
    .replace(/[\0-\x1F]/g, '')
    .trim();

  if (!sanitized) {
    return 'unnamed';
  }

  if (sanitized.length <= 200) {
    return sanitized;
  }

  const extension = path.extname(sanitized);
  if (!extension) {
    return sanitized.slice(0, 200);
  }

  const baseName = sanitized.slice(0, -extension.length) || 'file';
  const maxBaseLength = 200 - extension.length;
  if (maxBaseLength <= 0) {
    return sanitized.slice(0, 200);
  }

  return `${baseName.slice(0, maxBaseLength)}${extension}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveCollision(filePath: string): Promise<string> {
  const parsed = path.parse(filePath);
  let candidate = filePath;
  let suffix = 2;

  while (await pathExists(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
    suffix += 1;
  }

  return candidate;
}

export async function downloadAttachments(opts: {
  messageId: string;
  attachments: Array<{
    url: string;
    filename: string;
    contentType: string | null;
    size: number;
  }>;
  attachmentsDir: string;
}): Promise<DownloadResult[]> {
  await mkdir(opts.attachmentsDir, { recursive: true });

  const results: DownloadResult[] = [];

  for (const attachment of opts.attachments) {
    const contentType = attachment.contentType ?? 'application/octet-stream';

    if (!isSupportedType(contentType, attachment.filename)) {
      results.push({
        filename: attachment.filename,
        localPath: '',
        size: attachment.size,
        contentType,
        downloaded: false,
        reason: `unsupported file type: ${contentType}`,
      });
      continue;
    }

    if (attachment.size > MAX_FILE_SIZE) {
      results.push({
        filename: attachment.filename,
        localPath: '',
        size: attachment.size,
        contentType,
        downloaded: false,
        reason: 'exceeds 25 MB size limit',
      });
      continue;
    }

    const sanitizedFilename = sanitizeFilename(attachment.filename);
    const basePath = path.join(opts.attachmentsDir, `${opts.messageId}-${sanitizedFilename}`);
    const targetPath = await resolveCollision(basePath);
    const tempPath = path.join(opts.attachmentsDir, `.tmp-${randomUUID()}`);

    try {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(tempPath, buffer);
      await rename(tempPath, targetPath);

      const result: DownloadResult = {
        filename: attachment.filename,
        localPath: targetPath,
        size: attachment.size,
        contentType,
        downloaded: true,
      };

      if (isTextFile(attachment.filename, contentType)) {
        result.textContent = buffer.toString('utf8');
      }

      results.push(result);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});

      const message = error instanceof Error ? error.message : String(error);
      results.push({
        filename: attachment.filename,
        localPath: '',
        size: attachment.size,
        contentType,
        downloaded: false,
        reason: `download failed: ${message}`,
      });
    }
  }

  return results;
}
