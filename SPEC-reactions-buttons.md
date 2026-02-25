# Spec: Reaction Detection & Button Support

## Context

Cael communicates with James via Discord. Currently the only feedback mechanism is text replies (the `send_question` / `check_reply` / `wait_for_reply` flow). This adds two lighter-weight feedback channels:

1. **Reactions** — the lightest form of feedback. React to a message instead of typing.
2. **Buttons** — structured choices. Tap "Approve" instead of typing "approved".

Both follow the existing non-blocking, pollable pattern established by `pendingQuestions`/`replies`.

---

## Feature 1: Reaction Detection (higher priority)

### Discord Setup

- Add `GatewayIntentBits.GuildMessageReactions` to the client intents array in `src/index.ts` (line ~104).
- Add `Partials.Reaction` and `Partials.Message` to the client partials array. Discord.js requires these to receive reaction events on uncached messages.

Guild-only. No `DirectMessageReactions` — Cael's communication is in guild channels. Add later if needed.

### State

```typescript
type StoredReaction = {
  emoji: string;        // Unicode emoji or custom emoji string
  user: string;         // username
  userId: string;       // snowflake
  timestamp: number;    // Date.now() at event time
};

// Key: message ID → array of reactions on that message
const trackedReactions = new Map<string, StoredReaction[]>();

// Set of message IDs sent by the bot — only track reactions on these
const botMessageIds = new Set<string>();
```

### Tracking Bot Messages

Every tool that sends a message (`send_message`, `send_dm`, `send_embed`, `send_image`, `reply`, `send_question`, `send_notification`, `send_message_with_buttons`) should add the sent message's ID to `botMessageIds`. This scopes reaction tracking to only messages the bot authored.

Clean up `botMessageIds` entries older than 48 hours alongside the reaction cleanup.

**Implementation:** After each `channel.send(...)` or equivalent call that returns a `Message`, add:
```typescript
botMessageIds.add(sent.id);
```

### Event Listener

Listen for `messageReactionAdd` on the Discord client, right after the existing `messageCreate` listener:

```typescript
discord.on('messageReactionAdd', (reaction, user) => {
  if (user.bot) return;

  const messageId = reaction.message.id;

  // Only track reactions on messages the bot sent
  if (!botMessageIds.has(messageId)) return;

  // Cleanup old entries (same pattern as MentionTracker)
  cleanupReactions();

  const emoji = reaction.emoji.name ?? reaction.emoji.toString();

  const entry: StoredReaction = {
    emoji,
    user: ('username' in user && user.username) ? user.username : 'unknown',
    userId: user.id,
    timestamp: Date.now(),
  };

  const existing = trackedReactions.get(messageId);
  if (existing) {
    existing.push(entry);
  } else {
    trackedReactions.set(messageId, [entry]);
  }
});
```

### Cleanup

```typescript
function cleanupReactions(): void {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;

  for (const [messageId, reactions] of trackedReactions) {
    const filtered = reactions.filter(r => r.timestamp >= cutoff);
    if (filtered.length === 0) {
      trackedReactions.delete(messageId);
      botMessageIds.delete(messageId);
    } else {
      trackedReactions.set(messageId, filtered);
    }
  }

  // Also prune botMessageIds that have no reactions but are old
  // (We don't have timestamps on botMessageIds, so we rely on
  // Discord snowflake IDs which embed timestamps, but for simplicity
  // just let them accumulate — they're just strings in a Set.
  // The reaction map cleanup handles the important part.)
}
```

### New Tool: `check_reactions`

**Parameters:**
- `message_id` (string, required) — the message to check
- `since` (string, optional) — ISO 8601 timestamp. Only return reactions after this time. Useful for efficient polling.

**Behavior:**
- Look up `trackedReactions.get(messageId)`
- Filter by `since` if provided
- Return the array (or empty array if message ID unknown/no reactions)
- **Do NOT consume/delete** — reactions accumulate and can be checked multiple times
- Unknown `message_id` returns empty array (not an error)

**Response shape:**
```json
{
  "message_id": "123456",
  "reactions": [
    { "emoji": "👍", "user": "james", "user_id": "987654", "timestamp": 1700000000000 },
    { "emoji": "✅", "user": "james", "user_id": "987654", "timestamp": 1700000001000 }
  ]
}
```

**Tool description** (for `src/tools/index.ts`):
> "Check what reactions a message has received. Returns all tracked reactions with emoji, username, and timestamp. Reactions are tracked automatically for the current session on messages sent by the bot. Non-destructive — calling this does not clear the reactions. Use the optional since parameter (ISO 8601) to only get new reactions since last check."

---

## Feature 2: Button Support

### Sending Messages with Buttons

#### New Tool: `send_message_with_buttons`

**Parameters:**
- `channel` (string, required) — channel name or ID (resolved same as `send_message`)
- `text` (string, required) — message content (validated same as other message tools, max 2000 chars)
- `buttons` (array, required) — array of button definitions:
  - `id` (string, required) — unique identifier for this button (the `customId` in Discord.js). Max 100 characters.
  - `label` (string, required) — display text. Max 80 characters.
  - `style` (string, required) — one of: `"primary"` (blue), `"secondary"` (gray), `"success"` (green), `"danger"` (red). **Strict validation — throws on invalid value.**

**Constraints:**
- Min 1, max 5 buttons per message (Discord limit per action row)
- Button `id` values must be unique within the message
- Button `id` max 100 characters (Discord `customId` limit)
- Button `label` max 80 characters (Discord limit)
- Button `style` must be one of the four valid values — no silent defaulting

**Validation** (in `src/helpers.ts`):

```typescript
type ButtonInput = {
  id: string;
  label: string;
  style: string;
};

const VALID_BUTTON_STYLES = ['primary', 'secondary', 'success', 'danger'] as const;
type ButtonStyleName = typeof VALID_BUTTON_STYLES[number];

function validateButtons(buttons: unknown): ButtonInput[] {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    throw new Error('buttons must be a non-empty array');
  }
  if (buttons.length > 5) {
    throw new Error('buttons must have at most 5 entries (Discord limit)');
  }

  const seenIds = new Set<string>();
  const validated: ButtonInput[] = [];

  for (const button of buttons) {
    if (typeof button !== 'object' || button === null) {
      throw new Error('each button must be an object with id, label, and style');
    }

    const { id, label, style } = button as Record<string, unknown>;

    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('each button must have a non-empty string id');
    }
    if (id.length > 100) {
      throw new Error(`button id "${id.slice(0, 20)}..." exceeds 100 character limit`);
    }
    if (seenIds.has(id)) {
      throw new Error(`duplicate button id: "${id}"`);
    }
    seenIds.add(id);

    if (typeof label !== 'string' || label.trim() === '') {
      throw new Error('each button must have a non-empty string label');
    }
    if (label.length > 80) {
      throw new Error(`button label "${label.slice(0, 20)}..." exceeds 80 character limit`);
    }

    if (typeof style !== 'string' || !VALID_BUTTON_STYLES.includes(style as ButtonStyleName)) {
      throw new Error(`button style must be one of: ${VALID_BUTTON_STYLES.join(', ')}`);
    }

    validated.push({ id: id.trim(), label, style });
  }

  return validated;
}
```

**Implementation:**
```typescript
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const BUTTON_STYLE_MAP: Record<string, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

// Build buttons from validated args
const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
  validatedButtons.map(b =>
    new ButtonBuilder()
      .setCustomId(b.id)
      .setLabel(b.label)
      .setStyle(BUTTON_STYLE_MAP[b.style])
  )
);

const sent = await channel.send({ content: text, components: [row] });

// Track for interaction handling
pendingButtons.set(sent.id, {
  messageId: sent.id,
  channelId: channel.id,
  buttonIds: validatedButtons.map(b => b.id),
  timestamp: Date.now(),
});

// Also track as bot message for reaction detection
botMessageIds.add(sent.id);
```

**State:**
```typescript
type PendingButtons = {
  messageId: string;
  channelId: string;
  buttonIds: string[];
  timestamp: number;
};

type StoredButtonClick = {
  buttonId: string;
  user: string;
  userId: string;
  timestamp: number;
};

const pendingButtons = new Map<string, PendingButtons>();
const buttonClicks = new Map<string, StoredButtonClick[]>();
```

**Response:**
```json
{
  "success": true,
  "message_id": "123456"
}
```

**Tool description:**
> "Send a message with clickable buttons. Returns the message ID — use check_button_clicks to poll for clicks. Max 5 buttons per message. Styles: primary (blue), secondary (gray), success (green), danger (red)."

### Interaction Handler

Add an `interactionCreate` event listener. **Critical: always acknowledge every button interaction** to prevent Discord's "This interaction failed" error — even for untracked or expired messages.

```typescript
discord.on('interactionCreate', (interaction) => {
  if (!interaction.isButton()) return;

  // Always acknowledge to prevent "This interaction failed" in Discord UI
  interaction.deferUpdate().catch(() => {});

  const messageId = interaction.message.id;

  // Only record clicks on messages we're tracking
  if (!pendingButtons.has(messageId)) return;

  // Cleanup old entries
  cleanupButtons();

  const click: StoredButtonClick = {
    buttonId: interaction.customId,
    user: interaction.user.username,
    userId: interaction.user.id,
    timestamp: Date.now(),
  };

  const existing = buttonClicks.get(messageId);
  if (existing) {
    existing.push(click);
  } else {
    buttonClicks.set(messageId, [click]);
  }
});
```

**Key change from v1:** `deferUpdate()` is called first, before the tracking check. This ensures users never see "This interaction failed" regardless of whether the message is still tracked.

### Cleanup

```typescript
function cleanupButtons(): void {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;

  for (const [messageId, pending] of pendingButtons) {
    if (pending.timestamp < cutoff) {
      pendingButtons.delete(messageId);
      buttonClicks.delete(messageId);
    }
  }
}
```

### New Tool: `check_button_clicks`

**Parameters:**
- `message_id` (string, required) — the message to check
- `since` (string, optional) — ISO 8601 timestamp. Only return clicks after this time.

**Behavior:**
- Look up `buttonClicks.get(messageId)`
- Filter by `since` if provided
- Return the array (or empty array if message ID unknown/no clicks)
- **Do NOT consume/delete** — clicks accumulate and can be checked multiple times
- Unknown `message_id` returns empty array (not an error)

**Response shape:**
```json
{
  "message_id": "123456",
  "clicks": [
    { "button_id": "approve", "user": "james", "user_id": "987654", "timestamp": 1700000000000 }
  ]
}
```

**Tool description:**
> "Check which buttons have been clicked on a message sent with send_message_with_buttons. Returns all clicks with button ID, username, and timestamp. Non-destructive — calling this does not clear the clicks. Use the optional since parameter (ISO 8601) to only get new clicks since last check. Data is session-scoped."

---

## File Changes Summary

### `src/index.ts`
- Add `GatewayIntentBits.GuildMessageReactions` to intents
- Add `Partials.Reaction` and `Partials.Message` to partials
- Add imports: `ActionRowBuilder`, `ButtonBuilder`, `ButtonStyle` from discord.js
- Add types: `StoredReaction`, `PendingButtons`, `StoredButtonClick`
- Add state: `trackedReactions` map, `botMessageIds` set, `pendingButtons` map, `buttonClicks` map
- Add `botMessageIds.add(sent.id)` to every tool that sends a message
- Add event listener: `messageReactionAdd` (scoped to bot messages only)
- Add event listener: `interactionCreate` (always acknowledges, then tracks if known)
- Add cleanup functions: `cleanupReactions()`, `cleanupButtons()`
- Add tool cases in switch: `check_reactions`, `send_message_with_buttons`, `check_button_clicks`

### `src/tools/index.ts`
- Add tool schemas for: `check_reactions`, `send_message_with_buttons`, `check_button_clicks`
- All schemas must have `additionalProperties: false` (matching existing pattern)
- `send_message_with_buttons` button style uses `enum` in schema (matching `set_status` pattern)

### `src/helpers.ts`
- Export `validateButtons()` function (validates array structure, max 5, unique IDs, id length, label length, strict style)
- Export `VALID_BUTTON_STYLES` constant
- Export `parseOptionalTimestamp()` helper for the `since` parameter (parse ISO 8601, throw on invalid, return `number | undefined`)

### `src/helpers.test.ts`
- Tests for `validateButtons()`:
  - Valid input (1 button, 5 buttons)
  - Empty array throws
  - >5 buttons throws
  - Duplicate IDs throws
  - Missing/empty id throws
  - Missing/empty label throws
  - id >100 chars throws
  - label >80 chars throws
  - Invalid style throws
- Tests for `parseOptionalTimestamp()`:
  - Valid ISO string returns timestamp number
  - undefined returns undefined
  - Invalid string throws

---

## What NOT to Build

- No `wait_for_reaction` or `wait_for_button_click` blocking tools. The `check_*` + polling pattern from the caller is sufficient. Trivial to add later.
- No link buttons (URL buttons). Only component buttons with custom IDs.
- No select menus or modals. Just buttons.
- No persistence to disk. In-memory maps, same as existing state.
- No reaction removal tracking (`messageReactionRemove`). Add later if needed.
- No DM reaction support (`DirectMessageReactions` intent). Guild-only for now.
- No idle-timer cleanup. Event-driven cleanup matches `MentionTracker` pattern.
- No deduplication of same-user reactions/clicks. Store as event log. Caller can filter.

---

## Test Plan

### Unit Tests (helpers.test.ts)
- `validateButtons()`: all cases listed above
- `parseOptionalTimestamp()`: valid, undefined, invalid

### Integration/Behavioral Verification
- `npm run build` passes
- `npm test` passes (existing + new)
- Server starts without errors
- Tool schemas are valid (all required fields present, `additionalProperties: false`)
- Tool descriptions are clear and mention session scope
