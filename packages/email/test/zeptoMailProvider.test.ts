import { afterEach, describe, expect, it, vi } from "vitest";
import { ZeptoMailEmailProvider } from "../src/providers/zeptoMailProvider.js";

const CONFIG = {
  apiToken: "test-token",
  fromAddress: "admin@dravonixmedia.com",
  fromName: "DRAIVA by Dravonix Media",
};
const MESSAGE = { to: "owner@acme.test", subject: "Subject", html: "<p>hi</p>", text: "hi" };

describe("ZeptoMailEmailProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the correct recipient/subject/body and returns the request id on success", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return new Response(
          JSON.stringify({
            data: [{ code: "EM_104", message: "Email request received" }],
            message: "OK",
            request_id: "zm-req-123",
            object: "email",
          }),
          { status: 200 },
        );
      }),
    );

    const provider = new ZeptoMailEmailProvider(CONFIG);
    const result = await provider.send(MESSAGE);

    expect(result).toEqual({ success: true, providerMessageId: "zm-req-123" });
    expect(capturedUrl).toBe("https://api.zeptomail.com/v1.1/email");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.to).toEqual([{ email_address: { address: "owner@acme.test" } }]);
    expect(body.subject).toBe("Subject");
    expect(body.htmlbody).toBe("<p>hi</p>");
    expect(body.textbody).toBe("hi");
    expect(body.from).toEqual({
      address: "admin@dravonixmedia.com",
      name: "DRAIVA by Dravonix Media",
    });
  });

  it("never includes the API token in the request body, only the Zoho-enczapikey Authorization header", async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedInit = init;
        return new Response(JSON.stringify({ request_id: "x" }), { status: 200 });
      }),
    );

    await new ZeptoMailEmailProvider(CONFIG).send(MESSAGE);

    expect(String(capturedInit?.body)).not.toContain(CONFIG.apiToken);
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe(
      `Zoho-enczapikey ${CONFIG.apiToken}`,
    );
  });

  it("returns a typed failure result on a non-2xx response, never throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "TM_3301", message: "Bad Syntax", details: [{ code: "SM_101" }] },
            }),
            { status: 422 },
          ),
      ),
    );

    const result = await new ZeptoMailEmailProvider(CONFIG).send(MESSAGE);
    expect(result).toEqual({
      success: false,
      errorCode: "TM_3301",
      errorMessage: "Bad Syntax",
    });
  });

  it("returns a typed failure result when the network request itself throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );

    const result = await new ZeptoMailEmailProvider(CONFIG).send(MESSAGE);
    expect(result.success).toBe(false);
    expect(result).toMatchObject({ errorCode: "network_error" });
  });

  it("returns a typed failure result if a 2xx response is missing a request id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );

    const result = await new ZeptoMailEmailProvider(CONFIG).send(MESSAGE);
    expect(result).toEqual({
      success: false,
      errorCode: "missing_provider_message_id",
      errorMessage: "ZeptoMail response had no request id",
    });
  });

  it("returns a typed failure result on a 401 with no parseable error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );

    const result = await new ZeptoMailEmailProvider(CONFIG).send(MESSAGE);
    expect(result).toMatchObject({ success: false, errorCode: "http_401" });
  });
});
