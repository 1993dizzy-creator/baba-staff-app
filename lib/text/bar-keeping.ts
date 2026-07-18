export const keepingText={
ko:{search:"고객명·식별 정보·주류명 검색",filter:"필터",active:"보관 중",closed:"종료",recentActivity:"최근 활동순",oldActivity:"오래 미사용순",recentCreated:"최근 등록순",customerSort:"고객명순",zoneSort:"구역순",expirySort:"만료 임박순",newKeeping:"＋ 새 키핑 등록",customerName:"고객명",identifier:"고객 식별 정보",liquorName:"주류명",remaining:"현재 잔량",zone:"보관 구역",storedAt:"보관 시작일",lastUsed:"마지막 사용",expiresAt:"만료 예정일",note:"비고",camera:"카메라 촬영",album:"앨범 선택",register:"키핑 등록",saving:"저장 중…",list:"키핑 목록",customerInfo:"고객 정보",liquorInfo:"주류 정보",storageInfo:"보관 정보",finished:"소진",returned:"반출",discarded:"폐기",expiredReason:"만료",other:"기타 종료",expirySoon:"만료 임박",expiryPassed:"만료 경과",noActive:"보관 중인 키핑술이 없습니다.",first:"첫 키핑술을 등록해 주세요.",noClosed:"종료된 키핑술이 없습니다.",noResults:"검색 조건에 맞는 키핑술이 없습니다.",reset:"필터 초기화",retry:"다시 시도",loadMore:"더 보기",loading:"불러오는 중…",use:"사용 처리",move:"위치 이동",edit:"정보 수정",photo:"사진 교체",correct:"잔량 정정",close:"종료 처리",reactivate:"재활성화",reason:"사유",usedAt:"사용 시각",closedAt:"종료 시각",closeReason:"종료 사유",closeNote:"종료 메모",apply:"적용",cancel:"취소",save:"저장",recentLogs:"최근 기록",viewAllLogs:"전체 기록 보기",emptyLogs:"최근 기록이 없습니다.",allZones:"전체 구역",expiryFilter:"만료 상태",all:"전체",finishTogether:"0%이므로 소진 종료도 함께 처리",newPhotoOptional:"새 사진(선택)",reactivateReason:"재활성화 사유",photoRequired:"사진을 선택해 주세요.",invalid:"입력값을 확인해 주세요.",conflict:"다른 사용자가 먼저 수정했습니다. 입력 내용을 유지한 채 최신 정보를 다시 확인해 주세요.",error:"처리하지 못했습니다.",selectZone:"구역을 선택해 주세요.",inactiveZone:"비활성 구역"},
vi:{search:"Tìm khách, mã hoặc tên rượu",filter:"Bộ lọc",active:"Đang giữ",closed:"Đã kết thúc",recentActivity:"Hoạt động mới nhất",oldActivity:"Ít dùng lâu nhất",recentCreated:"Mới đăng ký",customerSort:"Theo khách",zoneSort:"Theo khu vực",expirySort:"Sắp hết hạn",newKeeping:"＋ Đăng ký rượu giữ",customerName:"Tên khách",identifier:"Thông tin nhận diện",liquorName:"Tên rượu",remaining:"Lượng còn lại",zone:"Khu vực giữ",storedAt:"Ngày bắt đầu",lastUsed:"Dùng gần nhất",expiresAt:"Ngày hết hạn",note:"Ghi chú",camera:"Chụp ảnh",album:"Chọn ảnh",register:"Đăng ký",saving:"Đang lưu…",list:"Danh sách giữ rượu",customerInfo:"Thông tin khách",liquorInfo:"Thông tin rượu",storageInfo:"Thông tin lưu giữ",finished:"Đã dùng hết",returned:"Đã trả khách",discarded:"Đã hủy",expiredReason:"Hết hạn",other:"Kết thúc khác",expirySoon:"Sắp hết hạn",expiryPassed:"Đã quá hạn",noActive:"Không có rượu đang giữ.",first:"Hãy đăng ký chai đầu tiên.",noClosed:"Không có rượu đã kết thúc.",noResults:"Không có kết quả phù hợp.",reset:"Đặt lại bộ lọc",retry:"Thử lại",loadMore:"Xem thêm",loading:"Đang tải…",use:"Xử lý sử dụng",move:"Chuyển vị trí",edit:"Sửa thông tin",photo:"Thay ảnh",correct:"Chỉnh lượng",close:"Kết thúc",reactivate:"Kích hoạt lại",reason:"Lý do",usedAt:"Thời gian dùng",closedAt:"Thời gian kết thúc",closeReason:"Lý do kết thúc",closeNote:"Ghi chú kết thúc",apply:"Áp dụng",cancel:"Hủy",save:"Lưu",recentLogs:"Nhật ký gần đây",viewAllLogs:"Xem toàn bộ nhật ký",emptyLogs:"Chưa có nhật ký.",allZones:"Tất cả khu vực",expiryFilter:"Tình trạng hạn",all:"Tất cả",finishTogether:"Còn 0%, đồng thời kết thúc là đã dùng hết",newPhotoOptional:"Ảnh mới (tùy chọn)",reactivateReason:"Lý do kích hoạt lại",photoRequired:"Vui lòng chọn ảnh.",invalid:"Vui lòng kiểm tra dữ liệu.",conflict:"Người khác đã sửa trước. Dữ liệu nhập vẫn được giữ; vui lòng tải thông tin mới.",error:"Không thể xử lý.",selectZone:"Vui lòng chọn khu vực.",inactiveZone:"Khu vực đã tắt"}
} as const;

export const keepingListText = {
  ko: { soldProduct: "판매상품", outsideBottle: "외부반입", zone: "보관 구역" },
  vi: { soldProduct: "Hàng bán", outsideBottle: "Mang vào", zone: "Khu vực" },
} as const;

export const keepingDetailText = {
  ko: { photoSelected: "사진 선택 완료", contact: "연락처", customerFeature: "고객 특징", zoneChange: "보관 구역 변경", currentZone: "현재", liquorUse: "키핑 사용", keepingClose: "키핑 종료", useHelp: "실제 사용 후 남은 잔량을 입력합니다.", correctionHelp: "사용 처리 없이 잘못 기록된 잔량만 수정합니다.", photoChange: "사진 변경", photoView: "사진 보기", useCount: (count: number) => `사용 ${count}회` },
  vi: { photoSelected: "Đã chọn ảnh", contact: "Liên hệ", customerFeature: "Đặc điểm khách", zoneChange: "Đổi khu vực", currentZone: "Hiện tại", liquorUse: "Sử dụng rượu gửi", keepingClose: "Kết thúc giữ rượu", useHelp: "Nhập lượng còn lại sau khi sử dụng thực tế.", correctionHelp: "Chỉ sửa lượng đã ghi sai, không xử lý sử dụng.", photoChange: "Thay ảnh", photoView: "Xem ảnh", useCount: (count: number) => `Đã dùng ${count} lần` },
} as const;

export const keepingImageErrorText = {
  ko: {
    unsupported: "지원하지 않는 사진 형식입니다.",
    processingFailed: "사진을 처리하지 못했습니다. 다시 촬영해 주세요.",
    tooLarge: "사진 용량을 줄이지 못했습니다. 다른 사진을 선택해 주세요.",
  },
  vi: {
    unsupported: "Định dạng ảnh không được hỗ trợ.",
    processingFailed: "Không thể xử lý ảnh. Vui lòng chụp lại.",
    tooLarge: "Không thể giảm dung lượng ảnh. Vui lòng chọn ảnh khác.",
  },
} as const;
