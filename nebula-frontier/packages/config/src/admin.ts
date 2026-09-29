/**
 * Admin tool limits (data/admin.json), validated at load so a bad edit fails fast instead of
 * silently removing a cap. Admin mail attachment caps bound what a single support mail can grant.
 */
import { z } from "zod";
import adminJson from "../data/admin.json" with { type: "json" };

const cap = z.number().int().positive();

export const adminLimitsSchema = z.object({
  mail: z.object({
    /** Max CREDITS attached to one admin mail. */
    maxCredits: cap,
    /** Max GEMS attached to one admin mail. */
    maxGems: cap,
    /** Max quantity per resource type attached to one admin mail. */
    maxResourceQuantity: cap,
    /** Max quantity per attached item stack. */
    maxItemQuantity: cap,
    /** Max number of attached item stacks. */
    maxItemStacks: cap,
  }),
});
export type AdminLimits = z.infer<typeof adminLimitsSchema>;

export const ADMIN_LIMITS: AdminLimits = adminLimitsSchema.parse(adminJson);
