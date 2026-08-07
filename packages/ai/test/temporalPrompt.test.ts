import { resolveConversationTemporalContext } from "@dravonix/core";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/prompt/buildSystemPrompt.js";
import { makeInput } from "./fixtures.js";

describe("buildSystemPrompt temporal context (Global Timezone + Daypart Awareness)", () => {
  it("includes business timezone, local date/time, day, and daypart", () => {
    const { company, memory, knowledge } = makeInput();
    const temporal = resolveConversationTemporalContext({
      companyTimezone: "Asia/Dubai",
      customerTimezone: null,
      now: new Date("2026-06-10T10:00:00.000Z"),
    });
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal);
    expect(prompt).toContain("CURRENT TEMPORAL CONTEXT");
    expect(prompt).toContain("Timezone: Asia/Dubai");
    expect(prompt).toContain("Local date: 2026-06-10");
    expect(prompt).toContain("Local time: 14:00");
    expect(prompt).toContain("Daypart: afternoon");
  });

  it("includes customer timezone and local context when known", () => {
    const { company, memory, knowledge } = makeInput();
    const temporal = resolveConversationTemporalContext({
      companyTimezone: "Asia/Dubai",
      customerTimezone: "Europe/London",
      now: new Date("2026-06-10T10:00:00.000Z"),
    });
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal);
    expect(prompt).toContain("CUSTOMER:");
    expect(prompt).toContain("Timezone: Europe/London");
    expect(prompt).toContain("Local time: 11:00");
    expect(prompt).toContain("Daypart: morning");
  });

  it("explicitly says customer timezone is unknown when absent -- never falls back to company timezone", () => {
    const { company, memory, knowledge } = makeInput();
    const temporal = resolveConversationTemporalContext({
      companyTimezone: "Asia/Dubai",
      customerTimezone: null,
      now: new Date("2026-06-10T10:00:00.000Z"),
    });
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal);
    expect(prompt).toMatch(/CUSTOMER:\s*\nTimezone: UNKNOWN/);
    expect(prompt).toMatch(/do not infer customer-local daypart/i);
    // The customer block must never silently repeat the business's timezone.
    const customerBlock = prompt.slice(prompt.indexOf("CUSTOMER:"));
    expect(customerBlock).not.toContain("Asia/Dubai");
  });

  it("contains no hardcoded Asia/Kolkata reference when the company's real timezone is different", () => {
    const { company, memory, knowledge } = makeInput();
    const temporal = resolveConversationTemporalContext({
      companyTimezone: "America/New_York",
      customerTimezone: "Australia/Sydney",
      now: new Date("2026-06-10T10:00:00.000Z"),
    });
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal);
    expect(prompt).not.toContain("Asia/Kolkata");
    expect(prompt).toContain("America/New_York");
    expect(prompt).toContain("Australia/Sydney");
  });

  it("reflects the injected `now`, never a value computed elsewhere", () => {
    const { company, memory, knowledge } = makeInput();
    const now = new Date("2031-11-02T03:15:00.000Z");
    const temporal = resolveConversationTemporalContext({
      companyTimezone: "UTC",
      customerTimezone: null,
      now,
    });
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal);
    expect(prompt).toContain(`UTC: ${now.toISOString()}`);
  });

  it("preserves the existing requiresHuman-only follow-up safety rule alongside the new temporal rules", () => {
    const { company, memory, knowledge, temporal } = makeInput();
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal);
    expect(prompt).toMatch(/never promise staff\s+follow-up/i);
    expect(prompt).toMatch(
      /understanding a relative time phrase is not authorization to commit the company/i,
    );
  });

  it("instructs the model never to invent a customer timezone or use server/Cloudflare UTC as customer-local time", () => {
    const { company, memory, knowledge, temporal } = makeInput();
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal);
    expect(prompt).toMatch(/never invent or guess a customer timezone/i);
    expect(prompt).toMatch(
      /never treat server\/cloudflare utc as if it were the customer's local time/i,
    );
  });

  it("surfaces a missing company timezone as a configuration gap rather than pretending UTC is the business's real timezone", () => {
    const { company, memory, knowledge } = makeInput();
    const temporal = resolveConversationTemporalContext({
      companyTimezone: null,
      customerTimezone: null,
      now: new Date("2026-06-10T10:00:00.000Z"),
    });
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal);
    expect(prompt).toMatch(/Timezone: NOT CONFIGURED \(using UTC as a technical fallback only/);
  });
});
