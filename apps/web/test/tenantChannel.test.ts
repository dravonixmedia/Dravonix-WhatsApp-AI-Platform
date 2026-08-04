import { describe, expect, it } from "vitest";
import type { RealtimeWatch } from "../lib/realtime/tenantChannel.js";
import { buildTenantWatchConfig, tenantChannelName } from "../lib/realtime/tenantChannel.js";

describe("buildTenantWatchConfig", () => {
  it("scopes every filter to exactly the caller's own scopeId", () => {
    const config = buildTenantWatchConfig("company-a", [
      { table: "conversations", filterColumn: "company_id", event: "INSERT" },
      { table: "messages", filterColumn: "company_id", event: "UPDATE" },
    ]);
    expect(config).toEqual([
      { table: "conversations", event: "INSERT", filter: "company_id=eq.company-a" },
      { table: "messages", event: "UPDATE", filter: "company_id=eq.company-a" },
    ]);
  });

  it("never mixes in a different tenant's id -- every filter embeds the same single scopeId passed in", () => {
    const scopeId = "11111111-1111-1111-1111-111111111111";
    const otherTenantId = "22222222-2222-2222-2222-222222222222";
    const config = buildTenantWatchConfig(scopeId, [
      { table: "conversations", filterColumn: "company_id", event: "INSERT" },
      { table: "handover_events", filterColumn: "company_id", event: "INSERT" },
      { table: "conversation_assignments", filterColumn: "company_id", event: "UPDATE" },
    ]);
    for (const watch of config) {
      expect(watch.filter).toBe(`company_id=eq.${scopeId}`);
      expect(watch.filter).not.toContain(otherTenantId);
    }
  });

  it("has no parameter for scopeId other than the caller's own -- there is no way to build a filter for a second tenant", () => {
    // buildTenantWatchConfig(scopeId, watches) only ever accepts ONE scopeId;
    // every watch entry's filter is derived from that single value. This
    // test documents the structural guarantee: passing a company id and
    // asking for a second, different id anywhere in the call is not an
    // expressible input at all.
    const config = buildTenantWatchConfig("company-a", [
      { table: "conversations", filterColumn: "company_id", event: "INSERT" },
    ]);
    expect(config).toHaveLength(1);
    expect(config[0]?.filter).toBe("company_id=eq.company-a");
  });

  it("honors an explicit INSERT or UPDATE event -- event is required, there is no default", () => {
    const config = buildTenantWatchConfig("scope-1", [
      { table: "messages", filterColumn: "conversation_id", event: "INSERT" },
      { table: "messages", filterColumn: "conversation_id", event: "UPDATE" },
    ]);
    expect(config[0]?.event).toBe("INSERT");
    expect(config[1]?.event).toBe("UPDATE");
  });

  it("rejects a DELETE event even if one reaches it bypassing TypeScript (defense-in-depth)", () => {
    const watches = [
      { table: "conversations", filterColumn: "company_id", event: "DELETE" },
    ] as unknown as RealtimeWatch[];
    expect(() => buildTenantWatchConfig("company-a", watches)).toThrow(/forbidden event "DELETE"/);
  });

  it("rejects a '*' event even if one reaches it bypassing TypeScript (defense-in-depth)", () => {
    const watches = [
      { table: "messages", filterColumn: "conversation_id", event: "*" },
    ] as unknown as RealtimeWatch[];
    expect(() => buildTenantWatchConfig("scope-1", watches)).toThrow(/forbidden event "\*"/);
  });

  it("supports a per-conversation scope just as well as a per-company scope (same function, different filterColumn/scopeId)", () => {
    const config = buildTenantWatchConfig("conversation-123", [
      { table: "messages", filterColumn: "conversation_id", event: "INSERT" },
    ]);
    expect(config).toEqual([
      { table: "messages", event: "INSERT", filter: "conversation_id=eq.conversation-123" },
    ]);
  });

  it("returns an empty array for an empty watch list", () => {
    expect(buildTenantWatchConfig("scope-1", [])).toEqual([]);
  });

  it("reconnect reproduces the exact same subscription set -- calling it twice with the same inputs is deterministic", () => {
    const watches: RealtimeWatch[] = [
      { table: "conversations", filterColumn: "company_id", event: "INSERT" },
      { table: "conversations", filterColumn: "company_id", event: "UPDATE" },
    ];
    const first = buildTenantWatchConfig("company-a", watches);
    const second = buildTenantWatchConfig("company-a", watches);
    expect(second).toEqual(first);
  });
});

describe("tenantChannelName", () => {
  it("embeds both the namespace and scopeId, so different tenants/conversations never share a channel identity", () => {
    expect(tenantChannelName("company", "abc")).toBe("dvx:company:abc");
    expect(tenantChannelName("conversation-thread", "xyz")).toBe("dvx:conversation-thread:xyz");
  });

  it("produces distinct names for distinct scopeIds under the same namespace", () => {
    const a = tenantChannelName("company", "tenant-a");
    const b = tenantChannelName("company", "tenant-b");
    expect(a).not.toBe(b);
  });
});
