"use server";

import { revalidatePath } from "next/cache";
import { getDashboardSession } from "../session.js";
import { createServerSupabaseClient } from "../supabase/server.js";

/**
 * Updates the active company's business currency. Entirely independent of
 * updateCompanyTimezoneAction (lib/actions/timezone.ts) -- this action
 * never reads or writes the company's timezone, and the timezone action
 * never reads or writes currency. The company id is always the caller's
 * own session-resolved activeCompanyId -- a browser-supplied company id is
 * never accepted or trusted. All authorization/validation happens
 * server-side inside the update_company_currency RPC (settings.manage
 * permission, fixed ISO 4217 support-list check) -- this action is a thin,
 * unprivileged wrapper around it.
 */
export async function updateCompanyCurrencyAction(currency: string): Promise<void> {
  const session = await getDashboardSession();
  if (!session) throw new Error("Not authenticated");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("update_company_currency", {
    p_company_id: session.activeCompanyId,
    p_currency: currency,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/dashboard/settings");
}
