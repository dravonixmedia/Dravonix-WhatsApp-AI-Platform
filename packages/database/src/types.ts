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

/**
 * Phase 2 role model expansion (migrations 23/24): the active six-role
 * client model is company_owner/company_admin/manager/team_leader/
 * sales_person/company_accounts. agent/knowledge_editor/billing_viewer/
 * viewer are legacy values kept dormant in the Postgres enum for
 * backward/history compatibility only -- agent and billing_viewer were
 * remapped to sales_person/company_accounts (zero hosted usage at
 * migration time, verified no-op), and knowledge_editor/viewer have no
 * approved semantic mapping and were retired from active UI/permissions
 * with zero hosted usage. None of the four legacy values are ever
 * assignable through the client Team page, the client invitation/
 * role-change RPCs, or the Super Admin role dropdowns going forward -- see
 * apps/web/lib/companyRoles.ts for the canonical active-role list/labels.
 */
export type CompanyRole =
  | "company_owner"
  | "company_admin"
  | "manager"
  | "team_leader"
  | "sales_person"
  | "company_accounts"
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

/** Mirrors the `usage_metric` enum (supabase/migrations/00000000000008_usage_notifications_audit.sql). Only the metrics this codebase actually records (see packages/database/src/usageEvents.ts) are exercised in production; the remaining enum members exist in the schema for future metering. */
export type UsageMetric =
  | "whatsapp_inbound_messages"
  | "whatsapp_outbound_messages"
  | "whatsapp_template_messages"
  | "active_contacts"
  | "claude_input_tokens"
  | "claude_cached_input_tokens"
  | "claude_output_tokens"
  | "claude_requests"
  | "speech_to_text_seconds"
  | "text_to_speech_characters"
  | "generated_voice_seconds"
  | "stored_audio_bytes"
  | "knowledge_storage_bytes"
  | "document_processing_jobs"
  | "staff_seats"
  | "whatsapp_numbers"
  | "failed_provider_calls";

/**
 * One raw usage_events row to insert. `idempotencyKey` must be a stable,
 * deterministic value derived from a durable identifier already available at
 * the call site (e.g. `${messageId}:${metric}`) -- never a random UUID --
 * so a queue retry that re-runs the same logical unit of work naturally
 * collides on the table's `unique(idempotency_key)` constraint instead of
 * double-counting.
 */
export interface UsageEventInsert {
  companyId: string;
  metric: UsageMetric;
  quantity: number;
  idempotencyKey: string;
  conversationId?: string | null;
  isBillable?: boolean;
  providerRequestId?: string | null;
}
