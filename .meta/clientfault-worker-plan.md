# CLIENT_FAULT locus plan — `src/safety-client.ts`

Branch: `fix/client-fault-locus-0829` @ `d5aff34a57014e98240309cebfd8db59d6791d77` (verified clean, HEAD matches).
Worktree: `/mnt/d/backup/projects/personal/mcp-discord-cael-wt-clientfault-0829`
Phase: **1 — research and plan only. No source/test edits made. Nothing committed.**

---

## 1. Inspected paths

### This repository (read in full or grepped exhaustively)
| Path | Why |
| --- | --- |
| `src/safety-client.ts` (121 lines, read in full) | The subject. All four error-composing strings live at lines 96, 103, 107, 109; doc example at line 15. |
| `src/safety-client.test.ts` | Existing test file for this module (8 lines; only pins `DEFAULT_SAFETY_TIMEOUT_MS`). Establishes the "export an internal for assertion" precedent. |
| `src/safety.test.ts` | The only end-to-end tests of `sanitize()` error text (lines 93–111, 244–260, 262–278). See §6 — its mocking is dead. |
| `src/index.ts` (lines 537–551, plus full grep for `Safety`) | `sanitizeAndFormat()` wraps `result.error` as `[Safety: ...]` at line 546 — the only downstream consumer of these strings. |
| `src/check-new-messages-runtime.ts` (line 76, 249) | Consumes `sanitizeAndFormat` via injection; composes no sidecar text. |
| `src/attachments.ts` | Composes `download failed: ${message}` (line 352) for Discord CDN, not the sidecar. Out of doctrine scope. |
| `src/preview-discord.ts`, `src/preview-discord-runtime.ts`, `src/tools/index.ts` | Deliberately bypass the sidecar; no sidecar error text. |
| `package.json`, `package-lock.json`, `tsconfig.json`, `esbuild.config.mjs`, `.gitignore`, `.env.example` | Build/test/dependency wiring. |

### Deployment wiring (read-only, sibling repo; nothing touched)
| Path | Why |
| --- | --- |
| `/mnt/d/backup/projects/personal/free-agent/docker-compose.yml` (lines 26–60) | Mount + env wiring for this MCP server. |
| `/mnt/d/backup/projects/personal/free-agent/.mcp.docker.json` (lines 11–14) | The command that launches this server inside the container. |

Not accessed, per instruction: the source checkout's `.npmrc` and `.security.yml` (both confirmed to exist at
`/mnt/d/backup/projects/personal/mcp-discord-cael/`; neither was opened, and neither exists in this worktree).

---

## 2. Taxonomy source and version basis

`package.json` pins `"undici": "8.10.0"` (exact, not a range). `node_modules/` **does not exist** in this worktree,
so no installed copy was available. Basis used instead, in descending authority:

1. **The exact published tarball for the pinned version**, downloaded to `/tmp/undici-pkg`:
   `https://registry.npmjs.org/undici/-/undici-8.10.0.tgz`
   Recomputed SHA-512: `sha512-HvltHd7avK13QIw/oLe4qoOLyoVSoafqJ2jYOrtMRBkbYT31eiBQ8O0ehRKZiEZCMEyLFQNIADpgCWC5fALvYQ==`
   — **byte-identical to the `integrity` field at `package-lock.json:2407`.** This is the same artifact `npm ci`
   would install, so it is equivalent to inspecting installed source.
2. Upstream tag source for cross-check: `https://raw.githubusercontent.com/nodejs/undici/v8.10.0/lib/core/errors.js`
   (HTTP 200, identical class/code table).
3. Published type declarations: `types/errors.d.ts` in the same tarball (enumerates 22 `UND_ERR*` code literals).

Full class→code table read from `lib/core/errors.js` of that tarball (26 exported classes). Throw sites were located
by grepping `lib/` of the same tarball, and the fetch-path behaviour was **verified empirically** on Node v22.19.0
by driving that exact tarball (see §4).

---

## 3. Proposed CLIENT_FAULT set

Doctrine, stated as a principle: **CLIENT_FAULT is the class of undici codes that can only be produced by this
process's own argument, header, or dispatcher-lifecycle misuse, raised on the request path *before any byte of the
request is written to a socket*.** Membership therefore requires two things: client-local *causation*, and a
guarantee of *pre-arrival* — because the user-visible string will claim the sidecar was never contacted.

```ts
// Client-local failures raised before the request was written to a socket.
// The sidecar was never contacted; the fault is in this process.
const CLIENT_FAULT_CODES = new Set([
  'UND_ERR_INVALID_ARG',
  'UND_ERR_NOT_SUPPORTED',
  'UND_ERR_CLOSED',
  'UND_ERR_MAX_ORIGINS_REACHED',
])
```

| Code | Class | Evidence (undici 8.10.0) |
| --- | --- | --- |
| `UND_ERR_INVALID_ARG` | `InvalidArgumentError` | ~200 throw sites, all argument/option validation; on the fetch path it is `DispatcherBase.dispatch` opts validation (`lib/dispatcher/dispatcher-base.js:150–162`), `Agent[kDispatch]` origin validation (`lib/dispatcher/agent.js:79`), and `lib/core/request.js` header/option validation — every one of them before a socket write. **Empirically reproduced** via `fetch(url, {headers:{connection:'not a token!!'}})` → `TypeError: fetch failed` with `cause.code === 'UND_ERR_INVALID_ARG'`. |
| `UND_ERR_NOT_SUPPORTED` | `NotSupportedError` | Exactly 2 throw sites; the fetch-path one is `lib/core/request.js:540` (`'expect header not supported'`), thrown while building the request object. **Empirically reproduced** via `fetch(url, {headers:{expect:'100-continue'}})` → `cause.code === 'UND_ERR_NOT_SUPPORTED'`. Pure caller misuse of the API. |
| `UND_ERR_CLOSED` | `ClientClosedError` | **Exactly one** throw site: `lib/dispatcher/dispatcher-base.js:169`, inside the `dispatch()` guard, before `this[kDispatch]` is reached. There is no other way to produce this code, so it is unconditionally pre-arrival. **Empirically reproduced** by dispatching on a `close()`d `Agent` → `cause.code === 'UND_ERR_CLOSED'`. |
| `UND_ERR_MAX_ORIGINS_REACHED` | `MaxOriginsReachedError` | **Exactly one** throw site: `lib/dispatcher/agent.js:86`, inside `Agent[kDispatch]`, before client selection/creation. It is a local pool-policy ceiling — it cannot be caused by anything remote. Static evidence only: the probe could not trip the condition (idle origins are released), so this member is included on unambiguous source evidence rather than a reproduction. |

Each member is verified to be `undefined`-safe through `findErrorCode()` (lines 43–48): the probe confirmed all
reproduced codes arrive as `TypeError('fetch failed').cause.code`, i.e. depth 1, well inside the depth-4 walk. The
mechanism is `lib/web/fetch/index.js:2371` (`onResponseError`) rejecting the dispatch promise, caught at
`lib/web/fetch/index.js:2009`, and re-thrown as `TypeError('fetch failed', { cause: err })` at line 271.

### Explicitly excluded adjacent codes

**Excluded because causation is client-local but pre-arrival is *not* guaranteed:**

| Code | Why excluded |
| --- | --- |
| `UND_ERR_DESTROYED` | This is the closest call, and the one judgment the PM may want to flip. It *is* reachable pre-dispatch (`dispatcher-base.js:165`, same guard as `UND_ERR_CLOSED`; empirically reproduced). But unlike `UND_ERR_CLOSED` it has **four** throw sites, and two of them (`dispatcher-base.js:130` — the default error used to fail already-queued requests when `destroy()` is called; `client.js:545` — a socket destroyed after connect) fire against requests that may already be in flight. Claiming "never reached the sidecar" would then be a false statement. Excluded so the CLIENT_FAULT message stays unconditionally true; it lands in the now-neutral fallback, which is honest either way. This module never calls `.close()`/`.destroy()` on its dispatcher, so the code is unreachable here in practice. To flip: add the string to the set — no other change. |
| `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH` | Client-side data fault, but detected *while writing the request body* on an already-established socket — part of the request may have reached the sidecar. Fails the pre-arrival test. |
| `UND_ERR_ABORT`, `UND_ERR_ABORTED` | Locus is ambiguous: may be our own `AbortController` (already handled first, at line 93) or a connection teardown surfaced as an abort. Not client-local by construction. |

**Excluded because they are client-local but unreachable on this module's `fetch` path** (keeping the set to codes
this module can actually produce; adding them would be untestable surface):

| Code | Why excluded |
| --- | --- |
| `UND_ERR_INVALID_RETURN_VALUE` | Only 2 throw sites: `lib/api/api-pipeline.js:203` and `lib/api/api-stream.js:164`, both validating a *caller-supplied factory's* return value. Reachable only via `client.stream()`/`client.pipeline()`, which this module does not use. |
| `UND_ERR_BPL_MISSING_UPSTREAM` | Single throw site `lib/dispatcher/balanced-pool.js:164`; `BalancedPool` only. This module uses `Agent`. |

**Excluded because the locus is the sidecar, the network, or a proxy hop — these are exactly the codes a wrong
CLIENT_FAULT set would dangerously relabel as client-local:**

| Code | Locus |
| --- | --- |
| `UND_ERR_SOCKET` | Socket-level failure on an established connection (remote/network). |
| `UND_ERR_RES_CONTENT_LENGTH_MISMATCH` | The sidecar's response body disagreed with its own `content-length`. Sidecar responded. |
| `UND_ERR_HEADERS_OVERFLOW` | The *response* headers exceeded the parser limit — remote-produced bytes. |
| `UND_ERR_RES_EXCEEDED_MAX_SIZE` | The *response* body exceeded the size ceiling — remote-produced bytes. |
| `UND_ERR_RESPONSE`, `UND_ERR_REQ_RETRY` | Carry `statusCode`; by definition the sidecar answered. |
| `UND_ERR_INFO` | `InformationalError` — connection-level informational failures (e.g. protocol negotiation), not caller misuse. |
| `HPE_*` (`HTTPParserError`, `lib/core/errors.js:309`) | Malformed response bytes from the peer. |
| `UND_ERR_PRX_CONN`, `UND_ERR_PRX_TLS`, `UND_ERR_SOCKS5` | Proxy-hop connection/TLS failures — network locus, not client-local. Note also that `lib/core/socks5-utils.js` throws `InvalidArgumentError` while parsing a *remote* SOCKS5 handshake reply; that is the one impure corner of `UND_ERR_INVALID_ARG`, and it is unreachable here because no `ProxyAgent`/`Socks5ProxyAgent` is configured (plain `new Agent(...)`, `http://safety-sidecar:3100`). Recorded so a future proxy change re-opens this question. |
| `UND_ERR_WS_MESSAGE_SIZE_EXCEEDED` | WebSocket only. |
| `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, `ETIMEDOUT` | Already owned by `TIMEOUT_CODES` — unchanged. |
| `UND_ERR_CONNECT_TIMEOUT`, `ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, `ENETUNREACH`, `EAI_AGAIN` | Already owned by `UNREACHABLE_CODES` — unchanged. |

---

## 4. Empirical verification performed

Driving the lockfile-verified tarball directly on Node v22.19.0 (no repo files touched):

```
closed-port        -> TypeError:fetch failed | resolved code = ECONNREFUSED
expect-header      -> TypeError:fetch failed | resolved code = UND_ERR_NOT_SUPPORTED
bad-connection-hdr -> TypeError:fetch failed | resolved code = UND_ERR_INVALID_ARG
destroyed-agent    -> TypeError:fetch failed | resolved code = UND_ERR_DESTROYED
closed-agent       -> TypeError:fetch failed | resolved code = UND_ERR_CLOSED
```

Two consequences: (a) the proposed members really do surface through `findErrorCode()`; (b) `ECONNREFUSED` still
resolves, so the unreachable class is not disturbed.

---

## 5. Proposed exact user-visible strings

Four classes (timeout has two long-standing sub-strings; both preserved verbatim).

**1 — Timeout, our own AbortController fired (line 96, UNCHANGED):**
```
Safety review exceeded timeout (payload: ${requestBody.length} chars, elapsed: ${elapsed}ms) — sidecar likely still processing a large payload; try a smaller scope
```

**2 — Timeout, undici transport timeout code (line 103, UNCHANGED):**
```
Safety sidecar timed out mid-processing (${code}, payload: ${requestBody.length} chars, elapsed: ${elapsed}ms) — sidecar is up but slow on a large payload; try a smaller scope
```

**3 — Unreachable (line 107, UNCHANGED):**
```
Safety sidecar unreachable (${code}): ${message}
```

**4 — CLIENT_FAULT (NEW, inserted after the unreachable branch):**
```
Safety client fault (${code}): ${message} — this MCP client's own request was rejected locally by undici; the request never reached the safety sidecar
```
No optional-code handling: every member of `CLIENT_FAULT_CODES` is reached only when `code !== undefined`.

**5 — Residual fallback, now locus-neutral (line 109, CHANGED):**
```
Safety review request failed${code !== undefined ? ` (${code})` : ''}: ${message}
```
Was: `Safety sidecar request failed...`. The optional-code behaviour is preserved exactly. The subject becomes the
*review request* (the operation) rather than the *sidecar* (a party), so the string asserts a symptom and no cause.

Ordering note: the four code sets are mutually disjoint, so branch order is not load-bearing. Proposal keeps the
existing narrative order (abort → timeout → unreachable → **client fault** → neutral) for a minimal diff, and §7
adds a test that pins disjointness so a future edit cannot silently create an overlap.

Shape of the change to `post()` (illustrative only — not applied):
```ts
    if (code !== undefined && CLIENT_FAULT_CODES.has(code)) {
      return {
        ok: false,
        error: `Safety client fault (${code}): ${message} — this MCP client's own request was rejected locally by undici; the request never reached the safety sidecar`,
      }
    }
    return { ok: false, error: `Safety review request failed${code !== undefined ? ` (${code})` : ''}: ${message}` }
```

---

## 6. Sibling error-string audit

Repo-wide grep for composed safety-sidecar error text (`Safety`, `sidecar`, `sanitize(`, `prefilter(`) across `src/`.

| Site | Current text | Verdict |
| --- | --- | --- |
| `src/safety-client.ts:96` | `Safety review exceeded timeout ... — sidecar likely still processing` | **Keep.** Names the sidecar as a *hypothesis about who is still working*, hedged with "likely", after our own timer fired. That is a diagnosis, not a fault assignment, and it is the actionable one. |
| `src/safety-client.ts:103` | `Safety sidecar timed out mid-processing (...) — sidecar is up but slow` | **Keep.** The locus claim is earned: a headers/body timeout means the connection was established and the sidecar owns the silence. |
| `src/safety-client.ts:107` | `Safety sidecar unreachable (${code}): ${message}` | **Keep.** Earned: every member of `UNREACHABLE_CODES` is a connect/DNS failure against the sidecar's address. |
| `src/safety-client.ts:109` | `Safety sidecar request failed...` | **Change** — the whole point. This is the unearned locus claim: it is the branch reached precisely when we *don't* know who failed. |
| `src/safety-client.ts:15` (doc comment) | `[Safety error: ${result.error}]` | **Cosmetic drift, optional.** The header example says `[Safety error: ...]`; the real consumer (`index.ts:546`) emits `[Safety: ...]`. Not a locus problem. Recommend leaving it unless the PM wants the docblock aligned in the same commit. |
| `src/index.ts:546` | `` `[Safety: ${result.error}]` `` | **Keep, no change.** `Safety:` is a subsystem tag, not a causal claim, and it does not add a locus to whatever it wraps. Under the new fallback it renders `[Safety: Safety review request failed (UND_ERR_SOCKET): ...]` — slightly redundant, still locus-neutral. Flagged as cosmetic only. |
| `src/check-new-messages-runtime.ts:76,249` | injected `sanitizeAndFormat`, passthrough | No composition. Nothing to change. |
| `src/attachments.ts:352` | `download failed: ${message}` | Discord CDN, not the sidecar. Already locus-neutral. Out of scope. |
| `src/tools/index.ts:498` | tool description mentioning sidecar bypass | Not an error string. |

**Conclusion: `src/safety-client.ts` is the only module in this repo that composes safety-sidecar error text.** There
is no sibling that needs the same edit — but the audit is what establishes that, and the three retained locus claims
above are retained *by argument* (each has earned its locus), not by omission.

---

## 7. Test plan

### 7.1 Blocking discovery: the existing end-to-end mocks are dead

`src/safety.test.ts` mocks `global.fetch` (lines 8–17) — a convention shared with `attachments.test.ts` and
`preview-discord.integration.test.ts`, where it is still valid. But since `d5aff34` ("apply Cael's undici realm
diagnosis"), `safety-client.ts:19` imports `fetch` **from `undici`**, and undici captures its own implementation at
module load (`index.js:126`, `const fetchImpl = require('./lib/web/fetch').fetch`). Assignment flows only the other
way, in `install()` at `index.js:224`. Reassigning `globalThis.fetch` therefore has **no effect** on this module.

Verified empirically (mock set, undici `fetch` called — the mock never ran):
```
ACTUAL produced error => Safety sidecar unreachable (ENOTFOUND): fetch failed
TEST EXPECTS         => Safety sidecar unreachable (ECONNREFUSED): fetch failed
```
So five tests in `src/safety.test.ts` (lines 27, 57, 75, 93, 244, 262) are not testing what they claim: they issue
**real network calls** to `http://safety-sidecar:3100`. On this host they fail (DNS `ENOTFOUND`); inside the
container, where the name resolves, they would pass or fail depending on whether the sidecar happens to be up.
This is pre-existing at `d5aff34` and independent of the CLIENT_FAULT work, but it blocks "full suite green".

### 7.2 Recommended approach — extract a pure classifier, then test it directly

Smallest change that makes all four classes testable without a network or a mockable global, and it follows the
existing precedent in this module (`DEFAULT_SAFETY_TIMEOUT_MS` is exported solely so `safety-client.test.ts` can pin
it):

```ts
export function describeFailure(
  err: unknown,
  ctx: { aborted: boolean; payloadChars: number; elapsedMs: number }
): string
```
`post()`'s `catch` block becomes a single call to it. No behavioural change; the strings move, they do not differ.

Tests go in the existing `src/safety-client.test.ts`, matching this repo's conventions exactly: `node:test` +
`node:assert/strict`, `import ... from './safety-client.js'`, compiled by `tsc` and run from `dist/`. Errors are
**injected as synthesized objects** in the shape the empirical probe confirmed — `Object.assign(new TypeError('fetch
failed'), { cause: Object.assign(new Error(msg), { code }) })` — which is the same shape `src/safety.test.ts:95`
already uses, so the convention is preserved even though the delivery mechanism changes.

### 7.3 Concrete cases

**Client fault (required regressions)**
1. `UND_ERR_INVALID_ARG` (cause message `'opts.origin must be a non-empty string or URL.'`) →
   - `assert.match(s, /client/)` — **the string names the client**;
   - `assert.match(s, /never reached the safety sidecar/)` — **states the request never reached the sidecar**;
   - `assert.match(s, /\(UND_ERR_INVALID_ARG\)/)` and the cause message is included;
   - `assert.doesNotMatch(s, /sidecar unreachable|sidecar timed out|sidecar request failed/)` — no sidecar fault claim.
2. Table-driven over the remaining members — `UND_ERR_NOT_SUPPORTED`, `UND_ERR_CLOSED`,
   `UND_ERR_MAX_ORIGINS_REACHED` — asserting the same four properties.

**Timeout**
3. `ctx.aborted === true` (with a benign error) → exact equality against string #1, with `payloadChars`/`elapsedMs`
   interpolated. Also assert abort wins over a nested code (pass `ECONNREFUSED` in the cause and confirm the
   timeout string still comes back) — pins the existing precedence at line 93.
4. Table over `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, `ETIMEDOUT` → exact equality against string #2.

**Unreachable**
5. Table over `ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, `ENETUNREACH`, `EAI_AGAIN`, `UND_ERR_CONNECT_TIMEOUT` →
   exact equality against `Safety sidecar unreachable (${code}): fetch failed`. This is the guard for requirement 3.

**Neutral fallback (required regression)**
6. `UND_ERR_SOCKET` with cause message `'other side closed'` →
   `assert.equal(s, 'Safety review request failed (UND_ERR_SOCKET): fetch failed')`, plus
   `assert.doesNotMatch(s, /sidecar/i)` and `assert.doesNotMatch(s, /client/i)` — neutral in **both** directions.
   *Trap to avoid:* a bare `/sidecar/i` negative assertion is unsound against arbitrary inputs, because undici's own
   message can contain the host name `safety-sidecar`. The test must therefore use a message with no `sidecar`
   substring (as above) and rely on exact equality for the composition itself.
7. No code anywhere in the cause chain (`new Error('boom')`) → `assert.equal(s, 'Safety review request failed: boom')`
   — pins the optional-code behaviour.
8. Also assert `UND_ERR_DESTROYED` and `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH` land in the **neutral** fallback —
   this is what makes the §3 exclusions enforced rather than merely argued.

**Structural**
9. Disjointness: assert the four sets share no member (`TIMEOUT`, `UNREACHABLE`, `CLIENT_FAULT`, and the implicit
   residual). Requires exporting `CLIENT_FAULT_CODES` (and the two existing sets) or asserting via `describeFailure`
   over the union — recommend the latter to avoid widening the module's public surface.
10. Non-`Error` throw (`'a string'`) → message renders as `unknown`, preserving line 92 behaviour.
11. Cause-chain depth: code at depth 2 resolves; code at depth 5 does not (falls to the no-code fallback) — pins
    `findErrorCode`'s depth-4 ceiling.

### 7.4 Repairing `src/safety.test.ts` (PM decision, recommended in scope)

Without a repair, `npm test` cannot be green regardless of this change. Minimal fix that keeps the module's
"copy this file into your MCP server" portability: make the module-level `dispatcher` overridable and have
`safety.test.ts` pass an undici `MockAgent` (which implements `Dispatcher`, so
`mockAgent.get('http://safety-sidecar:3100').intercept({...}).replyWithError(...)` gives a genuine end-to-end path).
That converts five currently-networked tests into hermetic ones. It is strictly larger than the locus fix, so I have
not assumed it — **flagging for your call.** The §7.3 cases stand on their own either way.

---

## 8. Build and test commands

Run from the worktree root:

```bash
npm ci                # REQUIRED FIRST — node_modules/ is absent here (see §10)
npm run build         # tsc && node esbuild.config.mjs  → dist/*.js + dist/bundle.js
npm test              # tsc && node --test --test-force-exit 'dist/**/*.test.js'  (full suite)
```
Single-file iteration during implementation:
```bash
npx tsc && node --test --test-force-exit dist/safety-client.test.js
```
`npm test` recompiles, so `npm run build` is not a prerequisite for it. TypeScript is `strict`, `NodeNext`, ES2022,
`rootDir: src` → `outDir: dist`; tests are `src/*.test.ts` compiled alongside sources (no separate test config).

---

## 9. Deployment wiring — provisional, read-only findings

- `free-agent/docker-compose.yml:28` bind-mounts the **source checkout**, not this worktree:
  `- ../mcp-discord-cael:/opt/mcp/mcp-discord-cael:ro`
- `free-agent/.mcp.docker.json:11-14` launches it as `node /opt/mcp/mcp-discord-cael/dist/bundle.js`.
- `free-agent/docker-compose.yml:52-56` sets `SAFETY_SIDECAR_URL=http://safety-sidecar:3100` and
  `SAFETY_TIMEOUT_MS=900000`, inherited by MCP children — matching the comments at `src/safety-client.ts:21-28`.

Therefore, provisionally:
1. **A host build is required.** The mount is `:ro` and carries `dist/` from the host; the container cannot build.
   `npm run build` must run in `/mnt/d/backup/projects/personal/mcp-discord-cael` (the source checkout) after the
   branch is merged/checked out there. Building in *this worktree* alone activates nothing.
2. **No image rebuild is required.** The server is bind-mounted, not baked into the image; `docker compose build`
   is unnecessary for this change.
3. **A restart is effectively required.** The MCP server is a long-lived child process spawned by Claude Code inside
   the `cael` container, so a new `dist/bundle.js` is only picked up when that child is respawned — in practice
   `docker compose restart cael` (or the next session that respawns MCP children).

Not verified, and deliberately not verified in this phase: whether the source checkout currently has a `dist/`, and
what the running container has loaded. Nothing in the deployment surface was touched.

---

## 10. Uncertainty and blockers

1. **BLOCKER — `node_modules/` is absent in this worktree**, so nothing was built or executed against the repo, and
   the current pass/fail state of the suite is inferred (§7.1), not observed. `npm ci` is needed before phase 2.
   I did not run it: the source checkout has an `.npmrc` I am instructed not to access, and although npm would not
   read it from here (it is a sibling directory, not an ancestor), installing could still need registry
   configuration I have not been asked to supply. **Please confirm `npm ci` in this worktree is authorized** — it
   creates only the gitignored `node_modules/`.
2. **Open decision — `UND_ERR_DESTROYED`.** Excluded on pre-arrival grounds (§3). Defensible either way; one-line
   flip if you want client-locus causation to outrank the "never reached" guarantee. If you flip it, the CLIENT_FAULT
   string must be softened (e.g. "…was rejected locally by undici" without the "never reached" clause), which would
   then weaken the required regression assertion — that coupling is the real reason I excluded it.
3. **Open decision — scope of the `safety.test.ts` repair** (§7.4). Needed for a green suite; larger than the fix.
4. `UND_ERR_MAX_ORIGINS_REACHED` is included on static source evidence only; I could not trip it in a probe.
   Low risk (single pre-dispatch throw site, cannot be caused remotely), but it is the one member without an
   empirical reproduction.
5. Deployment findings in §9 are read-only inferences from compose/MCP config. No container or mount was inspected
   live, per instruction.

---

# PM review decisions (appended after phase 1; phase-1 content above is left intact for provenance)

Sol PM reviewed this plan and independently checked the pinned undici 8.10.0 source. The rulings below **supersede**
the corresponding proposals in §3, §5, §7.3 and §10 where they differ. Everything else in the plan stands.

## D1 — CLIENT_FAULT membership: five codes, not four

```ts
const CLIENT_FAULT_CODES = new Set([
  'UND_ERR_INVALID_ARG',
  'UND_ERR_NOT_SUPPORTED',
  'UND_ERR_CLOSED',
  'UND_ERR_BPL_MISSING_UPSTREAM',
  'UND_ERR_MAX_ORIGINS_REACHED',
])
```

Reviewed invariant: *for this module's pinned undici 8.10.0 request path, each of these codes establishes a
client-local rejection before this request is sent to the sidecar.*

`UND_ERR_BPL_MISSING_UPSTREAM` is **added**, overturning the §3 exclusion. My phase-1 reason for excluding it was
reachability (`BalancedPool` is not used here) — but the PM's criterion is code semantics, not reachability, and the
criterion must be applied consistently. Its sole throw at `lib/dispatcher/balanced-pool.js:164` rejects dispatch
before client selection, which is exactly the property that qualifies the other members. The reachability caveat is
recorded in the source comment rather than used as a filter. Note this also resolves the §3 inconsistency the PM
would have been right to flag: I had excluded `UND_ERR_BPL_MISSING_UPSTREAM` on reachability grounds while including
`UND_ERR_MAX_ORIGINS_REACHED`, which I could not reproduce either.

Confirmed exclusions (my §3 reasoning upheld):
- `UND_ERR_DESTROYED` — multiple 8.10.0 throw paths can fail a connected socket or an already-queued/in-flight
  request, so "never reached" is not guaranteed.
- `UND_ERR_INVALID_RETURN_VALUE`, `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH` — thrown after a response, or while the
  request body is being transmitted.
- All remote / socket / response / proxy / parser / abort codes.

## D2 — Exact strings

- The two timeout strings and the unreachable string: preserved **byte-for-byte**.
- CLIENT_FAULT (supersedes my §5 proposal, which named the client differently):
  `Discord-reader client-side request fault (${code}): ${message} — request never reached the safety sidecar`
- Residual fallback: the existing optional-code shape with a neutral subject —
  `` `Safety review request failed${code !== undefined ? ` (${code})` : ''}: ${message}` ``
  and the composed output must contain no `sidecar` or `client` locus wording.

## D3 — Implementation shape

Extract a small pure failure-description function from `post()`; keep `post()`'s behaviour and precedence
(local abort signal → undici timeout → unreachable → CLIENT_FAULT → neutral fallback). Do not export the code sets
if behaviour-level tests suffice; a narrowly named exported classifier is acceptable, following the
`DEFAULT_SAFETY_TIMEOUT_MS` precedent. **Implemented as** `describeRequestFailure(err, ctx)`; the code sets stayed
module-private and are covered behaviourally.

## D4 — Dead mocks: repair in scope

PM ran the untouched suite after `npm ci`: **186 tests, 179 pass, 7 fail**, all seven in `src/safety.test.ts`,
confirming §7.1 — its `global.fetch` mocks no longer intercept the `fetch` imported from undici at `d5aff34`, so
those tests perform real DNS and see `ENOTFOUND`. Repair minimally and hermetically via an explicit, narrowly named
test-only fetch seam in `safety-client.ts` that defaults to the imported undici `fetch` and returns a restoration
function; update only `safety.test.ts`'s helper. **Implemented as** `__setSidecarFetchForTests(impl): () => void`.
The `MockAgent` fallback described in §7.4 was not needed — see the type note in the implementation report.

## D5 — Test table as built

Supersedes §7.3. Delivered in `src/safety-client.test.ts` (12 tests; the pre-existing
`DEFAULT_SAFETY_TIMEOUT_MS` pin is retained):

| # | Class | Test |
| --- | --- | --- |
| 1 | client fault | nested `UND_ERR_INVALID_ARG` → exact string, includes code + message, names the client, states the request never reached the safety sidecar, and asserts no sidecar-fault phrasing |
| 2 | client fault | table over `UND_ERR_NOT_SUPPORTED`, `UND_ERR_CLOSED`, `UND_ERR_BPL_MISSING_UPSTREAM`, `UND_ERR_MAX_ORIGINS_REACHED` |
| 3 | timeout | AbortController path → exact existing string |
| 4 | timeout | abort precedence over a nested `ECONNREFUSED` |
| 5 | timeout | table over `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, `ETIMEDOUT` → exact existing string |
| 6 | unreachable | table over all six unreachable codes → exact existing string |
| 7 | neutral | `UND_ERR_SOCKET` → exact neutral string, `doesNotMatch(/sidecar/i)`, `doesNotMatch(/client/i)` |
| 8 | neutral | no code anywhere → optional-code shape preserved |
| 9 | neutral | `UND_ERR_DESTROYED`, `UND_ERR_INVALID_RETURN_VALUE`, `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH` pinned to neutral |
| 10 | shape | non-`Error` throw renders as `unknown` |
| 11 | shape | cause walking finds a code four levels deep, gives up beyond the depth ceiling |

## D6 — Status of the phase-1 blockers (§10)

1. `npm ci` — done by the PM; `node_modules/undici` is 8.10.0, matching the taxonomy basis in §2. Resolved.
2. `UND_ERR_DESTROYED` — decided: **out** (D1). Resolved.
3. `safety.test.ts` repair scope — decided: **in scope** (D4). Resolved.
4. `UND_ERR_MAX_ORIGINS_REACHED` static-evidence-only caveat — accepted, and now applied consistently with
   `UND_ERR_BPL_MISSING_UPSTREAM` (D1).
5. §9 deployment findings remain provisional, repository-only, and unchanged.
