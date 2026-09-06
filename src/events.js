// An in-memory ring of recent log lines, so the web UI can show what the sync
// has been doing without anyone opening `docker compose logs`.
//
// Deliberately not persisted: this is a "what just happened" panel, and the
// durable record of where the sync stands already lives in state.json.

const MAX_EVENTS = 300;

const events = [];

export function record(event) {
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

// Newest first, since that is the end anyone reads.
//
// Every pass logs its progress, so an unfiltered feed is mostly per-tick chatter
// with the occasional real event buried in it. "Notable" is the default view:
// anything that went wrong, plus the lines that report something actually
// happening -- a write, a Discord post, a watermark move.
export function recentEvents({ limit = 50, notableOnly = true } = {}) {
  const wanted = notableOnly ? events.filter((e) => e.notable || e.level === 'warn' || e.level === 'error') : events;
  return wanted.slice(-limit).reverse();
}

export function eventCounts() {
  return {
    total: events.length,
    notable: events.filter((e) => e.notable || e.level === 'warn' || e.level === 'error').length,
  };
}

// Tests only -- the buffer is process-wide state.
export function clearEvents() {
  events.length = 0;
}
