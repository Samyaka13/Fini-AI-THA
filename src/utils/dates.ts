export const FIXED_NOW = new Date("2026-10-12T12:00:00.000Z");

export function ageInWholeDays(date: string, now: Date): number {
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000);
}
