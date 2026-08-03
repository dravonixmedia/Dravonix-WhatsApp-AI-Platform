import { z } from "zod";

/**
 * Structured AI response schema (Master Prompt section 11). Every Claude call
 * must return exactly this shape; nothing else is ever sent to the customer.
 */
export const leadUpdatesSchema = z
  .object({
    name: z.string().nullable(),
    companyName: z.string().nullable(),
    service: z.string().nullable(),
    product: z.string().nullable(),
    budget: z.string().nullable(),
    timeline: z.string().nullable(),
    email: z.string().nullable(),
    phoneNumber: z.string().nullable(),
    location: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .partial();

export const replyModeSchema = z.enum(["text_only", "voice_only", "text_and_voice", "auto"]);

export const aiStructuredResponseSchema = z
  .object({
    answer: z.string().min(1),
    language: z.string().min(2),
    intent: z.string().min(1),
    confidence: z.number().min(0).max(1),
    replyMode: replyModeSchema,
    leadUpdates: leadUpdatesSchema.nullable(),
    requiresHuman: z.boolean(),
    handoverReason: z.string().nullable(),
    knowledgeSourceIds: z.array(z.string()),
    internalNotes: z.string().nullable(),
  })
  // A "malformed handover decision" -- escalating (requiresHuman: true) with no
  // recorded reason -- is rejected as invalid, not silently accepted: the
  // dashboard would show an empty handover reason, and a repair attempt gets a
  // real chance to supply one instead. This constraint applies identically
  // regardless of response language.
  .refine((value) => !value.requiresHuman || Boolean(value.handoverReason?.trim()), {
    message: "handoverReason must be a non-empty string when requiresHuman is true",
    path: ["handoverReason"],
  });

export type AiStructuredResponse = z.infer<typeof aiStructuredResponseSchema>;
export type LeadUpdates = z.infer<typeof leadUpdatesSchema>;
