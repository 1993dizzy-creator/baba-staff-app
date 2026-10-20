export type KegSafetyPreview = {
    ok: true; dryRun: true; writesPerformed: false;
    previewToken: string; itemId: number; activeSessionId: number | null; previousSessionId: number | null;
    oldAt: string | null; replacementAt: string; businessDate: string;
    currentQuantity: number; projectedQuantity: number; capacityMl: number;
    storedSoldMl: number | null; storedLossMl: number | null; posBeforeSoldMl: number | null; posBeforeLossMl: number | null;
    soldDeltaMl: number | null; lossDeltaMl: number | null; priorDriftMl: number | null; snapshotMismatch: boolean;
    warnings: string[];
} & (
    { action: "replace"; soldMl: number; lossMl: number; overageMl: number; usagePercent: number } |
    { action: "edit-start"; soldMl: number | null; lossMl: number | null; overageMl: number | null; usagePercent: number | null }
);
export function kegSafetyError(code: string, vi: boolean) {
    const messages: Record<string, [string, string]> = {
        KEG_STORED_SNAPSHOT_MISMATCH: ["저장된 판매·미판매량과 현재 POS가 다릅니다. 과거 값을 덮어쓰지 않고 저장을 차단했습니다. 관리자 확인이 필요합니다.", "Số bán/chưa bán đã lưu khác POS hiện tại. Đã chặn ghi đè lịch sử. Cần quản trị viên kiểm tra."],
        KEG_STALE_PREVIEW: ["세션 또는 POS가 변경됐습니다. 미리보기를 다시 확인해 주세요.", "Phiên hoặc POS đã thay đổi. Hãy xem trước lại."],
        KEG_QUANTITY_CONFLICT: ["재고가 변경됐습니다. 새로고침 후 다시 확인해 주세요.", "Tồn kho đã thay đổi. Hãy tải lại và kiểm tra."],
        KEG_IDEMPOTENCY_CONFLICT: ["같은 요청 번호로 다른 변경을 저장할 수 없습니다. 결과를 확인한 뒤 다시 열어 주세요.", "Không thể dùng cùng mã yêu cầu cho thay đổi khác. Kiểm tra kết quả rồi mở lại."],
        KEG_TIME_CONFLICT: ["이전 세션 시작보다 빠른 시각은 선택할 수 없습니다.", "Không thể chọn thời gian trước khi phiên trước bắt đầu."],
        KEG_FUTURE_TIME: ["미래 시간은 선택할 수 없습니다.", "Không thể chọn thời gian tương lai."],
        KEG_BUSINESS_DATE_MISMATCH: ["선택한 시각과 영업일이 일치하지 않습니다. 베트남 현지 시각의 오전 3시 기준 영업일을 확인해 주세요.", "Thời gian đã chọn không khớp ngày kinh doanh. Kiểm tra ngày theo giờ Việt Nam, với mốc 03:00."],
        KEG_BOUNDARY_CONFLICT: ["이전 세션 연결·경계가 일치하지 않습니다. 관리자 확인이 필요합니다.", "Liên kết hoặc ranh giới phiên trước không khớp. Cần quản trị viên kiểm tra."],
        KEG_REASON_REQUIRED: ["변경 사유를 입력해 주세요.", "Vui lòng nhập lý do thay đổi."],
        KEG_CONFIRMATION_REQUIRED: ["단시간·0L 교체를 재확인해 주세요.", "Vui lòng xác nhận lại việc thay keg trong thời gian ngắn hoặc bán 0L."],
        KEG_INSUFFICIENT_QUANTITY: ["교체할 Keg 재고가 부족합니다.", "Không đủ tồn kho Keg để thay."],
        KEG_SAFETY_UNAVAILABLE: ["안전 확인 기능을 사용할 수 없습니다. 저장되지 않았습니다. 관리자에게 문의해 주세요.", "Không thể kiểm tra an toàn. Chưa lưu thay đổi. Vui lòng liên hệ quản trị viên."],
    };
    return messages[code]?.[vi ? 1 : 0] ?? (vi ? "Không thể lưu. Kiểm tra thông tin và xem trước lại." : "저장하지 못했습니다. 입력과 미리보기를 다시 확인해 주세요.");
}

export const kegSafetyText = {
    ko: { reason: "변경 사유", confirm: "단시간 또는 판매량 0L 교체를 확인했습니다", short: "5분 이내 교체 또는 판매량 0L입니다. 실제 교체인지 확인하고 사유를 남겨 주세요.", previewFirst: "미리보기를 확인한 뒤 저장해 주세요.", oldTime: "기존 시각", newTime: "변경 시각", saved: "저장된 이전 세션", current: "현재 POS (기존 구간)", proposed: "변경 후 이전 세션", delta: "변경으로 인한 차이", sale: "판매", unsold: "미판매", drift: "기존 저장값과 POS 차이", noPrevious: "연결된 이전 종료 세션이 없습니다. 최초 세션 시작 시각만 변경됩니다." },
    vi: { reason: "Lý do thay đổi", confirm: "Đã xác nhận thay keg trong thời gian ngắn hoặc bán 0L", short: "Thay trong 5 phút hoặc bán 0L. Xác nhận thay thực tế và ghi lý do.", previewFirst: "Vui lòng xem trước rồi mới lưu.", oldTime: "Thời gian cũ", newTime: "Thời gian mới", saved: "Phiên trước đã lưu", current: "POS hiện tại (khoảng cũ)", proposed: "Phiên trước sau thay đổi", delta: "Chênh lệch do thay đổi", sale: "Bán", unsold: "Chưa bán", drift: "Chênh lệch đã lưu / POS", noPrevious: "Không có phiên đã đóng liên kết. Chỉ thay đổi thời gian bắt đầu phiên đầu tiên." },
};

export const formatKegSafetyTime = (value: string) => new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(new Date(value)) + " (UTC+07)";

