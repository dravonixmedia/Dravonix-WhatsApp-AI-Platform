export interface RetentionCandidate {
  mediaFileId: string;
  storageKey: string;
  retentionExpiresAt: Date;
}

/** Pure filter: which candidates are past their retention window as of `now`. */
export function selectExpiredMedia(
  candidates: readonly RetentionCandidate[],
  now: Date = new Date(),
): RetentionCandidate[] {
  return candidates.filter((c) => c.retentionExpiresAt.getTime() <= now.getTime());
}

export function computeRetentionExpiry(createdAt: Date, retentionDays: number): Date {
  const expiry = new Date(createdAt);
  expiry.setUTCDate(expiry.getUTCDate() + retentionDays);
  return expiry;
}
