/** Base class for all typed application errors, carrying a stable machine-readable code. */
export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Thrown when a state machine is asked to apply an event not valid for its current state. */
export class InvalidStateTransitionError extends AppError {
  constructor(
    public readonly fromState: string,
    public readonly event: string,
  ) {
    super("invalid_state_transition", `Cannot apply event "${event}" from state "${fromState}"`);
  }
}

export type EntitlementDenialReason =
  | "company_suspended"
  | "company_manually_suspended"
  | "subscription_not_active"
  | "plan_missing_feature"
  | "usage_limit_reached"
  | "provider_not_configured"
  | "whatsapp_not_connected";

/** Thrown by the billing entitlement guard whenever a chargeable operation is disallowed. */
export class EntitlementDeniedError extends AppError {
  constructor(
    public readonly companyId: string,
    public readonly capability: string,
    public readonly reason: EntitlementDenialReason,
  ) {
    super("entitlement_denied", `Company ${companyId} may not use "${capability}": ${reason}`);
  }
}

/** Thrown when a manual payment approval is attempted by a user not authorized to approve it. */
export class ManualPaymentApprovalDeniedError extends AppError {
  constructor(message: string) {
    super("manual_payment_approval_denied", message);
  }
}

/** Thrown when a cross-tenant access attempt is detected. Always a bug or an attack, never expected. */
export class TenantIsolationViolationError extends AppError {
  constructor(
    public readonly requestedCompanyId: string,
    public readonly resourceCompanyId: string,
  ) {
    super(
      "tenant_isolation_violation",
      `Company ${requestedCompanyId} attempted to access a resource owned by ${resourceCompanyId}`,
    );
  }
}

/** Thrown when an AI structured response fails schema validation after the repair attempt. */
export class AiResponseValidationError extends AppError {
  constructor(message: string) {
    super("ai_response_invalid", message);
  }
}

/** Thrown when a request has no valid, unexpired session. */
export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super("unauthorized", message);
  }
}

/** Thrown when an authenticated user lacks the company role-permission required for an action. */
export class PermissionDeniedError extends AppError {
  constructor(
    public readonly companyId: string,
    public readonly permission: string,
  ) {
    super("permission_denied", `Missing permission "${permission}" for company ${companyId}`);
  }
}

/** Thrown when an "assign to me" (or similar atomic claim) loses the race to another caller. */
export class ConversationAlreadyClaimedError extends AppError {
  constructor(public readonly conversationId: string) {
    super(
      "conversation_already_claimed",
      `Conversation ${conversationId} was already claimed by another team member`,
    );
  }
}

/**
 * Thrown when a caller tries to act on a conversation assigned to a
 * different team member without holding the explicit override permission
 * (conversations.reassign).
 */
export class ConversationNotAssignedToCallerError extends AppError {
  constructor(public readonly conversationId: string) {
    super(
      "conversation_not_assigned_to_caller",
      `Conversation ${conversationId} is assigned to a different team member`,
    );
  }
}
