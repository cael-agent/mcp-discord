import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rename, rm, stat as fsStat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

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
  '.bmp',
]);

export const PDF_EXTENSIONS = new Set(['.pdf']);

export const MAX_FILE_SIZE = 25 * 1024 * 1024;
export const IMAGE_MAX_DIMENSION = 1024;
export const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const ALLOWED_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];

export const MAGIC_BYTES: Record<string, Array<{ offset: number; bytes: number[] }>> = {
  'image/png': [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  'image/jpeg': [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  'image/gif': [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }],
  'image/webp': [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  ],
  'image/bmp': [{ offset: 0, bytes: [0x42, 0x4d] }],
};

export type DownloadResult = {
  filename: string;
  localPath: string;
  size: number;
  contentType: string;
  downloaded: boolean;
  reason?: string;
  textContent?: string;
  isImage?: boolean;
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

export function isImageFile(filename: string, contentType: string): boolean {
  const ext = getExtension(filename);
  const baseContentType = contentTypeWithoutParameters(contentType);
  if (baseContentType === 'image/svg+xml' || ext === '.svg') return false;
  return IMAGE_EXTENSIONS.has(ext) || baseContentType.startsWith('image/');
}

export function isSupportedType(contentType: string, filename: string): boolean {
  const normalizedContentType = normalizeContentType(contentType);
  const baseContentType = contentTypeWithoutParameters(normalizedContentType);

  if (baseContentType === 'image/svg+xml') return false;
  const ext = getExtension(filename);
  if (ext === '.svg') return false;

  if (baseContentType && baseContentType !== 'application/octet-stream') {
    return (
      baseContentType.startsWith('text/') ||
      baseContentType.startsWith('image/') ||
      baseContentType === 'application/pdf'
    );
  }

  if (!ext) {
    return false;
  }

  return (
    TEXT_EXTENSIONS.has(ext) ||
    IMAGE_EXTENSIONS.has(ext) ||
    PDF_EXTENSIONS.has(ext)
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

export function validateUrl(url: string): void {
  const parsed = new URL(url);
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw new Error(`URL host "${parsed.hostname}" is not an allowed Discord CDN host`);
  }
}

export function validateMagicBytes(buffer: Buffer, contentType: string): void {
  const baseContentType = contentTypeWithoutParameters(contentType);
  const expected = MAGIC_BYTES[baseContentType];
  if (!expected) return;

  for (const check of expected) {
    if (buffer.length < check.offset + check.bytes.length) {
      throw new Error('file header does not match claimed type');
    }
    for (let i = 0; i < check.bytes.length; i++) {
      if (buffer[check.offset + i] !== check.bytes[i]) {
        throw new Error('file header does not match claimed type');
      }
    }
  }
}

export async function cleanupOldFiles(dir: string, maxAgeMs: number = TTL_MS): Promise<number> {
  let deleted = 0;
  try {
    const entries = await readdir(dir);
    const now = Date.now();

    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const filePath = path.join(dir, entry);
      try {
        const stats = await fsStat(filePath);
        if (stats.isFile() && (now - stats.mtimeMs) > maxAgeMs) {
          await rm(filePath, { force: true });
          deleted++;
        }
      } catch {
        // Skip files we can't stat or delete
      }
    }
  } catch {
    // Directory doesn't exist yet, nothing to clean
  }
  return deleted;
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
  await cleanupOldFiles(opts.attachmentsDir);

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

    try {
      validateUrl(attachment.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        filename: attachment.filename,
        localPath: '',
        size: attachment.size,
        contentType,
        downloaded: false,
        reason: message,
      });
      continue;
    }

    const imageFile = isImageFile(attachment.filename, contentType);
    const sanitizedFilename = sanitizeFilename(attachment.filename);
    const basePath = path.join(opts.attachmentsDir, `${opts.messageId}-${sanitizedFilename}`);
    const targetPath = await resolveCollision(basePath);
    const tempPath = path.join(opts.attachmentsDir, `.tmp-${randomUUID()}`);

    try {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      }

      let buffer: Buffer = Buffer.from(await response.arrayBuffer());

      if (buffer.length > MAX_FILE_SIZE) {
        throw new Error('actual download size exceeds 25 MB limit');
      }

      if (imageFile) {
        validateMagicBytes(buffer, contentType);

        buffer = await sharp(buffer)
          .rotate()
          .resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .toBuffer();
      }

      await writeFile(tempPath, buffer);
      await rename(tempPath, targetPath);

      const result: DownloadResult = {
        filename: attachment.filename,
        localPath: targetPath,
        size: buffer.length,
        contentType,
        downloaded: true,
        isImage: imageFile,
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
