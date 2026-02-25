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

const SIDECAR_URL = process.env.SAFETY_SIDECAR_URL ?? 'http://safety-sidecar:3100'
const TIMEOUT_MS = 60_000

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
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const res = await fetch(`${SIDECAR_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    return await res.json() as SidecarResponse
  } catch (err) {
    return { ok: false, error: `Safety sidecar unreachable: ${err instanceof Error ? err.message : 'unknown'}` }
  }
}

export async function sanitize(req: SanitizeRequest): Promise<SidecarResponse> {
  return post('/sanitize', req)
}

export async function prefilter(req: PrefilterRequest): Promise<SidecarResponse> {
  return post('/prefilter', req)
}
