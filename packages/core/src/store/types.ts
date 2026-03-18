import type { Session } from '../model/index.js';

export interface SessionFilter {
  source?: string;
  model?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface SessionStore {
  append(session: Session): Promise<void>;
  query(filter: SessionFilter): Promise<Session[]>;
  getById(id: string): Promise<Session | null>;
}
