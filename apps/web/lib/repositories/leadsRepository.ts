import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getLeadPhoneDisplays,
  searchCompanyLeadIds,
  type PhoneDisplayResult,
} from "./phoneDisplay.js";

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
  /** Always non-empty: the best real identity available (see resolveLeadDisplayName), never "Unknown lead" when any real data exists. */
  displayName: string;
  companyName: string | null;
  maskedPhoneNumber: string | null;
  phoneVisibility: "full" | "masked";
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
  contacts: {
    display_name: string | null;
    profile_name: string | null;
  } | null;
}

/**
 * Resolves the best real identity available for a lead, in the priority
 * order the dashboard requires: (1) a real contact/customer name -- either
 * the AI-extracted `leads.customer_name` or the WhatsApp profile's
 * display_name/profile_name (leads.contact_id is a not-null FK to contacts,
 * but the AI-extracted fields on `leads` itself are genuinely optional --
 * see packages/ai/src/schema.ts's leadUpdatesSchema, entirely `.partial()`
 * -- so a brand-new lead legitimately has no customer_name yet even though
 * its underlying contact is always known); (2) the company name, when no
 * personal name exists; (3) the phone display already resolved for this
 * lead (Phase 3A.1: full or masked, per get_lead_phone_displays -- never a
 * raw value computed here); (4) a neutral, non-fabricated fallback. Never
 * returns "Unknown lead" when any of these real fields exist.
 */
function resolveLeadDisplayName(row: LeadRow, phoneDisplay: string | null): string {
  const contactName = row.contacts?.display_name ?? row.contacts?.profile_name ?? null;
  return (
    row.customer_name ?? contactName ?? row.company_name ?? phoneDisplay ?? "Unnamed WhatsApp lead"
  );
}

/**
 * `phone` is undefined only when get_lead_phone_displays returned no row for
 * this lead id at all (the caller isn't authorized to see it, or it's
 * genuinely missing) -- treated as "no phone value known" (null), exactly
 * like the pre-Phase-3A.1 contract where a null rawPhone produced a null
 * maskedPhoneNumber. This is deliberately NOT the same "Unknown" placeholder
 * conversationsRepository/globalSearchRepository use for their
 * non-nullable maskedPhoneNumber field -- LeadListItem.maskedPhoneNumber has
 * always been nullable, and silently substituting the literal string
 * "Unknown" here would corrupt resolveLeadDisplayName's fallback chain (it
 * would render as if "Unknown" were a real identity fallback, ahead of the
 * neutral "Unnamed WhatsApp lead" label).
 */
function toListItem(row: LeadRow, phone: PhoneDisplayResult | undefined): LeadListItem {
  return {
    id: row.id,
    customerName: row.customer_name,
    displayName: resolveLeadDisplayName(row, phone?.maskedPhoneNumber ?? null),
    companyName: row.company_name,
    maskedPhoneNumber: phone?.maskedPhoneNumber ?? null,
    phoneVisibility: phone?.phoneVisibility ?? "masked",
    serviceInterest: row.service_interest,
    stage: row.stage,
    score: row.score,
    assignedMemberId: row.assigned_member_id,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const LEAD_SELECT_COLUMNS = `id, company_id, customer_name, company_name, service_interest,
       product_interest, budget, preferred_timeline, email, location, branch, notes,
       source, score, stage, assigned_member_id, conversation_id, created_at, updated_at,
       contacts (display_name, profile_name)`;

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
  // Phase 3A.1: search_company_leads (migration 25) replaces the raw
  // `phone_number ilike ...` filter -- see phoneDisplay.ts and the
  // migration's own comments for the privacy-aware matching rules.
  let leadIdFilter: string[] | null = null;
  if (filters.search && filters.search.trim().length > 0) {
    leadIdFilter = await searchCompanyLeadIds(client, filters.companyId, filters.search.trim());
    if (leadIdFilter.length === 0) {
      return { items: [], totalCount: 0 };
    }
  }

  let query = client
    .from("leads")
    .select(LEAD_SELECT_COLUMNS, { count: "exact" })
    .eq("company_id", filters.companyId);

  if (leadIdFilter) {
    query = query.in("id", leadIdFilter);
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

  const rows = (data ?? []) as unknown as LeadRow[];
  const phoneDisplays = await getLeadPhoneDisplays(
    client,
    rows.map((row) => row.id),
  );
  const items = rows.map((row) => toListItem(row, phoneDisplays.get(row.id)));
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
    .select(LEAD_SELECT_COLUMNS)
    .eq("company_id", companyId)
    .eq("id", leadId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as unknown as LeadRow;
  const phoneDisplays = await getLeadPhoneDisplays(client, [row.id]);
  return {
    ...toListItem(row, phoneDisplays.get(row.id)),
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
