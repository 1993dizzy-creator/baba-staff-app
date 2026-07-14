export type BarZoneKind = "storage" | "equipment";
export type BarZoneLevel = "upper" | "middle" | "lower" | "equipment";
export type BarZoneSide = "left" | "right" | null;
export type BarZoneRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BarZoneDefinition = {
  code: string;
  kind: BarZoneKind;
  level: BarZoneLevel;
  cabinetNo: number | null;
  side: BarZoneSide;
  selectableForKeeping: boolean;
  labelKo: string;
  labelVi: string;
  descriptionKo: string;
  descriptionVi: string;
  svg: BarZoneRect;
  hitSvg?: BarZoneRect;
  label?: {
    x: number;
    y: number;
  };
};

export const BAR_FRONT_IMAGE_SRC = "/img/bar/bar-front-view.jpg";
export const BAR_FRONT_IMAGE_WIDTH = 1491;
export const BAR_FRONT_IMAGE_HEIGHT = 734;
export const BAR_ZONE_MAP_VIEW_BOX = "0 0 1491 734";
export const SHOW_BAR_MAP_DEBUG = false;

// 정면도 이미지의 실제 양문 수납장 프레임 경계입니다.
// 가구 모듈 사이의 간격 때문에 동일 폭으로 8등분하지 않습니다.
const CABINET_RECTS: Record<number, BarZoneRect> = {
  1: { x: 18, y: 518, width: 177, height: 216 },
  2: { x: 195, y: 518, width: 175, height: 216 },
  3: { x: 379, y: 518, width: 176, height: 216 },
  4: { x: 555, y: 518, width: 179, height: 216 },
  5: { x: 750, y: 518, width: 180, height: 216 },
  6: { x: 930, y: 518, width: 178, height: 216 },
  7: { x: 1122, y: 518, width: 178, height: 216 },
  8: { x: 1300, y: 518, width: 176, height: 216 },
};

const MIDDLE_RECTS: Record<number, BarZoneRect> = Object.fromEntries(
  Object.entries(CABINET_RECTS).map(([cabinetNo, rect]) => [
    Number(cabinetNo),
    { x: rect.x, y: 498, width: rect.width, height: 18 },
  ])
);

// 얇은 상판도 모바일에서 누르기 쉽도록 실제 표시선보다 넓은 터치 영역을 둡니다.
const middleHitRect = (rect: BarZoneRect): BarZoneRect => ({
  x: rect.x,
  y: 478,
  width: rect.width,
  height: 40,
});

const upperStorageZone = ({
  code,
  cabinetNo,
  side,
  svg,
}: {
  code: string;
  cabinetNo: number;
  side: Exclude<BarZoneSide, null>;
  svg: BarZoneRect;
}): BarZoneDefinition => {
  const sideKo = side === "left" ? "좌측" : "우측";
  const sideVi = side === "left" ? "bên trái" : "bên phải";

  return {
    code,
    kind: "storage",
    level: "upper",
    cabinetNo,
    side,
    selectableForKeeping: true,
    labelKo: `상단 ${code}`,
    labelVi: `Phía trên ${code}`,
    descriptionKo: `수납장 ${cabinetNo}번 위쪽 상단 선반의 ${sideKo} 구역`,
    descriptionVi: `Khu vực ${sideVi} của kệ phía trên tủ số ${cabinetNo}`,
    svg,
  };
};

const fullWidthZone = (
  level: "middle" | "lower",
  cabinetNo: number
): BarZoneDefinition => {
  const isMiddle = level === "middle";
  const levelKo = isMiddle ? "중단" : "하단";
  const levelVi = isMiddle ? "Giữa" : "Dưới";
  const svg = isMiddle ? MIDDLE_RECTS[cabinetNo] : CABINET_RECTS[cabinetNo];

  return {
    code: `${isMiddle ? "B" : "C"}${cabinetNo}`,
    kind: "storage",
    level,
    cabinetNo,
    side: null,
    selectableForKeeping: true,
    labelKo: `${levelKo} ${isMiddle ? "B" : "C"}${cabinetNo}`,
    labelVi: `${levelVi} ${isMiddle ? "B" : "C"}${cabinetNo}`,
    descriptionKo: isMiddle
      ? `수납장 ${cabinetNo}번 바로 위쪽의 수평 상판 구역`
      : `POS 방향에서 ${cabinetNo}번째 양문 수납장 내부`,
    descriptionVi: isMiddle
      ? `Khu vực mặt bàn ngang ngay phía trên tủ số ${cabinetNo}`
      : `Khu vực dưới của tủ hai cánh thứ ${cabinetNo} tính từ phía POS`,
    svg,
    hitSvg: isMiddle ? middleHitRect(svg) : undefined,
    label: isMiddle
      ? { x: svg.x + svg.width / 2, y: 422 }
      : undefined,
  };
};

export const barZones: BarZoneDefinition[] = [
  upperStorageZone({ code: "A1", cabinetNo: 2, side: "right", svg: { x: 282, y: 260, width: 88, height: 99 } }),
  upperStorageZone({ code: "A2", cabinetNo: 3, side: "left", svg: { x: 379, y: 260, width: 88, height: 99 } }),
  upperStorageZone({ code: "A3", cabinetNo: 3, side: "right", svg: { x: 467, y: 260, width: 88, height: 99 } }),
  upperStorageZone({ code: "A4", cabinetNo: 4, side: "left", svg: { x: 555, y: 260, width: 89, height: 99 } }),
  {
    code: "A5",
    kind: "equipment",
    level: "equipment",
    cabinetNo: null,
    side: null,
    selectableForKeeping: false,
    labelKo: "가습기 공간",
    labelVi: "Khu vực máy tạo ẩm",
    descriptionKo: "수납장 4번 우측 + 5번 좌측에 해당하는 가습기 전용 공간",
    descriptionVi: "Khu vực dành riêng cho máy tạo ẩm, tương ứng bên phải tủ 4 và bên trái tủ 5",
    svg: { x: 644, y: 260, width: 196, height: 99 },
  },
  upperStorageZone({ code: "A6", cabinetNo: 5, side: "right", svg: { x: 840, y: 260, width: 90, height: 99 } }),
  upperStorageZone({ code: "A7", cabinetNo: 6, side: "left", svg: { x: 930, y: 260, width: 90, height: 99 } }),
  upperStorageZone({ code: "A8", cabinetNo: 6, side: "right", svg: { x: 1020, y: 260, width: 90, height: 99 } }),
  upperStorageZone({ code: "A9", cabinetNo: 7, side: "left", svg: { x: 1110, y: 260, width: 103, height: 99 } }),
  ...Array.from({ length: 8 }, (_, index) => fullWidthZone("middle", index + 1)),
  ...Array.from({ length: 8 }, (_, index) => fullWidthZone("lower", index + 1)),
];
