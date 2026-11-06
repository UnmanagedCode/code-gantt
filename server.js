import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './src/config.js';
import { createState } from './src/state.js';
import { createLive } from './src/live.js';
import { createApp } from './src/http/app.js';

let config;
try {
  config = resolveConfig(process.env);
} catch (err) {
  console.error(`[code-gantt] ${err.message}`);
  process.exit(1);
}

const state = createState(config);
const live = createLive({ state, config });
await live.start();
await state.refreshStores();

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const server = http.createServer(createApp({ state, live, publicDir }));
const port = Number(process.env.PORT) || 7300;
server.listen(port, '127.0.0.1', () => {
  console.log(`[code-gantt] listening on http://127.0.0.1:${port}`);
  state.runBackfill().catch((err) => console.error('[code-gantt] backfill failed:', err));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    live.stop();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
