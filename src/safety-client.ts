/**
 * Safety sidecar client — copy this file into your MCP server.
 *
 * Usage:
 *   import { sanitize, prefilter } from './safety-client.js'
 *
 *   const result = await sanitize({
 *     content: rawContent,
 *     schema: 'socialFeedBatch',
 *     context: 'Discord messages from #general',
 *     source: 'discord:channel:123',
 *   })
 *
 *   if (!result.ok) {
 *     return { content: [{ type: 'text', text: `[Safety error: ${result.error}]` }] }
 *   }
 */

import { Agent } from 'undici'

const SIDECAR_URL = process.env.SAFETY_SIDECAR_URL ?? 'http://safety-sidecar:3100'
// Sidecar retry ceiling is READER_TIMEOUT_MS x 2 attempts + ~5s retry delay.
// Keep the client above that, with some buffer for transport and JSON parsing.
// Default pairing: READER_TIMEOUT_MS=240000 → ceiling ~485s → 520s here.
// free-agent's docker-compose.yml overrides the pair: READER_TIMEOUT_MS=420000 →
// ceiling ~845s → SAFETY_TIMEOUT_MS=900000 (inherited from the container env).
export const DEFAULT_SAFETY_TIMEOUT_MS = 520_000
const TIMEOUT_MS = Number(process.env.SAFETY_TIMEOUT_MS) || DEFAULT_SAFETY_TIMEOUT_MS

// Node's default fetch dispatcher enforces headersTimeout/bodyTimeout of 300s.
// The sidecar holds the HTTP response open until its Reader finishes (minutes on
// large payloads), so the 300s default silently undercut TIMEOUT_MS and surfaced
// as a generic "fetch failed" that the catch-all mislabeled "unreachable"
// (free-agent diagnosis 2026-08-03 §1). Disable both so the AbortController below
// is the single timeout authority.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

/**
 * Walk err.cause chains looking for a syscall/undici error code.
 * fetch() failures arrive as TypeError('fetch failed') with the real error
 * (e.g. code ECONNREFUSED or UND_ERR_HEADERS_TIMEOUT) nested in `cause`.
 */
function findErrorCode(err: unknown, depth = 0): string | undefined {
  if (depth > 4 || typeof err !== 'object' || err === null) return undefined
  const candidate = err as { code?: unknown; cause?: unknown }
  if (typeof candidate.code === 'string') return candidate.code
  return findErrorCode(candidate.cause, depth + 1)
}

// Transport died while the sidecar was (likely) still processing.
const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT'])
// Could not reach the sidecar at all.
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
])

type SanitizeRequest = {
  content: string
  schema: string
  context: string
  source: string
}

type PrefilterRequest = {
  content: string
  source: string
}

type SidecarResponse = { ok: true; [key: string]: unknown } | { ok: false; error: string; [key: string]: unknown }

async function post(path: string, body: unknown): Promise<SidecarResponse> {
  const controller = new AbortController()
  const requestBody = JSON.stringify(body)
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const startedAt = Date.now()
  try {
    const res = await fetch(`${SIDECAR_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
      signal: controller.signal,
      dispatcher,
    } as RequestInit)
    return await res.json() as SidecarResponse
  } catch (err) {
    const elapsed = Date.now() - startedAt
    const message = err instanceof Error ? err.message : 'unknown'
    if (controller.signal.aborted) {
      return {
        ok: false,
        error: `Safety review exceeded timeout (payload: ${requestBody.length} chars, elapsed: ${elapsed}ms) — sidecar likely still processing a large payload; try a smaller scope`,
      }
    }
    const code = findErrorCode(err)
    if (code !== undefined && TIMEOUT_CODES.has(code)) {
      return {
        ok: false,
        error: `Safety sidecar timed out mid-processing (${code}, payload: ${requestBody.length} chars, elapsed: ${elapsed}ms) — sidecar is up but slow on a large payload; try a smaller scope`,
      }
    }
    if (code !== undefined && UNREACHABLE_CODES.has(code)) {
      return { ok: false, error: `Safety sidecar unreachable (${code}): ${message}` }
    }
    return { ok: false, error: `Safety sidecar request failed${code !== undefined ? ` (${code})` : ''}: ${message}` }
  } finally {
    clearTimeout(timeout)
  }
}

export async function sanitize(req: SanitizeRequest): Promise<SidecarResponse> {
  return post('/sanitize', req)
}

export async function prefilter(req: PrefilterRequest): Promise<SidecarResponse> {
  return post('/prefilter', req)
}
