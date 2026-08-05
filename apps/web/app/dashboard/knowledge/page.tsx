import { redirect } from "next/navigation";

/**
 * No client-ready Knowledge Base management module exists yet: the
 * `packages/knowledge` package only has retrieval (used internally by the
 * AI reply pipeline) and low-level ingestion utilities (file validation,
 * text extraction, chunking) -- no list/create/edit/upload/delete surface,
 * no dashboard repository function, and no Server Action anywhere in
 * apps/web. Removed from the sidebar nav; this route redirects rather than
 * showing a developer placeholder in case anything still links here.
 */
export default function KnowledgePage() {
  redirect("/dashboard");
}
