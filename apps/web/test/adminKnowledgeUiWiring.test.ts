import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions for the P2 knowledge ingestion UI, same
 * convention as viewLeadLinkWiring.test.ts/mediaAudioRouteWiring.test.ts
 * (no @testing-library/react in this repo -- the actual Server Action
 * behavior these forms bind to is covered dynamically in
 * adminKnowledgeIngestion.test.ts).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const adminCompanyPageSource = readFileSync(
  join(webRoot, "app/admin/companies/[id]/page.tsx"),
  "utf8",
);
const clientKnowledgePageSource = readFileSync(
  join(webRoot, "app/dashboard/knowledge/page.tsx"),
  "utf8",
);

describe("Super Admin knowledge base UI", () => {
  it("imports and binds adminReingestKnowledgeSourceAction to the company id", () => {
    expect(adminCompanyPageSource).toContain("adminReingestKnowledgeSourceAction");
    expect(adminCompanyPageSource).toContain(
      "const adminReingestKnowledgeSourceWithId = adminReingestKnowledgeSourceAction.bind(null, id);",
    );
  });

  it("the edit/re-ingest form submits source_id and source_type as hidden fields, scoped per source", () => {
    const detailsStart = adminCompanyPageSource.indexOf("<summary");
    expect(detailsStart).toBeGreaterThan(-1);
    const formSection = adminCompanyPageSource.slice(detailsStart, detailsStart + 1200);
    expect(formSection).toContain("action={adminReingestKnowledgeSourceWithId}");
    expect(formSection).toContain('name="source_id" value={source.id}');
    expect(formSection).toContain('name="source_type" value={source.source_type}');
  });

  it("still renders ingestion_status and ingestion_error for every source (truthful failure visibility)", () => {
    expect(adminCompanyPageSource).toContain("KNOWLEDGE_STATUS_BADGE[source.ingestion_status]");
    expect(adminCompanyPageSource).toContain("title={source.ingestion_error ?? undefined}");
  });

  it("does not add a file upload input anywhere in the knowledge section", () => {
    const knowledgeSectionStart = adminCompanyPageSource.indexOf("Knowledge base");
    const nextSectionStart = adminCompanyPageSource.indexOf("Entitlement overrides");
    const knowledgeSection = adminCompanyPageSource.slice(knowledgeSectionStart, nextSectionStart);
    expect(knowledgeSection).not.toContain('type="file"');
  });
});

describe("client knowledge page remains read-only", () => {
  it("has no create/edit/delete/retry/upload action wired", () => {
    expect(clientKnowledgePageSource).not.toContain("Action");
    expect(clientKnowledgePageSource).not.toContain("<form");
    expect(clientKnowledgePageSource).not.toContain('type="file"');
  });

  it("still renders ingestion_status truthfully", () => {
    expect(clientKnowledgePageSource).toContain("STATUS_BADGE[source.ingestion_status]");
  });
});
