export const partnerText = {
  ko: {
    title: "거래처 관리", description: "등록된 거래처와 결제조건을 관리합니다.", total: "전체 거래처", active: "사용 중", immediate: "즉시결제", postpaid: "후불결제", inactive: "사용 안 함", search: "거래처명, 연락처, 담당자 검색", add: "거래처 등록", edit: "기본정보 수정", name: "거래처명", type: "업종/종류", paymentMode: "결제방식", settlementMode: "정산 방식", adHoc: "수시정산", scheduled: "정기정산", settlementRule: "정산 규칙", netDays: "N일 후 지급", monthlyOnce: "월 1회", monthlyTwice: "월 2회", paymentDeadline: "지급기한", paymentDeadlineHelp: "입고/청구 후 N일", legacySettlement: "기존 후불 설정입니다. 정산 방식을 확인해주세요.", policyUnset: "후불 · 정책 미설정", term: "기본 결제기한", days: "일", contact: "담당자", phone: "전화번호", memo: "메모", ledger: "장부 거래처 연결", noLedger: "연결 안 함", save: "저장", saving: "저장 중…", details: "상세 보기", supply: "공급 품목", noSupply: "아직 연결된 품목이 없습니다.", history: "거래 내역", noHistory: "장부 연동 후 표시됩니다.", back: "거래처 목록", empty: "조건에 맞는 거래처가 없습니다.", loadFailed: "거래처를 불러오지 못했습니다.", saved: "저장했습니다.", duplicate: "같은 이름의 거래처가 이미 있습니다.", status: "상태",
  },
  vi: {
    title: "Quản lý đối tác", description: "Quản lý đối tác đã đăng ký và điều khoản thanh toán.", total: "Tất cả", active: "Đang dùng", immediate: "Thanh toán ngay", postpaid: "Thanh toán sau", inactive: "Ngừng dùng", search: "Tìm tên, điện thoại, người liên hệ", add: "Thêm đối tác", edit: "Sửa thông tin", name: "Tên đối tác", type: "Ngành / loại", paymentMode: "Hình thức thanh toán", settlementMode: "Cách đối soát", adHoc: "Đối soát khi cần", scheduled: "Đối soát định kỳ", settlementRule: "Chu kỳ đối soát", netDays: "Thanh toán sau N ngày", monthlyOnce: "Mỗi tháng 1 lần", monthlyTwice: "Mỗi tháng 2 lần", paymentDeadline: "Thời hạn thanh toán", paymentDeadlineHelp: "N ngày sau khi nhập hàng/xuất hóa đơn", legacySettlement: "Đây là thiết lập trả sau cũ. Vui lòng xác nhận cách đối soát.", policyUnset: "Trả sau · Chưa đặt chính sách", term: "Hạn thanh toán mặc định", days: "ngày", contact: "Người liên hệ", phone: "Số điện thoại", memo: "Ghi chú", ledger: "Liên kết đối tác sổ sách", noLedger: "Không liên kết", save: "Lưu", saving: "Đang lưu…", details: "Xem chi tiết", supply: "Mặt hàng cung cấp", noSupply: "Chưa có mặt hàng được liên kết.", history: "Lịch sử giao dịch", noHistory: "Sẽ hiển thị sau khi liên kết sổ sách.", back: "Danh sách đối tác", empty: "Không có đối tác phù hợp.", loadFailed: "Không thể tải đối tác.", saved: "Đã lưu.", duplicate: "Tên đối tác đã tồn tại.", status: "Trạng thái",
  },
} as const;

export const partnerTypeLabels = {
  food: { ko: "식자재", vi: "Thực phẩm" }, alcohol: { ko: "주류", vi: "Đồ uống có cồn" }, beverage: { ko: "음료", vi: "Đồ uống" }, consumable: { ko: "소모품", vi: "Vật tư tiêu hao" }, equipment: { ko: "장비", vi: "Thiết bị" }, service: { ko: "서비스", vi: "Dịch vụ" }, rent: { ko: "임대", vi: "Cho thuê" }, other: { ko: "기타", vi: "Khác" },
} as const;

export function formatPartnerPaymentPolicy(value: { paymentMode: string; settlementMode: string | null; settlementRule: string | null; defaultPaymentTermDays: number | null }, lang: "ko" | "vi") {
  const t = partnerText[lang];
  if (value.paymentMode === "immediate") return t.immediate;
  if (value.settlementMode === null) return t.policyUnset;
  if (value.settlementMode === "ad_hoc") return lang === "vi" ? "Trả sau · Đối soát khi cần" : "후불 · 수시정산";
  if (value.settlementRule === "net_days") return lang === "vi" ? `Trả sau · Net ${value.defaultPaymentTermDays}` : `후불 · Net ${value.defaultPaymentTermDays}`;
  if (value.settlementRule === "monthly_once") return lang === "vi" ? "Trả sau · Đối soát mỗi tháng 1 lần" : "후불 · 월 1회 정산";
  if (value.settlementRule === "monthly_twice") return lang === "vi" ? "Trả sau · Đối soát mỗi tháng 2 lần" : "후불 · 월 2회 정산";
  return t.policyUnset;
}
