import type { SessionStore } from '../store/types.js';
import type { SessionAdapter } from './types.js';

export type { SessionAdapter } from './types.js';

export class Collector {
  constructor(
    private readonly store: SessionStore,
    private readonly adapters: SessionAdapter[]
  ) {}

  async run(): Promise<void> {
    for (const adapter of this.adapters) {
      try {
        const available = await adapter.isAvailable();
        if (!available) continue;

        const sessions = await adapter.collect();
        for (const session of sessions) {
          await this.store.append(session);
        }
      } catch (err) {
        console.error(`[Collector] adapter "${adapter.name}" failed:`, err);
      }
    }
  }
}
