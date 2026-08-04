import { redirect } from "next/navigation";

/**
 * This placeholder's role is now filled by /dashboard/conversations (Live
 * Conversations, wired to real tenant-scoped queries). Kept as a redirect
 * rather than deleted outright in case anything still links to the old path.
 */
export default function InboxPage() {
  redirect("/dashboard/conversations");
}
