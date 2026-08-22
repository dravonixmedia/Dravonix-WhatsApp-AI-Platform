"use server";

/**
 * Writes directly to knowledge_sources/knowledge_chunks via the RLS-scoped
 * client -- both already carry "knowledge.manage" write policies (migration
 * 6), so no new RPC is needed. A migration-18 trigger audits every
 * knowledge_sources insert/update/delete. Content is stored as a single
 * knowledge_chunks row per source -- the simplest path that reuses the
 * existing retrieval mechanism (packages/knowledge's full-text/embedding
 * search over knowledge_chunks) without inventing a parallel content store.
 * No file upload: no existing Storage-backed upload UI exists yet in this
 * codebase, so this only supports the manual-text-content path the schema
 * already supports end-to-end.
 */

import { revalidatePath } from "next/cache";
import { getDashboardSession } from "../session.js";
import { createServerSupabaseClient } from "../supabase/server.js";

export async function addKnowledgeSourceAction(formData: FormData): Promise<void> {
  const session = await getDashboardSession();
  if (!session) throw new Error("Not authenticated");

  const title = String(formData.get("title") ?? "").trim();
  const sourceType = String(formData.get("source_type") ?? "faq");
  const content = String(formData.get("content") ?? "").trim();
  if (!title) throw new Error("Title is required");

  const supabase = await createServerSupabaseClient();
  const { data: source, error: sourceError } = await supabase
    .from("knowledge_sources")
    .insert({ company_id: session.activeCompanyId, source_type: sourceType, title })
    .select("id")
    .single();
  if (sourceError) throw new Error(sourceError.message);

  if (content) {
    const { error: chunkError } = await supabase.from("knowledge_chunks").insert({
      company_id: session.activeCompanyId,
      knowledge_source_id: source.id,
      content,
      chunk_index: 0,
    });
    if (chunkError) throw new Error(chunkError.message);
  }

  revalidatePath("/dashboard/knowledge");
  revalidatePath("/dashboard/onboarding");
}

export async function toggleKnowledgeSourceAction(formData: FormData): Promise<void> {
  const session = await getDashboardSession();
  if (!session) throw new Error("Not authenticated");

  const sourceId = String(formData.get("source_id") ?? "");
  const nextEnabled = formData.get("next_enabled") === "true";
  if (!sourceId) throw new Error("Source is required");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("knowledge_sources")
    .update({ is_enabled: nextEnabled })
    .eq("id", sourceId)
    .eq("company_id", session.activeCompanyId);
  if (error) throw new Error(error.message);

  revalidatePath("/dashboard/knowledge");
}

export async function removeKnowledgeSourceAction(formData: FormData): Promise<void> {
  const session = await getDashboardSession();
  if (!session) throw new Error("Not authenticated");

  const sourceId = String(formData.get("source_id") ?? "");
  if (!sourceId) throw new Error("Source is required");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("knowledge_sources")
    .delete()
    .eq("id", sourceId)
    .eq("company_id", session.activeCompanyId);
  if (error) throw new Error(error.message);

  revalidatePath("/dashboard/knowledge");
  revalidatePath("/dashboard/onboarding");
}
