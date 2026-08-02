/**
 * Masks a WhatsApp wa_id/phone number for display in the Human Handover Inbox
 * (final plan section 16): all digits except the last 4 become "*". Non-digit
 * characters (e.g. a leading "+") are stripped first so the mask can't be
 * defeated by formatting differences between stored numbers.
 */
export function maskPhoneNumber(waId: string): string {
  const digits = waId.replace(/\D/g, "");
  if (digits.length <= 4) return "*".repeat(digits.length);
  return "*".repeat(digits.length - 4) + digits.slice(-4);
}
