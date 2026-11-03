import type { LedgerSyncResult } from "./ledger-sync-contract";

export type QuickSaveIntent = {
  itemId: number;
  expectedQuantity: number;
  expectedUpdatedAt: string | null;
  payload: { quantity: number; supplier?: string; supplierPartnerId?: number | null; purchase_price?: number | null; note?: string };
  reason: string;
  purchaseBilledAmount?: { mode: string; amount?: number | null };
};
type Row = Record<string, unknown>;
export type QuickSaveSnapshot<T> = { ok?: boolean; data?: T[]; auditLogs?: Row[]; actorId?: number };
export type QuickSaveReply = { ok?: boolean; error?: string; code?: string; writeState?: string; ledgerSync?: LedgerSyncResult; blockReason?: string; candidateCount?: number; candidateCountExact?: boolean };
const qty = (value: unknown) => value == null || value === "" ? NaN : Math.round(Number(value) * 1000) / 1000;
const nullableNumber = (value: unknown) => value == null ? null : Number(value);

// Quantity alone never proves that this operation committed. Require one recent
// audit from this actor with the same transition and receipt details, plus the
// current row. Missing, truncated, ambiguous or subsequently changed evidence
// remains unresolved. No DB schema or audit contents are changed for recovery.
export function confirmedQuickSave<T extends { id: number; quantity?: unknown; updated_at?: string | null }>(intent: QuickSaveIntent, snapshot: QuickSaveSnapshot<T>) {
  const item = snapshot.data?.find(row => row.id === intent.itemId);
  const version = Date.parse(intent.expectedUpdatedAt ?? "");
  if (!snapshot.ok || !item || !Number.isFinite(version) || !Number.isSafeInteger(snapshot.actorId) ||
      qty(item.quantity) !== intent.payload.quantity || !(Date.parse(item.updated_at ?? "") > version) || !snapshot.auditLogs?.length) return null;
  if (snapshot.auditLogs.length >= 20 && !snapshot.auditLogs.some(log => Date.parse(String(log.created_at)) <= version)) return null;
  const matches = snapshot.auditLogs.filter(log => {
    if (Number(log.item_id) !== intent.itemId || Number(log.source_actor_user_id) !== snapshot.actorId ||
        log.source !== "quick_save" || log.reason !== intent.reason || !(Date.parse(String(log.created_at)) > version) ||
        qty(log.prev_quantity) !== intent.expectedQuantity || qty(log.new_quantity) !== intent.payload.quantity ||
        qty(log.change_quantity) !== qty(intent.payload.quantity - intent.expectedQuantity)) return false;
    if (intent.reason === "purchase") {
      if (log.new_supplier !== intent.payload.supplier ||
          nullableNumber(log.purchase_supplier_partner_id) !== (intent.payload.supplierPartnerId ?? null) ||
          nullableNumber(log.new_purchase_price) !== (intent.payload.purchase_price ?? null)) return false;
      if (intent.payload.quantity < intent.expectedQuantity && log.correction_of_inventory_log_id == null) return false;
      if (intent.payload.quantity > intent.expectedQuantity && intent.purchaseBilledAmount &&
          ((log.billed_amount_mode ?? "auto") !== intent.purchaseBilledAmount.mode ||
           nullableNumber(log.billed_amount) !== (intent.purchaseBilledAmount.amount ?? null))) return false;
    }
    return intent.reason !== "other" || log.new_note === intent.payload.note;
  });
  if (matches.length !== 1 || Number(matches[0].id) !== Number(snapshot.auditLogs[0].id)) return null;
  return { item, inventoryLogId: Number(matches[0].id) };
}

export const quickSaveRecoveryText = (lang: "ko" | "vi") => lang === "vi" ? {
  checking: "Đang kiểm tra tồn kho và nhật ký. Không lưu lại trong lúc chờ.",
  unknown: "Chưa xác minh được lần lưu trước. Dữ liệu bạn nhập được giữ nguyên. Hãy kiểm tra trạng thái hoặc nhờ quản lý; không nhập lại phiếu này.",
  check: "Kiểm tra trạng thái lưu", timeout: "Cơ sở dữ liệu quá thời gian xử lý. Đang kiểm tra kết quả lưu.",
  network: "Chưa nhận được xác nhận lưu thành công từ máy chủ. Đang kiểm tra kết quả thực tế.",
  rejected: "Đã xác nhận lần lưu không được thực hiện. Dữ liệu bạn nhập được giữ nguyên; có thể thử lại thủ công.",
} : {
  checking: "실제 재고와 감사로그를 확인 중입니다. 확인 중에는 다시 저장하지 마세요.",
  unknown: "이전 저장의 완료 여부를 확인하지 못했습니다. 입력값은 유지했습니다. 상태를 다시 확인하거나 관리자에게 문의하세요. 같은 입고를 다시 등록하지 마세요.",
  check: "저장 상태 다시 확인", timeout: "DB 처리 시간이 초과되어 실제 저장 결과를 확인합니다.",
  network: "저장 완료 응답을 확인할 수 없어 실제 저장 여부를 확인합니다.",
  rejected: "저장되지 않은 것을 확인했습니다. 입력값은 유지했으며 직접 다시 시도할 수 있습니다.",
};

// A form retains this instance until success or a definitive rejection. Repeated
// clicks after an uncertain response only perform the original read, never PATCH.
export function createQuickSaveRecovery<T extends { id: number; quantity?: unknown; updated_at?: string | null }>(intent: QuickSaveIntent) {
  let busy = false;
  let uncertain = false;
  let rolledBack = false;
  let timedOut = false;
  let failureReply: QuickSaveReply = {};
  let settled: { kind: "saved"; item?: T; reply: QuickSaveReply } | null = null;
  return {
    async run(write: () => Promise<Response>, read: () => Promise<QuickSaveSnapshot<T>>, onChecking = () => {}) {
      if (busy) return { kind: "busy" } as const;
      if (settled) return settled;
      busy = true;
      try {
        if (!uncertain) {
          try {
            const response = await write();
            const reply: QuickSaveReply = await response.json();
            if (!reply || typeof reply !== "object") throw new Error("Invalid save reply");
            if (response.ok && reply.ok) return settled = { kind: "saved", reply };
            if (response.status < 500 && response.status !== 408 && !response.ok) return { kind: "rejected", reply } as const;
            rolledBack = reply.writeState === "not_saved";
            timedOut = reply.error === "inventory_save_timeout";
            failureReply = reply;
          } catch { /* Transport loss is not proof of rollback. */ }
          uncertain = true;
        }
        onChecking();
        try {
          const snapshot = await read();
          const confirmed = confirmedQuickSave(intent, snapshot);
          if (confirmed) return settled = { kind: "saved", item: confirmed.item, reply: { ok: true,
            ...(intent.reason === "purchase" ? { ledgerSync: { status: "pending", code: "VERIFY_LEDGER_STATUS", inventoryLogId: confirmed.inventoryLogId } as LedgerSyncResult } : {}) } };
          const item = snapshot.data?.find(row => row.id === intent.itemId);
          if (rolledBack && snapshot.ok && Array.isArray(snapshot.auditLogs) && item && intent.expectedUpdatedAt &&
              item.updated_at === intent.expectedUpdatedAt && qty(item.quantity) === intent.expectedQuantity) return { kind: "not_saved", reply: failureReply } as const;
        } catch { /* Remain blocked even if the status read itself times out. */ }
        return { kind: "uncertain", timedOut } as const;
      } finally { busy = false; }
    },
  };
}
