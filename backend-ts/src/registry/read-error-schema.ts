import { z } from "zod";

/** Explicit local review of the connector's error meaning, not permission to
 * retry, proof that a record does not exist, or authority to enter a handler. */
export const readErrorContractSchema = z.object({
  profile: z.literal("erpbridge-read-error/v1"),
  remote_type: z.literal("not_found"),
  business_error: z.literal("ERP_RESOURCE_NOT_FOUND"),
}).strict();
