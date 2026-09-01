import { handoverItemNeedsAttention } from "../src/priority.js";
import type { HandoverRepository } from "../src/repository.js";
import type {
  ConversationAiMode,
  ConversationForThread,
  ConversationState,
  ConversationThreadMessage,
  ConversationThreadPage,
  HandoverConversationSummary,
  HandoverInboxItem,
  HandoverInboxListInput,
  HumanTemplateOutboundReservation,
  OutboundDeliveryStatus,
  OutboundFinalizeResult,
  OutboundReservation,
} from "../src/types.js";

const DEFAULT_FAKE_THREAD_PAGE_SIZE = 50;

export interface FakeConversationSeed {
  id: string;
  companyId: string;
  state: ConversationState;
  aiMode?: ConversationAiMode;
  assignedMemberId?: string | null;
  handoverReason?: string | null;
  stateChangedAt?: string;
}

export interface FakeMemberSeed {
  id: string;
  companyId: string;
  isActive?: boolean;
  permissions?: string[];
}

interface FakeConversation {
  id: string;
  companyId: string;
  state: ConversationState;
  aiMode: ConversationAiMode;
  assignedMemberId: string | null;
  handoverReason: string | null;
  stateChangedAt: string;
}

interface FakeMember {
  id: string;
  companyId: string;
  isActive: boolean;
  permissions: Set<string>;
}

interface FakeMessage {
  id: string;
  companyId: string;
  conversationId: string;
  senderMemberId: string | null;
  idempotencyKey: string | null;
  outboundStatus: OutboundDeliveryStatus;
  providerMessageId: string | null;
}

/** Seed for a read-only conversation-thread row (see getConversationThread). */
export type FakeThreadMessageSeed = ConversationThreadMessage & { conversationId: string };

let fakeIdCounter = 0;
function nextId(prefix: string): string {
  fakeIdCounter += 1;
  return `${prefix}-${fakeIdCounter}`;
}

/**
 * In-memory double replicating the authorization/state-transition/concurrency
 * semantics of migration 12's SECURITY DEFINER functions closely enough to
 * unit-test packages/handover's service/outboundMessage layer without a real
 * Postgres instance (mirrors the FakeMembershipRepository idiom in
 * packages/tenant/test/context.test.ts). The real guarantees this stands in
 * for -- row locking, RLS, empty search_path -- are instead verified against
 * a real local Postgres by supabase/tests/rls_handover.sql.
 *
 * `asMember(memberId)` simulates switching the "logged in" caller, mirroring
 * the SQL test harness's test_set_current_user().
 */
export class FakeHandoverRepository implements HandoverRepository {
  private readonly conversations = new Map<string, FakeConversation>();
  private readonly members = new Map<string, FakeMember>();
  private readonly messages = new Map<string, FakeMessage>();
  private readonly threadMessages: FakeThreadMessageSeed[];
  private callerMemberId: string | null = null;

  /**
   * Meta/WhatsApp Batch 2: defaults to "now" (a wide-open service window)
   * and no fallback template configured, so every pre-existing test in this
   * package that never calls setLastCustomerMessageAt/setFallbackTemplate
   * keeps behaving exactly as before this batch. Configurable per test via
   * the setters below for the window-gating/template-fallback scenarios.
   */
  private lastCustomerMessageAt: string | null = new Date().toISOString();
  private fallbackTemplate: { id: string; name: string; language: string } | null = null;

  setLastCustomerMessageAt(value: string | null): void {
    this.lastCustomerMessageAt = value;
  }

  setFallbackTemplate(value: { id: string; name: string; language: string } | null): void {
    this.fallbackTemplate = value;
  }

  constructor(
    conversations: FakeConversationSeed[] = [],
    members: FakeMemberSeed[] = [],
    threadMessages: FakeThreadMessageSeed[] = [],
  ) {
    this.threadMessages = threadMessages;
    for (const seed of conversations) {
      this.conversations.set(seed.id, {
        id: seed.id,
        companyId: seed.companyId,
        state: seed.state,
        aiMode: seed.aiMode ?? "active",
        assignedMemberId: seed.assignedMemberId ?? null,
        handoverReason: seed.handoverReason ?? null,
        stateChangedAt: seed.stateChangedAt ?? new Date().toISOString(),
      });
    }
    for (const seed of members) {
      this.members.set(seed.id, {
        id: seed.id,
        companyId: seed.companyId,
        isActive: seed.isActive ?? true,
        permissions: new Set(seed.permissions ?? []),
      });
    }
  }

  asMember(memberId: string): void {
    this.callerMemberId = memberId;
  }

  getConversationState(conversationId: string): FakeConversation {
    const conv = this.conversations.get(conversationId);
    if (!conv) throw new Error("conversation_not_found");
    return conv;
  }

  getMessageState(messageId: string): FakeMessage {
    const msg = this.messages.get(messageId);
    if (!msg) throw new Error("message_not_found");
    return msg;
  }

  private caller(companyId: string): FakeMember {
    if (!this.callerMemberId) throw new Error("unauthorized");
    const member = this.members.get(this.callerMemberId);
    if (!member || !member.isActive || member.companyId !== companyId) {
      throw new Error("not_a_member");
    }
    return member;
  }

  private requirePermission(member: FakeMember, permission: string): void {
    if (!member.permissions.has(permission)) throw new Error("permission_denied");
  }

  private summary(conv: FakeConversation): HandoverConversationSummary {
    return {
      id: conv.id,
      state: conv.state,
      aiMode: conv.aiMode,
      assignedMemberId: conv.assignedMemberId,
      handoverReason: conv.handoverReason,
    };
  }

  async assignToMe(conversationId: string): Promise<HandoverConversationSummary> {
    const conv = this.getConversationState(conversationId);
    const member = this.caller(conv.companyId);
    this.requirePermission(member, "conversations.assign");

    if (conv.assignedMemberId !== null) throw new Error("conversation_already_claimed");
    if (conv.state !== "handover_requested" && conv.state !== "queued_for_agent") {
      throw new Error("invalid_state_transition");
    }

    conv.assignedMemberId = member.id;
    conv.state = "human_active";
    return this.summary(conv);
  }

  async assignToMember(
    conversationId: string,
    targetMemberId: string,
  ): Promise<HandoverConversationSummary> {
    const conv = this.getConversationState(conversationId);
    const member = this.caller(conv.companyId);
    this.requirePermission(member, "conversations.assign");

    const target = this.members.get(targetMemberId);
    if (!target || !target.isActive || target.companyId !== conv.companyId) {
      throw new Error("target_member_not_found");
    }
    if (conv.state !== "handover_requested") throw new Error("invalid_state_transition");

    conv.assignedMemberId = targetMemberId;
    conv.state = "queued_for_agent";
    return this.summary(conv);
  }

  async start(conversationId: string): Promise<HandoverConversationSummary> {
    const conv = this.getConversationState(conversationId);
    const member = this.caller(conv.companyId);
    this.requirePermission(member, "conversations.assign");

    if (conv.assignedMemberId === member.id && conv.state === "queued_for_agent") {
      conv.state = "human_active";
    } else if (
      conv.assignedMemberId === null &&
      (conv.state === "handover_requested" || conv.state === "queued_for_agent")
    ) {
      conv.assignedMemberId = member.id;
      conv.state = "human_active";
    } else if (conv.assignedMemberId !== null && conv.assignedMemberId !== member.id) {
      this.requirePermission(member, "conversations.reassign");
      conv.assignedMemberId = member.id;
      conv.state = "human_active";
    } else {
      throw new Error("invalid_state_transition");
    }
    return this.summary(conv);
  }

  async markQueued(conversationId: string): Promise<HandoverConversationSummary> {
    const conv = this.getConversationState(conversationId);
    const member = this.caller(conv.companyId);
    this.requirePermission(member, "conversations.assign");
    if (conv.state !== "handover_requested") throw new Error("invalid_state_transition");
    conv.state = "queued_for_agent";
    return this.summary(conv);
  }

  async endHumanAssistance(conversationId: string): Promise<HandoverConversationSummary> {
    const conv = this.getConversationState(conversationId);
    const member = this.caller(conv.companyId);
    this.requirePermission(member, "conversations.assign");
    if (!["handover_requested", "queued_for_agent", "human_active"].includes(conv.state)) {
      throw new Error("invalid_state_transition");
    }
    conv.state = "ai_active";
    conv.assignedMemberId = null;
    conv.handoverReason = null;
    return this.summary(conv);
  }

  async closeConversation(conversationId: string): Promise<HandoverConversationSummary> {
    const conv = this.getConversationState(conversationId);
    const member = this.caller(conv.companyId);
    this.requirePermission(member, "conversations.assign");
    if (conv.state === "closed") throw new Error("invalid_state_transition");
    conv.state = "closed";
    return this.summary(conv);
  }

  async pauseAi(conversationId: string): Promise<HandoverConversationSummary> {
    const conv = this.getConversationState(conversationId);
    const member = this.caller(conv.companyId);
    if (conv.assignedMemberId !== member.id) this.requirePermission(member, "conversations.assign");
    conv.aiMode = "paused";
    return this.summary(conv);
  }

  async resumeAi(conversationId: string): Promise<HandoverConversationSummary> {
    const conv = this.getConversationState(conversationId);
    const member = this.caller(conv.companyId);
    if (conv.assignedMemberId !== member.id) this.requirePermission(member, "conversations.assign");
    conv.aiMode = "active";
    return this.summary(conv);
  }

  async markRead(conversationId: string): Promise<{ id: string; handoverLastReadAt: string }> {
    const conv = this.getConversationState(conversationId);
    const member = this.caller(conv.companyId);
    this.requirePermission(member, "conversations.view");
    return { id: conv.id, handoverLastReadAt: new Date().toISOString() };
  }

  async reserveHumanOutboundMessage(
    conversationId: string,
    _body: string,
    idempotencyKey: string,
  ): Promise<OutboundReservation> {
    const conv = this.getConversationState(conversationId);
    const member = this.caller(conv.companyId);
    this.requirePermission(member, "conversations.reply");
    if (conv.state !== "human_active") throw new Error("invalid_state_transition");
    if (conv.assignedMemberId === null) throw new Error("conversation_not_assigned");
    if (conv.assignedMemberId !== member.id && !member.permissions.has("conversations.reassign")) {
      throw new Error("conversation_not_assigned_to_caller");
    }

    const key = `${member.id}:${conversationId}:${idempotencyKey}`;
    const existing = [...this.messages.values()].find((m) => m.idempotencyKey === key);
    if (existing) {
      return {
        id: existing.id,
        claimed: false,
        outboundStatus: existing.outboundStatus,
        providerMessageId: existing.providerMessageId,
      };
    }

    const id = nextId("msg");
    this.messages.set(id, {
      id,
      companyId: conv.companyId,
      conversationId,
      senderMemberId: member.id,
      idempotencyKey: key,
      outboundStatus: "sending",
      providerMessageId: null,
    });
    return { id, claimed: true, outboundStatus: "sending", providerMessageId: null };
  }

  async finalizeHumanOutboundMessage(
    messageId: string,
    status: OutboundDeliveryStatus,
    providerMessageId: string | null,
    errorCode?: string | null,
    _retryable?: boolean | null,
  ): Promise<OutboundFinalizeResult> {
    const msg = this.getMessageState(messageId);
    const member = this.callerMemberId ? this.members.get(this.callerMemberId) : undefined;
    if (!member || msg.senderMemberId !== member.id) throw new Error("not_reservation_owner");
    if (msg.outboundStatus !== "sending") throw new Error("invalid_status_transition");
    msg.outboundStatus = status;
    msg.providerMessageId = providerMessageId ?? msg.providerMessageId;
    void errorCode;
    return { id: msg.id, outboundStatus: msg.outboundStatus };
  }

  async reconcileOutboundMessage(
    messageId: string,
    resolution: "confirm_sent" | "confirm_not_sent",
  ): Promise<OutboundFinalizeResult> {
    const msg = this.getMessageState(messageId);
    if (msg.outboundStatus !== "delivery_unknown") throw new Error("invalid_status_transition");
    msg.outboundStatus = resolution === "confirm_sent" ? "sent" : "send_failed";
    return { id: msg.id, outboundStatus: msg.outboundStatus };
  }

  async listHandoverInbox(input: HandoverInboxListInput): Promise<HandoverInboxItem[]> {
    return [...this.conversations.values()]
      .filter((c) => c.companyId === input.companyId)
      .map((c) => ({
        conversationId: c.id,
        maskedPhoneNumber: "****0000",
        state: c.state,
        aiMode: c.aiMode,
        priority: "low",
        unreadCount: 0,
        assignedMemberId: c.assignedMemberId,
        handoverReason: c.handoverReason,
        waitingSince: c.stateChangedAt,
      }));
  }

  /**
   * Mirrors SupabaseHandoverRepository.countHandoverBadge: filter to the
   * "all_active" state superset first (this fake's listHandoverInbox
   * ignores the filter param and returns every conversation, so that
   * narrowing has to happen here instead), then apply the same shared
   * handoverItemNeedsAttention predicate. This fake never tracks unread
   * inbound-message state (unreadCount is always 0), so only the
   * state/assignment half of that predicate is exercised here -- the
   * unread-driven escalation path is covered against the real Supabase
   * implementation instead.
   */
  async countHandoverBadge(companyId: string): Promise<number> {
    return [...this.conversations.values()]
      .filter(
        (c) =>
          c.companyId === companyId &&
          (c.state === "handover_requested" ||
            c.state === "queued_for_agent" ||
            c.state === "human_active"),
      )
      .filter((c) =>
        handoverItemNeedsAttention({
          state: c.state,
          assignedMemberId: c.assignedMemberId,
          unreadCount: 0,
        }),
      ).length;
  }

  async getConversationThread(
    conversationId: string,
    pagination?: { before?: string; limit?: number },
  ): Promise<ConversationThreadPage> {
    const limit = pagination?.limit ?? DEFAULT_FAKE_THREAD_PAGE_SIZE;

    // Mirrors SupabaseHandoverRepository's real query: order by created_at
    // descending, optionally below a `before` cursor, take limit + 1 to
    // detect hasMore, then reverse back to ascending for display.
    const descending = this.threadMessages
      .filter((m) => m.conversationId === conversationId)
      .filter((m) => !pagination?.before || m.createdAt < pagination.before)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit + 1);

    const hasMore = descending.length > limit;
    const page = hasMore ? descending.slice(0, limit) : descending;

    return {
      hasMore,
      messages: page
        .slice()
        .reverse()
        .map(({ conversationId: _conversationId, ...rest }) => rest),
    };
  }

  async getLastCustomerMessageAt(_conversationId: string): Promise<string | null> {
    return this.lastCustomerMessageAt;
  }

  async reserveHumanTemplateOutboundMessage(
    conversationId: string,
    idempotencyKey: string,
  ): Promise<HumanTemplateOutboundReservation> {
    const conv = this.getConversationState(conversationId);
    const member = this.caller(conv.companyId);
    this.requirePermission(member, "conversations.reply");
    if (conv.state !== "human_active") throw new Error("invalid_state_transition");
    if (conv.assignedMemberId === null) throw new Error("conversation_not_assigned");
    if (conv.assignedMemberId !== member.id && !member.permissions.has("conversations.reassign")) {
      throw new Error("conversation_not_assigned_to_caller");
    }
    if (!this.fallbackTemplate) throw new Error("no_fallback_template_configured");

    const key = `${member.id}:${conversationId}:${idempotencyKey}`;
    const existing = [...this.messages.values()].find((m) => m.idempotencyKey === key);
    if (existing) {
      return {
        id: existing.id,
        claimed: false,
        outboundStatus: existing.outboundStatus,
        providerMessageId: existing.providerMessageId,
        templateName: this.fallbackTemplate.name,
        templateLanguage: this.fallbackTemplate.language,
      };
    }

    const id = nextId("msg");
    this.messages.set(id, {
      id,
      companyId: conv.companyId,
      conversationId,
      senderMemberId: member.id,
      idempotencyKey: key,
      outboundStatus: "sending",
      providerMessageId: null,
    });
    return {
      id,
      claimed: true,
      outboundStatus: "sending",
      providerMessageId: null,
      templateName: this.fallbackTemplate.name,
      templateLanguage: this.fallbackTemplate.language,
    };
  }

  async getConversationForThread(conversationId: string): Promise<ConversationForThread | null> {
    const conv = this.conversations.get(conversationId);
    if (!conv) return null;
    return {
      id: conv.id,
      companyId: conv.companyId,
      state: conv.state,
      aiMode: conv.aiMode,
      assignedMemberId: conv.assignedMemberId,
      handoverReason: conv.handoverReason,
    };
  }
}
