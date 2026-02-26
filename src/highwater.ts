import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export type HighwaterState = {
  channels: Record<string, string>; // channelId -> lastMessageId (snowflake)
};

const EMPTY_STATE: HighwaterState = { channels: {} };

export function getDefaultStatePath(): string {
  return process.env.DISCORD_STATE_PATH ?? 'data/highwater.json';
}

export async function loadHighwater(filePath: string): Promise<HighwaterState> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.channels &&
      typeof parsed.channels === 'object' &&
      !Array.isArray(parsed.channels)
    ) {
      return parsed as HighwaterState;
    }
    return { ...EMPTY_STATE };
  } catch (err: unknown) {
    return { ...EMPTY_STATE };
  }
}

export async function saveHighwater(filePath: string, state: HighwaterState): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

export function getChannelHighwater(state: HighwaterState, channelId: string): string | undefined {
  return state.channels[channelId];
}

export function updateMultipleHighwaters(
  state: HighwaterState,
  updates: Record<string, string>,
): HighwaterState {
  return {
    ...state,
    channels: {
      ...state.channels,
      ...updates,
    },
  };
}
