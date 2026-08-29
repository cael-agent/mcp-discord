# Sol PM review — CLIENT_FAULT locus fix

Date: 2026-08-28 (America/Los_Angeles)

Worktree: `/mnt/d/backup/projects/personal/mcp-discord-cael-wt-clientfault-0829`

## Worker identity and disk review

- Phase 1 and phase 2 used the same resumed MCP session UUID
  `0f9d40b9-34e0-437c-9ad6-4f14a1069a12` (`clientfault-worker-2`).
- Both successful result JSON objects reported model `claude-opus-5` and Greyiris credential fingerprint
  `f0630a515a0e`.
- PM read `.meta/clientfault-worker-plan.md` in full, reviewed all three source/test diffs from disk, and inspected
  every `.meta/` evidence file. Worker final-message claims were not treated as evidence.

## Doctrine check

Command:

```bash
git -C /mnt/d/backup/projects/personal/workflow-v2 show \
  f9bbece:.meta/roundtable-2026-08-2x-experienced-world/run/SYNTHESIS.md
```

D2 at lines 37-44 says an unclassified fallthrough must be locus-neutral and specifically names the live
`UND_ERR_INVALID_ARG` → `Safety sidecar request failed` fallthrough as a defect. The implementation follows that
rule: evidence-backed timeout/unreachable/client classifications retain or gain a locus; the residual branch names
only the failed review request.

## Independent undici 8.10.0 taxonomy review

Version check:

```text
$ node -p "require('./node_modules/undici/package.json').version"
8.10.0
```

PM checked `node_modules/undici/lib/core/errors.js`, `types/errors.d.ts`, and the relevant throw sites. Final
CLIENT_FAULT membership:

- `UND_ERR_INVALID_ARG` — required regression; on this module's plain `Agent`/`fetch` path it is API, request, or
  header validation before the HTTP request is sent. The proxy/SOCKS corner is out of path here.
- `UND_ERR_NOT_SUPPORTED` — on this `fetch` + `res.json()` path, the reachable request failure is unsupported
  request construction (`lib/core/request.js:540`) before send; response `formData()` is not used.
- `UND_ERR_CLOSED` — sole throw at `lib/dispatcher/dispatcher-base.js:169`, before `kDispatch`.
- `UND_ERR_BPL_MISSING_UPSTREAM` — sole throw at `lib/dispatcher/balanced-pool.js:164`, before an upstream/client can
  be selected. Not reachable through today's `Agent`, but unambiguously pre-request by code semantics.
- `UND_ERR_MAX_ORIGINS_REACHED` — sole throw at `lib/dispatcher/agent.js:86`, before client creation/selection for
  the rejected origin.

Reviewed exclusions:

- `UND_ERR_DESTROYED` has four throw sites, including queued/connected-socket paths; pre-arrival is not guaranteed.
- `UND_ERR_INVALID_RETURN_VALUE` is thrown from stream/pipeline response handlers after the peer responded.
- `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH` can be detected while the request body is being written.
- Socket, response, parser, proxy, abort, and transport failures do not prove a client-local pre-arrival fault.

This classification is pinned to undici 8.10.0 and must be re-audited if the dependency or dispatcher architecture
changes.

## Diff review

- `src/safety-client.ts`: classifier ordering is abort → transport timeout → unreachable → CLIENT_FAULT → neutral;
  the existing timeout and unreachable strings are preserved. Production still uses undici's `fetch`, the same
  explicit `Agent`, request body/headers/signal, and timeout cleanup.
- `src/safety-client.test.ts`: behavior-level coverage includes all five CLIENT_FAULT members, all timeout and
  unreachable members, neutral fallback with and without a code, three deliberately excluded adjacent codes,
  non-Error input, and cause-depth behavior.
- `src/safety.test.ts`: only the dead mock helper and its strict-type follow-ons changed. The module-local fetch seam
  defaults to undici and is restored with `t.after`; existing test assertions are unchanged.
- Repo-wide string audit confirms no sibling module composes another causal sidecar error string. `src/index.ts`'s
  `[Safety: ...]` is a subsystem label and remains unchanged.
- `git diff --check`: exit 0.

No blocking review finding remained. One evidence correction was made: the worker's original full-suite wrapper
claimed a network-denied shell, but the command capture did not prove that policy. The claim was removed from
`.meta/clientfault-test-full-suite.txt` and qualified in `.meta/clientfault-worker-implementation.md`.

## Independent verification

Run by Sol PM from the feature worktree after reviewing the diff:

```text
$ npx tsc && node --test --test-force-exit dist/safety-client.test.js
# tests 12
# pass 12
# fail 0
exit 0

$ npm test
# tests 197
# pass 197
# fail 0
exit 0

$ npm run build
Bundle created: dist/bundle.js
exit 0

$ git diff --check
exit 0
```

Worker full outputs remain in `.meta/clientfault-test-safety-client.txt`,
`.meta/clientfault-test-full-suite.txt`, and `.meta/clientfault-build.txt`; PM reruns independently reproduced their
pass/fail conclusions.

## Deployment handoff (repository-only inspection)

- `/mnt/d/backup/projects/personal/free-agent/docker-compose.yml` bind-mounts
  `../mcp-discord-cael:/opt/mcp/mcp-discord-cael:ro`.
- `/mnt/d/backup/projects/personal/free-agent/.mcp.docker.json` launches
  `node /opt/mcp/mcp-discord-cael/dist/bundle.js`.

After merge, activation therefore requires `npm run build` in the host source checkout and a respawn of the running
Discord MCP child so it loads the rebuilt bundle. Restarting the `cael` container is a sufficient way to respawn it;
a targeted MCP-process/session restart is also sufficient if steward tooling supports that. No image rebuild is
needed because the repo is bind-mounted. No live container, mount, or deployment surface was inspected or changed.
