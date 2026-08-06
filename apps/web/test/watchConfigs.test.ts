import { describe, expect, it } from "vitest";
import { buildTenantWatchConfig } from "../lib/realtime/tenantChannel.js";
import {
  ALL_WATCH_LISTS,
  CONVERSATIONS_LIST_WATCHES,
  CONVERSATION_DETAIL_WATCHES,
  DASHBOARD_SHELL_WATCHES,
  HANDOVER_INBOX_WATCHES,
  LEADS_LIST_WATCHES,
  LEAD_DETAIL_WATCHES,
  MESSAGE_THREAD_WATCHES,
} from "../lib/realtime/watchConfigs.js";

const KNOWN_TENANT_FILTER_COLUMNS = new Set(["company_id", "id", "conversation_id"]);

describe("every dashboard realtime watch list", () => {
  for (const [name, watches] of Object.entries(ALL_WATCH_LISTS)) {
    describe(name, () => {
      it("registers only INSERT and/or UPDATE -- never DELETE, never '*'", () => {
        for (const watch of watches) {
          expect(["INSERT", "UPDATE"]).toContain(watch.event);
        }
      });

      it("uses only a recognized tenant-scoping filter column", () => {
        for (const watch of watches) {
          expect(KNOWN_TENANT_FILTER_COLUMNS.has(watch.filterColumn)).toBe(true);
        }
      });

      it("contains the authenticated company/resource filter for every entry once built", () => {
        const scopeId = "company-a";
        const config = buildTenantWatchConfig(scopeId, watches);
        for (const entry of config) {
          expect(entry.filter).toContain(scopeId);
        }
      });

      it("never leaks a second tenant's id into any built filter", () => {
        const scopeId = "company-a";
        const otherTenantId = "company-b";
        const config = buildTenantWatchConfig(scopeId, watches);
        for (const entry of config) {
          expect(entry.filter).not.toContain(otherTenantId);
        }
      });

      it("reconnect (re-invoking the builder with the same inputs) reproduces an identical subscription set", () => {
        const first = buildTenantWatchConfig("company-a", watches);
        const second = buildTenantWatchConfig("company-a", watches);
        expect(second).toEqual(first);
      });
    });
  }
});

describe("specific watch lists match their documented, minimal scope", () => {
  it("handover_events is only ever watched for INSERT (append-only in this app)", () => {
    for (const watches of [HANDOVER_INBOX_WATCHES, CONVERSATION_DETAIL_WATCHES]) {
      const handoverWatches = watches.filter((w) => w.table === "handover_events");
      expect(handoverWatches.length).toBeGreaterThan(0);
      for (const w of handoverWatches) {
        expect(w.event).toBe("INSERT");
      }
    }
  });

  it("CONVERSATION_DETAIL_WATCHES never registers INSERT for conversations (an already-existing id can't be inserted)", () => {
    const conversationsWatches = CONVERSATION_DETAIL_WATCHES.filter(
      (w) => w.table === "conversations",
    );
    expect(conversationsWatches).toEqual([
      { table: "conversations", filterColumn: "id", event: "UPDATE" },
    ]);
  });

  it("LEAD_DETAIL_WATCHES never registers INSERT for leads (an already-existing id can't be inserted)", () => {
    expect(LEAD_DETAIL_WATCHES).toEqual([{ table: "leads", filterColumn: "id", event: "UPDATE" }]);
  });

  it("CONVERSATIONS_LIST_WATCHES watches messages for INSERT only (list preview never changes via UPDATE)", () => {
    const messagesWatches = CONVERSATIONS_LIST_WATCHES.filter((w) => w.table === "messages");
    expect(messagesWatches).toEqual([
      { table: "messages", filterColumn: "company_id", event: "INSERT" },
    ]);
  });

  it("MESSAGE_THREAD_WATCHES watches both INSERT and UPDATE (new messages and status transitions)", () => {
    expect(MESSAGE_THREAD_WATCHES).toEqual([
      { table: "messages", filterColumn: "conversation_id", event: "INSERT" },
      { table: "messages", filterColumn: "conversation_id", event: "UPDATE" },
    ]);
  });

  it("LEADS_LIST_WATCHES watches both INSERT and UPDATE (new leads and stage/assignment changes)", () => {
    expect(LEADS_LIST_WATCHES).toEqual([
      { table: "leads", filterColumn: "company_id", event: "INSERT" },
      { table: "leads", filterColumn: "company_id", event: "UPDATE" },
    ]);
  });

  it("DASHBOARD_SHELL_WATCHES covers every table the bell badge and nav badge depend on (conversations, messages, conversation_assignments, handover_events)", () => {
    const tables = new Set(DASHBOARD_SHELL_WATCHES.map((w) => w.table));
    expect(tables).toEqual(
      new Set(["conversations", "messages", "conversation_assignments", "handover_events"]),
    );
  });

  it("DASHBOARD_SHELL_WATCHES watches messages for INSERT only, same as CONVERSATIONS_LIST_WATCHES", () => {
    const messagesWatches = DASHBOARD_SHELL_WATCHES.filter((w) => w.table === "messages");
    expect(messagesWatches).toEqual([
      { table: "messages", filterColumn: "company_id", event: "INSERT" },
    ]);
  });
});
