import type { SupabaseClient } from "@supabase/supabase-js";

export type SupportRequestType =
  "complaint" | "service_request" | "technical_issue" | "feature_request" | "general_support";

export type SupportRequestStatus =
  "open" | "in_progress" | "waiting_on_client" | "resolved" | "closed";

export type SupportRequestPriority = "low" | "normal" | "high" | "urgent";

export const SUPPORT_REQUEST_TYPE_LABELS: Record<SupportRequestType, string> = {
  complaint: "Complaint",
  service_request: "Service Request",
  technical_issue: "Technical Issue",
  feature_request: "Feature / Change Request",
  general_support: "General Support",
};

export const SUPPORT_REQUEST_STATUS_LABELS: Record<SupportRequestStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  waiting_on_client: "Waiting on Client",
  resolved: "Resolved",
  closed: "Closed",
};

export const SUPPORT_REQUEST_PRIORITY_LABELS: Record<SupportRequestPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

/** The only two priorities a client may choose at creation time (final plan section 7) -- urgent/low are Dravonix-only. */
export const CLIENT_SELECTABLE_PRIORITIES: readonly SupportRequestPriority[] = ["normal", "high"];

export interface SupportRequestMessageItem {
  id: string;
  authorType: "client" | "platform" | "system";
  message: string;
  isInternal: boolean;
  createdAt: string;
}

export interface SupportRequestListItem {
  id: string;
  reference: string;
  type: SupportRequestType;
  subject: string;
  status: SupportRequestStatus;
  createdAt: string;
  updatedAt: string;
  lastRepliedAt: string | null;
}

/**
 * Client-facing detail -- deliberately never includes priority (final plan
 * section 12: "Do not expose internal priority if we decide it should
 * remain Dravonix-only" -- the client sets it once at creation via
 * create_support_request but it is never surfaced back), assignment, or
 * internal notes (RLS already excludes is_internal=true rows from `messages`
 * for a non-platform-staff caller, so this shape is safe to render as-is).
 */
export interface SupportRequestDetail extends SupportRequestListItem {
  companyId: string;
  createdByUserId: string | null;
  description: string;
  messages: SupportRequestMessageItem[];
}

interface SupportRequestRow {
  id: string;
  company_id: string | null;
  created_by_user_id: string | null;
  reference: string;
  type: SupportRequestType;
  subject: string;
  description: string;
  status: SupportRequestStatus;
  created_at: string;
  updated_at: string;
  last_replied_at: string | null;
}

interface SupportRequestMessageRow {
  id: string;
  author_type: "client" | "platform" | "system";
  message: string;
  is_internal: boolean;
  created_at: string;
}

const LIST_COLUMNS =
  "id, reference, type, subject, status, created_at, updated_at, last_replied_at";
const DETAIL_COLUMNS = `${LIST_COLUMNS}, company_id, created_by_user_id, description`;
const MESSAGE_COLUMNS = "id, author_type, message, is_internal, created_at";

function toListItem(row: SupportRequestRow): SupportRequestListItem {
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    subject: row.subject,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRepliedAt: row.last_replied_at,
  };
}

function toMessageItem(row: SupportRequestMessageRow): SupportRequestMessageItem {
  return {
    id: row.id,
    authorType: row.author_type,
    message: row.message,
    isInternal: row.is_internal,
    createdAt: row.created_at,
  };
}

/**
 * Client-facing list, scoped to the caller's active company (RLS's
 * support_requests_select policy additionally enforces this regardless of
 * the .eq below -- has_company_permission(company_id, 'support_requests.view')).
 */
export async function listSupportRequests(
  client: SupabaseClient,
  companyId: string,
): Promise<SupportRequestListItem[]> {
  const { data, error } = await client
    .from("support_requests")
    .select(LIST_COLUMNS)
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as unknown as SupportRequestRow[]).map(toListItem);
}

/**
 * Single tenant-scoped request + its client-visible conversation. Returns
 * null for a missing, cross-tenant, or RLS-hidden request -- the caller
 * renders the same not-found response for every one of those cases. Internal
 * notes are never included here: RLS's support_request_messages_select
 * policy already excludes is_internal=true rows for a non-platform-staff
 * caller, so a plain unfiltered select is safe.
 */
export async function getSupportRequest(
  client: SupabaseClient,
  companyId: string,
  requestId: string,
): Promise<SupportRequestDetail | null> {
  const { data, error } = await client
    .from("support_requests")
    .select(DETAIL_COLUMNS)
    .eq("company_id", companyId)
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as unknown as SupportRequestRow;
  const { data: messageRows, error: messageError } = await client
    .from("support_request_messages")
    .select(MESSAGE_COLUMNS)
    .eq("request_id", requestId)
    .order("created_at", { ascending: true });
  if (messageError) throw messageError;

  return {
    ...toListItem(row),
    companyId: row.company_id ?? companyId,
    createdByUserId: row.created_by_user_id,
    description: row.description,
    messages: ((messageRows ?? []) as unknown as SupportRequestMessageRow[]).map(toMessageItem),
  };
}

// ---------------------------------------------------------------------------
// Super Admin (platform-staff) queries -- see RLS's is_platform_staff()
// branch, which grants unscoped SELECT across every company.
// ---------------------------------------------------------------------------

export interface AdminSupportRequestFilters {
  status?: SupportRequestStatus | "all";
  type?: SupportRequestType | "all";
  priority?: SupportRequestPriority | "all";
  companyId?: string;
  page: number;
  pageSize: number;
}

export interface AdminSupportRequestListItem extends SupportRequestListItem {
  companyId: string | null;
  companyName: string | null;
  priority: SupportRequestPriority;
  createdByUserId: string | null;
  assignedPlatformUserId: string | null;
}

export interface AdminSupportRequestListPage {
  items: AdminSupportRequestListItem[];
  totalCount: number;
}

export interface AdminSupportRequestDetail extends AdminSupportRequestListItem {
  description: string;
  resolvedAt: string | null;
  messages: SupportRequestMessageItem[];
}

interface AdminSupportRequestRow extends SupportRequestRow {
  priority: SupportRequestPriority;
  resolved_at: string | null;
  assigned_platform_user_id: string | null;
  companies: { name: string } | { name: string }[] | null;
}

const ADMIN_LIST_COLUMNS = `${LIST_COLUMNS}, company_id, priority, created_by_user_id, assigned_platform_user_id, companies (name)`;
const ADMIN_DETAIL_COLUMNS = `${ADMIN_LIST_COLUMNS}, description, resolved_at`;

function resolveCompanyName(companies: AdminSupportRequestRow["companies"]): string | null {
  if (!companies) return null;
  const row = Array.isArray(companies) ? companies[0] : companies;
  return row?.name ?? null;
}

function toAdminListItem(row: AdminSupportRequestRow): AdminSupportRequestListItem {
  return {
    ...toListItem(row),
    companyId: row.company_id,
    companyName: resolveCompanyName(row.companies),
    priority: row.priority,
    createdByUserId: row.created_by_user_id,
    assignedPlatformUserId: row.assigned_platform_user_id,
  };
}

/** Super Admin list for /admin/support-requests -- filterable by status/type/priority/company. */
export async function listAdminSupportRequests(
  client: SupabaseClient,
  filters: AdminSupportRequestFilters,
): Promise<AdminSupportRequestListPage> {
  let query = client.from("support_requests").select(ADMIN_LIST_COLUMNS, { count: "exact" });

  if (filters.status && filters.status !== "all") query = query.eq("status", filters.status);
  if (filters.type && filters.type !== "all") query = query.eq("type", filters.type);
  if (filters.priority && filters.priority !== "all")
    query = query.eq("priority", filters.priority);
  if (filters.companyId) query = query.eq("company_id", filters.companyId);

  const from = (filters.page - 1) * filters.pageSize;
  const to = from + filters.pageSize - 1;
  query = query.order("created_at", { ascending: false }).range(from, to);

  const { data, count, error } = await query;
  if (error) throw error;

  const items = ((data ?? []) as unknown as AdminSupportRequestRow[]).map(toAdminListItem);
  return { items, totalCount: count ?? items.length };
}

/** Super Admin detail -- includes internal notes (RLS's is_platform_staff() branch returns every message row). */
export async function getAdminSupportRequest(
  client: SupabaseClient,
  requestId: string,
): Promise<AdminSupportRequestDetail | null> {
  const { data, error } = await client
    .from("support_requests")
    .select(ADMIN_DETAIL_COLUMNS)
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as unknown as AdminSupportRequestRow & { resolved_at: string | null };
  const { data: messageRows, error: messageError } = await client
    .from("support_request_messages")
    .select(MESSAGE_COLUMNS)
    .eq("request_id", requestId)
    .order("created_at", { ascending: true });
  if (messageError) throw messageError;

  return {
    ...toAdminListItem(row),
    description: row.description,
    resolvedAt: row.resolved_at,
    messages: ((messageRows ?? []) as unknown as SupportRequestMessageRow[]).map(toMessageItem),
  };
}

export interface PlatformStaffOption {
  userId: string;
  role: string;
}

/** For the Super Admin "assign to" dropdown -- no display-name column exists on platform_members (confirmed by audit), so the UI masks the id, matching support_access_sessions' own precedent. */
export async function listActivePlatformStaff(
  client: SupabaseClient,
): Promise<PlatformStaffOption[]> {
  const { data, error } = await client
    .from("platform_members")
    .select("user_id, role")
    .eq("is_active", true);
  if (error) throw error;
  return (data ?? []).map((row) => ({ userId: row.user_id as string, role: row.role as string }));
}
