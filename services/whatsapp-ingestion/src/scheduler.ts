import { logger } from './logger';

const log = logger.child({ mod: 'scheduler' });

/** Milliseconds from now until the next local occurrence of "HH:MM" (24h). */
export function msUntilDailyTime(hhmm: string, now: Date = new Date()): number {
  const [h, m] = hhmm.split(':').map((x) => Number(x));
  const next = new Date(now);
  next.setHours(h ?? 0, m ?? 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** Valid "HH:MM" (00:00–23:59)? Guards against bad env values that would otherwise busy-loop setTimeout. */
function isValidTime(hhmm: string): boolean {
  const [h, m] = hhmm.split(':').map((x) => Number(x));
  return Number.isInteger(h) && Number.isInteger(m) && h! >= 0 && h! <= 23 && m! >= 0 && m! <= 59;
}

/**
 * Run `fn` once per day at local "HH:MM". Recomputes the delay after every run, so it never drifts and
 * stays correct across DST changes (unlike a fixed 24h setInterval). Returns a stop() to cancel.
 */
export function scheduleDaily(hhmm: string, fn: () => void | Promise<void>): () => void {
  if (!isValidTime(hhmm)) {
    log.error({ time: hhmm }, 'invalid daily time (want HH:MM) — not scheduling this one');
    return () => {};
  }
  let timer: NodeJS.Timeout;
  const arm = (): void => {
    const delay = msUntilDailyTime(hhmm);
    log.info({ at: hhmm, inMinutes: Math.round(delay / 60000) }, 'next daily run scheduled');
    timer = setTimeout(() => {
      void (async () => {
        try {
          await fn();
        } catch (err) {
          log.error({ err: (err as Error).message }, 'scheduled job threw');
        }
        arm(); // schedule the following day
      })();
    }, delay);
  };
  arm();
  return () => clearTimeout(timer);
}

/** Schedule `fn` at several "HH:MM" times each day. Returns a stop() that cancels them all. */
export function scheduleDailyTimes(times: string[], fn: () => void | Promise<void>): () => void {
  const stops = times.map((t) => scheduleDaily(t, fn));
  return () => stops.forEach((stop) => stop());
}
