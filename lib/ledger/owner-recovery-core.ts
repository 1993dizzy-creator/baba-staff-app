const SCALE = BigInt(1000);

function milli(value: string | number): bigint {
  const raw = String(value);
  if (!/^\d+(?:\.\d{1,3})?$/.test(raw)) throw new RangeError("Invalid recovery amount");
  const [whole, fraction = ""] = raw.split(".");
  return BigInt(whole) * SCALE + BigInt((fraction + "000").slice(0, 3));
}

function decimal(value: bigint): string {
  return `${value / SCALE}.${String(value % SCALE).padStart(3, "0")}`;
}

export function allocateOwnerRecoveryPool(
  requestedPool: string | number,
  owners: ReadonlyArray<{ userId: number; participantId: number; unrecoveredForAllocation: string | number }>,
) {
  const pool = milli(requestedPool);
  const eligible = owners.map(owner => ({ ...owner, remaining: milli(owner.unrecoveredForAllocation) }))
    .filter(owner => owner.remaining > BigInt(0))
    .sort((a, b) => a.userId - b.userId || a.participantId - b.participantId);
  const total = eligible.reduce((sum, owner) => sum + owner.remaining, BigInt(0));
  if (pool <= BigInt(0) || pool > total) throw new RangeError("Recovery exceeds unallocated principal");
  const shares = eligible.map(owner => {
    const numerator = pool * owner.remaining;
    return { ...owner, assigned: numerator / total, fractionalRemainder: numerator % total };
  });
  let remainder = pool - shares.reduce((sum, owner) => sum + owner.assigned, BigInt(0));
  const byRemainder = [...shares].sort((a, b) =>
    a.fractionalRemainder === b.fractionalRemainder
      ? a.userId - b.userId || a.participantId - b.participantId
      : a.fractionalRemainder > b.fractionalRemainder ? -1 : 1);
  for (const owner of byRemainder) {
    if (remainder === BigInt(0)) break;
    owner.assigned += BigInt(1);
    remainder -= BigInt(1);
  }
  if (remainder !== BigInt(0)) throw new RangeError("Recovery rounding mismatch");
  return shares.map(owner => {
    if (owner.assigned > owner.remaining) throw new RangeError("Recovery exceeds owner principal");
    return { userId: owner.userId, participantId: owner.participantId,
      unrecoveredForAllocation: decimal(owner.remaining), assignedAmount: decimal(owner.assigned) };
  });
}
