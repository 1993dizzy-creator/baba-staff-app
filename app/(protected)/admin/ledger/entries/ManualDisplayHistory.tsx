"use client";

import { useEffect, useState } from "react";
import type { ManualDisplayHistoryEntry } from "@/lib/ledger/manual-display-history";
import styles from "./entries.module.css";

function formatEditedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? "";
  return `${part("month")}.${part("day")} ${part("hour")}:${part("minute")}`;
}

export function ManualDisplayHistoryList({
  history,
  lang,
}: {
  history: ManualDisplayHistoryEntry[];
  lang: "ko" | "vi";
}) {
  if (history.length === 0) return null;
  const vi = lang === "vi";
  return (
    <details className={styles.manualDisplayHistory}>
      <summary>{vi ? "Lịch sử chỉnh sửa · " + history.length + " mục" : "수정 이력 · " + history.length + "건"}</summary>
      <div className={styles.manualDisplayHistoryList}>
        {history.map((item, index) => {
          const titleChanged = item.beforeTitle !== item.afterTitle;
          const memoChanged = (item.beforeMemo ?? "") !== (item.afterMemo ?? "");
          const amountChanged = item.beforeAmount !== undefined && item.afterAmount !== undefined && item.beforeAmount !== item.afterAmount;
          const bothChanged = titleChanged && memoChanged;
          const changeTitle = amountChanged && (titleChanged || memoChanged)
            ? (vi ? "Đã sửa giao dịch" : "거래 수정")
            : amountChanged
              ? (vi ? "Đã sửa số tiền" : "금액 수정")
              : bothChanged
            ? (vi ? "Đã sửa tiêu đề và ghi chú" : "제목·메모 수정")
            : titleChanged
              ? (vi ? "Đã sửa tiêu đề" : "제목 수정")
              : (vi ? "Đã sửa ghi chú" : "메모 수정");
          return (
            <article key={item.createdAt + ":" + index} className={styles.manualDisplayHistoryItem}>
              <div className={styles.manualDisplayHistoryHeader}>
                <strong className={styles.manualDisplayHistoryCardTitle}>{changeTitle}</strong>
                <div className={styles.manualDisplayHistoryMeta}>
                  <span className={styles.manualDisplayHistoryReason} title={item.reason}>{item.reason}</span>
                  <span className={styles.manualDisplayHistoryByline}>
                    <strong>{item.actorName ?? (vi ? "Không rõ" : "사용자 확인 불가")}</strong>
                    <span aria-hidden="true">·</span>
                    <time dateTime={item.createdAt}>{formatEditedAt(item.createdAt)}</time>
                  </span>
                </div>
              </div>
              {titleChanged ? (
                <div className={styles.manualDisplayHistoryChange}>
                  <span className={styles.manualDisplayHistoryBefore}>{item.beforeTitle || (vi ? "Không có" : "없음")}</span>
                  <span className={styles.manualDisplayHistoryArrow} aria-hidden="true">↓</span>
                  <span className={styles.manualDisplayHistoryAfter}>{item.afterTitle || (vi ? "Không có" : "없음")}</span>
                </div>
              ) : null}
              {memoChanged ? (
                <div className={styles.manualDisplayHistoryChange}>
                  <span className={styles.manualDisplayHistoryBefore}>{item.beforeMemo || (vi ? "Không có" : "없음")}</span>
                  <span className={styles.manualDisplayHistoryArrow} aria-hidden="true">↓</span>
                  <span className={styles.manualDisplayHistoryAfter}>{item.afterMemo || (vi ? "Không có" : "없음")}</span>
                </div>
              ) : null}
              {amountChanged ? (
                <div className={styles.manualDisplayHistoryChange}>
                  <span className={styles.manualDisplayHistoryBefore}>{item.beforeAmount?.toLocaleString("vi-VN")} ₫</span>
                  <span className={styles.manualDisplayHistoryArrow} aria-hidden="true">↓</span>
                  <span className={styles.manualDisplayHistoryAfter}>{item.afterAmount?.toLocaleString("vi-VN")} ₫</span>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </details>
  );
}

export default function ManualDisplayHistory({
  transactionId,
  lang,
}: {
  transactionId: number;
  lang: "ko" | "vi";
}) {
  const [history, setHistory] = useState<ManualDisplayHistoryEntry[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/admin/ledger/transactions/" + transactionId + "/display-history", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("DISPLAY_HISTORY_LOAD_FAILED");
        const body = await response.json() as { history?: ManualDisplayHistoryEntry[] };
        if (!controller.signal.aborted) setHistory(Array.isArray(body.history) ? body.history : []);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    })();
    return () => controller.abort();
  }, [transactionId]);

  if (error) return <p className={styles.error} role="alert">{lang === "vi" ? "Không thể tải lịch sử chỉnh sửa." : "수정 이력을 불러오지 못했습니다."}</p>;
  if (history === null) return null;
  return <ManualDisplayHistoryList history={history} lang={lang} />;
}

