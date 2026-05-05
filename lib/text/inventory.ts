export const inventoryText = {
  ko: {
    title: "재고관리",
    listTitle: "재고 목록",

    searchPlaceholder: "품목명 / 카테고리 / 코드 검색",

    lowStockThreshold: "부족 기준값",
    filterLowStock: "부족 품목만 보기",
    filterToday: "오늘 변경만",

    low: "부족",
    stockLow: "재고 부족",
    lowStockBanner: (count: number) =>
      `⚠️ 재고 부족 품목 ${count}개. 확인 필요.`,

    openInventoryForm: "재고등록 열기",
    closeInventoryForm: "재고등록 닫기",
    inputTitle: "재고 입력",

    categoryPlaceholder: "카테고리 (육류 / 소모품 등)",
    unitPlaceholder: "단위 (예: 병, 개, kg)",
    requiredFields: "품목명, 수량, 단위 입력하세요",

    newCategory: "새 카테고리",
    newCategoryPlaceholder: "새 카테고리 입력",
    newSupplier: "새 거래처",
    newSupplierPlaceholder: "새 거래처 입력",

    purchase: "구매",
    purchasePrice: "구매단가",
    otherReason: "기타 사유 입력",

    quickSave: "빠른저장",
    quickGuide: "새 수량 입력 또는 +/- 버튼 조정 후 빠른저장.",
    quantityNoChange: "수량 변화 없음",
    quantityCannotBeNegative: "수량은 0보다 작을 수 없습니다.",

    reasonTitle: "재고 변경 사유 선택",
    reasonCheck: "재고확인",
    service: "서비스",

    snapshotBaseDate: "기준일",
    snapshotDiff: "전일",
    snapshotView: "일자별 재고확인",

    logView: "재고 로그 보기",
    logRecent: "최근 변경 로그",
    logItemTitle: "품목 로그",

    sortDesc: "최신순",
    sortAsc: "오래된순",
    logCount: "로그 개수",
    createDone: "품목 등록",

    snapshotDates: "날짜 선택",
    resultCount: "품목 수",
    baseDateLabel: "기준 날짜",
    compareNowLabel: "현재 재고와 비교 중",
    snapshotCalendar: "스냅샷 캘린더",
    filterChange: "변화 있는 품목만 보기",
    previousDay: "전일대비",
    legendPurchase: "입고상품 있음",
    snapshotTitle: "일자별 입고 상품",
  },

  vi: {
    title: "Quản lý kho",
    listTitle: "Danh sách kho",

    searchPlaceholder: "Tìm theo tên hàng / danh mục / mã",

    lowStockThreshold: "Ngưỡng thiếu hàng",
    filterLowStock: "Chỉ xem hàng thiếu",
    filterToday: "Chỉ thay đổi hôm nay",

    low: "Thiếu",
    stockLow: "Thiếu hàng",
    lowStockBanner: (count: number) =>
      `⚠️ Có ${count} mặt hàng thiếu. Cần kiểm tra.`,

    openInventoryForm: "Mở đăng ký kho",
    closeInventoryForm: "Đóng đăng ký kho",
    inputTitle: "Nhập kho",

    categoryPlaceholder: "Danh mục (thịt / vật tư...)",
    unitPlaceholder: "Đơn vị (VD: chai, cái, kg)",
    requiredFields: "Vui lòng nhập tên hàng, số lượng, đơn vị",

    newCategory: "Danh mục mới",
    newCategoryPlaceholder: "Nhập danh mục mới",
    newSupplier: "Nơi mua mới",
    newSupplierPlaceholder: "Nhập nơi mua mới",

    purchase: "Mua",
    purchasePrice: "Đơn giá mua",
    otherReason: "Nhập lý do khác",

    quickSave: "Lưu nhanh",
    quickGuide: "Nhập số lượng mới hoặc chỉnh bằng nút +/- rồi lưu nhanh.",
    quantityNoChange: "Số lượng không thay đổi",
    quantityCannotBeNegative: "Số lượng không thể nhỏ hơn 0.",

    reasonTitle: "Chọn lý do thay đổi kho",
    reasonCheck: "Kiểm tra kho",
    service: "Dịch vụ",

    snapshotBaseDate: "Ngày chuẩn",
    snapshotDiff: "Hôm trước",
    snapshotView: "Kiểm tra kho theo ngày",

    logView: "Xem nhật ký kho",
    logRecent: "Nhật ký thay đổi gần đây",
    logItemTitle: "Nhật ký mặt hàng",

    sortDesc: "Mới nhất",
    sortAsc: "Cũ nhất",
    logCount: "Số lượng log",
    createDone: "Đăng ký hàng hóa",

    snapshotDates: "Chọn ngày",
    resultCount: "Số lượng mục",
    baseDateLabel: "Ngày đang xem",
    compareNowLabel: "Đang so sánh với tồn kho hiện tại",
    snapshotCalendar: "Lịch snapshot",
    filterChange: "Chỉ xem mặt hàng có thay đổi",
    previousDay: "So với hôm trước",
    legendPurchase: "Có hàng nhập",
    snapshotTitle: "Hàng nhập theo ngày",
  },
};