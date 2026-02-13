export const tools = [
  {
    name: 'send_message',
    description:
      "Send a message to a Discord channel. Use channel names like 'cael', 'general', 'logs', or a channel ID.",
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: "Channel name or ID.",
        },
        text: {
          type: 'string',
          description: 'Message text (max 2000 characters).',
        },
      },
      required: ['channel', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_dm',
    description: 'Send a direct message to a Discord user by user ID.',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: {
          type: 'string',
          description: 'Target Discord user ID.',
        },
        text: {
          type: 'string',
          description: 'Message text (max 2000 characters).',
        },
      },
      required: ['user_id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_embed',
    description: 'Send a rich embed to a Discord channel with optional URL, image, and color.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel name or ID.',
        },
        title: {
          type: 'string',
          description: 'Embed title.',
        },
        description: {
          type: 'string',
          description: 'Embed body text.',
        },
        url: {
          type: 'string',
          description: 'Optional link URL for the embed.',
        },
        image_url: {
          type: 'string',
          description: 'Optional image URL for the embed.',
        },
        color: {
          type: 'string',
          description: 'Optional hex color (for example #5865F2).',
        },
      },
      required: ['channel', 'title', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_image',
    description: 'Send an image file from disk to a Discord channel, with an optional caption.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel name or ID.',
        },
        image_path: {
          type: 'string',
          description: 'Absolute path to an image file on disk.',
        },
        caption: {
          type: 'string',
          description: 'Optional caption text (max 2000 characters).',
        },
      },
      required: ['channel', 'image_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'reply',
    description: 'Reply to a specific message in a channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel name or ID where the target message lives.',
        },
        message_id: {
          type: 'string',
          description: 'Message ID to reply to.',
        },
        text: {
          type: 'string',
          description: 'Reply text (max 2000 characters).',
        },
      },
      required: ['channel', 'message_id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_channel',
    description:
      'Read recent messages from a Discord channel. Returns messages with author, content, timestamp, and message IDs for replying.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel name or ID.',
        },
        limit: {
          type: 'number',
          description: 'How many messages to fetch (default 20, max 50).',
        },
      },
      required: ['channel'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_dms',
    description: 'Read recent direct messages with a specific user ID.',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: {
          type: 'string',
          description: 'Discord user ID.',
        },
        limit: {
          type: 'number',
          description: 'How many messages to fetch (default 20, max 50).',
        },
      },
      required: ['user_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'react',
    description: 'Add a reaction emoji to a message in a channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel name or ID.',
        },
        message_id: {
          type: 'string',
          description: 'Message ID to react to.',
        },
        emoji: {
          type: 'string',
          description: 'Unicode emoji or custom emoji string (name:id).',
        },
      },
      required: ['channel', 'message_id', 'emoji'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_thread',
    description: 'Create a thread from an existing message in a channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel name or ID.',
        },
        message_id: {
          type: 'string',
          description: 'Message ID to start the thread from.',
        },
        name: {
          type: 'string',
          description: 'Thread name.',
        },
      },
      required: ['channel', 'message_id', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_status',
    description:
      "Update bot presence status to online, idle, dnd, or invisible. Optionally set an activity text and type.",
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['online', 'idle', 'dnd', 'invisible'],
          description: 'Presence status.',
        },
        activity_type: {
          type: 'string',
          enum: ['playing', 'watching', 'listening', 'competing'],
          description: 'Activity type (defaults to playing when activity_text is set).',
        },
        activity_text: {
          type: 'string',
          description: 'Optional activity text.',
        },
      },
      required: ['status'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_channels',
    description: 'List available text channels in the configured Discord server.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'check_mentions',
    description:
      'Check for messages that mention you since a given time. Session-only: this only includes mentions received while this MCP process is running.',
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'Optional ISO timestamp. Only mentions at or after this time are returned.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'send_question',
    description:
      "Send a plain question message and track it for replies. Defaults to the 'general' channel.",
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'Question text to send.',
        },
        channel: {
          type: 'string',
          description: "Optional channel name or ID (default: 'general').",
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_reply',
    description: 'Check once for a reply to a tracked question message ID (non-blocking).',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'Message ID returned by send_question.',
        },
      },
      required: ['message_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for_reply',
    description: 'Wait for a reply to a tracked question message ID, with timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'Message ID returned by send_question.',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Timeout in seconds (default 300, max 3600).',
        },
      },
      required: ['message_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_notification',
    description:
      "Send an automated notification with a type emoji prefix. Defaults to the 'logs' channel.",
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Notification text (max 2000 characters).',
        },
        type: {
          type: 'string',
          enum: ['info', 'success', 'warning', 'error'],
          description: 'Notification type (default: info).',
        },
        channel: {
          type: 'string',
          description: "Optional channel name or ID (default: 'logs').",
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
];
