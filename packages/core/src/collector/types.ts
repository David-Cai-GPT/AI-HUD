import type { Session } from '../model/index.js';
import type { SessionStore } from '../store/types.js';

/**
 * Adapter interface for collecting sessions from external sources.
 * Implementations (e.g. OpenCodeAdapter) are injected by CLI; core does not depend on adapters.
 */
export interface SessionAdapter {
  readonly name: string;
  collect(store: SessionStore): Promise<Session[]>;
  isAvailable(): Promise<boolean>;
}
