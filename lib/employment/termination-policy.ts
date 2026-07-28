type TerminationPolicyUpdate = Record<string, unknown> & {
  termination_date?: string | null;
  is_active?: boolean;
};

type CurrentAccountState = {
  termination_date: string | null;
  is_active: boolean | null;
};

type TerminationPolicyResult =
  | { ok: true; update: TerminationPolicyUpdate }
  | { ok: false; reason: "future_termination_date" };

export function getVietnamDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function enforceTerminationAccountPolicy({
  update,
  current,
  today = getVietnamDateKey(),
}: {
  update: TerminationPolicyUpdate;
  current: CurrentAccountState;
  today?: string;
}): TerminationPolicyResult {
  const hasTerminationUpdate = Object.prototype.hasOwnProperty.call(
    update,
    "termination_date"
  );
  const finalTerminationDate = hasTerminationUpdate
    ? update.termination_date ?? null
    : current.termination_date;

  if (finalTerminationDate && finalTerminationDate > today) {
    return { ok: false, reason: "future_termination_date" };
  }

  const enforcedUpdate = { ...update };

  if (finalTerminationDate) {
    enforcedUpdate.is_active = false;
  } else if (hasTerminationUpdate) {
    // Clearing the date is not a rehire action. Preserve the current account state.
    enforcedUpdate.is_active = current.is_active === true;
  }

  return { ok: true, update: enforcedUpdate };
}
