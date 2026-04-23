# Learnings

## a0a22e - 2026-04-23T22:55:48Z
Always use `node --test --test-force-exit 'dist/**/*.test.js'` for final verification in this repo when you need the TAP summary quickly; plain `npm test` can emit all results and then linger because of known open handles.

