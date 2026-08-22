import { afterEach, describe, expect, it, vi } from "vitest";
import { ResendEmailProvider } from "../src/providers/resendProvider.js";

const CONFIG = { apiKey: "test-key", fromAddress: "invites@dravonix.test", fromName: "DRAIVA" };
const MESSAGE = { to: "owner@acme.test", subject: "Subject", html: "<p>hi</p>", text: "hi" };

describe("ResendEmailProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the correct recipient/subject/body and returns the provider message id on success", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return new Response(JSON.stringify({ id: "resend-msg-123" }), { status: 200 });
      }),
    );

    const provider = new ResendEmailProvider(CONFIG);
    const result = await provider.send(MESSAGE);

    expect(result).toEqual({ success: true, providerMessageId: "resend-msg-123" });
    expect(capturedUrl).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.to).toEqual(["owner@acme.test"]);
    expect(body.subject).toBe("Subject");
    expect(body.html).toBe("<p>hi</p>");
    expect(body.text).toBe("hi");
    expect(body.from).toBe("DRAIVA <invites@dravonix.test>");
  });

  it("never includes the API key in the request body, only the Authorization header", async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedInit = init;
        return new Response(JSON.stringify({ id: "x" }), { status: 200 });
      }),
    );

    await new ResendEmailProvider(CONFIG).send(MESSAGE);

    expect(String(capturedInit?.body)).not.toContain(CONFIG.apiKey);
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${CONFIG.apiKey}`,
    );
  });

  it("returns a typed failure result on a non-2xx response, never throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ name: "validation_error", message: "Invalid `to` field" }),
            {
              status: 422,
            },
          ),
      ),
    );

    const result = await new ResendEmailProvider(CONFIG).send(MESSAGE);
    expect(result).toEqual({
      success: false,
      errorCode: "validation_error",
      errorMessage: "Invalid `to` field",
    });
  });

  it("returns a typed failure result when the network request itself throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );

    const result = await new ResendEmailProvider(CONFIG).send(MESSAGE);
    expect(result.success).toBe(false);
    expect(result).toMatchObject({ errorCode: "network_error" });
  });

  it("returns a typed failure result if a 2xx response is missing an id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );

    const result = await new ResendEmailProvider(CONFIG).send(MESSAGE);
    expect(result).toEqual({
      success: false,
      errorCode: "missing_provider_message_id",
      errorMessage: "Resend response had no message id",
    });
  });
});
