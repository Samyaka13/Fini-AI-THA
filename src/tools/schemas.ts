import { z } from "zod";

export const getCustomerSchema = z.object({ email: z.string().email() });
export const getTransactionSchema = z.object({ customer_id: z.string().min(1), txn_id: z.string().min(1) });
export const issueRefundSchema = z.object({ txn_id: z.string().min(1), amount: z.number().positive() });
export const escalateToHumanSchema = z.object({ customer_id: z.string().nullable(), summary: z.string().min(1).max(500) });
