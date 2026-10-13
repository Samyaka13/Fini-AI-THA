let sequence = 0;
export function createId(prefix: "rfd" | "tkt"): string {
  sequence += 1;
  return `${prefix}_${String(sequence).padStart(4, "0")}`;
}
