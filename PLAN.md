# Discord MCP Startup Fix Plan

## Problem
The Discord MCP server has a critical startup bug in `src/index.ts:841-848`. The `main()` function calls `await discord.login()` BEFORE setting up the MCP transport. If Discord login hangs (DNS issue, rate limit, network timeout), the MCP server never responds to the Claude CLI initialization handshake, and Claude marks the entire server as unavailable.

## Solution Architecture

### 1. Initialization Order
**Change the startup sequence:**
- BEFORE: `discord.login()` → MCP transport setup → server ready
- AFTER: MCP transport setup → Discord login (background) → server ready

### 2. Discord Connection State Management
Create a connection state tracker that tools can check:
- State: `connecting | connected | error`
- Track error messages for debugging
- Tools should check state before attempting Discord operations

### 3. Error Handling
When Discord is not connected, tool calls should:
- Return clear, actionable error messages
- NOT crash or hang
- Explain what's happening (e.g., "Discord is still connecting, please retry in a moment")

## Implementation Steps

### Step 1: Add Connection State Tracking
Create a connection state manager at the top of `src/index.ts`:
```typescript
type DiscordConnectionState = 'connecting' | 'connected' | 'error';

const LOGIN_TIMEOUT_MS = 30_000; // 30 seconds

const connectionState = {
  status: 'connecting' as DiscordConnectionState,
  error: null as Error | null,
  connectedAt: null as number | null,
  loginStartedAt: null as number | null,
};

function setConnected(): void {
  connectionState.status = 'connected';
  connectionState.connectedAt = Date.now();
  connectionState.error = null;
}

function setError(error: Error): void {
  connectionState.status = 'error';
  connectionState.error = error;
}

function requireDiscordConnection(): void {
  // Use discord.isReady() as source of truth
  if (discord.isReady()) {
    if (connectionState.status !== 'connected') {
      setConnected();
    }
    return;
  }

  if (connectionState.status === 'error') {
    throw new Error(`Discord connection failed: ${connectionState.error?.message ?? 'unknown error'}. Server restart required.`);
  }

  // Check for login timeout
  if (connectionState.loginStartedAt) {
    const elapsed = Date.now() - connectionState.loginStartedAt;
    if (elapsed > LOGIN_TIMEOUT_MS) {
      const timeoutError = new Error(`Discord login timeout after ${LOGIN_TIMEOUT_MS / 1000}s`);
      setError(timeoutError);
      throw new Error(`Discord connection failed: ${timeoutError.message}. Server restart required.`);
    }
  }

  throw new Error('Discord is still connecting. Please retry in a moment.');
}
```

### Step 2: Add Discord Lifecycle Event Handlers
Before `main()`, add event handlers for connection lifecycle:
```typescript
discord.once('ready', () => {
  console.error(`Discord bot logged in as ${discord.user?.tag ?? 'unknown'}`);
  setConnected();
});

discord.on('error', (error) => {
  console.error('Discord client error:', error);
  if (connectionState.status === 'connecting') {
    setError(error);
  }
});
```

### Step 3: Reorder Startup Sequence
Modify `main()` function:
```typescript
async function main(): Promise<void> {
  // Setup MCP transport FIRST
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Discord MCP server ready (Discord connecting in background)');

  // Start Discord login in background (non-blocking)
  connectionState.loginStartedAt = Date.now();
  discord.login(DISCORD_TOKEN).catch((error) => {
    console.error('Discord login failed:', error);
    setError(error instanceof Error ? error : new Error(String(error)));
  });
}
```

### Step 4: Add Connection Checks to All Tools
At the start of the `switch` statement body (line 467, right after `try {`), add:
```typescript
try {
  // All tools require Discord connection
  requireDiscordConnection();

  switch (name) {
    // ... existing cases
  }
} catch (error) {
  return toErrorResponse(error);
}
```

This centralizes the check instead of duplicating it in every case.

### Step 5: Add Disconnect Detection to wait_for_reply
In the `wait_for_reply` handler's polling loop, add a connection check:
```typescript
while (Date.now() - startedAt < timeoutSeconds * 1000) {
  // Check if Discord disconnected mid-wait
  if (!discord.isReady()) {
    return toResponse({
      has_reply: false,
      error: 'Discord connection lost during wait',
      waited_seconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  }

  // ... existing logic
}
```

### Step 6: Tests
Create `src/index.test.ts` with integration-style tests:

**Test 1: requireDiscordConnection() behavior**
```typescript
test('requireDiscordConnection allows calls when isReady', () => {
  // Mock discord.isReady() to return true
  // Assert: requireDiscordConnection() does not throw
});

test('requireDiscordConnection throws when connecting', () => {
  // Mock discord.isReady() to return false
  // Mock connectionState.status = 'connecting'
  // Assert: throws "still connecting"
});

test('requireDiscordConnection throws when error state', () => {
  // Mock connectionState.status = 'error'
  // Assert: throws error with message
});

test('requireDiscordConnection detects timeout', () => {
  // Mock connectionState.loginStartedAt = Date.now() - LOGIN_TIMEOUT_MS - 1000
  // Mock discord.isReady() = false
  // Assert: throws timeout error and sets error state
});
```

**Test 2: Startup sequence verification**
```typescript
test('main() sets up MCP transport before Discord login', async () => {
  // Verify MCP server.connect is called before discord.login
  // This is more of a smoke test to document the order
});
```

### Step 7: Update package.json test script
Change from:
```json
"test": "tsc && node --test dist/helpers.test.js"
```

To run all test files:
```json
"test": "tsc && node --test 'dist/**/*.test.js'"
```

## Edge Cases Addressed

1. **Login timeout**: If Discord login never resolves, the connection state moves from "connecting" to "error" after 30 seconds. Tools get a clear terminal error message instead of endless retries.

2. **Mid-wait disconnection**: `wait_for_reply` now checks `discord.isReady()` in its polling loop and bails out if connection is lost.

3. **Race condition on first tool call**: A tool might be called immediately after MCP connects but before Discord connects. The `requireDiscordConnection()` check handles this by throwing a clear error.

4. **State synchronization**: Using `discord.isReady()` as source of truth instead of tracking login promise completion ensures state matches actual Discord client status.

## Known Limitations (Accepted for this hotfix)

1. **No reconnection handling**: If Discord disconnects after initial connection, the server needs to be restarted. This is acceptable because the orchestrator manages server lifecycle.

2. **Session-memory tools gated**: Tools like `check_reply`, `check_mentions` read in-memory state that could work without active Discord connection, but they're gated for simplicity and consistency. This prevents confusion about what works offline vs online.

3. **Event handlers during startup**: Message/reaction/interaction events that fire before connection completes are processed normally - the event handlers don't check connection state. This is safe because the events are just stored in memory.

## Non-Goals
- Don't implement auto-reconnection logic
- Don't add retry logic for Discord login
- Don't change the Discord client configuration
- Don't modify existing tool functionality beyond adding connection checks

## Definition of Done
- [ ] MCP transport initializes before Discord login
- [ ] Discord login happens in background (non-blocking Promise)
- [ ] Connection state is tracked (connecting/connected/error) with 30s timeout
- [ ] Connection state uses `discord.isReady()` as source of truth
- [ ] Discord lifecycle events ('ready', 'error') update connection state
- [ ] Tool handler switch has centralized `requireDiscordConnection()` check
- [ ] `wait_for_reply` checks for disconnection during polling
- [ ] Tests verify `requireDiscordConnection()` behavior in all states
- [ ] Tests verify timeout transitions connecting → error
- [ ] package.json test script runs all test files
- [ ] All existing tests still pass
- [ ] `npm test && npm run build` succeeds

## Codex Review Feedback Applied
- ✅ Use `discord.isReady()` as source of truth instead of login promise
- ✅ Add login timeout watchdog (30s) to prevent indefinite "connecting" state
- ✅ Centralize connection check instead of per-tool duplication
- ✅ Add disconnect detection to `wait_for_reply` polling loop
- ✅ Use Discord.js lifecycle events ('ready', 'error') for state management
- ⚠️ Test strategy simplified to focus on `requireDiscordConnection()` behavior (module structure makes full integration test complex)
- 📝 Documented decision to gate session-memory tools for consistency
