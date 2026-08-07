"use server";

import { revalidatePath } from "next/cache";
import { getDashboardSession } from "../session.js";
import { createServerSupabaseClient } from "../supabase/server.js";

/**
 * Updates the active company's business timezone (Global Timezone + Daypart
 * Awareness). The company id is always the caller's own session-resolved
 * activeCompanyId -- a browser-supplied company id is never accepted or
 * trusted. All authorization/validation happens server-side inside the
 * update_company_timezone RPC (settings.manage permission, real IANA
 * identifier check via pg_timezone_names) -- this action is a thin,
 * unprivileged wrapper around it.
 */
export async function updateCompanyTimezoneAction(timezone: string): Promise<void> {
  const session = await getDashboardSession();
  if (!session) throw new Error("Not authenticated");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("update_company_timezone", {
    p_company_id: session.activeCompanyId,
    p_timezone: timezone,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/dashboard/settings");
}

/**
 * Updates one WhatsApp customer's known timezone, or clears it back to
 * "unknown" when `timezone` is null. The contact's company is derived
 * server-side inside the update_contact_timezone RPC from the contact row
 * itself (never accepted as a parameter here or in the RPC) -- a caller can
 * never point this at another company's contact by id alone, since the RPC
 * re-verifies the caller is an active member of that contact's real
 * company with conversations.reply before writing anything.
 */
export async function updateContactTimezoneAction(
  contactId: string,
  timezone: string | null,
): Promise<void> {
  const session = await getDashboardSession();
  if (!session) throw new Error("Not authenticated");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("update_contact_timezone", {
    p_contact_id: contactId,
    p_timezone: timezone,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/dashboard/conversations");
  revalidatePath("/dashboard/handover");
}
