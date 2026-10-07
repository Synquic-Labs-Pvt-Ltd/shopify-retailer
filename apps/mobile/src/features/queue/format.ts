export function plural(count: number, singular: string, pluralForm: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago".
export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const ageMs = nowMs - new Date(iso).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 45_000) return 'just now';
  if (ageMs < HOUR_MS) return `${Math.max(1, Math.round(ageMs / MINUTE_MS))} min ago`;
  if (ageMs < DAY_MS) return `${Math.round(ageMs / HOUR_MS)} h ago`;
  const days = Math.floor(ageMs / DAY_MS);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

// The local wall-clock time of an ISO timestamp, for example "3:45 PM".
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// 8 seconds -> "0:08".
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
