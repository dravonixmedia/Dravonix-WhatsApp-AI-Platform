"use server";

import { revalidatePath } from "next/cache";
import { getDashboardCapabilities } from "../permissions.js";
import { getDashboardSession } from "../session.js";
import { createServerSupabaseClient } from "../supabase/server.js";
import type { LeadStage } from "../repositories/leadsRepository.js";

const VALID_STAGES: ReadonlySet<LeadStage> = new Set([
  "new",
  "qualifying",
  "qualified",
  "proposal_sent",
  "won",
  "lost",
]);

/**
 * Mutations here go straight through the authenticated, RLS-scoped client --
 * unlike the Human Handover lifecycle actions, the leads schema (migration
 * 5) already defines a direct `leads_update_member` UPDATE policy gated on
 * has_company_permission(company_id, 'leads.manage'), so no SECURITY
 * DEFINER RPC is needed for this simpler CRM-style update path. The
 * getDashboardCapabilities() check below is a UI-consistency guard only --
 * RLS is what actually enforces this regardless of what the client sends.
 */
async function requireManageLeads() {
  const session = await getDashboardSession();
  if (!session) throw new Error("Not authenticated");
  if (!getDashboardCapabilities(session.activeRole).canManageLeads) {
    throw new Error("Your role does not have permission to manage leads");
  }
  return session;
}

function revalidateLeadPaths(leadId: string): void {
  revalidatePath("/dashboard/leads");
  revalidatePath(`/dashboard/leads/${leadId}`);
}

export async function updateLeadStageAction(leadId: string, stage: string): Promise<void> {
  if (!VALID_STAGES.has(stage as LeadStage)) throw new Error("Invalid lead stage");
  const session = await requireManageLeads();

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("leads")
    .update({ stage })
    .eq("id", leadId)
    .eq("company_id", session.activeCompanyId);
  if (error) throw error;

  revalidateLeadPaths(leadId);
}

export async function assignLeadAction(
  leadId: string,
  targetMemberId: string | null,
): Promise<void> {
  const session = await requireManageLeads();

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("leads")
    .update({ assigned_member_id: targetMemberId })
    .eq("id", leadId)
    .eq("company_id", session.activeCompanyId);
  if (error) throw error;

  revalidateLeadPaths(leadId);
}

export async function updateLeadNotesAction(leadId: string, notes: string): Promise<void> {
  const session = await requireManageLeads();

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("leads")
    .update({ notes })
    .eq("id", leadId)
    .eq("company_id", session.activeCompanyId);
  if (error) throw error;

  revalidateLeadPaths(leadId);
}
