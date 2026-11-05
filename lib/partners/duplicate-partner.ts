// Regular partner duplicate policy: two names are the same partner when they are equal after
// the inventory normalizer (accents / tone-mark position, case, spacing, Unicode composition),
// e.g. "THỦY NAM" = "Thuỷ Nam". The database enforces the same key
// (business_partner_name_key + business_partners_name_key_unique); this module only lets the
// API and screens name the existing partner and offer it instead of creating a new one.
// Names that merely look alike are never merged.
import { normalizeVietnameseText } from "../inventory/normalize.ts";

export type DuplicatePartner = { id: number; name: string; isActive: boolean };
type PartnerRow = { id: number | string; name: string | null; isActive?: boolean | null; is_active?: boolean | null };
type AliasRow = { id: number; supplierName: string; status: string; businessPartnerId?: number | null };

export const partnerNameKey = (name: unknown) => normalizeVietnameseText(name);

export function findDuplicatePartner(partners: readonly PartnerRow[], name: unknown, excludeId?: number | null): DuplicatePartner | null {
  const key = partnerNameKey(name);
  if (!key) return null;
  const row = partners.find(partner => Number(partner.id) !== excludeId && partnerNameKey(partner.name) === key);
  return row ? { id: Number(row.id), name: String(row.name ?? ""), isActive: (row.isActive ?? row.is_active) !== false } : null;
}

// Inventory 직접 입력 suggestion only: an active partner (directly, or through a linked
// candidate) or a pending 등록대기 candidate with the same name key. It is never applied
// automatically; "기존 거래처 사용" sends the chosen partner id. The server's own automatic link
// stays limited to exact (case/trim) names and admin-linked candidates.
export function matchExistingSupplier(partners: readonly PartnerRow[], aliases: readonly AliasRow[], name: unknown):
  { kind: "partner"; id: number; name: string } | { kind: "alias"; id: number; name: string } | null {
  const key = partnerNameKey(name);
  if (!key) return null;
  const partner = findDuplicatePartner(partners.filter(row => (row.isActive ?? row.is_active) !== false), name);
  if (partner) return { kind: "partner", id: partner.id, name: partner.name };
  const sameKey = aliases.filter(alias => partnerNameKey(alias.supplierName) === key);
  const linked = sameKey.find(alias => alias.status === "linked" && alias.businessPartnerId != null);
  const linkedPartner = linked ? partners.find(row => Number(row.id) === linked.businessPartnerId && (row.isActive ?? row.is_active) !== false) : null;
  if (linkedPartner) return { kind: "partner", id: Number(linkedPartner.id), name: String(linkedPartner.name ?? "") };
  const pending = sameKey.find(alias => alias.status === "pending");
  return pending ? { kind: "alias", id: pending.id, name: pending.supplierName } : null;
}

export function duplicatePartnerMessage(lang: "ko" | "vi", partner: DuplicatePartner | null | undefined) {
  const vi = lang === "vi";
  if (!partner) return vi ? "Tên đối tác đã tồn tại." : "같은 이름의 거래처가 이미 있습니다.";
  if (!partner.isActive) {
    return vi
      ? `Đối tác "${partner.name}" đã được đăng ký (ngừng dùng). Hãy dùng lại đối tác này thay vì tạo mới.`
      : `이미 등록된 거래처 "${partner.name}"(사용 안 함)이 있습니다. 새로 만들지 말고 기존 거래처를 다시 사용해주세요.`;
  }
  return vi
    ? `Đối tác "${partner.name}" đã được đăng ký. Hãy dùng hoặc liên kết đối tác hiện có.`
    : `이미 등록된 거래처 "${partner.name}"이 있습니다. 기존 거래처를 사용하거나 연결해주세요.`;
}
