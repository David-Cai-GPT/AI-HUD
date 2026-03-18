import type { Session } from '@ai-hud/core';

export interface SessionAdapter {
  readonly name: string;
  collect(): Promise<Session[]>;
  isAvailable(): Promise<boolean>;
}
