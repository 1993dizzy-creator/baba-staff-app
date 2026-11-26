// Recipient rule contract shared by the settings UI preview and tests. The DB function
// notification_private.rules_match is the authority; this mirror must stay identical
// (tests/notifications-db.test.mjs compares both on the same matrix).
//
// - "roles" is the staff rank (직급): users.role is the single source of rank and permission
//   (lib/common/roles.ts). The legacy users.position mirror is intentionally not a rule attribute,
//   so rank is never expressed twice (e.g. master's legacy position is "owner" or NULL).
// - Inside one group, roles and parts are ANDed.
// - Groups are ORed. userIds is an extra allow list (also ORed).
// - An empty or missing list means "any value, NULL included". A non-empty list never matches NULL.
// - A group whose lists are all empty means "every active staff member".
// - The result is always intersected with the type's access ceiling by the DB (not here).

export const NOTIFICATION_RULE_ROLES = ["owner", "master", "manager", "leader", "staff"] as const;
export const NOTIFICATION_RULE_PARTS = ["owner", "hall", "bar", "kitchen", "cleaning", "etc"] as const;
export const MAX_RULE_GROUPS = 20;
export const MAX_RULE_USER_IDS = 100;

export type NotificationRuleGroup = {
  roles?: string[];
  parts?: string[];
};
export type NotificationRules = {
  groups?: NotificationRuleGroup[];
  userIds?: number[];
};
export type RuleSubject = {
  id: number;
  role: string | null;
  part: string | null;
};

const norm = (value: string | null | undefined) => {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text || null;
};

function attrMatch(list: string[] | undefined, value: string | null) {
  if (!Array.isArray(list) || list.length === 0) return true;
  if (value === null) return false;
  return list.includes(value);
}

export function matchesRecipientRules(rules: NotificationRules, subject: RuleSubject) {
  if (Array.isArray(rules.userIds) && rules.userIds.includes(subject.id)) return true;
  const role = norm(subject.role), part = norm(subject.part);
  return (rules.groups ?? []).some((group) => attrMatch(group.roles, role) && attrMatch(group.parts, part));
}

/** Matches the type ceiling too, i.e. what the DB fan-out would select for an active account. */
export function previewRecipients<T extends RuleSubject>(rules: NotificationRules, accessRoles: readonly string[], staff: T[]) {
  return staff.filter((member) => {
    const role = norm(member.role);
    return role !== null && accessRoles.includes(role) && matchesRecipientRules(rules, member);
  });
}

/** Client-side shape check before sending; the DB re-validates and normalizes. */
export function isValidRules(value: unknown): value is NotificationRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rules = value as Record<string, unknown>;
  if (Object.keys(rules).some((key) => key !== "groups" && key !== "userIds")) return false;
  const groups = rules.groups ?? [];
  const userIds = rules.userIds ?? [];
  if (!Array.isArray(groups) || groups.length > MAX_RULE_GROUPS) return false;
  if (!Array.isArray(userIds) || userIds.length > MAX_RULE_USER_IDS) return false;
  if (!userIds.every((id) => Number.isSafeInteger(id) && (id as number) > 0)) return false;
  const allowed: Record<string, readonly string[]> = {
    roles: NOTIFICATION_RULE_ROLES, parts: NOTIFICATION_RULE_PARTS,
  };
  return groups.every((group) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) return false;
    return Object.entries(group as Record<string, unknown>).every(([key, list]) =>
      key in allowed && Array.isArray(list) && list.every((item) => typeof item === "string" && allowed[key].includes(item)));
  });
}
