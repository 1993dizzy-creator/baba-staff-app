export const partnerText = {
  ko: {
    title: "거래처 관리", description: "등록된 거래처와 결제조건을 관리합니다.", total: "전체 거래처", active: "사용 중", unspecified: "미지정", immediate: "선불결제", postpaid: "후불결제", inactive: "사용 안 함", search: "거래처명, 연락처, 담당자 검색", add: "거래처 등록", edit: "기본정보 수정", name: "거래처명", type: "업종/종류", subtype: "중분류", paymentMode: "결제방식", defaultFundAccount: "결제수단", noFundAccount: "미지정", contact: "담당자", phone: "전화번호", memo: "메모", ledger: "장부 거래처 연결", noLedger: "연결 안 함", save: "저장", saving: "저장 중…", details: "상세 보기", supply: "공급 품목", noSupply: "아직 연결된 품목이 없습니다.", itemsTab: "품목", priceChangesTab: "가격변동", priceChangesLoading: "가격변동 내역을 불러오는 중입니다.", priceChangesLoadFailed: "가격변동 내역을 불러오지 못했습니다. 다시 시도해주세요.", noPriceChanges: "최근 가격변동 내역이 없습니다.", history: "거래 내역", noHistory: "장부 연동 후 표시됩니다.", back: "거래처 목록", empty: "조건에 맞는 거래처가 없습니다.", loadFailed: "거래처를 불러오지 못했습니다.", saved: "저장했습니다.", duplicate: "같은 이름의 거래처가 이미 있습니다.", status: "상태",
  },
  vi: {
    title: "Quản lý đối tác", description: "Quản lý đối tác đã đăng ký và điều khoản thanh toán.", total: "Tất cả", active: "Đang dùng", unspecified: "Chưa xác định", immediate: "Thanh toán trước", postpaid: "Thanh toán sau", inactive: "Ngừng dùng", search: "Tìm tên, điện thoại, người liên hệ", add: "Thêm đối tác", edit: "Sửa thông tin", name: "Tên đối tác", type: "Ngành / loại", subtype: "Danh mục phụ", paymentMode: "Hình thức thanh toán", defaultFundAccount: "Phương thức thanh toán", noFundAccount: "Chưa chọn", contact: "Người liên hệ", phone: "Số điện thoại", memo: "Ghi chú", ledger: "Liên kết đối tác sổ sách", noLedger: "Không liên kết", save: "Lưu", saving: "Đang lưu…", details: "Xem chi tiết", supply: "Mặt hàng cung cấp", noSupply: "Chưa có mặt hàng được liên kết.", itemsTab: "Mặt hàng", priceChangesTab: "Biến động giá", priceChangesLoading: "Đang tải lịch sử biến động giá.", priceChangesLoadFailed: "Không thể tải lịch sử biến động giá. Vui lòng thử lại.", noPriceChanges: "Không có biến động giá gần đây.", history: "Lịch sử giao dịch", noHistory: "Sẽ hiển thị sau khi liên kết sổ sách.", back: "Danh sách đối tác", empty: "Không có đối tác phù hợp.", loadFailed: "Không thể tải đối tác.", saved: "Đã lưu.", duplicate: "Tên đối tác đã tồn tại.", status: "Trạng thái",
  },
} as const;

export const partnerTypeLabels = {
  food: { ko: "식자재", vi: "Thực phẩm" }, alcohol: { ko: "주류", vi: "Đồ uống có cồn" }, beverage: { ko: "음료", vi: "Đồ uống" }, consumable: { ko: "소모품", vi: "Vật tư tiêu hao" }, equipment: { ko: "장비", vi: "Thiết bị" }, service: { ko: "서비스", vi: "Dịch vụ" }, rent: { ko: "임대", vi: "Cho thuê" }, utilities: { ko: "공과금", vi: "Điện nước & gas" }, other: { ko: "기타", vi: "Khác" },
} as const;

// Partner-facing fund account labels are a separate, simplified Source of Truth keyed by
// ledger_fund_accounts.code -- never by id, and never showing the raw Ledger display_name
// (e.g. "Cho 개인계좌 (BABA 소유분)" stays internal to Ledger screens).
const FUND_ACCOUNT_LABELS: Record<string, { full: { ko: string; vi: string }; compact: { ko: string; vi: string } }> = {
  store_cash: { full: { ko: "현금", vi: "Tiền mặt" }, compact: { ko: "현금", vi: "Tiền mặt" } },
  baba_corporate_bank: { full: { ko: "법인계좌", vi: "Tài khoản công ty" }, compact: { ko: "법인", vi: "Công ty" } },
  cho_personal_custody: { full: { ko: "개인계좌", vi: "Tài khoản cá nhân" }, compact: { ko: "개인", vi: "Cá nhân" } },
};
const FUND_ACCOUNT_UNSET = { ko: "미지정", vi: "Chưa chọn" };
// Safe fallback for a future ledger_fund_accounts.code this map doesn't know about yet.
const FUND_ACCOUNT_FALLBACK = { full: { ko: "기타 계정", vi: "Tài khoản khác" }, compact: { ko: "기타", vi: "Khác" } };

export function formatPartnerFundAccount(code: string | null, lang: "ko" | "vi", variant: "full" | "compact" = "full") {
  if (code === null) return FUND_ACCOUNT_UNSET[lang];
  const entry = FUND_ACCOUNT_LABELS[code] ?? FUND_ACCOUNT_FALLBACK;
  return entry[variant][lang];
}

export function formatPartnerPaymentMode(paymentMode: string, lang: "ko" | "vi", variant: "full" | "compact" = "full") {
  const t = partnerText[lang];
  if (paymentMode === "unspecified") return t.unspecified;
  if (variant === "compact") return paymentMode === "immediate" ? (lang === "vi" ? "Trước" : "선불") : (lang === "vi" ? "Sau" : "후불");
  return paymentMode === "immediate" ? t.immediate : t.postpaid;
}

// e.g. "개인(선불)" / "법인(후불)" / "미지정(선불)". Item-count is appended separately by callers
// (formatInventoryItemCount), keeping this formatter focused on payment alone.
export function formatPartnerPaymentSummary(value: { paymentMode: string; defaultFundAccountCode?: string | null }, lang: "ko" | "vi") {
  const fund = formatPartnerFundAccount(value.defaultFundAccountCode ?? null, lang, "compact");
  const mode = formatPartnerPaymentMode(value.paymentMode, lang, "compact");
  return `${fund}(${mode})`;
}

type PartnerPolicyValue = {
  paymentMode: string;
  settlementMode?: string | null;
  settlementRule?: string | null;
  settlementDays?: number[] | null;
  defaultPaymentTermDays?: number | null;
  defaultFundAccountCode?: string | null;
};

const WEEKDAY_LABELS = {
  ko: ["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"],
  vi: ["Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy", "Chủ Nhật"],
} as const;

// Monthly day 0 is the month end ("말일"); it is listed after numbered days.
function formatMonthDays(days: number[], lang: "ko" | "vi") {
  const sorted = [...days].sort((a, b) => (a === 0 ? 32 : a) - (b === 0 ? 32 : b));
  return sorted.map(day => day === 0 ? (lang === "vi" ? "cuối tháng" : "말일") : (lang === "vi" ? `ngày ${day}` : `${day}일`)).join(lang === "vi" ? " và " : "·");
}

// Settlement term of a postpaid partner as a settlement reference (정산 기준), never a
// confirmed payment/overdue date. Returns null for non-postpaid partners.
export function formatPartnerSettlementTerm(value: PartnerPolicyValue, lang: "ko" | "vi"): string | null {
  if (value.paymentMode !== "postpaid") return null;
  const vi = lang === "vi";
  if (value.settlementMode === "ad_hoc") return vi ? "Thanh toán không định kỳ" : "비정기 정산";
  if (value.settlementMode !== "scheduled" || !value.settlementRule) return vi ? "Chưa đặt chu kỳ thanh toán" : "정산주기 미지정";
  const days = Array.isArray(value.settlementDays) ? value.settlementDays.filter(day => Number.isInteger(day)) : [];
  switch (value.settlementRule) {
    case "weekly": {
      const label = days.length !== 1 || days[0] < 1 || days[0] > 7 ? null : WEEKDAY_LABELS[lang][days[0] - 1];
      if (!label) return vi ? "Hàng tuần (chưa chọn thứ)" : "주간 정산(요일 미지정)";
      return vi ? `${label} hằng tuần (mốc thanh toán)` : `매주 ${label} 지급 기준`;
    }
    case "monthly_once":
      if (days.length !== 1) return vi ? "Mỗi tháng 1 lần (chưa chọn ngày)" : "월 1회 정산(날짜 미지정)";
      return vi ? `Chốt ${formatMonthDays(days, lang)} hằng tháng` : `매월 ${formatMonthDays(days, lang)} 정산`;
    case "monthly_twice":
      if (days.length !== 2) return vi ? "Mỗi tháng 2 lần (chưa chọn ngày)" : "월 2회 정산(날짜 미지정)";
      return vi ? `Chốt ${formatMonthDays(days, lang)} hằng tháng` : `매월 ${formatMonthDays(days, lang)} 정산`;
    case "net_days":
      return value.defaultPaymentTermDays == null
        ? (vi ? "Trả sau N ngày (chưa nhập)" : "매입 후 N일(일수 미지정)")
        : (vi ? `Trả sau ${value.defaultPaymentTermDays} ngày kể từ khi mua` : `매입 후 ${value.defaultPaymentTermDays}일 지급`);
    default:
      return vi ? "Chưa đặt chu kỳ thanh toán" : "정산주기 미지정";
  }
}

// One-line policy summary for partner lists and the settings form preview, e.g.
// "후불 · 매월 15일·말일 정산 · 법인 기본" / "선불/즉시 성향 · 법인 기본". The fund account is a
// suggested default only; nothing here claims an actual payment.
export function formatPartnerPolicySummary(value: PartnerPolicyValue, lang: "ko" | "vi") {
  const vi = lang === "vi";
  const mode = value.paymentMode === "immediate" ? (vi ? "Trả trước/ngay" : "선불/즉시 성향")
    : value.paymentMode === "postpaid" ? (vi ? "Trả sau" : "후불")
    : (vi ? "Chưa chọn cách thanh toán" : "결제방식 미지정");
  const fund = value.defaultFundAccountCode
    ? (vi ? `Mặc định: ${formatPartnerFundAccount(value.defaultFundAccountCode, lang, "compact")}` : `${formatPartnerFundAccount(value.defaultFundAccountCode, lang, "compact")} 기본`)
    : (vi ? "Chưa chọn tài khoản" : "계좌 미지정");
  return [mode, formatPartnerSettlementTerm(value, lang), fund].filter(Boolean).join(" · ");
}

const PARTNER_SUBTYPE_UNCLASSIFIED = { ko: "미분류", vi: "Chưa phân loại" };

// Same KO/VI fallback shape as keepingLiquorName (lib/bar/keeping-types.ts) and the
// inventory category KO/VI fallback: current-language field first, other language
// second, then a language-appropriate "unclassified" string. null/undefined subtype
// (or a subtype with both names blank, which the DB forbids but a stale client read
// could still send) safely resolves to "unclassified" too.
export function formatPartnerSubtypeName(subtype: { nameKo: string | null; nameVi: string | null } | null | undefined, lang: "ko" | "vi") {
  if (!subtype) return PARTNER_SUBTYPE_UNCLASSIFIED[lang];
  const label = lang === "vi" ? subtype.nameVi || subtype.nameKo : subtype.nameKo || subtype.nameVi;
  return label || PARTNER_SUBTYPE_UNCLASSIFIED[lang];
}
