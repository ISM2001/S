export const DAY_MS = 86_400_000;
export const daysAgo = (d: number, now = new Date()) => new Date(now.getTime() - d * DAY_MS);
export const monthsAgo = (m: number, now = new Date()) => {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - m);
  return d;
};
export const period = (d = new Date()) => d.toISOString().slice(0, 7);
