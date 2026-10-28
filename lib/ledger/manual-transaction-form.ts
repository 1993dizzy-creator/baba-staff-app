// Shared state and rules of the manual income / expense / transfer form, used by the
// "장부 내역 추가" sheet and the full edit of an existing manual transaction.

export type ManualFormType = "income" | "expense" | "transfer";

export type ManualFormState = {
  type: ManualFormType;
  date: string; // YYYY-MM-DD (Asia/Ho_Chi_Minh wall clock)
  time: string; // HH:mm
  amount: string; // digits only
  partnerId: string; // business partner id ('' = none); expense only
  categoryId: string; // income / expense
  fromAccountId: string; // expense / transfer
  toAccountId: string; // income / transfer
  title: string; // display title override ('' = default)
  memo: string;
};

// What the ledger API exposes for an editable manual row (see buildLedgerEntries).
export type ManualEditSource = {
  type: ManualFormType;
  occurredAt: string;
  amount: number;
  categoryId: number | null;
  partyId: number | null;
  fromAccountId: number | null;
  toAccountId: number | null;
  title: string | null;
  memo: string | null;
  updatedAt: string;
};

export type ManualPartner = { id: number; ledgerPartyId: number; manualExpenseCategoryId: number | null };

export type ManualChanges = Partial<{
  occurredAt: string; type: ManualFormType; amount: number; categoryId: number | null; partyId: number | null;
  fromAccountId: number | null; toAccountId: number | null; title: string | null; memo: string | null;
}>;

const pad = (value: number) => String(value).padStart(2, "0");

// Wall-clock date and time in Asia/Ho_Chi_Minh (UTC+7, no DST).
export function vietnamDateTime(iso: string) {
  const local = new Date(Date.parse(iso) + 7 * 3_600_000);
  return {
    date: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
    time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
  };
}

export const manualOccurredAt = (date: string, time: string) => `${date}T${time}:00+07:00`;

// Ledger business date: 03:00 cut-off (00:00–02:59 belongs to the previous day).
export function manualBusinessDate(date: string, time: string) {
  if (time >= "03:00") return date;
  const previous = new Date(`${date}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

export function manualFormFromSource(source: ManualEditSource, partners: readonly ManualPartner[]): ManualFormState {
  const { date, time } = vietnamDateTime(source.occurredAt);
  const partner = source.partyId == null ? undefined : partners.find(row => row.ledgerPartyId === source.partyId);
  return {
    type: source.type, date, time, amount: String(source.amount),
    partnerId: partner ? String(partner.id) : "",
    categoryId: source.categoryId == null ? "" : String(source.categoryId),
    fromAccountId: source.fromAccountId == null ? "" : String(source.fromAccountId),
    toAccountId: source.toAccountId == null ? "" : String(source.toAccountId),
    title: source.title ?? "", memo: source.memo ?? "",
  };
}

export type ManualFormError = "amount" | "date" | "category" | "fromAccount" | "toAccount" | "sameAccount" | "unchanged";

const id = (value: string) => (value ? Number(value) : null);

// Only what differs from the original is sent; a type change also sends every field that
// type needs, so the server never mixes the old type's accounts or category with the new one.
export function manualFormChanges(source: ManualEditSource, initial: ManualFormState, draft: ManualFormState, partners: readonly ManualPartner[]):
  { changes: ManualChanges; error: null } | { changes: null; error: ManualFormError } {
  if (!/^[0-9]+$/.test(draft.amount) || !Number.isSafeInteger(Number(draft.amount)) || Number(draft.amount) <= 0) return { changes: null, error: "amount" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || !/^\d{2}:\d{2}$/.test(draft.time)) return { changes: null, error: "date" };
  if (draft.type !== "transfer" && !draft.categoryId) return { changes: null, error: "category" };
  if (draft.type !== "income" && !draft.fromAccountId) return { changes: null, error: "fromAccount" };
  if (draft.type !== "expense" && !draft.toAccountId) return { changes: null, error: "toAccount" };
  if (draft.type === "transfer" && draft.fromAccountId === draft.toAccountId) return { changes: null, error: "sameAccount" };
  const typeChanged = draft.type !== initial.type;
  const changes: ManualChanges = {};
  if (draft.date !== initial.date || draft.time !== initial.time) changes.occurredAt = manualOccurredAt(draft.date, draft.time);
  if (typeChanged) changes.type = draft.type;
  if (Number(draft.amount) !== source.amount) changes.amount = Number(draft.amount);
  if (draft.type !== "transfer" && (typeChanged || draft.categoryId !== initial.categoryId)) changes.categoryId = id(draft.categoryId);
  if (draft.type === "expense" && draft.partnerId !== initial.partnerId) {
    changes.partyId = draft.partnerId ? partners.find(row => String(row.id) === draft.partnerId)?.ledgerPartyId ?? null : null;
  }
  if (draft.type !== "income" && (typeChanged || draft.fromAccountId !== initial.fromAccountId)) changes.fromAccountId = id(draft.fromAccountId);
  if (draft.type !== "expense" && (typeChanged || draft.toAccountId !== initial.toAccountId)) changes.toAccountId = id(draft.toAccountId);
  if (draft.title.trim() !== initial.title.trim()) changes.title = draft.title.trim() || null;
  if (draft.memo.trim() !== initial.memo.trim()) changes.memo = draft.memo.trim() || null;
  return Object.keys(changes).length ? { changes, error: null } : { changes: null, error: "unchanged" };
}

const MESSAGES: Record<string, [string, string]> = {
  amount: ["금액은 양의 정수로 입력해주세요.", "Số tiền phải là số nguyên dương."],
  date: ["거래 일시를 확인해주세요.", "Hãy kiểm tra ngày giờ giao dịch."],
  category: ["카테고리를 선택해주세요.", "Hãy chọn danh mục."],
  fromAccount: ["출금 계정을 선택해주세요.", "Hãy chọn tài khoản chi."],
  toAccount: ["입금 계정을 선택해주세요.", "Hãy chọn tài khoản nhận."],
  sameAccount: ["출금 계정과 입금 계정이 같습니다.", "Tài khoản chi và nhận giống nhau."],
  unchanged: ["변경된 내용이 없습니다.", "Không có nội dung nào thay đổi."],
  reason: ["사유를 입력해주세요.", "Vui lòng nhập lý do."],
  MONTH_CLOSED: ["마감된 월의 거래이거나 마감된 월로 옮기려고 합니다. 마감을 다시 열기 전에는 바꿀 수 없습니다.", "Giao dịch thuộc tháng đã chốt hoặc chuyển sang tháng đã chốt."],
  STALE: ["다른 곳에서 먼저 수정되었습니다. 최신 내용을 불러온 뒤 다시 시도해주세요.", "Giao dịch vừa được sửa ở nơi khác. Hãy tải lại rồi thử lại."],
  ALREADY_CANCELLED: ["이미 삭제된 거래입니다.", "Giao dịch đã bị xóa."],
  LINKED_TRANSACTION: ["지급·미납·카드정산·투자금 등과 연결된 거래라 여기서 바꿀 수 없습니다. 연결된 화면의 정정 절차를 이용하세요.", "Giao dịch đã liên kết (thanh toán, công nợ, thẻ, vốn…). Hãy sửa ở màn hình liên quan."],
  SPECIAL_TRANSACTION: ["자동 연동 정보가 있는 거래라 여기서 바꿀 수 없습니다.", "Giao dịch có dữ liệu liên kết tự động nên không thể sửa tại đây."],
  ALREADY_CORRECTED: ["정정 거래가 이미 있는 거래입니다.", "Giao dịch đã có bút toán điều chỉnh."],
  UNSUPPORTED_TRANSACTION: ["원천 모듈에서 정정해야 하는 거래입니다.", "Giao dịch này phải sửa ở mô-đun gốc."],
  INVALID_MOVEMENTS: ["계정 이동 기록이 예상과 달라 자동 수정을 막았습니다.", "Bản ghi tài khoản không như dự kiến nên đã chặn sửa tự động."],
  INVALID_CATEGORY: ["카테고리가 거래 유형과 맞지 않거나 사용 중지되었습니다.", "Danh mục không khớp loại giao dịch hoặc đã ngừng dùng."],
  INVALID_ACCOUNTS: ["계정을 확인해주세요.", "Hãy kiểm tra tài khoản."],
  INVALID_PARTY: ["거래처는 지출에만 지정할 수 있고 사용 중이어야 합니다.", "Đối tác chỉ dùng cho khoản chi và phải đang hoạt động."],
  FORBIDDEN: ["owner/master만 수정·삭제할 수 있습니다.", "Chỉ owner/master được sửa/xóa."],
};

export function manualFormMessage(code: string, lang: "ko" | "vi") {
  const message = MESSAGES[code];
  return message ? message[lang === "vi" ? 1 : 0] : `${lang === "vi" ? "Không thể lưu." : "저장하지 못했습니다."} ${code}`;
}
