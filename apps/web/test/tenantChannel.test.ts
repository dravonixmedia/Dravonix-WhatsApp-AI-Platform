import { describe, expect, it } from "vitest";
import { buildTenantWatchConfig, tenantChannelName } from "../lib/realtime/tenantChannel.js";

describe("buildTenantWatchConfig", () => {
  it("scopes every filter to exactly the caller's own scopeId", () => {
    const config = buildTenantWatchConfig("company-a", [
      { table: "conversations", filterColumn: "company_id" },
      { table: "messages", filterColumn: "company_id" },
    ]);
    expect(config).toEqual([
      { table: "conversations", event: "*", filter: "company_id=eq.company-a" },
      { table: "messages", event: "*", filter: "company_id=eq.company-a" },
    ]);
  });

  it("never mixes in a different tenant's id -- every filter embeds the same single scopeId passed in", () => {
    const scopeId = "11111111-1111-1111-1111-111111111111";
    const otherTenantId = "22222222-2222-2222-2222-222222222222";
    const config = buildTenantWatchConfig(scopeId, [
      { table: "conversations", filterColumn: "company_id" },
      { table: "handover_events", filterColumn: "company_id" },
      { table: "conversation_assignments", filterColumn: "company_id" },
    ]);
    for (const watch of config) {
      expect(watch.filter).toBe(`company_id=eq.${scopeId}`);
      expect(watch.filter).not.toContain(otherTenantId);
    }
  });

  it("defaults event to '*' when unspecified, and honors an explicit event", () => {
    const config = buildTenantWatchConfig("scope-1", [
      { table: "messages", filterColumn: "conversation_id" },
      { table: "messages", filterColumn: "conversation_id", event: "INSERT" },
    ]);
    expect(config[0]?.event).toBe("*");
    expect(config[1]?.event).toBe("INSERT");
  });

  it("supports a per-conversation scope just as well as a per-company scope (same function, different filterColumn/scopeId)", () => {
    const config = buildTenantWatchConfig("conversation-123", [
      { table: "messages", filterColumn: "conversation_id" },
    ]);
    expect(config).toEqual([
      { table: "messages", event: "*", filter: "conversation_id=eq.conversation-123" },
    ]);
  });

  it("returns an empty array for an empty watch list", () => {
    expect(buildTenantWatchConfig("scope-1", [])).toEqual([]);
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
