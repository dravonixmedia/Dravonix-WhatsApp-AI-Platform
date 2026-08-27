import type { SupabaseClient } from "@supabase/supabase-js";
import { logServerError } from "../serverLogging.js";

export interface BillingPlanInfo {
  name: string;
  monthlyPrice: number;
  currency: string;
}

export interface BillingSubscriptionInfo {
  state: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  /** Phase 6C: set only while state = 'grace_period' (advance_overdue_subscriptions, migration 30); null otherwise. */
  gracePeriodEnd: string | null;
  plan: BillingPlanInfo | null;
}

export interface BillingInvoiceItem {
  id: string;
  invoiceNumber: string;
  status: string;
  total: number;
  currency: string;
  dueDate: string | null;
  paidDate: string | null;
  createdAt: string;
}

export interface BillingPaymentItem {
  id: string;
  method: string;
  status: string;
  amount: number;
  currency: string;
  submittedByUserId: string | null;
  approvedByUserId: string | null;
  createdAt: string;
}

interface SubscriptionRow {
  state: string;
  current_period_start: string | null;
  current_period_end: string | null;
  grace_period_end: string | null;
  plan_versions:
    | {
        monthly_price: number;
        currency: string;
        plans: { name: string } | { name: string }[] | null;
      }
    | {
        monthly_price: number;
        currency: string;
        plans: { name: string } | { name: string }[] | null;
      }[]
    | null;
}

function firstOf<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

/**
 * Read-only finance data for a single company -- /dashboard/billing (Phase
 * 6). Deliberately separate from SupabaseEntitlementRepository (which
 * answers "may this company use capability X right now" for the paid-
 * provider guard), not a replacement for it: this repository answers "what
 * should the Finance page display", which needs the plan's display name and
 * price, invoices, and payments -- none of which the entitlement guard
 * needs. Every query is scoped to the one company_id the caller already
 * has an active membership in; RLS (billing.view) is the actual boundary,
 * this is just the shape the page renders.
 */
export async function getBillingSubscription(
  client: SupabaseClient,
  companyId: string,
): Promise<BillingSubscriptionInfo | null> {
  const { data, error } = await client
    .from("subscriptions")
    .select(
      "state, current_period_start, current_period_end, grace_period_end, plan_versions (monthly_price, currency, plans (name))",
    )
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) {
    logServerError(
      "Failed to load billing subscription",
      error,
      { companyId },
      {
        operation: "getBillingSubscription",
      },
    );
    throw error;
  }
  if (!data) return null;

  const row = data as unknown as SubscriptionRow;
  const planVersion = firstOf(row.plan_versions);
  const plan = planVersion ? firstOf(planVersion.plans) : null;

  return {
    state: row.state,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    gracePeriodEnd: row.grace_period_end,
    plan:
      planVersion && plan
        ? {
            name: plan.name,
            monthlyPrice: Number(planVersion.monthly_price),
            currency: planVersion.currency,
          }
        : null,
  };
}

export async function listBillingInvoices(
  client: SupabaseClient,
  companyId: string,
  limit = 20,
): Promise<BillingInvoiceItem[]> {
  const { data, error } = await client
    .from("invoices")
    .select("id, invoice_number, status, total, currency, due_date, paid_date, created_at")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    logServerError(
      "Failed to list billing invoices",
      error,
      { companyId },
      {
        operation: "listBillingInvoices",
      },
    );
    throw error;
  }
  return (data ?? []).map((row) => ({
    id: row.id as string,
    invoiceNumber: row.invoice_number as string,
    status: row.status as string,
    total: Number(row.total),
    currency: row.currency as string,
    dueDate: row.due_date as string | null,
    paidDate: row.paid_date as string | null,
    createdAt: row.created_at as string,
  }));
}

export async function listBillingPayments(
  client: SupabaseClient,
  companyId: string,
  limit = 20,
): Promise<BillingPaymentItem[]> {
  const { data, error } = await client
    .from("payments")
    .select(
      "id, method, status, amount, currency, submitted_by_user_id, approved_by_user_id, created_at",
    )
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    logServerError(
      "Failed to list billing payments",
      error,
      { companyId },
      {
        operation: "listBillingPayments",
      },
    );
    throw error;
  }
  return (data ?? []).map((row) => ({
    id: row.id as string,
    method: row.method as string,
    status: row.status as string,
    amount: Number(row.amount),
    currency: row.currency as string,
    submittedByUserId: row.submitted_by_user_id as string | null,
    approvedByUserId: row.approved_by_user_id as string | null,
    createdAt: row.created_at as string,
  }));
}
