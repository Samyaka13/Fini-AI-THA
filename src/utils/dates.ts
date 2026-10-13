export const FIXED_NOW = new Date("2026-10-12T12:00:00.000Z");

export function ageInWholeDays(date: string, now: Date): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(now.getTime())) return null;
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (!Number.isFinite(start.getTime()) || start.getUTCFullYear() !== Number(date.slice(0, 4)) || start.getUTCMonth() + 1 !== Number(date.slice(5, 7)) || start.getUTCDate() !== Number(date.slice(8, 10))) return null;
  const age = Math.floor((end.getTime() - start.getTime()) / 86_400_000);
  return age < 0 ? null : age;
}
