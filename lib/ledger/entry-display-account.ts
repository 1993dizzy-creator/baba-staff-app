export function shortLedgerAccountName(accountName: string, lang: "ko" | "vi") {
  if (accountName === "매장 현금") return lang === "vi" ? "Tiền mặt" : "현금";
  if (accountName === "BABA 법인계좌") return lang === "vi" ? "Công ty" : "법인";
  if (accountName === "미지급") return lang === "vi" ? "Công nợ" : "미지급";
  if (accountName === "개인(Vương)" || accountName === "Vương 개인계좌 (BABA 소유분)") return "Vương";
  if (accountName === "개인(Cho)" || accountName === "Cho 개인계좌 (BABA 소유분)") return "Cho";
  return accountName;
}

export function accountTransferBadgeLabel(
  route: { fromAccountName: string; toAccountName: string },
  lang: "ko" | "vi",
) {
  return `${shortLedgerAccountName(route.fromAccountName, lang)} → ${shortLedgerAccountName(route.toAccountName, lang)}`;
}
