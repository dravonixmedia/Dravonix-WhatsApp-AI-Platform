"use server";

import { revalidatePath } from "next/cache";
import { getDashboardSession } from "../session.js";
import { createServerSupabaseClient } from "../supabase/server.js";

/**
 * Updates the caller's own active company's name/industry/country only --
 * update_company_profile has no parameter for is_demo, status, timezone, or
 * default_currency, so this action structurally cannot touch any of those
 * even if it wanted to. The company id is always the session's own
 * activeCompanyId, never a client-supplied value.
 */
export async function updateCompanyProfileAction(formData: FormData): Promise<void> {
  const session = await getDashboardSession();
  if (!session) throw new Error("Not authenticated");

  const name = String(formData.get("name") ?? "").trim();
  const industry = String(formData.get("industry") ?? "").trim() || null;
  const country = String(formData.get("country") ?? "").trim() || null;
  if (!name) throw new Error("Company name is required");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("update_company_profile", {
    p_company_id: session.activeCompanyId,
    p_name: name,
    p_industry: industry,
    p_country: country,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/onboarding");
}
