import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteStore, loadConfig, saveConfig, maskApiKey } from '@ai-hud/core';
import type { Session, SessionFilter } from '@ai-hud/core';
import { fetchCursorModels } from './cursor-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface OverviewStats {
  totalSessions: number;
  totalTokens: number;
  totalCost: number;
  byModel: Record<string, number>;
  bySource: Record<string, number>;
}

function aggregateOverview(sessions: Session[]): OverviewStats {
  let totalTokens = 0;
  let totalCost = 0;
  const byModel: Record<string, number> = {};
  const bySource: Record<string, number> = {};

  for (const s of sessions) {
    const input = s.contextUsage?.inputTokens ?? 0;
    const output = s.contextUsage?.outputTokens ?? 0;
    totalTokens += input + output;
    totalCost += s.cost?.amount ?? 0;

    const modelKey = s.model ?? '(unknown)';
    byModel[modelKey] = (byModel[modelKey] ?? 0) + 1;
    bySource[s.source] = (bySource[s.source] ?? 0) + 1;
  }

  return {
    totalSessions: sessions.length,
    totalTokens,
    totalCost,
    byModel,
    bySource,
  };
}

export async function createServer(store: SqliteStore) {
  const app = Fastify({ logger: true });

  const publicDir = path.join(__dirname, '..', 'public');
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await store.getById(id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    return reply.send(session);
  });

  app.get('/api/sessions', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const filter: SessionFilter = {};
    if (q.source) filter.source = q.source;
    if (q.model) filter.model = q.model;
    if (q.from) filter.from = q.from;
    if (q.to) filter.to = q.to;
    if (q.limit) filter.limit = Math.max(1, parseInt(q.limit, 10) || 50);

    const all = await store.query({ ...filter, limit: undefined });
    const total = all.length;
    const limit = filter.limit ?? 50;
    const sessions = all.slice(0, limit);

    return reply.send({ sessions, total });
  });

  app.get('/api/stats/overview', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const filter: SessionFilter = {};
    if (q.from) filter.from = q.from;
    if (q.to) filter.to = q.to;

    const sessions = await store.query(filter);
    const stats = aggregateOverview(sessions);
    return reply.send(stats);
  });

  // Cursor API Key 设置
  app.get('/api/settings/cursor', (_, reply) => {
    const cfg = loadConfig();
    const hasKey = !!cfg.cursorApiKey?.trim();
    return reply.send({
      hasKey,
      maskedKey: hasKey ? maskApiKey(cfg.cursorApiKey) : undefined,
    });
  });

  app.post<{ Body: { apiKey?: string } }>('/api/settings/cursor', async (req, reply) => {
    const key = req.body?.apiKey?.trim();
    const cfg = loadConfig();
    if (key) {
      cfg.cursorApiKey = key;
    } else {
      delete cfg.cursorApiKey;
    }
    saveConfig(cfg);
    return reply.send({ ok: true, hasKey: !!cfg.cursorApiKey });
  });

  // Cursor 用量（本地缓存）
  app.get('/api/cursor-usage', async (_, reply) => {
    const row = await store.getCursorUsage('models');
    if (!row) return reply.send({ data: null, fetchedAt: null });
    try {
      const data = JSON.parse(row.dataJson);
      return reply.send({ data, fetchedAt: row.fetchedAt });
    } catch {
      return reply.send({ data: null, fetchedAt: row.fetchedAt });
    }
  });

  app.post<{ Body: { startDate?: string; endDate?: string } }>(
    '/api/cursor-usage/refresh',
    async (req, reply) => {
      const cfg = loadConfig();
      const apiKey = cfg.cursorApiKey?.trim();
      if (!apiKey) {
        return reply.status(400).send({ error: '未配置 Cursor API Key' });
      }
      const startDate = req.body?.startDate ?? '7d';
      const endDate = req.body?.endDate ?? 'today';

      const result = await fetchCursorModels(apiKey, startDate, endDate);
      if ('error' in result) {
        return reply.status(400).send(result);
      }
      await store.saveCursorUsage('models', JSON.stringify(result));
      store.flush();
      return reply.send({ ok: true, data: result });
    }
  );

  app.get('/', (_, reply) => {
    return reply.sendFile('index.html');
  });

  return app;
}

export const DEFAULT_PORT = 3849;

export async function startServer(
  port: number = DEFAULT_PORT,
  store?: SqliteStore
): Promise<{ app: Awaited<ReturnType<typeof createServer>>; store: SqliteStore }> {
  const s = store ?? new SqliteStore();
  const app = await createServer(s);
  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`AI-HUD Web server listening on http://localhost:${port}`);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'EADDRINUSE') {
      console.error(`\n端口 ${port} 已被占用。请使用 --port 指定其他端口，例如：`);
      console.error(`  ai-hud serve --port 3848\n`);
    } else {
      app.log.error(err);
    }
    process.exit(1);
  }
  return { app, store: s };
}

async function main() {
  const port = parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT;
  await startServer(port);
}

if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  main();
}
