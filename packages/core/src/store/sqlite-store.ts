import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Session } from '../model/index.js';
import type {
  ContextUsage,
  CostInfo,
  TaskItem,
  ToolUsage,
} from '../model/session.js';
import type { SessionFilter, SessionStore } from './types.js';

interface RawMeta {
  tools?: ToolUsage[];
  agents?: string[];
  skills?: string[];
  mcp?: string[];
  tasks?: TaskItem[];
}

const DEFAULT_DB_PATH = path.join(os.homedir(), '.ai-hud', 'data', 'ai-hud.db');

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  project_path TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read INTEGER,
  cache_create INTEGER,
  cost_amount INTEGER,
  cost_currency TEXT,
  raw_meta TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_model ON sessions(model);
`;

export class SqliteStore implements SessionStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec(CREATE_TABLE_SQL);
  }

  private sessionToRow(session: Session): Record<string, unknown> {
    const rawMeta: RawMeta = {};
    if (session.tools?.length) rawMeta.tools = session.tools;
    if (session.agents?.length) rawMeta.agents = session.agents;
    if (session.skills?.length) rawMeta.skills = session.skills;
    if (session.mcp?.length) rawMeta.mcp = session.mcp;
    if (session.tasks?.length) rawMeta.tasks = session.tasks;

    const cu = session.contextUsage;
    const cost = session.cost;

    return {
      id: session.id,
      source: session.source,
      started_at: session.startedAt,
      ended_at: session.endedAt ?? null,
      project_path: session.projectPath ?? null,
      model: session.model ?? null,
      input_tokens: cu?.inputTokens ?? null,
      output_tokens: cu?.outputTokens ?? null,
      cache_read: cu?.cacheRead ?? null,
      cache_create: cu?.cacheCreate ?? null,
      cost_amount: cost?.amount ?? null,
      cost_currency: cost?.currency ?? null,
      raw_meta:
        Object.keys(rawMeta).length > 0 ? JSON.stringify(rawMeta) : null,
    };
  }

  private rowToSession(row: Record<string, unknown>): Session {
    let rawMeta: RawMeta | null = null;
    if (typeof row.raw_meta === 'string' && row.raw_meta) {
      try {
        rawMeta = JSON.parse(row.raw_meta) as RawMeta;
      } catch {
        rawMeta = null;
      }
    }

    const contextUsage: ContextUsage | undefined =
      row.input_tokens != null || row.output_tokens != null
        ? {
            inputTokens: Number(row.input_tokens) || 0,
            outputTokens: Number(row.output_tokens) || 0,
            ...(row.cache_read != null && { cacheRead: Number(row.cache_read) }),
            ...(row.cache_create != null && {
              cacheCreate: Number(row.cache_create),
            }),
          }
        : undefined;

    const cost: CostInfo | undefined =
      row.cost_amount != null && row.cost_currency != null
        ? {
            amount: Number(row.cost_amount),
            currency: String(row.cost_currency),
          }
        : undefined;

    return {
      id: String(row.id),
      source: String(row.source),
      startedAt: String(row.started_at),
      ...(row.ended_at != null && { endedAt: String(row.ended_at) }),
      ...(row.project_path != null && {
        projectPath: String(row.project_path),
      }),
      ...(row.model != null && { model: String(row.model) }),
      ...(contextUsage && { contextUsage }),
      ...(rawMeta?.tools?.length && { tools: rawMeta.tools }),
      ...(rawMeta?.agents?.length && { agents: rawMeta.agents }),
      ...(rawMeta?.skills?.length && { skills: rawMeta.skills }),
      ...(rawMeta?.mcp?.length && { mcp: rawMeta.mcp }),
      ...(rawMeta?.tasks?.length && { tasks: rawMeta.tasks }),
      ...(cost && { cost }),
    };
  }

  async append(session: Session): Promise<void> {
    const row = this.sessionToRow(session);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (
        id, source, started_at, ended_at, project_path, model,
        input_tokens, output_tokens, cache_read, cache_create,
        cost_amount, cost_currency, raw_meta
      ) VALUES (
        @id, @source, @started_at, @ended_at, @project_path, @model,
        @input_tokens, @output_tokens, @cache_read, @cache_create,
        @cost_amount, @cost_currency, @raw_meta
      )
    `);
    stmt.run(row);
  }

  async query(filter: SessionFilter): Promise<Session[]> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.source != null) {
      conditions.push('source = @source');
      params.source = filter.source;
    }
    if (filter.model != null) {
      conditions.push('model = @model');
      params.model = filter.model;
    }
    if (filter.from != null) {
      conditions.push('started_at >= @from');
      params.from = filter.from;
    }
    if (filter.to != null) {
      conditions.push('started_at <= @to');
      params.to = filter.to;
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    if (filter.limit != null && Number.isFinite(filter.limit)) {
      params._limit = Math.max(1, Math.floor(filter.limit));
    }
    const limitClause =
      params._limit != null ? 'LIMIT @_limit' : '';

    const sql = `SELECT * FROM sessions ${whereClause} ORDER BY started_at DESC ${limitClause}`.trim();
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(params) as Record<string, unknown>[];

    return rows.map((r) => this.rowToSession(r));
  }

  async getById(id: string): Promise<Session | null> {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row != null ? this.rowToSession(row) : null;
  }

  close(): void {
    this.db.close();
  }
}
