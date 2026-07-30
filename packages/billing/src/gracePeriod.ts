/**
 * Grace period is read from the plan/company at the moment it starts and never
 * recomputed from the current (possibly since-changed) default -- ADR-0006.
 */
export function computeGracePeriodEnd(startedAt: Date, gracePeriodDays: number): Date {
  const end = new Date(startedAt);
  end.setUTCDate(end.getUTCDate() + gracePeriodDays);
  return end;
}

export function isGracePeriodExpired(gracePeriodEnd: Date, now: Date = new Date()): boolean {
  return now.getTime() >= gracePeriodEnd.getTime();
}
