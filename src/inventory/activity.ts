export function parseActivityDate(value: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(NaN);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Activity date must be a valid YYYY-MM-DD date');
  return date.toISOString();
}
export function activityCutoff(now = new Date()): string {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, 1));
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(now.getUTCDate(), lastDay));
  return cutoff.toISOString();
}
export function projectIsActive(lastCommitAt: string | null, empty: boolean, cutoff: string): boolean | null {
  return empty ? false : lastCommitAt === null ? null : lastCommitAt >= cutoff;
}
