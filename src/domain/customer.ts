export type CustomerStatus = "active" | "frozen";

/** Trusted record: never send this type to the language model or customer. */
export interface CustomerRecord {
  id: string;
  name: string;
  email: string;
  cardLast4: string;
  status: CustomerStatus;
}

export interface CustomerLookupResult {
  found: true;
  id: string;
  name: string;
  card_last4: string;
  status: CustomerStatus;
  verified: false;
}

export interface CustomerNotFoundResult { found: false; reason: "not_found"; }
export type GetCustomerResult = CustomerLookupResult | CustomerNotFoundResult;
