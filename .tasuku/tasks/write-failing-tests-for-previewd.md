---
status: done
priority: 1
tags: [test, feature]
created_at: 2026-04-23T22:14:22.740834017Z
updated_at: 2026-04-23T22:27:42.71458997Z
---

# Write failing tests for preview_discord PR 1b (preview-first redesign) without...

Write failing tests for preview_discord PR 1b (preview-first redesign) without implementing feature logic

## Notes

### 2026-04-23T22:27:40Z [3a6f2a]
Added preview_discord failing spec coverage: pure formatter tests, runtime/integration tests with injected Discord fixtures, tool schema test, preview state-path helper tests, and safety timeout constant pin. Added only compile-time stubs for preview-discord modules plus schema/helper exports needed for tests to compile.

