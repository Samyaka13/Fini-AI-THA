export interface SupportSession {
  verified: boolean;
  customerId: string | null;
  suppliedEmail: string | null;
  suppliedCardLast4: string | null;
}

export const newSession = (): SupportSession => ({
  verified: false,
  customerId: null,
  suppliedEmail: null,
  suppliedCardLast4: null,
});
