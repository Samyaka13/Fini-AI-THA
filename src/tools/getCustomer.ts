import type { MockStore } from "../data/mockStore.js";
import type { GetCustomerResult } from "../domain/customer.js";

/** Required mock API. The returned card digits are only consumed by the trusted verifier. */
export function getCustomer(store: MockStore, email: string): GetCustomerResult {
  const customer = store.findCustomerByEmail(email);
  if (!customer) return { found: false, reason: "not_found" };
  return { found: true, id: customer.id, name: customer.name, card_last4: customer.cardLast4, status: customer.status, verified: false };
}
