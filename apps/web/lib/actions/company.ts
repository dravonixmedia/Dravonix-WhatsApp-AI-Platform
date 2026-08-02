"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { ACTIVE_COMPANY_COOKIE } from "../session.js";
import { createServerSupabaseClient } from "../supabase/server.js";

/**
 * Switches the dashboard's active company (Human Handover Inbox final plan
 * section 15). Re-verifies the target is a *currently* active membership
 * before setting the cookie -- a client can never force an arbitrary
 * company_id into effect, since this live check is the only thing that
 * decides whether the cookie is written at all.
 */
export async function switchCompanyAction(companyId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data: membership, error } = await supabase
    .from("company_members")
    .select("id")
    .eq("user_id", user.id)
    .eq("company_id", companyId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  if (!membership) throw new Error("Not an active member of that company");

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_COMPANY_COOKIE, companyId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  revalidatePath("/dashboard", "layout");
}
