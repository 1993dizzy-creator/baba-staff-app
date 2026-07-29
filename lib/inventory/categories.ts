export const CATEGORY_OPTIONS_BY_PART = {
    kitchen: [
        { ko: "채소", vi: "Rau củ" },
        { ko: "허브", vi: "Rau thơm" },
        { ko: "과일", vi: "Trái cây" },
        { ko: "버섯", vi: "Nấm" },
        { ko: "육류", vi: "Thịt" },
        { ko: "해산물", vi: "Hải sản" },
        { ko: "가공식품", vi: "Thực phẩm chế biến" },
        { ko: "건어물", vi: "Đồ khô" },
        { ko: "유제품", vi: "Sản phẩm sữa" },
        { ko: "치즈", vi: "Phô mai" },
        { ko: "소스", vi: "Nước sốt" },
        { ko: "조미료", vi: "Gia vị" },
        { ko: "면류", vi: "Mì" },
        { ko: "튀김류", vi: "Đồ chiên" },
        { ko: "스낵", vi: "Snack" },
        { ko: "견과류", vi: "Hạt" },
        { ko: "기름", vi: "Dầu" },
        { ko: "절임", vi: "Đồ ngâm" },
        { ko: "식자재", vi: "Nguyên liệu" },
        { ko: "기타", vi: "Khác" },
    ],
    bar: [
        { ko: "위스키", vi: "Whisky" },
        { ko: "진", vi: "Gin" },
        { ko: "럼", vi: "Rum" },
        { ko: "보드카", vi: "Vodka" },
        { ko: "데킬라", vi: "Tequila" },
        { ko: "와인", vi: "Wine" },
        { ko: "코냑", vi: "Cognac" },
        { ko: "리큐르", vi: "Liqueur" },
        { ko: "시럽", vi: "Syrup" },
        { ko: "음료", vi: "Đồ uống" },
        { ko: "비터", vi: "Bitters" },
        { ko: "베르무트", vi: "Vermouth" },
        { ko: "기타", vi: "Khác" },
    ],
    hall: [
        { ko: "맥주", vi: "Bia" },
        { ko: "생맥주", vi: "Bia tươi" },
        { ko: "병맥주", vi: "Bia chai" },
        { ko: "수제맥주", vi: "Bia thủ công" },
        { ko: "소주", vi: "Soju" },
        { ko: "음료", vi: "Đồ uống" },
        { ko: "기타", vi: "Khác" },
    ],
    etc: [{ ko: "기타", vi: "Khác" }],
};

export type InventoryCategoryOption = { ko: string; vi: string };

function normalizeCategoryValue(value?: string | null) {
    return (value || "").trim().toLocaleLowerCase();
}

export function resolveInventoryCategoryOption(
    part?: string | null,
    category?: string | null,
    categoryVi?: string | null
): InventoryCategoryOption | null {
    const options = CATEGORY_OPTIONS_BY_PART[
        (part || "").trim().toLocaleLowerCase() as keyof typeof CATEGORY_OPTIONS_BY_PART
    ] ?? [];
    const candidates = new Set(
        [category, categoryVi].map(normalizeCategoryValue).filter(Boolean)
    );

    return options.find((option) =>
        candidates.has(normalizeCategoryValue(option.ko))
        || candidates.has(normalizeCategoryValue(option.vi))
    ) ?? null;
}

export function getInventoryCategoryLabel(
    part: string | null | undefined,
    category: string | null | undefined,
    categoryVi: string | null | undefined,
    lang: "ko" | "vi"
) {
    const option = resolveInventoryCategoryOption(part, category, categoryVi);
    if (option) return option[lang];

    const primary = lang === "vi" ? categoryVi : category;
    const fallback = lang === "vi" ? category : categoryVi;
    return primary?.trim() || fallback?.trim() || "";
}
