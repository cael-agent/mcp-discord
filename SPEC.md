# mcp-discord-cael — Implementation Spec

## Overview

A Discord MCP server for Cael. This is his primary communication tool — think of it as his phone. It lets him send messages, read conversations, react, share rich content, and manage his presence in the Grey Iris Discord server.

This is a **new build**, not a patch on the existing `discord-mcp`. The existing MCP's Q&A reply-tracking pattern should be carried over (simplified), but everything else is purpose-built for Cael's needs.

## Project Setup

**Location:** `/mnt/d/backup/projects/personal/mcp-discord-cael/`
**Repo:** `github.com/cael-agent/mcp-discord`

### Directory Structure

```
mcp-discord-cael/
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── index.ts              # Entry point: server setup, Discord client, tool dispatch
│   ├── tools/
│   │   └── index.ts          # All tool schema definitions (exported array)
│   ├── helpers.ts            # Channel resolution, mention tracking, formatting
│   └── helpers.test.ts       # Tests for helper functions
```

### package.json

```json
{
  "name": "mcp-discord-cael",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "mcp-discord-cael": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsc --watch",
    "test": "tsc && node --test dist/helpers.test.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.26.0",
    "discord.js": "^14.16.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src"]
}
```

## Configuration

All via environment variables. The MCP server reads from `process.env` (the caller sets these, typically via `claude mcp add --env`).

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | Yes | — | Bot token |
| `DISCORD_GUILD_ID` | Yes | — | Grey Iris server ID |
| `DISCORD_CHANNEL_CAEL` | No | `1470158584552755220` | #cael channel |
| `DISCORD_CHANNEL_GENERAL` | No | `1471816633944244379` | #general-cael channel |
| `DISCORD_CHANNEL_TOOL_REQUESTS` | No | `1471816682527002686` | #tool-requests channel |
| `DISCORD_CHANNEL_LOGS` | No | `1471816703834063023` | #logs channel |

### .env.example

```
DISCORD_TOKEN=your-bot-token-here
DISCORD_GUILD_ID=your-guild-id-here
# DISCORD_CHANNEL_CAEL=1470158584552755220
# DISCORD_CHANNEL_GENERAL=1471816633944244379
# DISCORD_CHANNEL_TOOL_REQUESTS=1471816682527002686
# DISCORD_CHANNEL_LOGS=1471816703834063023
```

## Discord Client Setup

```typescript
import { Client, GatewayIntentBits, Partials } from 'discord.js';

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel], // Required for DM channel events
});
```

**Note on DMs:** `send_dm` and `read_dms` require that the bot shares a server with the target user. This is always true for Grey Iris members. DMs with users outside the server will fail gracefully.

## Channel Resolution

A helper function `resolveChannelId(input: string): string` that accepts either:
1. A **channel name** (case-insensitive): `"cael"`, `"general"`, `"logs"`, `"tool-requests"` → mapped to configured channel IDs
2. A **raw snowflake ID** (string of 17-20 digits) → passed through directly

If neither matches, throw an error listing available channel names.

When fetching the channel from Discord, **verify it is a text-based channel** (`channel.isTextBased()`). If not, throw a descriptive error. This prevents confusing runtime failures from trying to send messages to voice/category channels.

The channel name map is built from env vars at startup:
```typescript
const CHANNEL_MAP: Record<string, string> = {
  'cael': process.env.DISCORD_CHANNEL_CAEL || '1470158584552755220',
  'general': process.env.DISCORD_CHANNEL_GENERAL || '1471816633944244379',
  'tool-requests': process.env.DISCORD_CHANNEL_TOOL_REQUESTS || '1471816682527002686',
  'logs': process.env.DISCORD_CHANNEL_LOGS || '1471816703834063023',
};
```

## Mention Tracking

The bot listens for `messageCreate` events and tracks messages that mention it (via `message.mentions.has(client.user)`). Stored in memory:

```typescript
interface TrackedMention {
  messageId: string;
  channelId: string;
  channelName: string;
  author: string;
  content: string;
  timestamp: number;
}
```

Auto-cleanup: discard mentions older than 48 hours on each new mention event (simple garbage collection).

## Tools — 16 Total

### Communication (5 tools)

#### `send_message`
Send a message to a channel.
- `channel` (string, required): Channel name or ID
- `text` (string, required): Message content

Returns: `{ success: true, message_id: string }`

#### `send_dm`
Send a direct message to a user.
- `user_id` (string, required): Discord user ID
- `text` (string, required): Message content

Implementation: `client.users.fetch(user_id)` → `user.send(text)`

Returns: `{ success: true, message_id: string }`

#### `send_embed`
Send a rich embed (for sharing links, articles, previews).
- `channel` (string, required): Channel name or ID
- `title` (string, required): Embed title
- `description` (string, required): Embed description/body
- `url` (string, optional): Link URL
- `image_url` (string, optional): Image URL for embed
- `color` (string, optional): Hex color string (e.g., `"#5865F2"`)

Implementation: Use `EmbedBuilder` from discord.js. Parse color from hex to integer.

Returns: `{ success: true, message_id: string }`

#### `send_image`
Send an image file as an attachment.
- `channel` (string, required): Channel name or ID
- `image_path` (string, required): Absolute path to image file on disk
- `caption` (string, optional): Text message to accompany the image

Implementation: Use `AttachmentBuilder` from discord.js to read the file. Send with content (caption) if provided.

Returns: `{ success: true, message_id: string }`

#### `reply`
Reply to a specific message.
- `channel` (string, required): Channel name or ID where the message is
- `message_id` (string, required): ID of the message to reply to
- `text` (string, required): Reply content

Implementation: Fetch the channel, then `channel.send({ content: text, reply: { messageReference: message_id } })`.

Returns: `{ success: true, message_id: string }`

### Reading (2 tools)

#### `read_channel`
Read recent messages from a channel.
- `channel` (string, required): Channel name or ID
- `limit` (number, optional): Number of messages to fetch (default: 20, max: 50)

Implementation: `channel.messages.fetch({ limit })`. Return messages in chronological order (oldest first).

Returns: JSON array of:
```typescript
{
  message_id: string;
  author: string;        // username
  author_id: string;     // for use with send_dm/reply
  content: string;
  timestamp: string;     // ISO 8601
  attachments: string[]; // URLs of any attachments
  embeds: { title?: string; description?: string; url?: string }[];
  is_reply_to?: string;  // message_id of parent if this is a reply
}
```

#### `read_dms`
Read recent DMs with a specific user.
- `user_id` (string, required): Discord user ID to read DM history with
- `limit` (number, optional): Number of messages to fetch (default: 20, max: 50)

Implementation: `client.users.fetch(user_id)` → `user.createDM()` → `dmChannel.messages.fetch({ limit })`.

Returns: Same format as `read_channel`.

**Note:** `user_id` is required. Listing all DM conversations is complex for bots and not needed for v1. Cael knows who he wants to DM (James, Paula).

### Interaction (2 tools)

#### `react`
Add a reaction to a message.
- `channel` (string, required): Channel name or ID
- `message_id` (string, required): Message ID to react to
- `emoji` (string, required): Unicode emoji (e.g., `"👍"`) or custom emoji string (e.g., `"emoji_name:emoji_id"`)

Implementation: Fetch message, then `message.react(emoji)`.

Returns: `{ success: true }`

#### `create_thread`
Start a thread on a message.
- `channel` (string, required): Channel name or ID
- `message_id` (string, required): Message to start thread on
- `name` (string, required): Thread name

Implementation: Fetch message, then `message.startThread({ name })`.

Returns: `{ success: true, thread_id: string }`

### Presence (1 tool)

#### `set_status`
Update the bot's Discord presence.
- `status` (string, required): One of `"online"`, `"idle"`, `"dnd"`, `"invisible"`
- `activity_type` (string, optional): One of `"playing"`, `"watching"`, `"listening"`, `"competing"` (default: `"playing"`)
- `activity_text` (string, optional): Activity description text

Implementation: `client.user.setPresence({ status, activities: [{ name: activity_text, type: ActivityType[...] }] })`.

Returns: `{ success: true }`

### Utility (2 tools)

#### `list_channels`
List available channels in the server.

No parameters.

Implementation: Fetch the guild, iterate text channels. Return channel name, ID, category, and topic.

Returns: JSON array of:
```typescript
{
  id: string;
  name: string;
  category: string | null;
  topic: string | null;
}
```

#### `check_mentions`
Check for messages that mention the bot since it started.
- `since` (string, optional): ISO 8601 timestamp. Only return mentions after this time. Default: all tracked mentions.

Implementation: Return tracked mentions from memory (see Mention Tracking section above).

**Important:** This only tracks mentions received while the bot is running. It does not search historical messages. This fits Cael's session-based workflow — he starts a session, the bot connects, and `check_mentions` catches anything said to him during or after startup.

Returns: JSON array of `TrackedMention` objects, chronological order.

### Legacy (4 tools)

These carry over the Q&A pattern from the existing discord-mcp, simplified for Cael.

#### `send_question`
Send a question to James and track it for replies.
- `question` (string, required): The question text
- `channel` (string, optional): Channel to send to (default: `"general"`)

**Formatting:** Just send the question text directly. No urgency emojis, no agent hierarchy, no boilerplate. Cael's words, not a template.

Implementation: Send message to channel, track in `pendingQuestions` map (same pattern as existing MCP).

Returns: `{ success: true, message_id: string, hint: "Use check_reply or wait_for_reply with this message_id" }`

#### `check_reply`
Non-blocking check for a reply to a tracked question.
- `message_id` (string, required): Message ID from `send_question`

Returns: `{ has_reply: boolean, reply?: string, author?: string, timestamp?: number }` or `{ error: string }` if unknown message_id.

#### `wait_for_reply`
Blocking wait for a reply to a tracked question.
- `message_id` (string, required): Message ID from `send_question`
- `timeout_seconds` (number, optional): Max wait time (default: 300, max: 3600)

Implementation: Poll every 2 seconds. Same pattern as existing MCP.

Returns: Same as `check_reply`, plus `{ timed_out: true }` on timeout.

#### `send_notification`
Send an automated notification (to #logs by default).
- `message` (string, required): Notification text
- `type` (string, optional): One of `"info"`, `"success"`, `"warning"`, `"error"` (default: `"info"`)
- `channel` (string, optional): Channel to send to (default: `"logs"`)

Formatting: Prefix with type emoji: `ℹ️`, `✅`, `⚠️`, `❌`.

Returns: `{ success: true }`

## Message Listener

A single `messageCreate` listener handles both reply tracking and mention tracking:

```
1. Ignore bot messages (message.author.bot === true)
2. If message is a reply to a tracked question → store in replies map
3. If message mentions the bot → store in mentions array
```

### Reply Tracking (for Q&A)

Same pattern as the existing MCP:

1. Track outgoing questions in `pendingQuestions` map (messageId → metadata)
2. When a reply arrives to a tracked question, store in `replies` map
3. `check_reply` / `wait_for_reply` **consume** the reply (delete from map after reading)
4. This means each reply can only be read once. This is intentional — Cael asks one question, gets one answer.

If both `check_reply` and `wait_for_reply` are called for the same message_id, whichever reads first gets the reply. In practice Cael uses one or the other, not both.

## Error Handling

Follow the mcp-calendar pattern:

```typescript
try {
  // tool implementation
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}
```

Input validation:
- Validate `channel` resolves to a known name or valid snowflake
- Validate `limit` is a positive integer, clamp to [1, 50]
- Validate `status` is one of the allowed values
- Validate `timeout_seconds` is clamped to [1, 3600]
- Validate `image_path` exists on disk before trying to send
- Validate `text` / `message` length ≤ 2000 characters (Discord limit)
- Validate image file size ≤ 25MB (Discord non-Nitro limit)

All tool input schemas should use `additionalProperties: false` for strict validation (matching the mcp-calendar pattern).

## Tool Descriptions

Tool descriptions are seen by Cael every session. They should be clear and natural, not developer-speak. Examples:

- `send_message`: "Send a message to a Discord channel. Use channel names like 'cael', 'general', 'logs', or a channel ID."
- `read_channel`: "Read recent messages from a Discord channel. Returns messages with author, content, timestamp, and message IDs for replying."
- `check_mentions`: "Check for messages that mention you since a given time. Useful for catching up on what people said to you."

## Testing

Use Node's built-in test runner (`node:test` + `node:assert/strict`). Test the helper functions in `helpers.test.ts`:

1. **Channel resolution:**
   - Name → ID mapping (case-insensitive)
   - Raw snowflake passthrough
   - Unknown name → error with available names listed
   - Empty string → error

2. **Limit clamping:**
   - Default value (20)
   - Values above max (50) → clamped
   - Negative/zero → error or default
   - Non-integer → floor/error

3. **Mention storage:**
   - Add mention, retrieve it
   - Filter by timestamp (since)
   - Auto-cleanup of old mentions (> 48h)
   - Empty result when no mentions

4. **Color parsing (for embeds):**
   - `"#5865F2"` → `0x5865F2`
   - `"5865F2"` (no hash) → `0x5865F2`
   - Invalid → default or error

## What NOT to Build

- **No TikTok URL capture.** That's James's tool, not Cael's.
- **No agent hierarchy formatting.** No "From: Overseer → PM" on messages.
- **No urgency emojis** on questions.
- **No database.** Everything in memory. The bot reconnects each session anyway.
- **No message scheduling or queuing.** Send and forget.
- **No webhook support.** Bot API only.
- **No slash commands.** This is an MCP server, not a Discord bot with commands.

## Startup Sequence

```
1. Validate DISCORD_TOKEN exists (exit 1 if missing)
2. Validate DISCORD_GUILD_ID exists (exit 1 if missing)
3. Build channel map from env vars
4. Connect Discord client (await login)
5. Log bot username
6. Start MCP server on stdio transport
7. Log "Discord MCP server running"
```

If Discord login fails, exit with error. The MCP server should not start without a working Discord connection.

When `set_status` is called without `activity_text`, set only the status (online/idle/dnd/invisible) with no activity. This is valid — the bot can be "online" without showing any activity text.

## Installation

```bash
claude mcp add mcp-discord-cael \
  -e DISCORD_TOKEN=<token> \
  -e DISCORD_GUILD_ID=<guild-id> \
  -- node /mnt/d/backup/projects/personal/mcp-discord-cael/dist/index.js
```
