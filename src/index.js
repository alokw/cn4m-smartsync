import { config, configProblems } from './config.js';
import { log } from './log.js';
import { startServer } from './server.js';
import { runSync } from './sync.js';
import { flushStatus } from './status.js';

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

log.event(`starting sync loop, every ${config.syncIntervalSeconds}s`);
tick();

async function shutdown(signal) {
  log.info(`${signal} received, shutting down`);
  stopping = true;
  clearTimeout(timer);
  // Do not hang forever on a keep-alive connection. Longer than flushStatus is
  // allowed to take, and still inside Docker's 10s grace before SIGKILL.
  setTimeout(() => process.exit(0), 9000).unref();
  // Let the last pass's status update reach cn4m before the process goes away.
  await flushStatus();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
