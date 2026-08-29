import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_SAFETY_TIMEOUT_MS, describeRequestFailure } from './safety-client.js';

const CTX = { aborted: false, payloadChars: 4096, elapsedMs: 1234 };

/**
 * The shape undici 8.10.0 actually delivers: TypeError('fetch failed') with the
 * real error — and its code — nested in `cause`.
 */
function fetchFailure(code: string, causeMessage = 'underlying failure'): TypeError {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(causeMessage), { code }),
  });
}

function nestedFailure(depth: number, code: string): Error {
  let err: Error & { code?: string; cause?: unknown } = Object.assign(new Error('deep failure'), { code });
  for (let i = 0; i < depth; i += 1) {
    err = Object.assign(new TypeError('fetch failed'), { cause: err });
  }
  return err;
}

test('DEFAULT_SAFETY_TIMEOUT_MS is pinned to the preview-first timeout default', () => {
  assert.equal(DEFAULT_SAFETY_TIMEOUT_MS, 520_000);
});

// --- client fault -----------------------------------------------------------

test('client fault: nested UND_ERR_INVALID_ARG blames this client, not the sidecar', () => {
  const error = describeRequestFailure(
    fetchFailure('UND_ERR_INVALID_ARG', 'opts.origin must be a non-empty string or URL.'),
    CTX
  );

  assert.equal(
    error,
    'Discord-reader client-side request fault (UND_ERR_INVALID_ARG): fetch failed — request never reached the safety sidecar'
  );
  assert.match(error, /UND_ERR_INVALID_ARG/);
  assert.match(error, /fetch failed/);
  assert.match(error, /client/);
  assert.match(error, /request never reached the safety sidecar/);
  // The regression itself: no causal attribution to the sidecar.
  assert.doesNotMatch(error, /Safety sidecar (unreachable|timed out|request failed)/);
});

test('client fault: every CLIENT_FAULT code composes the same client-locus string', () => {
  for (const code of [
    'UND_ERR_NOT_SUPPORTED',
    'UND_ERR_CLOSED',
    'UND_ERR_BPL_MISSING_UPSTREAM',
    'UND_ERR_MAX_ORIGINS_REACHED',
  ]) {
    const error = describeRequestFailure(fetchFailure(code), CTX);

    assert.equal(
      error,
      `Discord-reader client-side request fault (${code}): fetch failed — request never reached the safety sidecar`
    );
    assert.match(error, /client/);
    assert.match(error, /request never reached the safety sidecar/);
    assert.doesNotMatch(error, /Safety sidecar (unreachable|timed out|request failed)/);
  }
});

// --- timeout ----------------------------------------------------------------

test('timeout: our own AbortController firing keeps the payload/elapsed string', () => {
  const error = describeRequestFailure(new Error('This operation was aborted'), { ...CTX, aborted: true });

  assert.equal(
    error,
    'Safety review exceeded timeout (payload: 4096 chars, elapsed: 1234ms) — sidecar likely still processing a large payload; try a smaller scope'
  );
});

test('timeout: the abort signal outranks a nested unreachable code', () => {
  const error = describeRequestFailure(fetchFailure('ECONNREFUSED'), { ...CTX, aborted: true });

  assert.equal(
    error,
    'Safety review exceeded timeout (payload: 4096 chars, elapsed: 1234ms) — sidecar likely still processing a large payload; try a smaller scope'
  );
});

test('timeout: every transport timeout code still names the sidecar as mid-processing', () => {
  for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT']) {
    assert.equal(
      describeRequestFailure(fetchFailure(code), CTX),
      `Safety sidecar timed out mid-processing (${code}, payload: 4096 chars, elapsed: 1234ms) — sidecar is up but slow on a large payload; try a smaller scope`
    );
  }
});

// --- unreachable ------------------------------------------------------------

test('unreachable: every connect/DNS code still names the sidecar as unreachable', () => {
  for (const code of [
    'ECONNREFUSED',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
  ]) {
    assert.equal(
      describeRequestFailure(fetchFailure(code), CTX),
      `Safety sidecar unreachable (${code}): fetch failed`
    );
  }
});

// --- neutral fallback -------------------------------------------------------

test('fallback: UND_ERR_SOCKET is locus-neutral — it blames neither the sidecar nor the client', () => {
  const error = describeRequestFailure(fetchFailure('UND_ERR_SOCKET', 'other side closed'), CTX);

  assert.equal(error, 'Safety review request failed (UND_ERR_SOCKET): fetch failed');
  assert.doesNotMatch(error, /sidecar/i);
  assert.doesNotMatch(error, /client/i);
});

test('fallback: an error with no code anywhere keeps the optional-code shape', () => {
  const error = describeRequestFailure(new Error('something broke'), CTX);

  assert.equal(error, 'Safety review request failed: something broke');
  assert.doesNotMatch(error, /sidecar/i);
  assert.doesNotMatch(error, /client/i);
});

test('fallback: codes excluded from CLIENT_FAULT stay neutral rather than blaming the client', () => {
  // Each of these is client-adjacent but cannot promise the request was never
  // sent: UND_ERR_DESTROYED can fail a connected socket or a queued request,
  // and the other two are thrown after a response or mid request-body write.
  for (const code of [
    'UND_ERR_DESTROYED',
    'UND_ERR_INVALID_RETURN_VALUE',
    'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
  ]) {
    const error = describeRequestFailure(fetchFailure(code), CTX);

    assert.equal(error, `Safety review request failed (${code}): fetch failed`);
    assert.doesNotMatch(error, /never reached/);
    assert.doesNotMatch(error, /client/i);
  }
});

// --- shape preservation -----------------------------------------------------

test('a non-Error throw still renders as unknown', () => {
  assert.equal(describeRequestFailure('just a string', CTX), 'Safety review request failed: unknown');
});

test('cause walking finds a code four levels deep but gives up beyond the depth ceiling', () => {
  assert.equal(
    describeRequestFailure(nestedFailure(4, 'ECONNREFUSED'), CTX),
    'Safety sidecar unreachable (ECONNREFUSED): fetch failed'
  );
  assert.equal(
    describeRequestFailure(nestedFailure(5, 'ECONNREFUSED'), CTX),
    'Safety review request failed: fetch failed'
  );
});
