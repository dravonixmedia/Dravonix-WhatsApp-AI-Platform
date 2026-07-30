import { describe, expect, it } from "vitest";
import { MockWhatsAppProvider } from "../src/providers/mockProvider.js";

describe("MockWhatsAppProvider", () => {
  it("records sent text messages and returns a unique provider message ID", async () => {
    const provider = new MockWhatsAppProvider();
    const result1 = await provider.sendText({
      phoneNumberId: "PN1",
      toWaId: "919820000001",
      body: "Hello",
    });
    const result2 = await provider.sendText({
      phoneNumberId: "PN1",
      toWaId: "919820000001",
      body: "Hi again",
    });

    expect(provider.sentText).toHaveLength(2);
    expect(result1.providerMessageId).not.toBe(result2.providerMessageId);
  });

  it("records sent audio messages", async () => {
    const provider = new MockWhatsAppProvider();
    await provider.sendAudio({
      phoneNumberId: "PN1",
      toWaId: "919820000001",
      audioMediaIdOrUrl: "media-1",
    });
    expect(provider.sentAudio).toHaveLength(1);
  });

  it("never performs a real network call", async () => {
    const provider = new MockWhatsAppProvider();
    const metadata = await provider.getMediaMetadata("media-1");
    expect(metadata.url).toContain("mock.local");
  });
});
