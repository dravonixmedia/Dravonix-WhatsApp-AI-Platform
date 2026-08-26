import type { SupabaseClient } from "@supabase/supabase-js";

export interface GeneratedInvoice {
  companyId: string;
  invoiceId: string;
  invoiceNumber: string;
}

export interface AdvancedSubscription {
  companyId: string;
  subscriptionId: string;
  newState: string;
}

export interface SuspendedSubscription {
  companyId: string;
  subscriptionId: string;
}

export interface SentReminder {
  companyId: string;
  invoiceId: string;
  stage: string;
}

/** Everything the daily billing scheduler needs -- one method per migration-30 RPC. All transactional/idempotency/tenant-scoping logic lives in those RPCs, not here. */
export interface BillingSchedulerRepository {
  generateDueInvoices(): Promise<GeneratedInvoice[]>;
  advanceOverdueSubscriptions(): Promise<AdvancedSubscription[]>;
  suspendExpiredGraceSubscriptions(): Promise<SuspendedSubscription[]>;
  sendDueReminders(): Promise<SentReminder[]>;
}

/**
 * Production implementation, calling the four service_role-only migration-30
 * RPCs. Uses the service-role client (bypasses RLS), same convention as
 * SupabaseRazorpayPaymentRepository (apps/api) and
 * SupabaseHandoverWorkerRepository (outbound-reconciler) -- this runs
 * entirely server-side on a Cron Trigger, with no end-user JWT.
 */
export class SupabaseBillingSchedulerRepository implements BillingSchedulerRepository {
  constructor(private readonly client: SupabaseClient) {}

  async generateDueInvoices(): Promise<GeneratedInvoice[]> {
    const { data, error } = await this.client.rpc("generate_due_subscription_invoices");
    if (error) throw error;
    return (
      (data ?? []) as Array<{ company_id: string; invoice_id: string; invoice_number: string }>
    ).map((row) => ({
      companyId: row.company_id,
      invoiceId: row.invoice_id,
      invoiceNumber: row.invoice_number,
    }));
  }

  async advanceOverdueSubscriptions(): Promise<AdvancedSubscription[]> {
    const { data, error } = await this.client.rpc("advance_overdue_subscriptions");
    if (error) throw error;
    return (
      (data ?? []) as Array<{ company_id: string; subscription_id: string; new_state: string }>
    ).map((row) => ({
      companyId: row.company_id,
      subscriptionId: row.subscription_id,
      newState: row.new_state,
    }));
  }

  async suspendExpiredGraceSubscriptions(): Promise<SuspendedSubscription[]> {
    const { data, error } = await this.client.rpc("suspend_expired_grace_subscriptions");
    if (error) throw error;
    return ((data ?? []) as Array<{ company_id: string; subscription_id: string }>).map((row) => ({
      companyId: row.company_id,
      subscriptionId: row.subscription_id,
    }));
  }

  async sendDueReminders(): Promise<SentReminder[]> {
    const { data, error } = await this.client.rpc("send_due_billing_reminders");
    if (error) throw error;
    return ((data ?? []) as Array<{ company_id: string; invoice_id: string; stage: string }>).map(
      (row) => ({
        companyId: row.company_id,
        invoiceId: row.invoice_id,
        stage: row.stage,
      }),
    );
  }
}
