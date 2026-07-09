import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { DuckStore } from './store/DuckStore.js';
import { registerIngest } from './ingest.js';
import { registerQuery } from './query.js';
import { registerAgent } from './agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const store = new DuckStore(config);
  await store.init();

  const app = Fastify({ logger: { level: process.env.MO_LOG_LEVEL || 'info' }, bodyLimit: 64 * 1024 * 1024 });
  await app.register(cors, { origin: true });

  registerIngest(app, store);
  registerQuery(app, store);
  registerAgent(app, store);

  // Serve the built React UI, if present.
  const uiDir = resolve(process.env.MO_UI_DIR || resolve(__dirname, '../../ui/dist'));
  if (existsSync(uiDir)) {
    await app.register(fastifyStatic, { root: uiDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && (req.raw.url.startsWith('/api') || req.raw.url.startsWith('/v1'))) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => store.shutdown());
  return { app, store };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { app } = await buildServer();
  app.listen({ port: config.port, host: '0.0.0.0' }).then((addr) => {
    app.log.info(`minimal-observation listening on ${addr} (cold=${config.cold.kind}, retention=${config.retentionDays}d)`);
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => app.close().then(() => process.exit(0)));
  }
}
