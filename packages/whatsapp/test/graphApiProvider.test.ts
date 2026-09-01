import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GraphApiWhatsAppProvider,
  WhatsAppProviderError,
} from "../src/providers/graphApiProvider.js";

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

  describe("sendTemplate (Meta/WhatsApp Batch 2)", () => {
    it("builds a template-type message and stores the real provider message id (item 21)", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [{ id: "wamid.TEMPLATE.REAL" }] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const provider = new GraphApiWhatsAppProvider({
        accessToken: "test-token",
        graphApiVersion: "v21.0",
      });

      const result = await provider.sendTemplate({
        phoneNumberId: "123",
        toWaId: "919999999999",
        templateName: "reengagement_v1",
        languageCode: "en",
        bodyParameters: [],
      });

      expect(result.providerMessageId).toBe("wamid.TEMPLATE.REAL");
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://graph.facebook.com/v21.0/123/messages");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        messaging_product: "whatsapp",
        to: "919999999999",
        type: "template",
        template: { name: "reengagement_v1", language: { code: "en" } },
      });
    });

    it("includes a body component only when parameters are actually supplied", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [{ id: "wamid.TEMPLATE.PARAMS" }] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const provider = new GraphApiWhatsAppProvider({
        accessToken: "test-token",
        graphApiVersion: "v21.0",
      });

      await provider.sendTemplate({
        phoneNumberId: "123",
        toWaId: "919999999999",
        templateName: "with_params",
        languageCode: "en",
        bodyParameters: ["Acme Co"],
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.template.components).toEqual([
        { type: "body", parameters: [{ type: "text", text: "Acme Co" }] },
      ]);
    });
  });

  describe("structured error code/subcode capture (item 22)", () => {
    it("captures Meta's error.code and error.error_subcode without matching any English message text", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            message: "(#131047) Re-engagement message",
            code: 131047,
            error_subcode: 2494055,
          },
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const provider = new GraphApiWhatsAppProvider({
        accessToken: "test-token",
        graphApiVersion: "v21.0",
      });

      await expect(
        provider.sendText({ phoneNumberId: "123", toWaId: "919999999999", body: "hi" }),
      ).rejects.toMatchObject({
        errorCode: "131047",
        errorSubcode: "2494055",
      });
    });

    it("never leaks the access token in a thrown error, even on failure", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: "Invalid OAuth access token.", code: 190 } }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const provider = new GraphApiWhatsAppProvider({
        accessToken: "super-secret-token-value",
        graphApiVersion: "v21.0",
      });

      try {
        await provider.sendText({ phoneNumberId: "123", toWaId: "919999999999", body: "hi" });
        expect.unreachable("expected sendText to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(WhatsAppProviderError);
        expect(JSON.stringify(error)).not.toContain("super-secret-token-value");
        expect((error as Error).message).not.toContain("super-secret-token-value");
      }
    });
  });
});
