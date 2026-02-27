const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function formatShortDate(date: Date): string {
  return `${WEEKDAY_NAMES[date.getUTCDay()]} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

export function formatRelativeTime(date: Date | string): string {
  const inputDate = typeof date === 'string' ? new Date(date) : date;
  const timestamp = inputDate.getTime();
  if (Number.isNaN(timestamp)) {
    throw new Error('Invalid date passed to formatRelativeTime');
  }

  const elapsed = Math.max(0, Date.now() - timestamp);

  if (elapsed < MINUTE_MS) {
    return 'just now';
  }

  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  }

  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  }

  if (elapsed < 2 * DAY_MS) {
    return 'yesterday';
  }

  if (elapsed < 7 * DAY_MS) {
    return `${Math.floor(elapsed / DAY_MS)}d ago`;
  }

  return formatShortDate(inputDate);
}
