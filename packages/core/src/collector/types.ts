import type { Session } from '../model/index.js';

/**
 * Adapter interface for collecting sessions from external sources.
 * Implementations (e.g. OpenCodeAdapter) are injected by CLI; core does not depend on adapters.
 */
export interface SessionAdapter {
  readonly name: string;
  collect(): Promise<Session[]>;
  isAvailable(): Promise<boolean>;
}
