import cors from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { discoverTargets } from './discovery.js';
import { ensureTarget, startMonitor } from './monitor.js';
import { runInTarget, targetFrom, TargetError } from './target.js';
import { api } from './routes.js';
import { startSampler } from './sampler.js';
import { startAuditReader } from './audit.js';
import { historyDbPath, pruneHistory } from './history-store.js';

/** Always-on activity history for the servers in HISTORY_SERVERS (sampler + audit reader + retention). */
function startHistory(): void {
  if (config.history.servers.length === 0) return;
  const unknown = config.history.servers.filter((s) => !config.servers.includes(s));
  if (unknown.length) console.warn(`[history] HISTORY_SERVERS entries not in DB_SERVERS: ${unknown.join(', ')}`);
  const prune = () => {
    try {
      const n = pruneHistory();
      if (n.sampled || n.audit) console.log(`[history] removed ${n.sampled} sampled and ${n.audit} audit rows older than ${config.history.retentionDays} days`);
    } catch (err) {
      console.error('[history] prune failed', err);
    }
  };
  prune();
  setInterval(prune, 60 * 60_000).unref();
  console.log(`[history] saving to ${historyDbPath()} (kept ${config.history.retentionDays} days)`);
  startSampler();
  startAuditReader();
}

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: config.corsOrigin.split(',').map((s) => s.trim()), methods: ['GET'] }));

// Read-only service: reject anything that is not a GET/HEAD/OPTIONS.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  res.status(405).json({ error: 'This service is read-only' });
});

// Every API call runs against the database chosen in the header (X-Target), starting its monitoring on first use.
app.use('/api', async (req, res, next) => {
  // Listing the databases must not start monitoring one.
  if (req.path === '/targets') return next();
  try {
    const target = targetFrom(req);
    await ensureTarget(target);
    runInTarget(target, () => next());
  } catch (err) {
    const status = err instanceof TargetError ? 400 : 502;
    res.status(status).json({ error: `Cannot open database: ${(err as Error).message}` });
  }
});

app.use('/api', api);

// Serve the built Angular app when present (npm run build in ../client).
const here = dirname(fileURLToPath(import.meta.url));
const clientDist = join(here, '..', '..', 'client', 'dist', 'client', 'browser');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(clientDist, 'index.html')));
}

Promise.all([startMonitor(), discoverTargets()])
  .then(() => {
    setInterval(() => void discoverTargets(), 30 * 60_000).unref();
    startHistory();
    app.listen(config.port, () => console.log(`[server] SQL Monitor API listening on http://localhost:${config.port}`));
  })
  .catch((err) => {
    console.error('[server] failed to start', err);
    process.exit(1);
  });
