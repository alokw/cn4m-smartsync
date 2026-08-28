import { config, configProblems } from './config.js';
import { log } from './log.js';
import { startServer } from './server.js';
import { runSync } from './sync.js';

const server = startServer();

for (const problem of configProblems()) log.warn(`config: ${problem}`);

let timer = null;
let stopping = false;

// setTimeout rather than setInterval: the next tick is scheduled only after the
// previous sync settles, so a slow run can never stack up behind itself.
async function tick() {
  if (stopping) return;
  await runSync();
  if (!stopping) timer = setTimeout(tick, config.syncIntervalSeconds * 1000);
}

log.info(`starting sync loop, every ${config.syncIntervalSeconds}s`);
tick();

function shutdown(signal) {
  log.info(`${signal} received, shutting down`);
  stopping = true;
  clearTimeout(timer);
  server.close(() => process.exit(0));
  // Do not hang forever on a keep-alive connection.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
