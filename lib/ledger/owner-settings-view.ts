type EffectiveParticipant = { effective_from: string };

// The dashboard already selects the active composition for the viewed month.
export function ownerCompositionStartMonth(participants: readonly EffectiveParticipant[]): string | null {
  return participants[0]?.effective_from?.slice(0, 7) ?? null;
}
