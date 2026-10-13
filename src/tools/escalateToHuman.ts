import type { MockStore } from "../data/mockStore.js";
export function escalateToHuman(store: MockStore, customerId: string | null, summary: string, now: Date): { ticket_id: string } {
  return { ticket_id: store.createTicket(customerId, summary, now).id };
}
