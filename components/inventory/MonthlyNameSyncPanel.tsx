"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import InventoryDailySyncResults from "@/components/inventory/InventoryDailySyncResults";
import { fetchInventoryApi } from "@/lib/inventory/client-auth";
import type { InventoryDailySyncResult } from "@/lib/inventory/daily-sync-result";
import type { MonthlyInventoryNameSyncItem } from "@/lib/inventory/monthly-name-sync";
import type { InventoryDailySyncChange } from "@/lib/inventory/snapshot-name-sync";

type Lang = "ko" | "vi";

const text = {
  ko: {
    title: (month: string, count: number, days: number) => `${Number(month.slice(5))}월 입고정보 동기화 필요 ${count}개 · ${days}일`,
    none: (month: string) => `${Number(month.slice(5))}월 입고정보 동기화 필요 항목 없음`,
    loading: "월간 동기화 항목 확인 중...",
    loadFailed: "월간 동기화 항목을 확인하지 못했습니다.",
    syncAll: "일괄 동기화",
    processingAll: (count: number) => `${count}개 처리 중...`,
    confirmMonth: (month: string, count: number, days: number) =>
      `${Number(month.slice(5))}월 ${days}일, ${count}개 품목의 입고정보를 동기화합니다. 표시정보는 반영하고, 금액·거래처 변경은 기존 장부 확인 절차를 유지합니다.`,
    monthResult: (synced: number, review: number, failed: number, skipped: number) =>
      `일괄 동기화: ${synced}개 완료 · ${review}개 관리자 확인 필요 · ${failed}개 실패${skipped ? ` · ${skipped}개는 이미 처리되어 건너뜀` : ""}`,
    syncOne: "동기화",
    processing: "처리 중...",
    empty: "없음",
    quantityReview: "수량 변경은 별도 입고보정 필요",
    syncFailed: "입고정보를 동기화하지 못했습니다. 다시 시도해주세요.",
    result: (date: string, synced: number, review: number, failed: number) =>
      `${date} · ${synced}개 동기화 완료${review ? ` · ${review}개 관리자 확인 필요` : ""}${failed ? ` · ${failed}개 실패` : ""}`,
    fields: {
      item_name: "한글명", item_name_vi: "베트남어명", part: "파트", category: "카테고리", category_vi: "베트남어 카테고리",
      code: "코드", unit: "단위", purchase_price: "단가", supplier: "거래처", supplier_partner_id: "거래처 연결",
    },
  },
  vi: {
    title: (month: string, count: number, days: number) => `Tháng ${Number(month.slice(5))}: cần đồng bộ ${count} mặt hàng · ${days} ngày`,
    none: (month: string) => `Tháng ${Number(month.slice(5))}: không có mặt hàng cần đồng bộ`,
    loading: "Đang kiểm tra mục cần đồng bộ trong tháng...",
    loadFailed: "Không thể kiểm tra mục cần đồng bộ trong tháng.",
    syncAll: "Đồng bộ tất cả",
    processingAll: (count: number) => `Đang xử lý ${count} mặt hàng...`,
    confirmMonth: (month: string, count: number, days: number) =>
      `Đồng bộ thông tin nhập hàng của ${count} mặt hàng trong ${days} ngày của tháng ${Number(month.slice(5))}. Cập nhật thông tin hiển thị; thay đổi tiền và nhà cung cấp vẫn cần xác nhận trong sổ như hiện tại.`,
    monthResult: (synced: number, review: number, failed: number, skipped: number) =>
      `Đồng bộ tất cả: ${synced} hoàn tất · ${review} cần quản trị viên kiểm tra · ${failed} thất bại${skipped ? ` · ${skipped} đã xử lý trước nên bỏ qua` : ""}`,
    syncOne: "Đồng bộ",
    processing: "Đang xử lý...",
    empty: "Không có",
    quantityReview: "Thay đổi số lượng cần dùng quy trình điều chỉnh nhập hàng riêng",
    syncFailed: "Không thể đồng bộ thông tin nhập hàng. Vui lòng thử lại.",
    result: (date: string, synced: number, review: number, failed: number) =>
      `${date} · Đã đồng bộ ${synced} mặt hàng${review ? ` · ${review} mặt hàng cần quản trị viên kiểm tra` : ""}${failed ? ` · ${failed} mặt hàng thất bại` : ""}`,
    fields: {
      item_name: "Tên tiếng Hàn", item_name_vi: "Tên tiếng Việt", part: "Bộ phận", category: "Danh mục", category_vi: "Danh mục tiếng Việt",
      code: "Mã", unit: "Đơn vị", purchase_price: "Đơn giá", supplier: "Nhà cung cấp", supplier_partner_id: "Liên kết nhà cung cấp",
    },
  },
} as const;

const formatDay = (date: string, lang: Lang) => {
  const day = new Date(`${date}T00:00:00Z`);
  const weekday = day.toLocaleDateString(lang === "vi" ? "vi-VN" : "ko-KR", { weekday: "short", timeZone: "UTC" });
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))} (${weekday})`;
};

// Every 입고정보 동기화 item of the selected month in one place, grouped by business date.
// Read via the monthly GET. 동기화 posts the daily sync_item with the item's own businessDate;
// 일괄 동기화 posts sync_month with the listed rows, which the server re-checks and runs through
// the same per-item sync. Either way the existing ledger confirmation rules apply.
export default function MonthlyNameSyncPanel({ month, lang, reloadKey, onSynced }: {
  month: string; lang: Lang; reloadKey: number;
  onSynced: (businessDate: string) => void | Promise<void>;
}) {
  const t = text[lang];
  const [items, setItems] = useState<MonthlyInventoryNameSyncItem[]>([]);
  const [canSync, setCanSync] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [processingKey, setProcessingKey] = useState<string | null>(null);
  const [result, setResult] = useState<{ message: string; businessDate: string; results: InventoryDailySyncResult[] } | null>(null);
  const sequenceRef = useRef(0);
  const monthRef = useRef(month);
  monthRef.current = month;

  const load = useCallback(async (targetMonth: string) => {
    const sequence = ++sequenceRef.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetchInventoryApi(`/api/inventory/snapshot/name-sync?month=${encodeURIComponent(targetMonth)}`, { cache: "no-store" });
      const json = await response.json() as { ok?: boolean; month?: string; canSync?: boolean; monthlySyncItems?: MonthlyInventoryNameSyncItem[] };
      // A response for a month the user has already left never replaces the current list.
      if (sequence !== sequenceRef.current) return;
      if (!response.ok || !json.ok || json.month !== targetMonth) { setItems([]); setCanSync(false); setError(text[lang].loadFailed); return; }
      setItems(json.monthlySyncItems ?? []);
      setCanSync(json.canSync === true);
    } catch {
      if (sequence === sequenceRef.current) { setItems([]); setCanSync(false); setError(text[lang].loadFailed); }
    } finally {
      if (sequence === sequenceRef.current) setLoading(false);
    }
  }, [lang]);

  // A new month starts empty; a reload of the same month keeps the list until the answer arrives.
  const [shownMonth, setShownMonth] = useState(month);
  if (shownMonth !== month) {
    setShownMonth(month);
    setItems([]);
    setCanSync(false);
    setResult(null);
    setExpanded(false);
  }
  useEffect(() => {
    if (!month) return;
    void load(month);
    return () => { sequenceRef.current += 1; };
  }, [month, reloadKey, load]);

  // One request at a time across 동기화 and 일괄 동기화, even on a fast double click.
  const busyRef = useRef(false);
  const syncAll = async () => {
    if (busyRef.current || !items.length) return;
    const requestMonth = month;
    const targets = items.map(item => ({ businessDate: item.businessDate, itemId: item.itemId }));
    const days = new Set(targets.map(target => target.businessDate)).size;
    if (!window.confirm(t.confirmMonth(requestMonth, targets.length, days))) return;
    busyRef.current = true;
    setProcessingKey("all");
    setError("");
    setResult(null);
    try {
      const response = await fetchInventoryApi("/api/inventory/snapshot/name-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync_month", month: requestMonth, targets }),
      });
      const json = await response.json() as { ok?: boolean; month?: string; results?: (InventoryDailySyncResult & { businessDate: string })[]; syncedCount?: number; reviewRequiredCount?: number; failedCount?: number; skippedCount?: number };
      if (monthRef.current !== requestMonth) return;
      if (!response.ok || !json.ok) { setError(t.syncFailed); return; }
      setResult({
        message: t.monthResult(Number(json.syncedCount ?? 0), Number(json.reviewRequiredCount ?? 0), Number(json.failedCount ?? 0), Number(json.skippedCount ?? 0)),
        businessDate: `${requestMonth}-01`,
        results: json.results ?? [],
      });
      const dates = [...new Set((json.results ?? []).map(row => row.businessDate))];
      await Promise.all([load(requestMonth), ...dates.map(date => onSynced(date))]);
    } catch {
      if (monthRef.current === requestMonth) setError(t.syncFailed);
    } finally {
      busyRef.current = false;
      setProcessingKey(null);
    }
  };

  const sync = async (item: MonthlyInventoryNameSyncItem) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const requestMonth = month;
    setProcessingKey(`${item.businessDate}:${item.itemId}`);
    setError("");
    setResult(null);
    try {
      const response = await fetchInventoryApi("/api/inventory/snapshot/name-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync_item", business_date: item.businessDate, item_id: item.itemId }),
      });
      const json = await response.json() as { ok?: boolean; results?: InventoryDailySyncResult[]; syncedCount?: number; reviewRequiredCount?: number; failedCount?: number };
      if (monthRef.current !== requestMonth) return;
      if (!response.ok || !json.ok) { setError(t.syncFailed); return; }
      setResult({
        message: t.result(formatDay(item.businessDate, lang), Number(json.syncedCount ?? 0), Number(json.reviewRequiredCount ?? 0), Number(json.failedCount ?? 0)),
        businessDate: item.businessDate,
        results: json.results ?? [],
      });
      await Promise.all([load(requestMonth), onSynced(item.businessDate)]);
    } catch {
      if (monthRef.current === requestMonth) setError(t.syncFailed);
    } finally {
      busyRef.current = false;
      setProcessingKey(null);
    }
  };

  if (!month) return null;
  const dates = [...new Set(items.map(item => item.businessDate))];
  const formatValue = (change: InventoryDailySyncChange, value: string | number | null | undefined) => {
    if (value === null || value === undefined || String(value).trim() === "") return t.empty;
    return change.field === "purchase_price" ? `${Number(value).toLocaleString()} ₫` : String(value);
  };
  const itemLabel = (item: MonthlyInventoryNameSyncItem) =>
    (lang === "vi" ? item.currentItemNameVi || item.currentItemName : item.currentItemName || item.currentItemNameVi) || `#${item.itemId}`;

  return (
    <section data-testid="monthly-name-sync" data-month={month} style={{ background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: 14, padding: "10px 12px", marginBottom: 12, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {/* 일괄 동기화 sits left of the title; shown only to sync roles when the month has rows. */}
        {canSync && items.length ? <button type="button" data-testid="monthly-name-sync-all" disabled={processingKey !== null || loading} onClick={() => void syncAll()}
          style={{ flexShrink: 0, padding: "6px 10px", minHeight: 30, borderRadius: 8, border: "1px solid #1d4ed8", background: "#1d4ed8", color: "#fff",
            fontSize: 11, fontWeight: 800, whiteSpace: "nowrap", cursor: processingKey !== null || loading ? "not-allowed" : "pointer", opacity: processingKey !== null && processingKey !== "all" || loading ? 0.6 : 1 }}>
          {processingKey === "all" ? t.processingAll(items.length) : t.syncAll}
        </button> : null}
        <button type="button" aria-expanded={expanded} disabled={!items.length} onClick={() => setExpanded(current => !current)}
          style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, border: "none", background: "transparent", padding: 0, cursor: items.length ? "pointer" : "default", textAlign: "left" }}>
          <span data-testid="monthly-name-sync-title" style={{ fontSize: 13, fontWeight: 900, color: items.length ? "#334155" : "#64748b", minWidth: 0, overflowWrap: "anywhere" }}>
            📅 {loading && !items.length ? t.loading : items.length ? t.title(month, items.length, dates.length) : t.none(month)}
          </span>
          {items.length ? <span aria-hidden="true" style={{ fontSize: 14, fontWeight: 900, color: "#334155", flexShrink: 0 }}>{expanded ? "⌃" : "⌄"}</span> : null}
        </button>
      </div>
      {error ? <div role="alert" style={{ fontSize: 12, fontWeight: 700, color: "#b91c1c" }}>{error}</div> : null}
      {result ? <div role="status" data-testid="monthly-name-sync-result" style={{ fontSize: 12, fontWeight: 700, color: "#1d4ed8" }}>
        {result.message}
        <InventoryDailySyncResults results={result.results} businessDate={result.businessDate} lang={lang} />
      </div> : null}
      {expanded && items.length ? <div style={{ display: "grid", gap: 10 }}>
        {dates.map(date => (
          <div key={date} data-testid={`monthly-name-sync-date-${date}`} style={{ display: "grid", gap: 6 }}>
            <strong style={{ fontSize: 12, color: "#0f172a" }}>{formatDay(date, lang)}</strong>
            {items.filter(item => item.businessDate === date).map(item => {
              const key = `${item.businessDate}:${item.itemId}`;
              const busy = processingKey !== null;
              return (
                <div key={key} data-testid={`monthly-name-sync-item-${key}`} data-business-date={item.businessDate} data-item-id={item.itemId}
                  style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "end", gap: 8, border: "1px solid #e2e8f0", background: "#fff", borderRadius: 10, padding: "6px 8px" }}>
                  <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
                    <span style={{ fontSize: 12, fontWeight: 800, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{itemLabel(item)}</span>
                    {item.changes.map(change => {
                      const from = formatValue(change, change.displayFrom !== undefined ? change.displayFrom : change.from);
                      const to = formatValue(change, change.displayTo !== undefined ? change.displayTo : change.to);
                      return (
                        <div key={`${change.field}:${String(change.from)}:${String(change.to)}`} title={`${t.fields[change.field]}  ${from} → ${to}`}
                          style={{ minWidth: 0, display: "flex", alignItems: "baseline", gap: 5, overflow: "hidden", whiteSpace: "nowrap", fontSize: 11 }}>
                          <span style={{ flexShrink: 0, color: "#94a3b8", fontSize: 10 }}>{t.fields[change.field]}</span>
                          <span style={{ minWidth: 0, maxWidth: "42%", overflow: "hidden", textOverflow: "ellipsis", color: "#64748b" }}>{from}</span>
                          <span aria-hidden="true" style={{ flexShrink: 0, color: "#94a3b8" }}>→</span>
                          <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", color: "#1f2937", fontWeight: 800 }}>{to}</span>
                        </div>
                      );
                    })}
                    {item.quantityReviewRequired ? <span style={{ fontSize: 11, fontWeight: 800, color: "#b45309" }}>{t.quantityReview}</span> : null}
                  </div>
                  {canSync ? <button type="button" disabled={busy || loading} onClick={() => void sync(item)}
                    style={{ flexShrink: 0, padding: "6px 10px", minHeight: 28, borderRadius: 8, border: `1px solid ${busy ? "#d1d5db" : "#2563eb"}`,
                      background: processingKey === key ? "#1d4ed8" : busy ? "#f3f4f6" : "#2563eb", color: busy && processingKey !== key ? "#6b7280" : "#fff",
                      fontSize: 11, fontWeight: 800, cursor: busy ? "not-allowed" : "pointer" }}>
                    {processingKey === key ? t.processing : t.syncOne}
                  </button> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div> : null}
    </section>
  );
}
