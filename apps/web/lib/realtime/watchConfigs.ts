import type { RealtimeWatch } from "./tenantChannel.js";

/**
 * Named, importable (and therefore independently testable) watch lists for
 * every Realtime subscription in the dashboard. Kept out of page JSX
 * specifically so a test can assert on the exact configured events/filters
 * without rendering anything. Every list here is INSERT/UPDATE only --
 * DELETE and "*" are not representable at all (see tenantChannel.ts).
 *
 * Each entry is scoped to only the event(s) that can actually occur for
 * that table/context, not "both, to be safe" -- e.g. a conversation-detail
 * page filters conversations by that exact conversationId, which by
 * definition already exists by the time this page can render, so an
 * INSERT for that id can never fire and isn't registered.
 */

/** /dashboard/conversations (Live Conversations list). */
export const CONVERSATIONS_LIST_WATCHES: RealtimeWatch[] = [
  { table: "conversations", filterColumn: "company_id", event: "INSERT" },
  { table: "conversations", filterColumn: "company_id", event: "UPDATE" },
  // Only INSERT: the list's preview comes from body/channel_type/direction,
  // set once at insert and never changed by any UPDATE (outbound_status and
  // similar columns aren't rendered in this list).
  { table: "messages", filterColumn: "company_id", event: "INSERT" },
  { table: "conversation_assignments", filterColumn: "company_id", event: "INSERT" },
  { table: "conversation_assignments", filterColumn: "company_id", event: "UPDATE" },
];

/** /dashboard/handover (Human Handover Inbox list). */
export const HANDOVER_INBOX_WATCHES: RealtimeWatch[] = [
  { table: "conversations", filterColumn: "company_id", event: "INSERT" },
  { table: "conversations", filterColumn: "company_id", event: "UPDATE" },
  { table: "conversation_assignments", filterColumn: "company_id", event: "INSERT" },
  { table: "conversation_assignments", filterColumn: "company_id", event: "UPDATE" },
  // INSERT only: handover_events is append-only in this app (trigger_handover's
  // insert ... on conflict do nothing) -- no UPDATE code path exists for it.
  { table: "handover_events", filterColumn: "company_id", event: "INSERT" },
];

/**
 * Conversation-detail header/actions (shared by /dashboard/conversations/[id]
 * and /dashboard/handover/[id]) -- everything except the message thread
 * itself, which uses MESSAGE_THREAD_WATCHES below instead.
 */
export const CONVERSATION_DETAIL_WATCHES: RealtimeWatch[] = [
  // UPDATE only: filtered to one specific, already-existing conversation id
  // -- an INSERT for that same id can never occur.
  { table: "conversations", filterColumn: "id", event: "UPDATE" },
  { table: "conversation_assignments", filterColumn: "conversation_id", event: "INSERT" },
  { table: "conversation_assignments", filterColumn: "conversation_id", event: "UPDATE" },
  { table: "handover_events", filterColumn: "conversation_id", event: "INSERT" },
];

/** ConversationThread.tsx -- the live message list itself. */
export const MESSAGE_THREAD_WATCHES: RealtimeWatch[] = [
  { table: "messages", filterColumn: "conversation_id", event: "INSERT" },
  { table: "messages", filterColumn: "conversation_id", event: "UPDATE" },
];

/**
 * Dashboard shell (notification bell badge + Human Handover nav badge) --
 * mounted once in app/dashboard/layout.tsx, since router.refresh() re-runs
 * the whole current route segment tree (layout AND page), this keeps the
 * bell/nav badge live on every /dashboard/* route -- including ones with no
 * list-specific boundary of their own (Overview, Settings, Billing) --
 * without duplicating any of those pages' own narrower watch lists.
 * Deliberately the same shape as HANDOVER_INBOX_WATCHES plus a
 * messages INSERT watch (the bell's unread-customer-message count depends
 * on new inbound messages, which HANDOVER_INBOX_WATCHES alone doesn't
 * cover).
 */
export const DASHBOARD_SHELL_WATCHES: RealtimeWatch[] = [
  { table: "conversations", filterColumn: "company_id", event: "INSERT" },
  { table: "conversations", filterColumn: "company_id", event: "UPDATE" },
  { table: "messages", filterColumn: "company_id", event: "INSERT" },
  { table: "conversation_assignments", filterColumn: "company_id", event: "INSERT" },
  { table: "conversation_assignments", filterColumn: "company_id", event: "UPDATE" },
  { table: "handover_events", filterColumn: "company_id", event: "INSERT" },
];

/** /dashboard/leads (Leads list). */
export const LEADS_LIST_WATCHES: RealtimeWatch[] = [
  { table: "leads", filterColumn: "company_id", event: "INSERT" },
  { table: "leads", filterColumn: "company_id", event: "UPDATE" },
];

/** /dashboard/leads/[leadId] -- one specific, already-existing lead. */
export const LEAD_DETAIL_WATCHES: RealtimeWatch[] = [
  { table: "leads", filterColumn: "id", event: "UPDATE" },
];

/** Every watch list above, for tests that need to audit all of them at once. */
export const ALL_WATCH_LISTS: Record<string, RealtimeWatch[]> = {
  CONVERSATIONS_LIST_WATCHES,
  HANDOVER_INBOX_WATCHES,
  CONVERSATION_DETAIL_WATCHES,
  MESSAGE_THREAD_WATCHES,
  LEADS_LIST_WATCHES,
  LEAD_DETAIL_WATCHES,
  DASHBOARD_SHELL_WATCHES,
};
