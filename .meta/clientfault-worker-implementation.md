# CLIENT_FAULT locus — implementation report (phase 2)

Worktree: `/mnt/d/backup/projects/personal/mcp-discord-cael-wt-clientfault-0829`
Branch: `fix/client-fault-locus-0829`, still at `d5aff34a57014e98240309cebfd8db59d6791d77`.
**Nothing committed, nothing pushed. Working tree is ready for PM review.**

Plan of record: `.meta/clientfault-worker-plan.md` (phase-1 research, with the PM's reviewed decisions appended
as a `PM review decisions` section rather than overwriting the original reasoning).

---

## 1. Changed paths

| Path | Change |
| --- | --- |
| `src/safety-client.ts` | +96/−28 net. Added the CLIENT_FAULT class, made the residual fallback locus-neutral, extracted the classifier, added the test-only transport seam. |
| `src/safety-client.test.ts` | 1 test → 12 tests covering all four classes plus shape preservation. |
| `src/safety.test.ts` | Helper only: `setMockFetch` now drives the new seam instead of the dead `global.fetch` override. Two mechanical adjustments follow from that (below). No test bodies or assertions changed. |

`git diff --stat`: `3 files changed, 246 insertions(+), 28 deletions(-)`. `git diff --check`: clean, exit 0.
No dependency changes, no unrelated edits, no audit fixes, no deployment surface touched.

### `src/safety-client.ts` in detail

- `src/safety-client.ts:19` — `import { Agent, fetch as undiciFetch } from 'undici'` (aliased; the undici import
  itself is unchanged in substance, preserving the `d5aff34` realm fix).
- `src/safety-client.ts:38-56` — `type SidecarFetch`, the module-private `sidecarFetch` binding defaulting to
  undici's `fetch`, and `__setSidecarFetchForTests(impl): () => void`.
- `src/safety-client.ts:89-95` — `CLIENT_FAULT_CODES` (module-private), with a comment recording both the
  inclusion rule and the named exclusions.
- `src/safety-client.ts:107-127` — `describeRequestFailure(err, ctx)`, the extracted pure classifier.
- `src/safety-client.ts:149` — `post()` now calls `sidecarFetch(...)`; its `catch` block is a single delegation to
  `describeRequestFailure`. Precedence is unchanged and explicit: local abort signal → undici timeout → unreachable
  → CLIENT_FAULT → neutral fallback.

`post()`'s production behaviour is byte-identical to `d5aff34`: same `Agent({ headersTimeout: 0, bodyTimeout: 0 })`,
same `AbortController` as sole timeout authority, same request shape, same `dispatcher` option, same
`findErrorCode` depth ceiling, same `err instanceof Error ? err.message : 'unknown'` semantics.

---

## 2. CLIENT_FAULT set as implemented

```ts
const CLIENT_FAULT_CODES = new Set([
  'UND_ERR_INVALID_ARG',
  'UND_ERR_NOT_SUPPORTED',
  'UND_ERR_CLOSED',
  'UND_ERR_BPL_MISSING_UPSTREAM',
  'UND_ERR_MAX_ORIGINS_REACHED',
])
```

Exactly the PM-reviewed five. Invariant: on undici 8.10.0's request path each of these codes is thrown by
argument/header validation or by a dispatcher guard that rejects the dispatch before a client is selected, so the
request was never sent. Per-code evidence (throw sites, and which were empirically reproduced against the
lockfile-verified 8.10.0 tarball) is in `.meta/clientfault-worker-plan.md` §3 and §4; the PM's amendment to include
`UND_ERR_BPL_MISSING_UPSTREAM` — semantics over reachability, applied consistently — is recorded in D1.

Deliberately excluded, and pinned by test to the neutral fallback: `UND_ERR_DESTROYED`,
`UND_ERR_INVALID_RETURN_VALUE`, `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH`. Also excluded: every remote, socket,
response, proxy, parser and abort code.

## 3. Strings

Verified mechanically against `HEAD:src/safety-client.ts`, not by eye
(`.meta/clientfault-string-preservation.txt`, all checks PASS), and again as **runtime output from the built
`dist/`** (`.meta/clientfault-runtime-strings.txt`):

```
abort         : Safety review exceeded timeout (payload: 4096 chars, elapsed: 1234ms) — sidecar likely still processing a large payload; try a smaller scope
timeout       : Safety sidecar timed out mid-processing (UND_ERR_HEADERS_TIMEOUT, payload: 4096 chars, elapsed: 1234ms) — sidecar is up but slow on a large payload; try a smaller scope
unreachable   : Safety sidecar unreachable (ECONNREFUSED): fetch failed
client fault  : Discord-reader client-side request fault (UND_ERR_INVALID_ARG): fetch failed — request never reached the safety sidecar
neutral       : Safety review request failed (UND_ERR_SOCKET): fetch failed
neutral/nocode: Safety review request failed: something broke
```

- The three pre-existing strings are byte-for-byte identical to `HEAD`, modulo the two mechanical variable renames
  forced by the extraction (`${requestBody.length}` → `${payloadChars}`, `${elapsed}` → `${elapsedMs}`). The
  preservation check applies exactly that substitution and then compares.
- The fallback differs from `HEAD` in its subject only — `Safety sidecar request failed` → `Safety review request
  failed` — with the optional-code ternary otherwise character-identical. The composed output contains neither
  `sidecar` nor `client`, asserted in both directions by test.
- `grep -c 'Safety sidecar request failed' dist/bundle.js` → `0`: the old locus claim is gone from the shipping
  artifact (`.meta/clientfault-bundle-strings.txt`).

## 4. The `safety.test.ts` repair

`__setSidecarFetchForTests(impl)` returns a restore function; `setMockFetch` now does
`const restore = __setSidecarFetchForTests(impl); t.after(() => { restore(); });`. Restoration is unconditional per
test, so an override cannot leak. Production never consults `globalThis.fetch`, so the seam changes no production
behaviour — it only makes the transport substitutable.

The `MockAgent` fallback sketched in plan §7.4 was **not** needed. Two mechanical consequences of typing the seam as
`typeof undiciFetch` under `strict`:

1. `src/safety.test.ts` now imports `Response` from `undici` and constructs undici `Response` objects. Node's global
   `Response` is not assignable to undici's (`Property 'textStream' is missing`), and the mocks now feed the same
   `Response` implementation production consumes — a fidelity improvement, not a workaround.
2. The URL-capture line became `typeof url === 'string' ? url : 'href' in url ? url.href : url.url` (`in`-narrowing
   over undici's `RequestInfo`, replacing an `instanceof URL` chain that TypeScript would not narrow through
   undici's `Request`). No casts, no `any`, no `@ts-expect-error` anywhere in the change.

Every assertion in `safety.test.ts` is unchanged, including the exact
`Safety sidecar unreachable (ECONNREFUSED): fetch failed` expectation at line 113 — which now genuinely exercises
the classifier instead of accidentally performing DNS.

## 5. Test and build results

All commands run from the worktree root. Full captured output, with exact commands and exit status, in `.meta/`.

| Command | Result | Evidence |
| --- | --- | --- |
| `npx tsc && node --test --test-force-exit dist/safety-client.test.js` | **12/12 pass**, exit 0 | `.meta/clientfault-test-safety-client.txt` |
| `npm test` (`tsc && node --test --test-force-exit 'dist/**/*.test.js'`) | **197 tests, 197 pass, 0 fail**, exit 0 | `.meta/clientfault-test-full-suite.txt` |
| `npm run build` (`tsc && node esbuild.config.mjs`) | exit 0; `dist/bundle.js` rebuilt (5,718,821 bytes) | `.meta/clientfault-build.txt` |
| `git diff --check` | clean, exit 0 | `.meta/clientfault-diff-check.txt` |

Baseline for comparison — the PM's run of the untouched tree after `npm ci`: 186 tests, 179 pass, **7 fail**.
Now: 197 tests, **197 pass, 0 fail**. The delta is +11 tests (`safety-client.test.ts` 1 → 12) and the 7
previously-failing `safety.test.ts` tests repaired.

The full suite passed with the explicit fetch seam in place. The command capture did **not** independently record
the shell's network policy, so it is evidence for the test result but not for a no-egress claim. Hermeticity of the
seven repaired tests rests on the reviewed seam wiring (`setMockFetch` installs the module-local implementation for
each affected test and `t.after` restores it), not on an unrecorded sandbox property.

## 6. Sibling audit (re-run post-edit)

Full output: `.meta/clientfault-sibling-audit.txt`. Searched `src/**/*.ts` for `Safety sidecar`, `Safety review`,
`Discord-reader`, `[Safety`, `sidecar`, and every importer of `safety-client`.

- **`src/safety-client.ts` remains the only module in this repo that composes safety-sidecar error text.** The
  audit is what establishes that; there is no sibling needing the same edit.
- `src/index.ts:546` — `` `[Safety: ${result.error}]` `` — **unchanged, deliberately.** `Safety:` is a subsystem
  tag, not a causal claim; it adds no locus to whatever it wraps.
- `src/check-new-messages-runtime.ts` consumes an injected `sanitizeAndFormat` and composes nothing.
- `src/attachments.ts:352` (`download failed: ${message}`) is Discord CDN, not the sidecar; already neutral; not
  touched.
- `src/tools/index.ts:498` and the `sidecar` mentions in `src/index.ts` are tool descriptions and comments, not
  error text. Not touched.
- Per instruction, the doc-comment cosmetic drift at `src/safety-client.ts:15` (`[Safety error: ...]` vs the
  `[Safety: ...]` the consumer actually emits) was **left alone**, and no unrelated subsystem label was changed.

The three retained sidecar-naming strings are retained by argument, not by omission: the mid-processing timeout and
the unreachable string have each earned their locus (a headers/body timeout means the connection was established
and the sidecar owns the silence; every unreachable code is a connect/DNS failure against the sidecar's address),
and the abort string hedges with "likely" about who is still working rather than assigning fault.

## 7. Residual uncertainty

1. `UND_ERR_MAX_ORIGINS_REACHED` and `UND_ERR_BPL_MISSING_UPSTREAM` rest on **static source evidence only** — single,
   unambiguous pre-dispatch throw sites (`lib/dispatcher/agent.js:86`, `lib/dispatcher/balanced-pool.js:164`), but
   neither was reproduced in a live probe (the other three members were). Both are unreachable through this module's
   `Agent` today, so the practical risk of a mislabel is nil; the classification is a taxonomy statement.
2. The invariant is **pinned to undici 8.10.0** (exact pin in `package.json`, integrity-matched in phase 1). An
   undici major bump should re-check the throw sites before trusting the set. The source comment at
   `src/safety-client.ts:82-88` states the rule so a future reader can re-derive it.
3. `UND_ERR_INVALID_ARG` has one impure corner in 8.10.0: `lib/core/socks5-utils.js` throws it while parsing a
   *remote* SOCKS5 handshake reply. Unreachable here — this module builds a plain `new Agent(...)` against
   `http://safety-sidecar:3100` with no proxy — but introducing a `ProxyAgent`/`Socks5ProxyAgent` would re-open it.
4. `__setSidecarFetchForTests` is exported production surface used only by tests. It is narrowly named, documented as
   test-only, and cannot alter behaviour unless called. If the PM prefers zero test-only exports, the alternative is
   a `MockAgent` dispatcher seam, which would be a larger change for the same result.
5. Deployment activation remains the **provisional, repository-only** finding from plan §9 (host `npm run build` in
   the source checkout after merge; no image rebuild; the MCP child must be respawned for the new bundle to load).
   Nothing in the deployment surface was inspected live or touched in this phase.

## 8. Evidence files under `.meta/`

| File | Contents |
| --- | --- |
| `clientfault-worker-plan.md` | Phase-1 research and plan, with `PM review decisions` appended (provenance preserved) |
| `clientfault-worker-implementation.md` | This report |
| `clientfault-test-safety-client.txt` | `npx tsc` + focused `node --test` run, full TAP output, exit status |
| `clientfault-test-full-suite.txt` | Full `npm test` output, exit status |
| `clientfault-build.txt` | Full `npm run build` output, exit status, built artifact listing |
| `clientfault-string-preservation.txt` | Mechanical byte-for-byte check of the four pre-existing strings vs `HEAD` |
| `clientfault-runtime-strings.txt` | All five composed strings printed from the built `dist/` |
| `clientfault-bundle-strings.txt` | Proof the old `Safety sidecar request failed` locus is absent from `dist/bundle.js` |
| `clientfault-sibling-audit.txt` | Post-edit repo-wide sibling audit |
| `clientfault-diff-check.txt` | `git diff --check`, `git diff --stat`, `git status`, HEAD |
