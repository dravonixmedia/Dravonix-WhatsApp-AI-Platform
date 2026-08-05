import { NextResponse } from "next/server";

/**
 * Unauthenticated liveness check for post-deploy smoke testing (staging and
 * production) -- deliberately outside middleware's `/dashboard/:path*`
 * matcher, so it never redirects to /login, and deliberately makes no
 * Supabase call (a basic liveness signal that the Worker itself is up and
 * serving, not a database-reachability check). Returns the deployed
 * APP_ENV so a smoke test can also confirm it hit the environment it
 * expected (e.g. "staging" body on the staging URL, never "production").
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    status: "ok",
    appEnv: process.env.APP_ENV ?? "unknown",
  });
}
