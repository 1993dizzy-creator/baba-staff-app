export type BarZoneLevel = "upper" | "middle" | "lower";
export type BarZoneSide = "left" | "right" | null;

export type BarZoneDefinition = {
  code: string;
  level: BarZoneLevel;
  cabinetNo: number;
  side: BarZoneSide;
  labelKo: string;
  labelVi: string;
  descriptionKo: string;
  descriptionVi: string;
  svg: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export const BAR_ZONE_MAP_VIEW_BOX = "0 0 840 340";

const GRID_X = 100;
const CELL_WIDTH = 90;
const UPPER_Y = 66;
const UPPER_HEIGHT = 56;
const MIDDLE_Y = 136;
const MIDDLE_HEIGHT = 66;
const LOWER_Y = 216;
const LOWER_HEIGHT = 66;

const cabinetX = (cabinetNo: number) => GRID_X + (cabinetNo - 1) * CELL_WIDTH;

const upperZone = (
  cabinetNo: number,
  side: Exclude<BarZoneSide, null>
): BarZoneDefinition => {
  const sideKo = side === "left" ? "좌측" : "우측";
  const sideVi = side === "left" ? "bên trái" : "bên phải";

  return {
    code: `U${cabinetNo}${side === "left" ? "L" : "R"}`,
    level: "upper",
    cabinetNo,
    side,
    labelKo: `상단 ${cabinetNo}번 ${sideKo}`,
    labelVi: `Phía trên tủ ${cabinetNo} ${sideVi}`,
    descriptionKo: `수납장 ${cabinetNo}번 위쪽 상단 선반의 ${sideKo} 구역`,
    descriptionVi: `Khu vực ${sideVi} của kệ phía trên tủ số ${cabinetNo}`,
    svg: {
      x: cabinetX(cabinetNo) + (side === "right" ? CELL_WIDTH / 2 : 0),
      y: UPPER_Y,
      width: CELL_WIDTH / 2,
      height: UPPER_HEIGHT,
    },
  };
};

const fullWidthZone = (
  level: "middle" | "lower",
  cabinetNo: number
): BarZoneDefinition => {
  const isMiddle = level === "middle";
  const levelKo = isMiddle ? "중단" : "하단";
  const levelVi = isMiddle ? "Giữa" : "Dưới";

  return {
    code: `${isMiddle ? "M" : "L"}${cabinetNo}`,
    level,
    cabinetNo,
    side: null,
    labelKo: `${levelKo} ${cabinetNo}번`,
    labelVi: `${levelVi} tủ ${cabinetNo}`,
    descriptionKo: `POS 방향에서 ${cabinetNo}번째 양문 수납장의 ${levelKo} 구역`,
    descriptionVi: `Khu vực ${levelVi.toLowerCase()} của tủ hai cánh thứ ${cabinetNo} tính từ phía POS`,
    svg: {
      x: cabinetX(cabinetNo),
      y: isMiddle ? MIDDLE_Y : LOWER_Y,
      width: CELL_WIDTH,
      height: isMiddle ? MIDDLE_HEIGHT : LOWER_HEIGHT,
    },
  };
};

export const barZones: BarZoneDefinition[] = [
  upperZone(2, "right"),
  upperZone(3, "left"),
  upperZone(3, "right"),
  upperZone(4, "left"),
  upperZone(4, "right"),
  upperZone(5, "left"),
  upperZone(5, "right"),
  upperZone(6, "left"),
  upperZone(6, "right"),
  upperZone(7, "left"),
  ...Array.from({ length: 8 }, (_, index) => fullWidthZone("middle", index + 1)),
  ...Array.from({ length: 8 }, (_, index) => fullWidthZone("lower", index + 1)),
];

export const barUnavailableUpperCabinets = [1, 8] as const;
