import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphApiWhatsAppProvider } from "../src/providers/graphApiProvider.js";

/**
 * Confirms the one formula every deployed Worker actually relies on for its
 * WhatsApp Graph API base URL (packages/whatsapp/src/providers/
 * graphApiProvider.ts): `https://graph.facebook.com/${graphApiVersion}`.
 * Never previously covered by a test anywhere in this repo -- found while
 * confirming it's safe for dravonix-dashboard-staging to leave
 * META_GRAPH_API_VERSION unset and rely on packages/config's default (see
 * packages/config/test/env.test.ts).
 */
describe("GraphApiWhatsAppProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds its base URL from graphApiVersion (the same value packages/config defaults to v21.0)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.TEST" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GraphApiWhatsAppProvider({
      accessToken: "test-token",
      graphApiVersion: "v21.0",
    });

    await provider.sendText({ phoneNumberId: "123", toWaId: "919999999999", body: "hi" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/123/messages");
  });

  it("an explicit baseUrl override (test-only escape hatch) takes precedence over graphApiVersion", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.TEST" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GraphApiWhatsAppProvider({
      accessToken: "test-token",
      graphApiVersion: "v21.0",
      baseUrl: "https://example.test/graph-override",
    });

    await provider.sendText({ phoneNumberId: "123", toWaId: "919999999999", body: "hi" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/graph-override/123/messages");
  });
});
