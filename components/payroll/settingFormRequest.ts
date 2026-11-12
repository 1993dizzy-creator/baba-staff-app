/**
 * /admin/users 복리후생 스위치에서 설정 하나만 모달로 열 때의 요청.
 * - enable: 스위치가 바꾸려는 상태(true = 적용, false = 해제). null이면 상태는 그대로 두고 상세 설정만 연다.
 * 카드는 조회가 끝나면 폼을 바로 열고 이 값으로 미리 채운다. 미리 채운 값이 미저장 판정의 기준값이므로
 * 아무것도 입력하지 않고 닫으면 경고 없이 닫히고, 서버 상태(스위치 표시)는 바뀌지 않는다.
 * 저장은 각 카드의 기존 저장 API·검증을 그대로 쓴다(스위치가 직접 저장하지 않음).
 */
export type PayrollSettingFormRequest = { enable: boolean | null };

/** 모달 모드에서 폼이 끝났음을 알린다: 저장 성공(재조회 완료) 또는 사용자의 취소. */
export type PayrollSettingFormResult = "saved" | "cancelled";
