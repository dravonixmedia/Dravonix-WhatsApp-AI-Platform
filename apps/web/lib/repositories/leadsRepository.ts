import type { SupabaseClient } from "@supabase/supabase-js";
import { maskPhoneNumber } from "@dravonix/handover";

export type LeadStage = "new" | "qualifying" | "qualified" | "proposal_sent" | "won" | "lost";

export type LeadListStageFilter = "all" | LeadStage;
export type LeadListAssignmentFilter = "all" | "mine" | "unassigned";

export interface LeadListFilters {
  companyId: string;
  callerMemberId: string;
  search?: string;
  stage?: LeadListStageFilter;
  assignment?: LeadListAssignmentFilter;
  page: number;
  pageSize: number;
}

export interface LeadListItem {
  id: string;
  customerName: string | null;
  companyName: string | null;
  maskedPhoneNumber: string | null;
  serviceInterest: string | null;
  stage: LeadStage;
  score: number | null;
  assignedMemberId: string | null;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadListPage {
  items: LeadListItem[];
  totalCount: number;
}

export interface LeadDetail extends LeadListItem {
  companyId: string;
  productInterest: string | null;
  budget: string | null;
  preferredTimeline: string | null;
  email: string | null;
  location: string | null;
  branch: string | null;
  notes: string | null;
  source: string;
}

export interface LeadEventItem {
  id: string;
  eventType: string;
  eventData: Record<string, unknown>;
  actorMemberId: string | null;
  createdAt: string;
}

interface LeadRow {
  id: string;
  company_id: string;
  customer_name: string | null;
  company_name: string | null;
  phone_number: string | null;
  service_interest: string | null;
  product_interest: string | null;
  budget: string | null;
  preferred_timeline: string | null;
  email: string | null;
  location: string | null;
  branch: string | null;
  notes: string | null;
  source: string;
  score: number | null;
  stage: LeadStage;
  assigned_member_id: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

function toListItem(row: LeadRow): LeadListItem {
  return {
    id: row.id,
    customerName: row.customer_name,
    companyName: row.company_name,
    maskedPhoneNumber: row.phone_number ? maskPhoneNumber(row.phone_number) : null,
    serviceInterest: row.service_interest,
    stage: row.stage,
    score: row.score,
    assignedMemberId: row.assigned_member_id,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Tenant-scoped, paginated, searchable leads list for /dashboard/leads. RLS
 * (leads_select_member, migration 5) additionally enforces company_id
 * scoping regardless of this filter -- has_company_permission(company_id,
 * 'leads.view').
 */
export async function listLeads(
  client: SupabaseClient,
  filters: LeadListFilters,
): Promise<LeadListPage> {
  let query = client
    .from("leads")
    .select(
      `id, company_id, customer_name, company_name, phone_number, service_interest,
       product_interest, budget, preferred_timeline, email, location, branch, notes,
       source, score, stage, assigned_member_id, conversation_id, created_at, updated_at`,
      { count: "exact" },
    )
    .eq("company_id", filters.companyId);

  if (filters.search && filters.search.trim().length > 0) {
    const term = filters.search.trim();
    query = query.or(
      `customer_name.ilike.%${term}%,company_name.ilike.%${term}%,phone_number.ilike.%${term}%,email.ilike.%${term}%`,
    );
  }
  if (filters.stage && filters.stage !== "all") {
    query = query.eq("stage", filters.stage);
  }
  if (filters.assignment === "mine") {
    query = query.eq("assigned_member_id", filters.callerMemberId);
  } else if (filters.assignment === "unassigned") {
    query = query.is("assigned_member_id", null);
  }

  const from = (filters.page - 1) * filters.pageSize;
  const to = from + filters.pageSize - 1;
  query = query.order("updated_at", { ascending: false }).range(from, to);

  const { data, count, error } = await query;
  if (error) throw error;

  const items = ((data ?? []) as unknown as LeadRow[]).map(toListItem);
  return { items, totalCount: count ?? items.length };
}

/**
 * Single tenant-scoped lead for /dashboard/leads/[leadId]. Returns null for
 * a missing, cross-tenant, or RLS-hidden lead -- the caller renders the same
 * not-found response for every one of those cases, never revealing which
 * happened.
 */
export async function getLead(
  client: SupabaseClient,
  companyId: string,
  leadId: string,
): Promise<LeadDetail | null> {
  const { data, error } = await client
    .from("leads")
    .select(
      `id, company_id, customer_name, company_name, phone_number, service_interest,
       product_interest, budget, preferred_timeline, email, location, branch, notes,
       source, score, stage, assigned_member_id, conversation_id, created_at, updated_at`,
    )
    .eq("company_id", companyId)
    .eq("id", leadId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as unknown as LeadRow;
  return {
    ...toListItem(row),
    companyId: row.company_id,
    productInterest: row.product_interest,
    budget: row.budget,
    preferredTimeline: row.preferred_timeline,
    email: row.email,
    location: row.location,
    branch: row.branch,
    notes: row.notes,
    source: row.source,
  };
}

/** Read-only audit timeline for a lead (lead_events_select_member RLS, migration 5). */
export async function listLeadEvents(
  client: SupabaseClient,
  companyId: string,
  leadId: string,
): Promise<LeadEventItem[]> {
  const { data, error } = await client
    .from("lead_events")
    .select("id, event_type, event_data, actor_member_id, created_at")
    .eq("company_id", companyId)
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false });
  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id as string,
    eventType: row.event_type as string,
    eventData: (row.event_data as Record<string, unknown>) ?? {},
    actorMemberId: row.actor_member_id as string | null,
    createdAt: row.created_at as string,
  }));
}
