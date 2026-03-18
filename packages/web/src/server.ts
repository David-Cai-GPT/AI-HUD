import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteStore } from '@ai-hud/core';
import type { Session, SessionFilter } from '@ai-hud/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3847;

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

  app.get('/', (_, reply) => {
    return reply.sendFile('index.html');
  });

  return app;
}

async function main() {
  const store = new SqliteStore();
  const app = await createServer(store);
  const port = parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT;

  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`AI-HUD Web server listening on http://localhost:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
