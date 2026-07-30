export interface AuditLogEntry {
  companyId: string | null;
  actorUserId: string | null;
  actorType: "user" | "platform_staff" | "system";
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogWriter {
  write(entry: AuditLogEntry): Promise<void>;
}

/**
 * Every sensitive action -- settings changes, knowledge changes, billing
 * actions, manual suspensions, handovers, support access, invitations, role
 * changes, WhatsApp connection changes, and all super-admin actions -- must go
 * through this single function (Master Prompt sections 9, 17, 18), never a
 * direct table insert from application code, so the audit trail can't be
 * accidentally bypassed by a new call site.
 */
export async function recordAuditLog(writer: AuditLogWriter, entry: AuditLogEntry): Promise<void> {
  await writer.write(entry);
}
