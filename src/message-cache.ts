const MAX_CACHE_SIZE = 10_000;

export class MessageChannelCache {
  private cache = new Map<string, string>(); // messageId -> channelId
  private insertionOrder: string[] = [];
  private maxSize: number;

  constructor(maxSize = MAX_CACHE_SIZE) {
    this.maxSize = maxSize;
  }

  set(messageId: string, channelId: string): void {
    if (this.cache.has(messageId)) {
      return;
    }
    this.cache.set(messageId, channelId);
    this.insertionOrder.push(messageId);

    while (this.insertionOrder.length > this.maxSize) {
      const oldest = this.insertionOrder.shift()!;
      this.cache.delete(oldest);
    }
  }

  get(messageId: string): string | undefined {
    return this.cache.get(messageId);
  }

  setMany(entries: Array<{ messageId: string; channelId: string }>): void {
    for (const { messageId, channelId } of entries) {
      this.set(messageId, channelId);
    }
  }

  get size(): number {
    return this.cache.size;
  }
}
