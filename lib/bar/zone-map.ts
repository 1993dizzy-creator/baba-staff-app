export type BarZoneKind = "storage" | "equipment";
export type BarZoneLevel = "upper" | "middle" | "lower" | "equipment";
export type BarZoneSide = "left" | "right" | null;
export type BarZoneRect = { x: number; y: number; width: number; height: number };
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
  label?: { x: number; y: number };
};

export const BAR_FRONT_IMAGE_SRC = "/img/bar/bar-front-view.jpg";
export const BAR_FRONT_IMAGE_WIDTH = 1491;
export const BAR_FRONT_IMAGE_HEIGHT = 734;
export const BAR_ZONE_MAP_VIEW_BOX = "0 0 1491 734";
export const SHOW_BAR_MAP_DEBUG = false;

// Coordinates follow the actual furniture boundaries in the 1491×734 source image.
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
  Object.entries(CABINET_RECTS).map(([cabinetNo, rect]) => [Number(cabinetNo), { x: rect.x, y: 498, width: rect.width, height: 18 }])
);

const middleHitRect = (rect: BarZoneRect): BarZoneRect => ({ x: rect.x, y: 478, width: rect.width, height: 40 });

function cabinetZone(level: "middle" | "lower", cabinetNo: number): BarZoneDefinition {
  const isMiddle = level === "middle";
  const prefix = isMiddle ? "B" : "C";
  const svg = isMiddle ? MIDDLE_RECTS[cabinetNo] : CABINET_RECTS[cabinetNo];
  return {
    code: `${prefix}${cabinetNo}`,
    kind: "storage",
    level,
    cabinetNo,
    side: null,
    selectableForKeeping: true,
    labelKo: isMiddle ? `중단 ${cabinetNo} · B${cabinetNo}` : `하단 수납장 ${cabinetNo} · C${cabinetNo}`,
    labelVi: isMiddle ? `Mặt bàn ${cabinetNo} · B${cabinetNo}` : `Tủ dưới ${cabinetNo} · C${cabinetNo}`,
    descriptionKo: isMiddle ? `수납장 ${cabinetNo}번 위쪽 수평 상판 구역` : `POS 방향에서 ${cabinetNo}번째 양문 수납장 내부`,
    descriptionVi: isMiddle ? `Khu vực mặt bàn ngang phía trên tủ số ${cabinetNo}` : `Bên trong tủ hai cánh thứ ${cabinetNo} tính từ phía POS`,
    svg,
    hitSvg: isMiddle ? middleHitRect(svg) : undefined,
    label: isMiddle ? { x: svg.x + svg.width / 2, y: 422 } : undefined,
  };
}

export const barZones: BarZoneDefinition[] = [
  {
    code: "A1", kind: "storage", level: "upper", cabinetNo: null, side: "left", selectableForKeeping: true,
    labelKo: "상단 좌측 · A1", labelVi: "Kệ trên trái · A1",
    descriptionKo: "가습기 기준 좌측 상단 선반 전체", descriptionVi: "Toàn bộ kệ trên bên trái máy tạo ẩm",
    svg: { x: 282, y: 260, width: 362, height: 99 },
  },
  {
    code: "A2", kind: "equipment", level: "equipment", cabinetNo: null, side: null, selectableForKeeping: false,
    labelKo: "가습기 공간 · A2", labelVi: "Khu vực máy tạo ẩm · A2",
    descriptionKo: "수납장 4번 우측 + 5번 좌측에 해당하는 가습기 전용 공간", descriptionVi: "Khu vực máy tạo ẩm tương ứng bên phải tủ 4 và bên trái tủ 5",
    svg: { x: 644, y: 260, width: 196, height: 99 },
  },
  {
    code: "A3", kind: "storage", level: "upper", cabinetNo: null, side: "right", selectableForKeeping: true,
    labelKo: "상단 우측 · A3", labelVi: "Kệ trên phải · A3",
    descriptionKo: "가습기 기준 우측 상단 선반 전체", descriptionVi: "Toàn bộ kệ trên bên phải máy tạo ẩm",
    svg: { x: 840, y: 260, width: 373, height: 99 },
  },
  ...Array.from({ length: 8 }, (_, index) => cabinetZone("middle", index + 1)),
  ...Array.from({ length: 8 }, (_, index) => cabinetZone("lower", index + 1)),
];

export const BAR_ZONE_CODES = barZones.map((zone) => zone.code);
export function isBarZoneCode(value: unknown): value is string {
  return typeof value === "string" && BAR_ZONE_CODES.includes(value);
}
