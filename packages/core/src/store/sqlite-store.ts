import initSqlJs, { type SqlJsStatic } from 'sql.js';
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
  prompt?: string;
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
  system_tokens INTEGER,
  user_tokens INTEGER,
  assistant_tokens INTEGER,
  cost_amount INTEGER,
  cost_currency TEXT,
  raw_meta TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_model ON sessions(model);
`;

type Db = InstanceType<SqlJsStatic['Database']>;

function rowFromColumnsValues(
  columns: string[],
  rowValues: unknown[]
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i++) {
    row[columns[i]] = rowValues[i];
  }
  return row;
}

function rowsFromResult(columns: string[], values: unknown[][]): Record<string, unknown>[] {
  return values.map((vals) => {
    const row: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]] = vals[i];
    }
    return row;
  });
}

export class SqliteStore implements SessionStore {
  private db: Db | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly dbPath: string = DEFAULT_DB_PATH) {}

  private async ensureInit(): Promise<void> {
    if (this.db) return;
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    await this.initPromise;
  }

  private async doInit(): Promise<void> {
    const SQL = await initSqlJs();
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    let db: Db;
    if (fs.existsSync(this.dbPath)) {
      const buf = fs.readFileSync(this.dbPath);
      db = new SQL.Database(buf);
    } else {
      db = new SQL.Database();
    }
    db.run(CREATE_TABLE_SQL);
    // 兼容旧库：若缺少列则添加
    const cols = db.exec('PRAGMA table_info(sessions)');
    const colNames = (cols[0]?.values ?? []).map(
      (r: unknown) => String((r as unknown[])?.[1])
    );
    for (const col of ['system_tokens', 'user_tokens', 'assistant_tokens']) {
      if (!colNames.includes(col)) {
        db.run(`ALTER TABLE sessions ADD COLUMN ${col} INTEGER`);
      }
    }
    this.db = db;
  }

  private sessionToRow(session: Session): Record<string, unknown> {
    const rawMeta: RawMeta = {};
    if (session.prompt) rawMeta.prompt = session.prompt;
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
      system_tokens: cu?.systemTokens ?? null,
      user_tokens: cu?.userTokens ?? null,
      assistant_tokens: cu?.assistantTokens ?? null,
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
            ...(row.system_tokens != null && {
              systemTokens: Number(row.system_tokens),
            }),
            ...(row.user_tokens != null && {
              userTokens: Number(row.user_tokens),
            }),
            ...(row.assistant_tokens != null && {
              assistantTokens: Number(row.assistant_tokens),
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
      ...(rawMeta?.prompt && { prompt: rawMeta.prompt }),
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
    await this.ensureInit();
    const row = this.sessionToRow(session);
    const r = this.db!;
    r.run(
      `INSERT OR REPLACE INTO sessions (
        id, source, started_at, ended_at, project_path, model,
        input_tokens, output_tokens, cache_read, cache_create,
        system_tokens, user_tokens, assistant_tokens,
        cost_amount, cost_currency, raw_meta
      ) VALUES (
        :id, :source, :started_at, :ended_at, :project_path, :model,
        :input_tokens, :output_tokens, :cache_read, :cache_create,
        :system_tokens, :user_tokens, :assistant_tokens,
        :cost_amount, :cost_currency, :raw_meta
      )`,
      {
        ':id': row.id,
        ':source': row.source,
        ':started_at': row.started_at,
        ':ended_at': row.ended_at,
        ':project_path': row.project_path,
        ':model': row.model,
        ':input_tokens': row.input_tokens,
        ':output_tokens': row.output_tokens,
        ':cache_read': row.cache_read,
        ':cache_create': row.cache_create,
        ':system_tokens': row.system_tokens,
        ':user_tokens': row.user_tokens,
        ':assistant_tokens': row.assistant_tokens,
        ':cost_amount': row.cost_amount,
        ':cost_currency': row.cost_currency,
        ':raw_meta': row.raw_meta,
      }
    );
  }

  async query(filter: SessionFilter): Promise<Session[]> {
    await this.ensureInit();
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.source != null) {
      conditions.push('source = :source');
      params[':source'] = filter.source;
    }
    if (filter.model != null) {
      conditions.push('model = :model');
      params[':model'] = filter.model;
    }
    if (filter.from != null) {
      conditions.push('started_at >= :from');
      params[':from'] = filter.from;
    }
    if (filter.to != null) {
      conditions.push('started_at <= :to');
      params[':to'] = filter.to;
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause =
      filter.limit != null && Number.isFinite(filter.limit)
        ? `LIMIT ${Math.max(1, Math.floor(filter.limit))}`
        : '';

    const sql = `SELECT * FROM sessions ${whereClause} ORDER BY started_at DESC ${limitClause}`.trim();
    const results = this.db!.exec(sql, params);
    if (results.length === 0) return [];
    const { columns, values } = results[0];
    const rows = rowsFromResult(columns, values);
    return rows.map((r) => this.rowToSession(r));
  }

  async getById(id: string): Promise<Session | null> {
    await this.ensureInit();
    const results = this.db!.exec('SELECT * FROM sessions WHERE id = :id', {
      ':id': id,
    });
    if (results.length === 0 || results[0].values.length === 0) return null;
    const { columns, values } = results[0];
    const row = rowFromColumnsValues(columns, values[0]!);
    return this.rowToSession(row);
  }

  close(): void {
    if (this.db) {
      try {
        const data = this.db.export();
        fs.writeFileSync(this.dbPath, Buffer.from(data));
      } finally {
        this.db.close();
      }
      this.db = null;
    }
  }
}
