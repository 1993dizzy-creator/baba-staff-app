import { shortLedgerAccountName } from "./entry-display-account.ts";
import type { LedgerEntry } from "./entries.ts";

// List title only. The original memo, source key and audit text are never
// changed: the detail sheet shows the full memo and search still reads it.
const SHORT_TITLE_LENGTH = 24;

// A manual balance adjustment keeps a short user title as is; a long accounting
// memo becomes "<account> <kind>", e.g. 현금 반올림 조정 / 현금 정산차이.
export function balanceAdjustmentListTitle(entry: Pick<LedgerEntry, "userAdjustment" | "title" | "memo" | "accountName">, lang: "ko" | "vi") {
  if (entry.userAdjustment !== "balance") return null;
  const title = entry.title.trim();
  if (title && !/\r?\n/.test(title) && title.length <= SHORT_TITLE_LENGTH) return title;
  const text = `${entry.memo ?? ""} ${title}`;
  const vi = lang === "vi";
  const kind = /반올림|잔돈|rounding|làm\s*tròn/i.test(text) ? (vi ? "Làm tròn" : "반올림 조정")
    : /정산\s*오류|lỗi\s*đối\s*soát/i.test(text) ? (vi ? "Lỗi đối soát" : "정산오류")
    : (vi ? "Chênh lệch đối soát" : "정산차이");
  const account = entry.accountName ? shortLedgerAccountName(entry.accountName, lang) : "";
  if (!account) return kind;
  return vi ? `${kind} ${account === "Tiền mặt" ? "tiền mặt" : account}` : `${account} ${kind}`;
}
