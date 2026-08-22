import { describe, expect, it } from "vitest";
import { MockEmailProvider } from "../src/providers/mockProvider.js";

describe("MockEmailProvider", () => {
  it("records every sent message and returns a success result without any network call", async () => {
    const provider = new MockEmailProvider();
    const message = { to: "owner@acme.test", subject: "Hi", html: "<p>hi</p>", text: "hi" };

    const result = await provider.send(message);

    expect(result).toEqual({ success: true, providerMessageId: "mock-email-1" });
    expect(provider.sent).toEqual([message]);
  });

  it("assigns a distinct providerMessageId to each send", async () => {
    const provider = new MockEmailProvider();
    const first = await provider.send({ to: "a@x.test", subject: "s", html: "h", text: "t" });
    const second = await provider.send({ to: "b@x.test", subject: "s", html: "h", text: "t" });
    expect(first).not.toEqual(second);
    expect(provider.sent).toHaveLength(2);
  });
});
