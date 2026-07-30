export type NotificationChannel = "in_app" | "email" | "whatsapp_template";
export type NotificationAudience = "company_admin" | "customer_contact" | "platform_staff";

/** Master Prompt section 32. */
export type NotificationCategory =
  | "renewal_upcoming"
  | "payment_successful"
  | "payment_failed"
  | "grace_period_started"
  | "grace_period_ending"
  | "account_suspended"
  | "payment_received"
  | "account_restored"
  | "subscription_cancelled"
  | "usage_threshold_reached"
  | "whatsapp_disconnected"
  | "provider_credentials_expired"
  | "knowledge_ingestion_failed"
  | "message_processing_failed"
  | "human_handover_requested"
  | "high_value_lead_received";

const BILLING_CATEGORIES: ReadonlySet<NotificationCategory> = new Set([
  "renewal_upcoming",
  "payment_successful",
  "payment_failed",
  "grace_period_started",
  "grace_period_ending",
  "account_suspended",
  "payment_received",
  "account_restored",
  "subscription_cancelled",
  "usage_threshold_reached",
]);

export class InvalidNotificationAudienceError extends Error {
  constructor(category: NotificationCategory, audience: NotificationAudience) {
    super(`Notification category "${category}" must never be sent to audience "${audience}"`);
    this.name = "InvalidNotificationAudienceError";
  }
}

/**
 * Billing notifications must only reach authorized company administrators,
 * never customer-facing contacts (Master Prompt section 32). This is checked
 * structurally here so no call site can accidentally leak billing state to a
 * customer.
 */
export function assertValidNotificationAudience(
  category: NotificationCategory,
  audience: NotificationAudience,
): void {
  if (BILLING_CATEGORIES.has(category) && audience !== "company_admin") {
    throw new InvalidNotificationAudienceError(category, audience);
  }
}

export interface NotificationInput {
  companyId: string | null;
  audience: NotificationAudience;
  channel: NotificationChannel;
  category: NotificationCategory;
  recipientUserId?: string;
  recipientContactId?: string;
  subject?: string;
  body: string;
}

export interface NotificationSendResult {
  sent: boolean;
  error?: string;
}

export interface NotificationProvider {
  send(input: NotificationInput): Promise<NotificationSendResult>;
}

/** Validates audience/category compatibility, then delegates to the provider. */
export async function sendNotification(
  provider: NotificationProvider,
  input: NotificationInput,
): Promise<NotificationSendResult> {
  assertValidNotificationAudience(input.category, input.audience);
  return provider.send(input);
}
