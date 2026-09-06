import { record } from './events.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

function emit(level, msg, extra, notable = false) {
  if (LEVELS[level] < threshold) return;
  const at = new Date().toISOString();
  const line = `${at} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const stream = LEVELS[level] >= LEVELS.warn ? console.error : console.log;
  if (extra === undefined) stream(line);
  else stream(line, typeof extra === 'string' ? extra : JSON.stringify(extra));

  // Everything that reaches the console reaches the web UI too, so the two can
  // never disagree about what happened.
  record({ at, level, message: extra === undefined ? msg : `${msg} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`, notable });
}

export const log = {
  debug: (m, e) => emit('debug', m, e),
  info: (m, e) => emit('info', m, e),
  warn: (m, e) => emit('warn', m, e),
  error: (m, e) => emit('error', m, e),
  // An info line worth surfacing on the status page: something actually
  // happened, as opposed to the loop narrating its progress.
  event: (m, e) => emit('info', m, e, true),
};
