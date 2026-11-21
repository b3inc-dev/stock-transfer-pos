/** The caller has already scoped candidates to this shop, item, location and time window. */
export function matchPendingSale<T extends { quantity: number }>(
  candidates: readonly T[],
  observedDelta: number | null,
): T | null {
  if (observedDelta === null || observedDelta >= 0) return null;
  const matches = candidates.filter((candidate) => candidate.quantity === -observedDelta);
  return matches.length === 1 ? matches[0] : null;
}
