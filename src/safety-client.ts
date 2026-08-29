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

import { Agent, fetch as undiciFetch } from 'undici'

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

type SidecarFetch = typeof undiciFetch

// Transport seam. Production always uses undici's own `fetch`: globalThis.fetch
// belongs to Node's separate undici realm and ignores the `dispatcher` above, so
// this module must never read it (the realm diagnosis that introduced the
// explicit undici import). Tests swap the seam instead.
let sidecarFetch: SidecarFetch = undiciFetch

/**
 * Test-only transport seam. Returns a restore function; callers must invoke it
 * (node:test `t.after(...)`) so an override cannot leak into another test.
 */
export function __setSidecarFetchForTests(impl: SidecarFetch): () => void {
  const previous = sidecarFetch
  sidecarFetch = impl
  return () => {
    sidecarFetch = previous
  }
}

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
// This process's own fault: on undici 8.10.0's request path each of these codes
// is thrown by argument/header validation or by a dispatcher guard that rejects
// the dispatch before a client is selected, so the request was never sent.
// Deliberately absent: UND_ERR_DESTROYED (several throw paths fail a connected
// socket or an already-queued request), UND_ERR_INVALID_RETURN_VALUE and
// UND_ERR_REQ_CONTENT_LENGTH_MISMATCH (thrown after a response, or while the
// request body is on the wire), and every remote/socket/response/proxy/parser/
// abort code — those belong to the sidecar, the network, or nobody in particular.
const CLIENT_FAULT_CODES = new Set([
  'UND_ERR_INVALID_ARG',
  'UND_ERR_NOT_SUPPORTED',
  'UND_ERR_CLOSED',
  'UND_ERR_BPL_MISSING_UPSTREAM',
  'UND_ERR_MAX_ORIGINS_REACHED',
])

/**
 * Compose the user-visible text for a failed transport attempt.
 *
 * Locus discipline: only the timeout and unreachable classes have earned the
 * right to name the sidecar as the cause, and only the client-fault class may
 * name this process. Everything else is a symptom whose cause is unknown, so
 * the residual string names the operation and attributes fault to no one.
 *
 * Exported for tests, like DEFAULT_SAFETY_TIMEOUT_MS.
 */
export function describeRequestFailure(
  err: unknown,
  ctx: { aborted: boolean; payloadChars: number; elapsedMs: number }
): string {
  const { aborted, payloadChars, elapsedMs } = ctx
  const message = err instanceof Error ? err.message : 'unknown'
  if (aborted) {
    return `Safety review exceeded timeout (payload: ${payloadChars} chars, elapsed: ${elapsedMs}ms) — sidecar likely still processing a large payload; try a smaller scope`
  }
  const code = findErrorCode(err)
  if (code !== undefined && TIMEOUT_CODES.has(code)) {
    return `Safety sidecar timed out mid-processing (${code}, payload: ${payloadChars} chars, elapsed: ${elapsedMs}ms) — sidecar is up but slow on a large payload; try a smaller scope`
  }
  if (code !== undefined && UNREACHABLE_CODES.has(code)) {
    return `Safety sidecar unreachable (${code}): ${message}`
  }
  if (code !== undefined && CLIENT_FAULT_CODES.has(code)) {
    return `Discord-reader client-side request fault (${code}): ${message} — request never reached the safety sidecar`
  }
  return `Safety review request failed${code !== undefined ? ` (${code})` : ''}: ${message}`
}

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
    const res = await sidecarFetch(`${SIDECAR_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
      signal: controller.signal,
      dispatcher,
    })
    return await res.json() as SidecarResponse
  } catch (err) {
    return {
      ok: false,
      error: describeRequestFailure(err, {
        aborted: controller.signal.aborted,
        payloadChars: requestBody.length,
        elapsedMs: Date.now() - startedAt,
      }),
    }
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
