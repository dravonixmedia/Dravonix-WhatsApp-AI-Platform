/**
 * Hand-maintained row types mirroring supabase/migrations/*.sql.
 *
 * Once a real Supabase project exists, these can be replaced/augmented with
 * `supabase gen types typescript` output (see SUPABASE_SETUP.md) -- keep this file
 * as the fallback source of truth until that generation is wired into CI.
 */

export type CompanyStatus = "onboarding" | "active" | "suspended" | "manually_suspended" | "closed";

export interface CompanyRow {
  id: string;
  name: string;
  slug: string;
  status: CompanyStatus;
  is_demo: boolean;
  timezone: string;
  default_currency: string;
  created_at: string;
  updated_at: string;
}

export type PlatformRole = "super_admin" | "platform_support" | "platform_billing_admin";

export interface PlatformMemberRow {
  user_id: string;
  role: PlatformRole;
  is_active: boolean;
  created_at: string;
}

export type CompanyRole =
  | "company_owner"
  | "company_admin"
  | "manager"
  | "agent"
  | "knowledge_editor"
  | "billing_viewer"
  | "viewer";

export interface CompanyMemberRow {
  id: string;
  company_id: string;
  user_id: string;
  role: CompanyRole;
  is_active: boolean;
  invited_at: string;
  disabled_at: string | null;
  created_at: string;
}

export interface WhatsappPhoneNumberRow {
  id: string;
  company_id: string;
  whatsapp_account_id: string;
  phone_number_id: string;
  display_phone_number: string | null;
  status: string;
  webhook_health_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ConversationState =
  "ai_active" | "handover_requested" | "queued_for_agent" | "human_active" | "paused" | "closed";

/** Human Handover Inbox: AI automation mode, independent of ConversationState (see packages/core). */
export type ConversationAiMode = "active" | "paused";

export interface ConversationRow {
  id: string;
  company_id: string;
  contact_id: string;
  whatsapp_phone_number_id: string | null;
  state: ConversationState;
  last_message_at: string | null;
  last_ai_summary: string | null;
  unresolved_questions: string[];
  handover_reason: string | null;
  assigned_member_id: string | null;
  state_changed_at: string;
  ai_mode: ConversationAiMode;
  handover_last_read_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Human Handover Inbox: outbound-message reserve/claim/send/finalize lifecycle status. */
export type OutboundDeliveryStatus =
  "reserved" | "sending" | "sent" | "send_failed" | "delivery_unknown";

export interface MessageRow {
  id: string;
  company_id: string;
  conversation_id: string;
  direction: "inbound" | "outbound";
  channel_type: "text" | "audio" | "template" | "system";
  sender_type: "customer" | "ai" | "human_agent" | "system";
  sender_member_id: string | null;
  provider_message_id: string | null;
  body: string | null;
  detected_language: string | null;
  language_confidence: number | null;
  reply_mode: string | null;
  ai_structured_response: Record<string, unknown> | null;
  idempotency_key: string | null;
  outbound_status: OutboundDeliveryStatus | null;
  source_message_id: string | null;
  send_claimed_at: string | null;
  send_lease_expires_at: string | null;
  send_attempt_count: number;
  last_send_error_code: string | null;
  retryable: boolean | null;
  legacy_outbound: boolean;
  created_at: string;
}

export type SubscriptionState =
  | "onboarding"
  | "trial"
  | "active"
  | "payment_due"
  | "grace_period"
  | "suspended"
  | "cancel_at_period_end"
  | "cancelled"
  | "manually_suspended"
  | "closed";

export interface SubscriptionRow {
  id: string;
  company_id: string;
  plan_version_id: string;
  state: SubscriptionState;
  provider: string;
  provider_subscription_id: string | null;
  provider_status: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  grace_period_end: string | null;
  suspension_reason: string | null;
  cancellation_reason: string | null;
  reactivated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContactRow {
  id: string;
  company_id: string;
  whatsapp_wa_id: string;
  profile_name: string | null;
  display_name: string | null;
  is_blocked: boolean;
  last_detected_language: string | null;
  created_at: string;
  updated_at: string;
}
