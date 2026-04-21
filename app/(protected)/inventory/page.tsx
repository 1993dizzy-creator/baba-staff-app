"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase/client";
import { useLanguage } from "@/lib/language-context";
import { inventoryText } from "@/lib/text";
import Container from "@/components/Container";
import { ui } from "@/lib/styles/ui";
import { getUser } from "@/lib/supabase/auth";
import InventoryLogGroupCard from "@/components/InventoryLogGroupCard";
import InventorySubNav from "@/components/InventorySubNav";

const CATEGORY_OPTIONS_BY_PART = {
    kitchen: [
        { ko: "채소", vi: "Rau củ" },
        { ko: "허브", vi: "Rau thơm" },
        { ko: "과일", vi: "Trái cây" },
        { ko: "버섯", vi: "Nấm" },
        { ko: "육류", vi: "Thịt" },
        { ko: "해산물", vi: "Hải sản" },
        { ko: "가공육", vi: "Thịt chế biến" },
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
        { ko: "분말", vi: "Bột" },
        { ko: "감미료", vi: "Chất tạo ngọt" },
        { ko: "절임", vi: "Đồ ngâm" },
        { ko: "소모품", vi: "Vật tư tiêu hao" },
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


const PART_VALUES = ["kitchen", "hall", "bar", "etc"] as const;
type PartValue = (typeof PART_VALUES)[number];

const PART_META: Record<
    PartValue,
    {
        color: string;
        soft: string;
        emoji: string;
    }
> = {
    kitchen: {
        color: "#f59e0b",
        soft: "#fff7ed",
        emoji: "🍳",
    },
    hall: {
        color: "#10b981",
        soft: "#ecfdf5",
        emoji: "🍺",
    },
    bar: {
        color: "#3b82f6",
        soft: "#eff6ff",
        emoji: "🍸",
    },
    etc: {
        color: "#8b5cf6",
        soft: "#f5f3ff",
        emoji: "📦",
    },
};

export default function InventoryPage() {
    const currentUser = getUser();
    const actorName = currentUser?.name || "";
    const actorUsername = currentUser?.username || "";

    const defaultPart: PartValue =
        PART_VALUES.includes(currentUser?.part as PartValue)
            ? (currentUser?.part as PartValue)
            : "kitchen";

    const { lang } = useLanguage();
    const t = inventoryText[lang];

    const [itemName, setItemName] = useState("");
    const [quantity, setQuantity] = useState("");
    const [unit, setUnit] = useState("");
    const [note, setNote] = useState("");
    const [part, setPart] = useState<PartValue>(defaultPart);
    const [category, setCategory] = useState("");
    const [categoryKo, setCategoryKo] = useState("");
    const [categoryVi, setCategoryVi] = useState("");
    const [isCustomCategory, setIsCustomCategory] = useState(false);
    const [isCustomSupplier, setIsCustomSupplier] = useState(false);
    const [purchasePrice, setPurchasePrice] = useState("");
    const [supplier, setSupplier] = useState("");
    const [lowStockThreshold, setLowStockThreshold] = useState("");
    const [code, setCode] = useState("");

    const [inventoryList, setInventoryList] = useState<any[]>([]);
    const [recentLogs, setRecentLogs] = useState<any[]>([]);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [openItemId, setOpenItemId] = useState<number | null>(null);
    const [isFormOpen, setIsFormOpen] = useState(false);

    const [search, setSearch] = useState("");
    const [partFilter, setPartFilter] = useState<PartValue>(defaultPart);
    const [categoryFilter, setCategoryFilter] = useState("all");
    const [showLowStockOnly, setShowLowStockOnly] = useState(false);
    const [showTodayUpdatedOnly, setShowTodayUpdatedOnly] = useState(false);
    const [quantityDrafts, setQuantityDrafts] = useState<Record<number, string>>({});
    const [latestSnapshotMap, setLatestSnapshotMap] = useState<Record<number, number>>({});
    const [latestSnapshotDate, setLatestSnapshotDate] = useState<string>("");
    const [quickSaveItem, setQuickSaveItem] = useState<any | null>(null);
    const [quickSaveReason, setQuickSaveReason] = useState<
        "check" | "purchase" | "service" | "other" | null
    >(null);
    const [quickSaveOtherText, setQuickSaveOtherText] = useState("");
    const [logModalItem, setLogModalItem] = useState<any | null>(null);
    const [itemLogs, setItemLogs] = useState<any[]>([]);
    const [isItemLogsLoading, setIsItemLogsLoading] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isDeletingId, setIsDeletingId] = useState<number | null>(null);
    const [isQuickSaving, setIsQuickSaving] = useState(false);
    const [showLowStockBanner, setShowLowStockBanner] = useState(true);

    const itemNameRef = useRef<HTMLInputElement>(null);
    const supplierRef = useRef<HTMLInputElement>(null);
    const priceRef = useRef<HTMLInputElement>(null);
    const unitRef = useRef<HTMLInputElement>(null);
    const quantityRef = useRef<HTMLInputElement>(null);
    const noteRef = useRef<HTMLInputElement>(null);
    const formRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const lowStockThresholdRef = useRef<HTMLInputElement>(null);

    const categoryOptions =
        CATEGORY_OPTIONS_BY_PART[part as keyof typeof CATEGORY_OPTIONS_BY_PART] ?? [];

    const customCategoryOptions = Array.from(
        new Set(
            inventoryList
                .filter((item) => item.part === part)
                .map((item) =>
                    lang === "vi"
                        ? item.category_vi || item.category || ""
                        : item.category || item.category_vi || ""
                )
                .map((value) => value.trim())
                .filter(Boolean)
        )
    );

    const mergedCategoryOptions = [
        ...categoryOptions.map((option) => ({
            label: lang === "vi" ? option.vi : option.ko,
            ko: option.ko,
            vi: option.vi,
        })),
        ...customCategoryOptions
            .filter(
                (value) =>
                    !categoryOptions.some((option) => {
                        const label = lang === "vi" ? option.vi : option.ko;
                        return label.trim().toLowerCase() === value.trim().toLowerCase();
                    })
            )
            .map((value) => ({
                label: value,
                ko: lang === "ko" ? value : "",
                vi: lang === "vi" ? value : "",
            })),
    ];

    const customSupplierOptions = Array.from(
        new Set(
            inventoryList
                .map((item) => (item.supplier || "").trim())
                .filter(Boolean)
        )
    );

    const mergedSupplierOptions = customSupplierOptions.sort((a, b) =>
        a.localeCompare(b, "vi")
    );

    const getDisplayItemName = (item: any) =>
        lang === "vi"
            ? item.item_name_vi || item.item_name || "-"
            : item.item_name || item.item_name_vi || "-";

    const getDisplayCategory = (item: any) =>
        lang === "vi"
            ? item.category_vi || item.category || "-"
            : item.category || item.category_vi || "-";

    const getCategoryKey = (item: any) =>
        item.category || item.category_vi || "-";

    const getDisplayLogItemName = (log: any) =>
        lang === "vi"
            ? log.item_name_vi || log.item_name || "-"
            : log.item_name || log.item_name_vi || "-";

    const getDisplayLogCategory = (log: any) =>
        lang === "vi"
            ? log.category_vi || log.category || "-"
            : log.category || log.category_vi || "-";

    const getPartLabel = (value: string) => {
        switch (value) {
            case "kitchen":
                return t.kitchen;
            case "hall":
                return t.hall;
            case "bar":
                return t.bar;
            case "etc":
                return t.etc;
            default:
                return value || "-";
        }
    };

    const getActionBadge = (action: string) => {
        if (action === "create") return "NEW";
        if (action === "delete") return "DEL";
        return "UP";
    };

    const getActionColor = (action: string) => {
        if (action === "create") return "seagreen";
        if (action === "delete") return "crimson";
        return "royalblue";
    };

    const formatDateTime = (value: string) => {
        const d = new Date(value);
        const yy = String(d.getFullYear()).slice(2);
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const min = String(d.getMinutes()).padStart(2, "0");
        return `${yy}.${mm}.${dd} ${hh}:${min}`;
    };

    const getLogChanges = (log: any, lang: string) => {
        const changes: {
            label: string;
            before?: string;
            after: string;
            color?: string;
        }[] = [];

        if (log.action === "create") {
            changes.push({
                label: lang === "vi" ? "Tạo" : "생성",
                after: `${log.new_quantity ?? 0}${log.unit ? ` ${log.unit}` : ""}`,
                color: "seagreen",
            });
            return changes;
        }

        if (log.action === "delete") {
            changes.push({
                label: lang === "vi" ? "Xóa" : "삭제",
                before: `${formatDecimalDisplay(log.prev_quantity)}${log.unit ? ` ${log.unit}` : ""}`,
                after: `${formatDecimalDisplay(log.new_quantity)}${log.unit ? ` ${log.unit}` : ""}`,
                color: "crimson",
            });
            return changes;
        }

        if (
            log.prev_quantity !== log.new_quantity &&
            !(log.prev_quantity == null && log.new_quantity == null)
        ) {
            changes.push({
                label: lang === "vi" ? "SL" : "수량",
                before: `${formatDecimalDisplay(log.prev_quantity)}${log.unit ? ` ${log.unit}` : ""}`,
                after: `${formatDecimalDisplay(log.new_quantity)}${log.unit ? ` ${log.unit}` : ""}`,
                color:
                    Number(log.new_quantity ?? 0) > Number(log.prev_quantity ?? 0)
                        ? "seagreen"
                        : Number(log.new_quantity ?? 0) < Number(log.prev_quantity ?? 0)
                            ? "crimson"
                            : "#111827",
            });
        }

        if ((log.prev_note || "") !== (log.new_note || "")) {
            changes.push({
                label: lang === "vi" ? "GC" : "비고",
                before: log.prev_note || "-",
                after: log.new_note || "-",
            });
        }

        if ((log.prev_supplier || "") !== (log.new_supplier || "")) {
            changes.push({
                label: lang === "vi" ? "NCC" : "거래처",
                before: log.prev_supplier || "-",
                after: log.new_supplier || "-",
            });
        }

        if ((log.prev_code || "") !== (log.new_code || "")) {
            changes.push({
                label: lang === "vi" ? "Mã" : "코드",
                before: log.prev_code || "-",
                after: log.new_code || "-",
            });
        }

        if ((log.prev_unit || "") !== (log.new_unit || "")) {
            changes.push({
                label: lang === "vi" ? "ĐV" : "단위",
                before: log.prev_unit || "-",
                after: log.new_unit || "-",
            });
        }

        if ((log.prev_category || "") !== (log.new_category || "")) {
            changes.push({
                label: lang === "vi" ? "DM" : "카테고리",
                before:
                    lang === "vi"
                        ? log.prev_category_vi || log.prev_category || "-"
                        : log.prev_category || log.prev_category_vi || "-",
                after:
                    lang === "vi"
                        ? log.new_category_vi || log.new_category || "-"
                        : log.new_category || log.new_category_vi || "-",
            });
        }

        if ((log.prev_part || "") !== (log.new_part || "")) {
            changes.push({
                label: lang === "vi" ? "BP" : "파트",
                before: getPartLabel(log.prev_part || "-"),
                after: getPartLabel(log.new_part || "-"),
            });
        }

        if (
            parseDecimal(log.prev_low_stock_threshold ?? 1) !==
            parseDecimal(log.new_low_stock_threshold ?? 1)
        ) {
            changes.push({
                label: lang === "vi" ? "Ngưỡng" : "부족기준",
                before: String(log.prev_low_stock_threshold ?? 1),
                after: String(log.new_low_stock_threshold ?? 1),
            });
        }

        if (
            log.prev_purchase_price !== log.new_purchase_price &&
            !(log.prev_purchase_price == null && log.new_purchase_price == null)
        ) {
            changes.push({
                label: lang === "vi" ? "Giá" : "구매가",
                before: formatMoneyDisplay(log.prev_purchase_price),
                after: formatMoneyDisplay(log.new_purchase_price),
            });
        }

        if (changes.length === 0) {
            changes.push({
                label: lang === "vi" ? "Sửa" : "변경",
                after: lang === "vi" ? "Không có chi tiết" : "변경 내역 없음",
            });
        }

        return changes;
    };

    const getQuickReasonLabel = (
        reason: "check" | "purchase" | "service" | "other",
        customText?: string
    ) => {
        if (reason === "check") return t.quickReasonCheck;
        if (reason === "purchase") return t.quickReasonPurchase;
        if (reason === "service") return t.quickReasonService;
        return customText?.trim() || t.quickReasonOther;
    };

    const buildQuickChangeNote = ({
        currentQty,
        nextQty,
        reason,
        customText,
    }: {
        currentQty: number;
        nextQty: number;
        reason: "check" | "purchase" | "service" | "other";
        customText?: string;
    }) => {
        const diff = nextQty - currentQty;
        const diffText = `${diff > 0 ? "+" : ""}${formatDecimalDisplay(diff)}`;
        const reasonLabel = getQuickReasonLabel(reason, customText);
        return `${diffText} (${reasonLabel})`;
    };

    const fetchInventory = async () => {
        const { data, error } = await supabase
            .from("inventory")
            .select("*")
            .order("updated_at", { ascending: false });

        if (error) {
            console.error(error);
            return;
        }

        setInventoryList(data || []);
    };

    const fetchRecentLogs = async () => {
        const { data, error } = await supabase
            .from("inventory_logs")
            .select("*")
            .order("created_at", { ascending: false })
            .limit(3);

        if (error) {
            console.error(error);
            return;
        }

        setRecentLogs(data || []);
    };

    const fetchItemLogs = async (item: any) => {
        setLogModalItem(item);
        setIsItemLogsLoading(true);

        const { data, error } = await supabase
            .from("inventory_logs")
            .select("*")
            .eq("item_id", item.id)
            .order("created_at", { ascending: false })
            .limit(50);

        if (error) {
            console.error(error);
            setItemLogs([]);
            setIsItemLogsLoading(false);
            return;
        }

        setItemLogs(data || []);
        setIsItemLogsLoading(false);
    };

    const fetchLatestSnapshot = async () => {
        const { data: batchRow, error: batchError } = await supabase
            .from("inventory_snapshot_batches")
            .select("id, snapshot_date")
            .order("snapshot_date", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (batchError) {
            console.error(batchError);
            return;
        }

        if (!batchRow) {
            setLatestSnapshotMap({});
            setLatestSnapshotDate("");
            return;
        }

        const { data: snapshotItems, error: itemsError } = await supabase
            .from("inventory_snapshot_items")
            .select("item_id, quantity")
            .eq("batch_id", batchRow.id);

        if (itemsError) {
            console.error(itemsError);
            return;
        }

        const nextMap: Record<number, number> = {};

        (snapshotItems || []).forEach((row) => {
            if (row.item_id !== null && row.item_id !== undefined) {
                nextMap[Number(row.item_id)] = Number(row.quantity ?? 0);
            }
        });

        setLatestSnapshotMap(nextMap);
        setLatestSnapshotDate(batchRow.snapshot_date || "");
    };

    const normalizePriceInput = (value: string | number | null | undefined) => {
        return String(value ?? "").replace(/[^\d]/g, "");
    };

    const formatNumber = (value: string | number | null | undefined) => {
        const digits = normalizePriceInput(value);
        return digits ? Number(digits).toLocaleString("en-US") : "";
    };

    const parsePrice = (value: string | number | null | undefined) => {
        const digits = normalizePriceInput(value);
        return digits ? Number(digits) : null;
    };

    const formatMoneyDisplay = (value: string | number | null | undefined) => {
        if (value === null || value === undefined || value === "") return "-";

        const num =
            typeof value === "number"
                ? value
                : Number(String(value).replace(/[^\d.-]/g, ""));

        if (!Number.isFinite(num)) return "-";

        return `${num.toLocaleString("en-US")} ₫`;
    };

    const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim();

    const parseDecimal = (value: string | number | null | undefined) => {
        if (value === null || value === undefined || value === "") return 0;
        const normalized = String(value).replace(/,/g, "").trim();
        const num = Number(normalized);
        return Number.isNaN(num) ? 0 : num;
    };

    const formatDecimalDisplay = (value: string | number | null | undefined) => {
        if (value === null || value === undefined || value === "") return "0";

        const num =
            typeof value === "number"
                ? value
                : Number(String(value).replace(/,/g, "").trim());

        if (!Number.isFinite(num)) return "0";

        return num.toFixed(2).replace(/\.?0+$/, "");
    };

    const roundDecimal = (value: number) => {
        return Math.round(value * 100) / 100;
    };

    const resetForm = () => {
        setItemName("");
        setQuantity("");
        setUnit("");
        setNote("");
        setPart(defaultPart);
        setCategory("");
        setPurchasePrice("");
        setSupplier("");
        setCode("");
        setLowStockThreshold("");
        setEditingId(null);
        setIsCustomCategory(false);
        setIsCustomSupplier(false);
        setCategoryKo("");
        setCategoryVi("");
    };

    const handleDelete = async (id: number) => {
        if (isDeletingId === id) return;

        const ok = confirm(t.deleteConfirm);
        if (!ok) return;

        setIsDeletingId(id);

        try {
            const targetItem = inventoryList.find((item) => item.id === id);
            if (!targetItem) {
                alert(t.deleteTargetNotFound);
                return;
            }

            const { data: deletedRows, error: deleteError } = await supabase
                .from("inventory")
                .delete()
                .eq("id", id)
                .select(`
                id,
                item_name,
                item_name_vi,
                part,
                category,
                category_vi,
                quantity,
                purchase_price,
                note,
                unit,
                code,
                supplier,
                low_stock_threshold
            `);

            if (deleteError) {
                console.error(deleteError);
                alert(t.deleteFail);
                return;
            }

            if (!deletedRows || deletedRows.length === 0) {
                alert(t.deleteTargetNotFound);
                return;
            }

            const deletedItem = deletedRows[0];

            const { error: logError } = await supabase.from("inventory_logs").insert([
                {
                    item_id: deletedItem.id,
                    item_name: deletedItem.item_name,
                    item_name_vi: deletedItem.item_name_vi ?? null,
                    action: "delete",

                    part: deletedItem.part,
                    category: deletedItem.category,
                    category_vi: deletedItem.category_vi ?? null,

                    prev_quantity: deletedItem.quantity ?? 0,
                    new_quantity: 0,
                    change_quantity: -Number(deletedItem.quantity ?? 0),

                    prev_purchase_price: deletedItem.purchase_price ?? null,
                    new_purchase_price: null,

                    prev_note: deletedItem.note ?? null,
                    new_note: null,

                    prev_supplier: deletedItem.supplier ?? null,
                    new_supplier: null,

                    prev_code: deletedItem.code ?? null,
                    new_code: null,

                    prev_unit: deletedItem.unit ?? null,
                    new_unit: null,

                    prev_category: deletedItem.category ?? null,
                    new_category: null,

                    prev_category_vi: deletedItem.category_vi ?? null,
                    new_category_vi: null,

                    prev_part: deletedItem.part ?? null,
                    new_part: null,

                    unit: deletedItem.unit ?? null,
                    code: deletedItem.code ?? null,

                    actor_name: actorName,
                    actor_username: actorUsername,

                    prev_low_stock_threshold: deletedItem.low_stock_threshold ?? 1,
                    new_low_stock_threshold: null,
                },
            ]);

            if (logError) {
                console.error(logError);
                alert(t.deleteLogSaveFail);
            }

            await fetchInventory();
            await fetchRecentLogs();
        } finally {
            setIsDeletingId(null);
        }
    };

    const handleEdit = (item: any) => {
        const nextPart = item.part || "";
        const nextCategory = lang === "vi" ? item.category_vi || "" : item.category || "";
        const nextCategoryOptions =
            CATEGORY_OPTIONS_BY_PART[nextPart as keyof typeof CATEGORY_OPTIONS_BY_PART] ?? [];
        const nextItemName =
            lang === "vi"
                ? item.item_name_vi || item.item_name || ""
                : item.item_name || item.item_name_vi || "";

        setIsFormOpen(true);
        setEditingId(item.id);
        setOpenItemId(item.id);
        setPart(nextPart);
        setItemName(nextItemName);
        setCategory(nextCategory);
        setCategoryKo(item.category || item.category_vi || "");
        setCategoryVi(item.category_vi || item.category || "");

        const matched = nextCategoryOptions.find(
            (option) => (lang === "vi" ? option.vi : option.ko) === nextCategory
        );
        setIsCustomCategory(!matched && !!nextCategory);

        setQuantity(String(item.quantity ?? ""));
        setUnit(item.unit || "");
        setNote(item.note || "");
        setPurchasePrice(formatNumber(item.purchase_price));
        setSupplier(item.supplier || "");

        setIsCustomSupplier(
            !!item.supplier &&
            !mergedSupplierOptions.some(
                (option) =>
                    option.trim().toLowerCase() === String(item.supplier || "").trim().toLowerCase()
            )
        );
        setCode(item.code || "");
        setLowStockThreshold(String(item.low_stock_threshold ?? 1));

        setTimeout(() => {
            formRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
            });
        }, 0);
    };

    const handleSubmit = async () => {
        if (isSubmitting) return;
        setIsSubmitting(true);

        try {
            const normalizedItemName = normalizeText(itemName);
            const normalizedCategoryKo = normalizeText(categoryKo || (lang === "ko" ? category : ""));
            const normalizedCategoryVi = normalizeText(categoryVi || (lang === "vi" ? category : ""));
            const normalizedSupplier = normalizeText(supplier);
            const normalizedUnit = normalizeText(unit);
            const normalizedNote = normalizeText(note);
            const normalizedCode = normalizeText(code);

            if (!part || !normalizedItemName || !quantity || !normalizedUnit) {
                alert(t.requiredFields);
                return;
            }

            const nextLowStock = lowStockThreshold ? parseDecimal(lowStockThreshold) : 1;

            if (nextLowStock < 0) {
                alert(t.quantityCannotBeNegative);
                return;
            }

            const nextQuantity = parseDecimal(quantity);
            const nextPurchasePrice =
                purchasePrice.trim() === "" ? null : parsePrice(purchasePrice);

            if (editingId) {
                const targetItem = inventoryList.find((item) => item.id === editingId);

                if (!targetItem) {
                    alert(t.editFail);
                    return;
                }

                const currentItemName =
                    lang === "vi"
                        ? targetItem.item_name_vi || targetItem.item_name || ""
                        : targetItem.item_name || targetItem.item_name_vi || "";

                const hasChanges =
                    normalizeText(currentItemName) !== normalizedItemName ||
                    normalizeText(targetItem.category || "") !== normalizedCategoryKo ||
                    normalizeText(targetItem.category_vi || "") !== normalizedCategoryVi ||
                    parseDecimal(targetItem.quantity) !== nextQuantity ||
                    normalizeText(targetItem.unit || "") !== normalizedUnit ||
                    normalizeText(targetItem.note || "") !== normalizedNote ||
                    (targetItem.part || "") !== part ||
                    (targetItem.purchase_price ?? null) !== nextPurchasePrice ||
                    normalizeText(targetItem.supplier || "") !== normalizedSupplier ||
                    normalizeText(targetItem.code || "") !== normalizedCode ||
                    parseDecimal(targetItem.low_stock_threshold ?? 1) !== nextLowStock;

                if (!hasChanges) {
                    alert(lang === "vi" ? "Không có thay đổi" : "변경사항 없음");
                    return;
                }

                const updatePayload =
                    lang === "ko"
                        ? {
                            item_name: normalizedItemName,
                            category: normalizedCategoryKo,
                            category_vi: normalizedCategoryVi,
                            quantity: nextQuantity,
                            purchase_price: nextPurchasePrice,
                            low_stock_threshold: nextLowStock,
                            unit: normalizedUnit,
                            note: normalizedNote,
                            part,
                            supplier: normalizedSupplier,
                            code: normalizedCode,
                            updated_at: new Date().toISOString(),
                            updated_by_name: actorName,
                            updated_by_username: actorUsername,
                        }
                        : {
                            item_name_vi: normalizedItemName,
                            category: normalizedCategoryKo,
                            category_vi: normalizedCategoryVi,
                            quantity: nextQuantity,
                            purchase_price: nextPurchasePrice,
                            low_stock_threshold: nextLowStock,
                            unit: normalizedUnit,
                            note: normalizedNote,
                            part,
                            supplier: normalizedSupplier,
                            code: normalizedCode,
                            updated_at: new Date().toISOString(),
                            updated_by_name: actorName,
                            updated_by_username: actorUsername,
                        };

                const { error } = await supabase
                    .from("inventory")
                    .update(updatePayload)
                    .eq("id", editingId);

                if (error) {
                    console.error(error);
                    alert(t.editFail);
                    return;
                }

                await supabase.from("inventory_logs").insert([
                    {
                        item_id: editingId,
                        item_name: lang === "ko" ? normalizedItemName : targetItem.item_name ?? null,
                        item_name_vi: lang === "vi" ? normalizedItemName : targetItem.item_name_vi ?? null,
                        action: "update",

                        part,
                        category: normalizedCategoryKo,
                        category_vi: normalizedCategoryVi,

                        prev_quantity: targetItem.quantity ?? 0,
                        new_quantity: nextQuantity,
                        change_quantity: nextQuantity - Number(targetItem.quantity ?? 0),
                        new_purchase_price: nextPurchasePrice,

                        prev_purchase_price: targetItem.purchase_price ?? null,

                        prev_note: targetItem.note ?? null,
                        new_note: normalizedNote,

                        prev_supplier: targetItem.supplier ?? null,
                        new_supplier: normalizedSupplier || null,

                        prev_code: targetItem.code ?? null,
                        new_code: normalizedCode || null,

                        prev_unit: targetItem.unit ?? null,
                        new_unit: normalizedUnit || null,

                        prev_category: targetItem.category ?? null,
                        new_category: normalizedCategoryKo || null,

                        prev_category_vi: targetItem.category_vi ?? null,
                        new_category_vi: normalizedCategoryVi || null,

                        prev_part: targetItem.part ?? null,
                        new_part: part || null,

                        unit: normalizedUnit,
                        code: normalizedCode,

                        actor_name: actorName,
                        actor_username: actorUsername,

                        prev_low_stock_threshold: targetItem.low_stock_threshold ?? 1,
                        new_low_stock_threshold: nextLowStock,
                    },
                ]);

                alert(t.editSuccess);
            } else {
                const insertPayload =
                    lang === "ko"
                        ? {
                            item_name: normalizedItemName,
                            category: normalizedCategoryKo,
                            item_name_vi: "",
                            category_vi: normalizedCategoryVi,
                            quantity: nextQuantity,
                            unit: normalizedUnit,
                            note: normalizedNote,
                            part,
                            purchase_price: nextPurchasePrice,
                            supplier: normalizedSupplier,
                            code: normalizedCode,
                            low_stock_threshold: nextLowStock,
                            updated_at: new Date().toISOString(),
                            updated_by_name: actorName,
                            updated_by_username: actorUsername,
                        }
                        : {
                            item_name: "",
                            category: normalizedCategoryKo,
                            item_name_vi: normalizedItemName,
                            category_vi: normalizedCategoryVi,
                            quantity: nextQuantity,
                            unit: normalizedUnit,
                            note: normalizedNote,
                            part,
                            purchase_price: nextPurchasePrice,
                            supplier: normalizedSupplier,
                            code: normalizedCode,
                            low_stock_threshold: nextLowStock,
                            updated_at: new Date().toISOString(),
                            updated_by_name: actorName,
                            updated_by_username: actorUsername,
                        };

                const { data: insertedData, error } = await supabase
                    .from("inventory")
                    .insert([insertPayload])
                    .select()
                    .single();

                if (error || !insertedData) {
                    console.error(error);
                    alert(t.saveFail);
                    return;
                }

                await supabase.from("inventory_logs").insert([
                    {
                        item_id: insertedData.id,
                        item_name: insertedData.item_name ?? null,
                        item_name_vi: insertedData.item_name_vi ?? null,
                        action: "create",

                        part: insertedData.part,
                        category: insertedData.category ?? null,
                        category_vi: insertedData.category_vi ?? null,

                        prev_quantity: 0,
                        new_quantity: insertedData.quantity ?? 0,
                        change_quantity: insertedData.quantity ?? 0,

                        prev_purchase_price: null,
                        new_purchase_price: insertedData.purchase_price ?? null,

                        prev_note: null,
                        new_note: insertedData.note ?? null,

                        prev_supplier: null,
                        new_supplier: insertedData.supplier ?? null,

                        prev_code: null,
                        new_code: insertedData.code ?? null,

                        prev_unit: null,
                        new_unit: insertedData.unit ?? null,

                        prev_category: null,
                        new_category: insertedData.category ?? null,

                        prev_category_vi: null,
                        new_category_vi: insertedData.category_vi ?? null,

                        prev_part: null,
                        new_part: insertedData.part ?? null,

                        unit: insertedData.unit ?? null,
                        code: insertedData.code ?? null,

                        actor_name: actorName,
                        actor_username: actorUsername,

                        prev_low_stock_threshold: null,
                        new_low_stock_threshold: insertedData.low_stock_threshold ?? 1,
                    },
                ]);

                alert(t.saveSuccess);
            }

            await fetchInventory();
            await fetchRecentLogs();

            resetForm();
            setIsFormOpen(false);
            itemNameRef.current?.focus();
        } finally {
            setIsSubmitting(false);
        }
    };

    const adjustQuantityDraft = (itemId: number, delta: number) => {
        setQuantityDrafts((prev) => {
            const current = parseDecimal(prev[itemId] ?? "0");
            const next = roundDecimal(current + delta);

            return {
                ...prev,
                [itemId]: String(next < 0 ? 0 : next),
            };
        });
    };

    const handleQuantitySave = (item: any) => {
        const draft = quantityDrafts[item.id];

        if (draft === undefined || String(draft).trim() === "") {
            alert(t.requiredFields);
            return;
        }

        const nextQty = parseDecimal(draft);

        if (nextQty < 0) {
            alert(t.quantityCannotBeNegative);
            return;
        }

        setQuickSaveItem(item);
        setQuickSaveReason(null);
        setQuickSaveOtherText("");
    };

    const handleQuickSaveConfirm = async (
        reason: "check" | "purchase" | "service" | "other"
    ) => {
        if (isQuickSaving) return;
        setIsQuickSaving(true);

        try {
            if (!quickSaveItem) return;

            const draft = quantityDrafts[quickSaveItem.id];
            const nextQty = roundDecimal(parseDecimal(draft));
            const currentQty = roundDecimal(Number(quickSaveItem.quantity ?? 0));
            const diffQty = roundDecimal(nextQty - currentQty);

            if (draft === undefined || String(draft).trim() === "") {
                alert(t.requiredFields);
                return;
            }

            if (nextQty < 0) {
                alert(t.quantityCannotBeNegative);
                return;
            }

            if (nextQty === currentQty) {
                alert(lang === "vi" ? "Số lượng không thay đổi" : "수량 변화 없음");
                return;
            }

            if (reason === "other" && !quickSaveOtherText.trim()) {
                alert(lang === "vi" ? "Vui lòng nhập nội dung khác" : "기타 내용을 입력하세요.");
                return;
            }

            const quickNote = buildQuickChangeNote({
                currentQty,
                nextQty,
                reason,
                customText: quickSaveOtherText,
            });

            const { error: updateError } = await supabase
                .from("inventory")
                .update({
                    quantity: nextQty,
                    note: quickNote,
                    updated_at: new Date().toISOString(),
                    updated_by_name: actorName,
                    updated_by_username: actorUsername,
                })
                .eq("id", quickSaveItem.id);

            if (updateError) {
                console.error(updateError);
                alert(t.quickChangeFail);
                return;
            }

            const { error: logError } = await supabase.from("inventory_logs").insert([
                {
                    item_id: quickSaveItem.id,
                    item_name: quickSaveItem.item_name,
                    item_name_vi: quickSaveItem.item_name_vi ?? null,
                    action: "update",
                    part: quickSaveItem.part,
                    category: quickSaveItem.category,
                    category_vi: quickSaveItem.category_vi ?? null,
                    prev_quantity: currentQty,
                    new_quantity: nextQty,
                    change_quantity: diffQty,
                    prev_purchase_price: quickSaveItem.purchase_price ?? null,
                    new_purchase_price: quickSaveItem.purchase_price ?? null,
                    prev_note: quickSaveItem.note ?? null,
                    new_note: quickNote,
                    unit: quickSaveItem.unit,
                    code: quickSaveItem.code,
                    actor_name: actorName,
                    actor_username: actorUsername,
                },
            ]);

            if (logError) {
                console.error(logError);
                alert(t.quickChangeFail);
                return;
            }

            await fetchInventory();
            await fetchRecentLogs();

            setQuantityDrafts((prev) => ({
                ...prev,
                [quickSaveItem.id]: String(nextQty),
            }));

            setQuickSaveItem(null);
            setQuickSaveReason(null);
            setQuickSaveOtherText("");
        } finally {
            setIsQuickSaving(false);
        }
    };

    const handleKeyDown = (
        e: React.KeyboardEvent,
        nextRef?: React.RefObject<HTMLInputElement | HTMLSelectElement | null>
    ) => {
        if (e.key === "Enter") {
            e.preventDefault();

            if (nextRef?.current) {
                nextRef.current.focus();
            } else {
                handleSubmit();
            }
        }
    };

    useEffect(() => {
        fetchInventory();
        fetchRecentLogs();
        fetchLatestSnapshot();
    }, []);

    useEffect(() => {
        const savedPartFilter = localStorage.getItem("inventory_part_filter");
        if (savedPartFilter && PART_VALUES.includes(savedPartFilter as PartValue)) {
            setPartFilter(savedPartFilter as PartValue);
        } else {
            setPartFilter(defaultPart);
        }
    }, [defaultPart]);

    useEffect(() => {
        localStorage.setItem("inventory_part_filter", partFilter);
    }, [partFilter]);


    useEffect(() => {
        setCategoryFilter("all");
    }, [partFilter]);

    useEffect(() => {
        if (editingId) return;

        setCategory("");
        setCategoryKo("");
        setCategoryVi("");
        setIsCustomCategory(false);
    }, [part, editingId]);

    useEffect(() => {
        if (!isFormOpen) return;

        setTimeout(() => {
            formRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
            });
        }, 0);

        setTimeout(() => {
            itemNameRef.current?.focus();
        }, 180);
    }, [isFormOpen]);

    const lowStockItems = inventoryList.filter(
        (item) => Number(item.quantity) <= Number(item.low_stock_threshold ?? 1)
    );

    const categoryTabs = useMemo(() => {
        return [
            { key: "all", label: lang === "vi" ? "Tất cả" : "전체" },
            ...Array.from(
                new Map(
                    inventoryList
                        .filter((item) => item.part === partFilter)
                        .filter((item) => getCategoryKey(item) && getCategoryKey(item) !== "-")
                        .map((item) => [
                            getCategoryKey(item),
                            {
                                key: getCategoryKey(item),
                                label: getDisplayCategory(item),
                            },
                        ])
                ).values()
            ),
        ];
    }, [inventoryList, partFilter, lang]);

    const isToday = (value?: string) => {
        if (!value) return false;

        const date = new Date(value);
        const now = new Date();

        return (
            date.getFullYear() === now.getFullYear() &&
            date.getMonth() === now.getMonth() &&
            date.getDate() === now.getDate()
        );
    };

    const getPartMeta = (value?: string) => {
        const safePart: PartValue =
            value && PART_VALUES.includes(value as PartValue)
                ? (value as PartValue)
                : "etc";

        return PART_META[safePart];
    };

    const getPartButtonStyle = (value: PartValue, active: boolean) => {
        const meta = PART_META[value];

        return {
            padding: "8px 10px",
            borderRadius: 8,
            border: active ? `1px solid ${meta.color}` : "1px solid #d1d5db",
            background: active ? meta.color : "#f9fafb",
            color: active ? "#fff" : "#111827",
            fontWeight: 700,
            fontSize: 13,
            cursor: "pointer",
            whiteSpace: "nowrap" as const,
        };
    };

    const getFilterToggleButtonStyle = (active: boolean, activeColor: string) => {
        return {
            flex: 1,
            padding: "8px 12px",
            background: active ? activeColor : "#f5f5f5",
            color: active ? "#fff" : "#111827",
            border: active ? `1px solid ${activeColor}` : "1px solid #ddd",
            borderRadius: 8,
            cursor: "pointer",
            fontWeight: 600,
            fontSize: 13, // 🔥 추가
        };
    };

    const getCategoryTabButtonStyle = (active: boolean) => {
        return {
            padding: "7px 10px",
            borderRadius: 999,
            border: active ? "1px solid #111827" : "1px solid #d1d5db",
            background: active ? "#111827" : "#f9fafb",
            color: active ? "#fff" : "#111827",
            fontWeight: 700,
            fontSize: 12,
            whiteSpace: "nowrap" as const,
            cursor: "pointer",
            flexShrink: 0,
        };
    };

    // 재고 메인 목록은 운영 편의상 최신 수정순이 아니라 코드 > 이름순으로 고정한다.
    // (로그 / 스냅샷 페이지는 최신순 기준 유지 가능)
    const filteredInventory = inventoryList
        .filter((item) => {
            const keyword = search.trim().toLowerCase();
            const displayItemName = getDisplayItemName(item).toLowerCase();
            const displayCategory = getDisplayCategory(item);
            const displayCode = String(item.code || "").toLowerCase();
            const categoryKey = getCategoryKey(item);

            const matchSearch =
                !keyword ||
                displayItemName.includes(keyword) ||
                displayCategory.toLowerCase().includes(keyword) ||
                displayCode.includes(keyword);

            const matchPart = item.part === partFilter;
            const matchCategory =
                categoryFilter === "all" || categoryKey === categoryFilter;
            const matchLowStock =
                !showLowStockOnly ||
                Number(item.quantity) <= Number(item.low_stock_threshold ?? 1);

            const matchTodayUpdated =
                !showTodayUpdatedOnly || isToday(item.updated_at);

            return (
                matchSearch &&
                matchPart &&
                matchCategory &&
                matchLowStock &&
                matchTodayUpdated
            );
        })
        .sort((a, b) => {
            const codeA = (a.code || "").toLowerCase();
            const codeB = (b.code || "").toLowerCase();

            // 1. 코드 있는 것 우선
            if (codeA && !codeB) return -1;
            if (!codeA && codeB) return 1;

            // 2. 코드 비교
            const codeCompare = codeA.localeCompare(codeB, undefined, {
                numeric: true,
                sensitivity: "base",
            });

            if (codeCompare !== 0) return codeCompare;

            // 3. 이름 비교
            const nameA = getDisplayItemName(a).toLowerCase();
            const nameB = getDisplayItemName(b).toLowerCase();

            return nameA.localeCompare(nameB, undefined, {
                numeric: true,
                sensitivity: "base",
            });
        });

    const groupedInventory: Record<string, any[]> = filteredInventory.reduce(
        (acc: Record<string, any[]>, item) => {
            const categoryKey = getDisplayCategory(item) || "-";

            if (!acc[categoryKey]) {
                acc[categoryKey] = [];
            }

            acc[categoryKey].push(item);
            return acc;
        },
        {}
    );

    const itemLogGroups = logModalItem
        ? [
            {
                item_id: logModalItem.id,
                noteKey: itemLogs[0]?.new_note || itemLogs[0]?.prev_note || "",
                groupKey: `item-${logModalItem.id}`,
                latest: itemLogs[0] || null,
                logs: itemLogs,
            },
        ].filter((group) => group.latest)
        : [];



    const labelStyle = {
        fontSize: 13,
        fontWeight: 700,
        color: "#374151",
        marginBottom: 6,
    };

    return (
        <Container noPaddingTop>
            <InventorySubNav />

            <div
                style={{
                    position: "relative",
                    marginBottom: 8,
                }}
            >
                {/* 돋보기 아이콘 */}
                <span
                    style={{
                        position: "absolute",
                        left: 12,
                        top: "50%",
                        transform: "translateY(-50%)",
                        fontSize: 16,
                        color: "#9ca3af",
                        pointerEvents: "none",
                    }}
                >
                    🔍
                </span>

                <input
                    type="text"
                    placeholder={t.searchPlaceholder}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={{
                        ...ui.input,
                        paddingLeft: 40,   // 🔥 핵심 (아이콘 공간)
                        marginBottom: 0,
                    }}
                />
            </div>

            {lowStockItems.length > 0 && showLowStockBanner && (
                <div
                    style={{
                        marginBottom: 12,
                        padding: "10px 12px",
                        borderRadius: 10,
                        background: "#fff5f5",
                        border: "1px solid #f3caca",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 10,
                    }}
                >
                    {/* 좌측 (기존 기능 유지) */}
                    <div
                        onClick={() => {
                            setSearch("");
                            setPartFilter(defaultPart);
                            setCategoryFilter("all");
                            setShowLowStockOnly(true);
                            setShowTodayUpdatedOnly(false);

                            setTimeout(() => {
                                listRef.current?.scrollIntoView({
                                    behavior: "smooth",
                                    block: "start",
                                });
                            }, 0);
                        }}
                        style={{
                            color: "crimson",
                            fontWeight: 600,
                            fontSize: 13,
                            cursor: "pointer",
                            flex: 1,
                        }}
                    >
                        {t.lowStockBanner(lowStockItems.length)}
                    </div>

                    {/* 우측 닫기 버튼 */}
                    <button
                        onClick={(e) => {
                            e.stopPropagation(); // 🔥 핵심 (부모 클릭 막기)
                            setShowLowStockBanner(false);
                        }}
                        style={{
                            border: "none",
                            background: "transparent",
                            fontSize: 16,
                            cursor: "pointer",
                            color: "#9ca3af",
                        }}
                    >
                        ✕
                    </button>
                </div>
            )}

            {/* 재고목록 */}
            <div
                ref={listRef}
                style={{
                    ...ui.card,
                    padding: 12,
                    marginBottom: 16,
                }}
            >
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 10,
                    }}
                >
                    <span
                        style={{
                            fontSize: 15,
                            fontWeight: 700,
                            color: "#111827",
                        }}
                    >
                        {t.listTitle}
                    </span>

                    {latestSnapshotDate && (
                        <span
                            style={{
                                fontSize: 12,
                                fontWeight: 600,
                                color: "#6b7280",
                            }}
                        >
                            {latestSnapshotDate}
                        </span>
                    )}
                </div>

                <div style={ui.filterBox}>
                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(4, 1fr)",
                            gap: 6,
                            marginBottom: 10,
                        }}
                    >
                        {[
                            { value: "kitchen", label: t.kitchen },
                            { value: "hall", label: t.hall },
                            { value: "bar", label: t.bar },
                            { value: "etc", label: t.etc },
                        ].map((partOption) => {
                            const partValue = partOption.value as PartValue;
                            const active = partFilter === partValue;
                            const meta = PART_META[partValue];

                            return (
                                <button
                                    key={partOption.value}
                                    type="button"
                                    onClick={() => setPartFilter(partValue)}
                                    style={getPartButtonStyle(partValue, active)}
                                >
                                    {meta.emoji} {partOption.label}
                                </button>
                            );
                        })}
                    </div>

                    <div
                        style={{
                            display: "flex",
                            gap: 6,
                            overflowX: "auto",
                            paddingBottom: 4,
                            marginBottom: 10,
                        }}
                    >
                        {categoryTabs.map((cat) => {
                            const active = categoryFilter === cat.key;

                            return (
                                <button
                                    key={cat.key}
                                    type="button"
                                    onClick={() => setCategoryFilter(cat.key)}
                                    style={getCategoryTabButtonStyle(active)}
                                >
                                    {cat.label}
                                </button>
                            );
                        })}
                    </div>

                    <div
                        style={{
                            display: "flex",
                            gap: 6,
                            marginTop: 2,
                            paddingTop: 0,
                        }}
                    >
                        <button
                            onClick={() => setShowLowStockOnly(!showLowStockOnly)}
                            style={getFilterToggleButtonStyle(showLowStockOnly, "crimson")}
                        >
                            {showLowStockOnly ? t.viewAllItems : t.viewLowStockOnly}
                        </button>

                        <button
                            onClick={() => setShowTodayUpdatedOnly(!showTodayUpdatedOnly)}
                            style={getFilterToggleButtonStyle(showTodayUpdatedOnly, "royalblue")}
                        >
                            {showTodayUpdatedOnly ? t.viewAllFromTodayFilter : t.viewTodayUpdatedOnly}
                        </button>
                    </div>
                </div>

                {filteredInventory.length === 0 ? (
                    <div
                        style={{
                            height: 160,
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#9ca3af",
                            fontSize: 13,
                            gap: 6,
                        }}
                    >
                        <div style={{ fontSize: 22 }}>📭</div>
                        <div>{t.noData}</div>
                    </div>
                ) : (
                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 8,
                            maxHeight: 400,
                            overflowY: "auto",
                            paddingRight: 4,
                        }}
                    >
                        {Object.entries(groupedInventory).map(([categoryName, items]: [string, any[]]) => (
                            <div
                                key={categoryName}
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: 4,
                                }}
                            >
                                <div
                                    style={{
                                        fontSize: 13,
                                        fontWeight: 800,
                                        color: "#374151",
                                        padding: "2px 2px 0",
                                    }}
                                >
                                    {categoryName}
                                </div>

                                {items.map((item) => {
                                    const isOpen = openItemId === item.id;
                                    const quantityDraft =
                                        quantityDrafts[item.id] ?? String(item.quantity ?? "");

                                    const snapshotQty = latestSnapshotMap[item.id];
                                    const hasSnapshot = snapshotQty !== undefined;
                                    const diffQty = hasSnapshot
                                        ? roundDecimal(Number(item.quantity ?? 0) - Number(snapshotQty))
                                        : null;

                                    return (
                                        <div
                                            key={item.id}
                                            style={{
                                                ...ui.card,
                                                padding: "5px 8px",
                                                borderLeft:
                                                    Number(item.quantity) <= Number(item.low_stock_threshold ?? 1)
                                                        ? "4px solid crimson"
                                                        : `4px solid ${getPartMeta(item.part).color}`,
                                                background: "#fff",
                                            }}
                                        >
                                            <div
                                                style={{
                                                    display: "flex",
                                                    justifyContent: "space-between",
                                                    alignItems: "center",
                                                    padding: "2px 0",
                                                    minHeight: 24,
                                                    gap: 8,
                                                }}
                                            >
                                                <div style={{ minWidth: 0, flex: 1 }}>
                                                    <div
                                                        style={{
                                                            display: "flex",
                                                            alignItems: "center",
                                                            gap: 6,
                                                            flexWrap: "wrap",
                                                            lineHeight: 1.2,
                                                        }}
                                                    >
                                                        <span
                                                            style={{
                                                                fontSize: 14,
                                                                fontWeight: 700,
                                                                color: "#111827",
                                                                wordBreak: "break-word",
                                                            }}
                                                        >
                                                            {[item.code ? `[${item.code}]` : "", getDisplayItemName(item)]
                                                                .filter(Boolean)
                                                                .join(" ")}
                                                        </span>

                                                        {Number(item.quantity) <= Number(item.low_stock_threshold ?? 1) && (
                                                            <span
                                                                style={{
                                                                    ...ui.badgeMini,
                                                                    background: "crimson",
                                                                }}
                                                            >
                                                                {t.low}
                                                            </span>
                                                        )}
                                                    </div>

                                                    <div style={ui.metaText}>
                                                        {[getPartLabel(item.part || ""), getDisplayCategory(item)].join(" · ")}
                                                    </div>
                                                </div>

                                                <div
                                                    style={{
                                                        display: "flex",
                                                        alignItems: "center",
                                                        gap: 8,
                                                        flexShrink: 0,
                                                    }}
                                                >
                                                    <div
                                                        style={{
                                                            minWidth: 58,
                                                            textAlign: "right",
                                                            lineHeight: 1.2,
                                                            whiteSpace: "nowrap",
                                                        }}
                                                    >
                                                        <div>
                                                            <span
                                                                style={{
                                                                    fontSize: 14,
                                                                    fontWeight: 700,
                                                                    color:
                                                                        Number(item.quantity) <= Number(item.low_stock_threshold ?? 1)
                                                                            ? "crimson"
                                                                            : "#111827",
                                                                }}
                                                            >
                                                                {item.quantity}
                                                            </span>{" "}
                                                            <span
                                                                style={{
                                                                    fontSize: 14,
                                                                    fontWeight: 700,
                                                                    color: "#111827",
                                                                }}
                                                            >
                                                                {item.unit}
                                                            </span>
                                                        </div>

                                                        <div
                                                            style={{
                                                                marginTop: 2,
                                                                fontSize: 12,
                                                                fontWeight: 700,
                                                                color:
                                                                    diffQty === null
                                                                        ? "#9ca3af"
                                                                        : diffQty > 0
                                                                            ? "seagreen"
                                                                            : diffQty < 0
                                                                                ? "crimson"
                                                                                : "#6b7280",
                                                            }}
                                                        >
                                                            {diffQty === null
                                                                ? "-"
                                                                : `${t.snapshotDiffLabel} ${diffQty > 0 ? "+" : ""}${formatDecimalDisplay(diffQty)}`}
                                                        </div>
                                                    </div>

                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            const nextOpen = !isOpen;
                                                            setOpenItemId(nextOpen ? item.id : null);
                                                            if (nextOpen) {
                                                                setQuantityDrafts((prev) => ({
                                                                    ...prev,
                                                                    [item.id]: String(item.quantity ?? ""),
                                                                }));
                                                            }
                                                        }}
                                                        style={{
                                                            ...ui.subButton,
                                                            width: "auto",
                                                            minWidth: 68,
                                                            padding: "7px 10px",
                                                            fontSize: 13,
                                                            fontWeight: 700,
                                                            background: isOpen ? getPartMeta(item.part).color : "#f5f5f5",
                                                            color: isOpen ? "#fff" : "#111827",
                                                            border: isOpen
                                                                ? `1px solid ${getPartMeta(item.part).color}`
                                                                : "1px solid #ddd",
                                                        }}
                                                    >
                                                        {isOpen ? t.close : t.detail}
                                                    </button>
                                                </div>
                                            </div>

                                            {isOpen && (
                                                <div
                                                    style={{
                                                        borderTop: "1px solid #eee",
                                                        paddingTop: 5,
                                                        marginTop: 5,
                                                    }}
                                                >
                                                    <div
                                                        style={{
                                                            display: "grid",
                                                            gridTemplateColumns: "1fr 92px",
                                                            gap: 8,
                                                            alignItems: "stretch",
                                                            marginBottom: 8,
                                                        }}
                                                    >
                                                        <div
                                                            style={{
                                                                display: "flex",
                                                                flexDirection: "column",
                                                                gap: 6,
                                                                minWidth: 0,
                                                            }}
                                                        >
                                                            <input
                                                                type="number"
                                                                step="0.1"
                                                                value={quantityDraft}
                                                                placeholder={lang === "vi" ? "Nhập số lượng mới" : "새 수량 입력"}
                                                                onChange={(e) =>
                                                                    setQuantityDrafts((prev) => ({
                                                                        ...prev,
                                                                        [item.id]: e.target.value,
                                                                    }))
                                                                }
                                                                style={{
                                                                    ...ui.input,
                                                                    marginBottom: 0,
                                                                    minWidth: 0,
                                                                    padding: "0 10px",
                                                                    height: 36,
                                                                    fontSize: 13,
                                                                    lineHeight: 1,
                                                                }}
                                                            />

                                                            <div
                                                                style={{
                                                                    display: "grid",
                                                                    gridTemplateColumns: "repeat(4, 1fr)",
                                                                    gap: 4,
                                                                }}
                                                            >
                                                                <button
                                                                    type="button"
                                                                    onClick={() => adjustQuantityDraft(item.id, -0.1)}
                                                                    style={{
                                                                        ...ui.subButton,
                                                                        width: "100%",
                                                                        minWidth: 0,
                                                                        height: 34,
                                                                        padding: "0 6px",
                                                                        fontSize: 12,
                                                                        fontWeight: 700,
                                                                        background: "#fee2e2",
                                                                        color: "crimson",
                                                                        border: "1px solid #fecaca",
                                                                    }}
                                                                >
                                                                    -0.1
                                                                </button>

                                                                <button
                                                                    type="button"
                                                                    onClick={() => adjustQuantityDraft(item.id, 0.1)}
                                                                    style={{
                                                                        ...ui.subButton,
                                                                        width: "100%",
                                                                        minWidth: 0,
                                                                        height: 34,
                                                                        padding: "0 6px",
                                                                        fontSize: 12,
                                                                        fontWeight: 700,
                                                                        background: "#dcfce7",
                                                                        color: "seagreen",
                                                                        border: "1px solid #bbf7d0",
                                                                    }}
                                                                >
                                                                    +0.1
                                                                </button>

                                                                <button
                                                                    type="button"
                                                                    onClick={() => adjustQuantityDraft(item.id, -1)}
                                                                    style={{
                                                                        ...ui.subButton,
                                                                        width: "100%",
                                                                        minWidth: 0,
                                                                        height: 34,
                                                                        padding: "0 6px",
                                                                        fontSize: 12,
                                                                        fontWeight: 700,
                                                                        background: "#fee2e2",
                                                                        color: "crimson",
                                                                        border: "1px solid #fecaca",
                                                                    }}
                                                                >
                                                                    -1
                                                                </button>

                                                                <button
                                                                    type="button"
                                                                    onClick={() => adjustQuantityDraft(item.id, 1)}
                                                                    style={{
                                                                        ...ui.subButton,
                                                                        width: "100%",
                                                                        minWidth: 0,
                                                                        height: 34,
                                                                        padding: "0 6px",
                                                                        fontSize: 12,
                                                                        fontWeight: 700,
                                                                        background: "#dcfce7",
                                                                        color: "seagreen",
                                                                        border: "1px solid #bbf7d0",
                                                                    }}
                                                                >
                                                                    +1
                                                                </button>
                                                            </div>
                                                        </div>

                                                        <button
                                                            type="button"
                                                            onClick={() => handleQuantitySave(item)}
                                                            disabled={isQuickSaving}
                                                            style={{
                                                                ...ui.button,
                                                                width: "100%",
                                                                minWidth: 0,
                                                                height: "100%",
                                                                minHeight: 76,
                                                                padding: "0 10px",
                                                                fontSize: 13,
                                                                fontWeight: 800,
                                                                lineHeight: 1.2,
                                                                whiteSpace: "normal",
                                                                wordBreak: "keep-all",
                                                                opacity: isQuickSaving ? 0.6 : 1,
                                                                cursor: isQuickSaving ? "not-allowed" : "pointer",
                                                            }}
                                                        >
                                                            {lang === "vi" ? "Lưu nhanh" : "빠른저장"}
                                                        </button>
                                                    </div>

                                                    <div
                                                        style={{
                                                            fontSize: 12,
                                                            color: "#6b7280",
                                                            marginBottom: 10,
                                                            lineHeight: 1.4,
                                                        }}
                                                    >
                                                        {lang === "vi"
                                                            ? "Nhập số lượng mới hoặc bấm nút +/- rồi lưu nhanh."
                                                            : "새 수량 입력 또는 +/- 버튼 조정 후 빠른저장."}
                                                    </div>

                                                    <div style={ui.detailGrid}>
                                                        <div style={ui.detailLabel}>{t.supplier}</div>
                                                        <div style={ui.detailValue}>{item.supplier || "-"}</div>

                                                        <div style={ui.detailLabel}>{t.purchasePrice}</div>
                                                        <div style={ui.detailValue}>
                                                            {formatMoneyDisplay(item.purchase_price)}
                                                        </div>

                                                        <div style={ui.detailLabel}>{t.lowStockThreshold}</div>
                                                        <div style={ui.detailValue}>{item.low_stock_threshold ?? 1}</div>

                                                        <div style={ui.detailLabel}>{t.updatedAt}</div>
                                                        <div style={ui.detailValue}>
                                                            {item.updated_at
                                                                ? (() => {
                                                                    const d = new Date(item.updated_at);
                                                                    const yy = String(d.getFullYear()).slice(2);
                                                                    const mm = String(d.getMonth() + 1).padStart(2, "0");
                                                                    const dd = String(d.getDate()).padStart(2, "0");
                                                                    const hh = String(d.getHours()).padStart(2, "0");
                                                                    const min = String(d.getMinutes()).padStart(2, "0");
                                                                    return `${yy}.${mm}.${dd} ${hh}:${min} · ${item.updated_by_name || "-"}`;
                                                                })()
                                                                : "-"}
                                                        </div>

                                                        <div style={ui.detailLabel}>{t.note}</div>
                                                        <div style={ui.detailValue}>{item.note || "-"}</div>
                                                    </div>

                                                    {Number(item.quantity) <= Number(item.low_stock_threshold ?? 1) && (
                                                        <div
                                                            style={{
                                                                marginTop: 10,
                                                                color: "crimson",
                                                                fontWeight: "bold",
                                                                fontSize: 13,
                                                            }}
                                                        >
                                                            {t.stockLow}
                                                        </div>
                                                    )}

                                                    <div
                                                        style={{
                                                            display: "flex",
                                                            gap: 5,
                                                            marginTop: 6,
                                                            paddingTop: 0,
                                                            justifyContent: "flex-end",
                                                            flexWrap: "wrap",
                                                        }}
                                                    >
                                                        <button
                                                            onClick={() => fetchItemLogs(item)}
                                                            style={{
                                                                ...ui.subButton,
                                                                width: "auto",
                                                                minWidth: 58,
                                                                padding: "7px 12px",
                                                                fontSize: 13,
                                                                fontWeight: 700,
                                                            }}
                                                        >
                                                            {lang === "vi" ? "Log" : "로그"}
                                                        </button>

                                                        <button
                                                            onClick={() => handleEdit(item)}
                                                            style={{
                                                                ...ui.subButton,
                                                                width: "auto",
                                                                minWidth: 58,
                                                                padding: "7px 12px",
                                                                fontSize: 13,
                                                                background: "royalblue",
                                                                color: "white",
                                                                border: "1px solid royalblue",
                                                                fontWeight: 700,
                                                            }}
                                                        >
                                                            {t.edit}
                                                        </button>

                                                        <button
                                                            onClick={() => handleDelete(item.id)}
                                                            disabled={isDeletingId === item.id}
                                                            style={{
                                                                ...ui.subButton,
                                                                width: "auto",
                                                                minWidth: 58,
                                                                padding: "7px 12px",
                                                                fontSize: 13,
                                                                background: "crimson",
                                                                color: "white",
                                                                border: "1px solid crimson",
                                                                fontWeight: 700,
                                                                opacity: isDeletingId === item.id ? 0.6 : 1,
                                                                cursor: isDeletingId === item.id ? "not-allowed" : "pointer",
                                                            }}
                                                        >
                                                            {isDeletingId === item.id
                                                                ? (lang === "vi" ? "Đang xóa..." : "삭제 중...")
                                                                : t.delete}
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        ))}

                    </div>
                )}
            </div>

            {/* 재고입력 */}
            <button
                onClick={() => setIsFormOpen((prev) => !prev)}
                style={{
                    width: "100%",
                    marginBottom: 12,
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid #1f2937",

                    background: isFormOpen ? "#1f2937" : "#111827", // 🔥 핵심
                    color: "#ffffff",

                    fontSize: 14,
                    fontWeight: 700,
                    letterSpacing: "-0.2px",

                    cursor: "pointer",
                }}
            >
                {isFormOpen ? t.closeInventoryForm : t.openInventoryForm}
            </button>

            {isFormOpen && (
                <div
                    ref={formRef}
                    style={{
                        ...ui.card,
                        padding: 20,
                        marginBottom: 24,
                    }}
                >
                    <h2 style={ui.sectionTitle}>{t.inputTitle}</h2>

                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                        {/* 파트 */}
                        <div>
                            <div style={labelStyle}>
                                {lang === "vi" ? "Bộ phận" : "파트"}
                            </div>
                            <div
                                style={{
                                    display: "grid",
                                    gridTemplateColumns: "repeat(4, 1fr)",
                                    gap: 8,
                                }}
                            >
                                {[
                                    { value: "kitchen", label: t.kitchen },
                                    { value: "hall", label: t.hall },
                                    { value: "bar", label: t.bar },
                                    { value: "etc", label: t.etc },
                                ].map((partOption) => {
                                    const partValue = partOption.value as PartValue;
                                    const active = part === partValue;
                                    const meta = PART_META[partValue];

                                    return (
                                        <button
                                            key={partOption.value}
                                            type="button"
                                            onClick={() => setPart(partValue)}
                                            style={getPartButtonStyle(partValue, active)}
                                        >
                                            {meta.emoji} {partOption.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* 카테고리 */}
                        <div>
                            <div style={labelStyle}>
                                {lang === "vi" ? "Danh mục" : "카테고리"}
                            </div>
                            <select
                                value={isCustomCategory ? "__custom__" : category}
                                onChange={(e) => {
                                    const value = e.target.value;

                                    if (value === "__custom__") {
                                        setIsCustomCategory(true);
                                        setCategory("");
                                        setCategoryKo("");
                                        setCategoryVi("");
                                        return;
                                    }

                                    const selected = mergedCategoryOptions.find(
                                        (option) => option.label === value
                                    );

                                    setIsCustomCategory(false);
                                    setCategory(value);

                                    if (selected) {
                                        setCategoryKo(selected.ko);
                                        setCategoryVi(selected.vi);
                                    } else {
                                        if (lang === "vi") {
                                            setCategoryKo("");
                                            setCategoryVi(value);
                                        } else {
                                            setCategoryKo(value);
                                            setCategoryVi("");
                                        }
                                    }
                                }}
                                style={ui.input}
                            >
                                <option value="">{t.categoryPlaceholder}</option>

                                {mergedCategoryOptions.map((option) => (
                                    <option key={`${part}-${option.label}`} value={option.label}>
                                        {option.label}
                                    </option>
                                ))}

                                <option value="__custom__">
                                    {lang === "vi" ? "Nhập trực tiếp" : "직접 입력"}
                                </option>
                            </select>
                        </div>

                        {isCustomCategory && (
                            <div>
                                <div style={labelStyle}>
                                    {lang === "vi" ? "Danh mục mới" : "새 카테고리"}
                                </div>
                                <input
                                    type="text"
                                    placeholder={lang === "vi" ? "Nhập danh mục mới" : "새 카테고리 입력"}
                                    value={category}
                                    onChange={(e) => {
                                        const value = e.target.value;
                                        setCategory(value);

                                        if (lang === "vi") {
                                            setCategoryKo("");
                                            setCategoryVi(value);
                                        } else {
                                            setCategoryKo(value);
                                            setCategoryVi("");
                                        }
                                    }}
                                    style={ui.input}
                                    onKeyDown={(e) => handleKeyDown(e, itemNameRef)}
                                />
                            </div>
                        )}

                        {/* 코드 */}
                        <div>
                            <div style={labelStyle}>
                                {lang === "vi" ? "Mã" : "코드"}
                            </div>
                            <input
                                type="text"
                                placeholder={t.codePlaceholder}
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                                style={ui.input}
                            />
                        </div>

                        {/* 품목명 */}
                        <div>
                            <div style={labelStyle}>
                                {lang === "vi" ? "Tên sản phẩm" : "품목명"}
                            </div>
                            <input
                                type="text"
                                placeholder={t.itemNamePlaceholder}
                                value={itemName}
                                onChange={(e) => setItemName(e.target.value)}
                                style={ui.input}
                                ref={itemNameRef}
                                onKeyDown={(e) => handleKeyDown(e, supplierRef)}
                            />
                        </div>

                        {/* 거래처 */}
                        <div>
                            <div style={labelStyle}>
                                {lang === "vi" ? "Nhà cung cấp" : "거래처"}
                            </div>

                            <select
                                value={isCustomSupplier ? "__custom__" : supplier}
                                onChange={(e) => {
                                    const value = e.target.value;

                                    if (value === "__custom__") {
                                        setIsCustomSupplier(true);
                                        setSupplier("");
                                        return;
                                    }

                                    setIsCustomSupplier(false);
                                    setSupplier(value);
                                }}
                                style={ui.input}
                            >
                                <option value="">{t.supplierPlaceholder}</option>

                                {mergedSupplierOptions.map((option) => (
                                    <option key={option} value={option}>
                                        {option}
                                    </option>
                                ))}

                                <option value="__custom__">
                                    {lang === "vi" ? "Nhập trực tiếp" : "직접 입력"}
                                </option>
                            </select>
                        </div>

                        {isCustomSupplier && (
                            <div>
                                <div style={labelStyle}>
                                    {lang === "vi" ? "Nhà cung cấp mới" : "새 거래처"}
                                </div>
                                <input
                                    type="text"
                                    placeholder={lang === "vi" ? "Nhập nhà cung cấp mới" : "새 거래처 입력"}
                                    value={supplier}
                                    onChange={(e) => setSupplier(e.target.value)}
                                    style={ui.input}
                                    ref={supplierRef}
                                    onKeyDown={(e) => handleKeyDown(e, priceRef)}
                                />
                            </div>
                        )}

                        {/* 구매가 */}
                        <div>
                            <div style={labelStyle}>
                                {lang === "vi" ? "Giá nhập" : "구매가"}
                            </div>
                            <input
                                type="text"
                                placeholder={t.purchasePricePlaceholder}
                                value={purchasePrice}
                                onChange={(e) => {
                                    setPurchasePrice(formatNumber(e.target.value));
                                }}
                                style={ui.input}
                                ref={priceRef}
                                onKeyDown={(e) => handleKeyDown(e, unitRef)}
                            />
                        </div>

                        {/* 단위 */}
                        <div>
                            <div style={labelStyle}>
                                {lang === "vi" ? "Đơn vị" : "단위"}
                            </div>
                            <input
                                type="text"
                                placeholder={t.unitPlaceholder}
                                value={unit}
                                onChange={(e) => setUnit(e.target.value)}
                                style={ui.input}
                                ref={unitRef}
                                onKeyDown={(e) => handleKeyDown(e, quantityRef)}
                            />
                        </div>

                        <div
                            style={{
                                display: "flex",
                                gap: 8,
                                flexWrap: "wrap",
                                marginTop: -6,
                            }}
                        >
                            {["Kg", "g", "L", "ml", lang === "vi" ? "Chai" : "병"].map((u) => {
                                const active = unit === u;

                                return (
                                    <button
                                        key={u}
                                        type="button"
                                        onClick={() => setUnit(u)}
                                        style={getCategoryTabButtonStyle(active)}
                                    >
                                        {u}
                                    </button>
                                );
                            })}
                        </div>

                        {/* 수량 */}
                        <div>
                            <div style={labelStyle}>
                                {lang === "vi" ? "Số lượng" : "수량"}
                            </div>
                            <input
                                type="number"
                                step="0.1"
                                placeholder={t.quantityPlaceholder}
                                value={quantity}
                                onChange={(e) => setQuantity(e.target.value)}
                                style={ui.input}
                                ref={quantityRef}
                                onKeyDown={(e) => handleKeyDown(e, lowStockThresholdRef)}
                            />
                        </div>

                        {/* 부족기준 */}
                        <div>
                            <div style={labelStyle}>
                                {lang === "vi" ? "Ngưỡng thấp" : "부족기준"}
                            </div>
                            <input
                                type="number"
                                step="0.1"
                                placeholder={t.lowStockThresholdPlaceholder}
                                value={lowStockThreshold}
                                onChange={(e) => setLowStockThreshold(e.target.value)}
                                style={ui.input}
                                ref={lowStockThresholdRef}
                                onKeyDown={(e) => handleKeyDown(e, noteRef)}
                            />
                        </div>

                        {/* 비고 */}
                        <div>
                            <div style={labelStyle}>
                                {lang === "vi" ? "Ghi chú" : "비고"}
                            </div>
                            <input
                                type="text"
                                placeholder={t.notePlaceholder}
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                style={ui.input}
                                ref={noteRef}
                                onKeyDown={(e) => handleKeyDown(e)}
                            />
                        </div>

                        <button
                            onClick={handleSubmit}
                            disabled={isSubmitting}
                            style={{
                                ...ui.button,
                                opacity: isSubmitting ? 0.6 : 1,
                                cursor: isSubmitting ? "not-allowed" : "pointer",
                            }}
                        >
                            {isSubmitting
                                ? (lang === "vi" ? "Đang lưu..." : "저장 중...")
                                : editingId
                                    ? t.editSave
                                    : t.save}
                        </button>

                        {editingId && (
                            <button
                                onClick={() => resetForm()}
                                style={{
                                    ...ui.button,
                                    background: "#e5e7eb",
                                    color: "black",
                                    border: "1px solid #d1d5db",
                                }}
                            >
                                {t.cancelEdit}
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* 최근 변경 로그 */}
            <div
                style={{
                    ...ui.card,
                    padding: 16,
                    marginBottom: 18,
                }}
            >
                <h2 style={ui.sectionTitle}>{t.recentLogs}</h2>

                {recentLogs.length === 0 ? (
                    <div
                        style={{
                            height: 120,
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#9ca3af",
                            fontSize: 13,
                            gap: 6,
                        }}
                    >
                        <div style={{ fontSize: 20 }}>📭</div>
                        <div>{t.noLogs}</div>
                    </div>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        {recentLogs.map((log) => (
                            <div
                                key={log.id}
                                style={{
                                    ...ui.card,
                                    padding: "5px 8px",
                                    borderLeft:
                                        log.action === "create"
                                            ? "4px solid seagreen"
                                            : log.action === "delete"
                                                ? "4px solid crimson"
                                                : "4px solid royalblue",
                                    background: "#fff",
                                }}
                            >
                                <div style={ui.cardRow}>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: 6,
                                                flexWrap: "wrap",
                                            }}
                                        >
                                            <span
                                                style={{
                                                    ...ui.badgeMini,
                                                    background:
                                                        log.action === "create"
                                                            ? "seagreen"
                                                            : log.action === "delete"
                                                                ? "crimson"
                                                                : "royalblue",
                                                }}
                                            >
                                                {log.action === "create"
                                                    ? "NEW"
                                                    : log.action === "delete"
                                                        ? "DEL"
                                                        : "UP"}
                                            </span>

                                            <span
                                                style={{
                                                    fontSize: 14,
                                                    fontWeight: 700,
                                                    lineHeight: 1.2,
                                                    color: "#111827",
                                                    wordBreak: "break-word",
                                                }}
                                            >
                                                {[log.code ? `[${log.code}]` : "", getDisplayLogItemName(log)]
                                                    .filter(Boolean)
                                                    .join(" ")}
                                            </span>
                                        </div>

                                        <div style={ui.metaText}>
                                            {[getPartLabel(log.part || ""), getDisplayLogCategory(log)].join(" · ")}
                                        </div>
                                    </div>

                                    <div
                                        style={{
                                            textAlign: "right",
                                            flexShrink: 0,
                                            marginLeft: 10,
                                        }}
                                    >
                                        <div
                                            style={{
                                                fontSize: 14,
                                                fontWeight: 700,
                                                lineHeight: 1.2,
                                                whiteSpace: "nowrap",
                                            }}
                                        >
                                            <span
                                                style={{
                                                    color:
                                                        Number(log.change_quantity) > 0
                                                            ? "green"
                                                            : Number(log.change_quantity) < 0
                                                                ? "crimson"
                                                                : "#111827",
                                                }}
                                            >
                                                {Number(log.change_quantity) > 0 ? "+" : ""}
                                                {formatDecimalDisplay(log.change_quantity)}
                                            </span>{" "}
                                            <span style={{ color: "#111827" }}>{log.unit || ""}</span>
                                        </div>

                                        <div style={ui.metaText}>
                                            {[
                                                log.created_at
                                                    ? new Date(log.created_at).toLocaleTimeString([], {
                                                        hour: "2-digit",
                                                        minute: "2-digit",
                                                        hour12: false,
                                                    })
                                                    : "-",
                                                log.actor_name || "-",
                                            ].join(" · ")}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {quickSaveItem && (
                <div
                    style={{
                        position: "fixed",
                        inset: 0,
                        background: "rgba(0,0,0,0.45)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        zIndex: 1000,
                        padding: 20,
                    }}
                    onClick={() => {
                        setQuickSaveItem(null);
                        setQuickSaveReason(null);
                        setQuickSaveOtherText("");
                    }}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            width: "100%",
                            maxWidth: 360,
                            background: "#fff",
                            borderRadius: 14,
                            padding: 18,
                            boxShadow: "0 20px 50px rgba(0,0,0,0.2)",
                            display: "flex",
                            flexDirection: "column",
                            gap: 10,
                        }}
                    >
                        <div style={{ fontSize: 17, fontWeight: 800, color: "#111827" }}>
                            {t.quickReasonTitle}
                        </div>

                        <div style={{ ...ui.metaText, marginBottom: 4 }}>
                            {[quickSaveItem.code ? `[${quickSaveItem.code}]` : "", getDisplayItemName(quickSaveItem)]
                                .filter(Boolean)
                                .join(" ")}
                        </div>

                        <div
                            style={{
                                display: "grid",
                                gridTemplateColumns: "1fr 1fr",
                                gap: 8,
                            }}
                        >
                            <button
                                type="button"
                                onClick={() => handleQuickSaveConfirm("check")}
                                disabled={isQuickSaving}
                                style={{
                                    ...ui.subButton,
                                    opacity: isQuickSaving ? 0.6 : 1,
                                    cursor: isQuickSaving ? "not-allowed" : "pointer",
                                }}
                            >
                                {t.quickReasonCheck}
                            </button>

                            <button
                                type="button"
                                onClick={() => handleQuickSaveConfirm("purchase")}
                                disabled={isQuickSaving}
                                style={{
                                    ...ui.subButton,
                                    opacity: isQuickSaving ? 0.6 : 1,
                                    cursor: isQuickSaving ? "not-allowed" : "pointer",
                                }}
                            >
                                {t.quickReasonPurchase}
                            </button>

                            <button
                                type="button"
                                onClick={() => handleQuickSaveConfirm("service")}
                                disabled={isQuickSaving}
                                style={{
                                    ...ui.subButton,
                                    opacity: isQuickSaving ? 0.6 : 1,
                                    cursor: isQuickSaving ? "not-allowed" : "pointer",
                                }}
                            >
                                {t.quickReasonService}
                            </button>

                            <button
                                type="button"
                                onClick={() => setQuickSaveReason("other")}
                                disabled={isQuickSaving}
                                style={{
                                    ...ui.subButton,
                                    opacity: isQuickSaving ? 0.6 : 1,
                                    cursor: isQuickSaving ? "not-allowed" : "pointer",
                                }}
                            >
                                {t.quickReasonOther}
                            </button>
                        </div>

                        {quickSaveReason === "other" && (
                            <>
                                <input
                                    type="text"
                                    value={quickSaveOtherText}
                                    onChange={(e) => setQuickSaveOtherText(e.target.value)}
                                    placeholder={t.quickReasonOtherPlaceholder}
                                    style={ui.input}
                                />
                                <button
                                    type="button"
                                    onClick={() => handleQuickSaveConfirm("other")}
                                    disabled={isQuickSaving}
                                    style={{
                                        ...ui.button,
                                        opacity: isQuickSaving ? 0.6 : 1,
                                        cursor: isQuickSaving ? "not-allowed" : "pointer",
                                    }}
                                >
                                    {isQuickSaving
                                        ? (lang === "vi" ? "Đang lưu..." : "저장 중...")
                                        : t.editSave}
                                </button>
                            </>
                        )}

                        <button
                            type="button"
                            onClick={() => {
                                setQuickSaveItem(null);
                                setQuickSaveReason(null);
                                setQuickSaveOtherText("");
                            }}
                            style={{
                                ...ui.subButton,
                                marginTop: 4,
                            }}
                        >
                            {lang === "vi" ? "Đóng" : "닫기"}
                        </button>
                    </div>
                </div>
            )}

            {logModalItem && (
                <div
                    style={{
                        position: "fixed",
                        inset: 0,
                        background: "rgba(0,0,0,0.45)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        zIndex: 1000,
                        padding: 20,
                    }}
                    onClick={() => {
                        setLogModalItem(null);
                        setItemLogs([]);
                    }}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            width: "100%",
                            maxWidth: 560,
                            maxHeight: "80vh",
                            overflow: "hidden",
                            background: "#fff",
                            borderRadius: 14,
                            padding: 18,
                            boxShadow: "0 20px 50px rgba(0,0,0,0.2)",
                            display: "flex",
                            flexDirection: "column",
                            gap: 12,
                        }}
                    >
                        <div style={{ fontSize: 17, fontWeight: 800, color: "#111827" }}>
                            {lang === "vi" ? "Lịch sử vật phẩm" : "품목 로그"}
                        </div>

                        <div style={{ ...ui.metaText }}>
                            {[logModalItem.code ? `[${logModalItem.code}]` : "", getDisplayItemName(logModalItem)]
                                .filter(Boolean)
                                .join(" ")}
                        </div>

                        <div
                            style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 8,
                                overflowY: "auto",
                                paddingRight: 4,
                            }}
                        >
                            {isItemLogsLoading ? (
                                <div>{lang === "vi" ? "Đang tải..." : "불러오는 중..."}</div>
                            ) : itemLogGroups.length === 0 ? (
                                <div>{lang === "vi" ? "Không có log" : "로그 없음"}</div>
                            ) : (
                                itemLogGroups.map((group) => {
                                    const log = group.latest;

                                    return (
                                        <InventoryLogGroupCard
                                            key={group.groupKey}
                                            group={group}
                                            isOpen={true}
                                            lang={lang}
                                            noteText={group.noteKey || "-"}
                                            partLabel={getPartLabel(log.part || "")}
                                            itemName={getDisplayLogItemName(log)}
                                            categoryName={getDisplayLogCategory(log)}
                                            detailLabel={t.detail}
                                            closeLabel={t.close}
                                            deleteLabel={t.delete}
                                            isMaster={false}
                                            getActionBadge={getActionBadge}
                                            getActionColor={getActionColor}
                                            formatDateTime={formatDateTime}
                                            getLogChanges={getLogChanges}
                                        />
                                    );
                                })
                            )}
                        </div>

                        <button
                            type="button"
                            onClick={() => {
                                setLogModalItem(null);
                                setItemLogs([]);
                            }}
                            style={ui.subButton}
                        >
                            {lang === "vi" ? "Đóng" : "닫기"}
                        </button>
                    </div>
                </div>
            )}
        </Container>
    );
}