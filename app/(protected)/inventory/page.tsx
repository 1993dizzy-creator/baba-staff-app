"use client";

import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "@/lib/language-context";
import { commonText, inventoryText } from "@/lib/text";
import Container from "@/components/Container";
import { ui } from "@/lib/styles/ui";
import { getUser, isAdmin } from "@/lib/supabase/auth";
import InventoryLogGroupCard from "@/components/InventoryLogGroupCard";
import { usePathname, useSearchParams } from "next/navigation";
import SubNav from "@/components/SubNav";
import { getInventoryTabs } from "@/lib/navigation/inventory-tabs";
import {PART_VALUES, PART_META, type PartValue,} from "@/lib/common/parts";
import {
    INVENTORY_REASON_EMOJIS,
    INVENTORY_REASON_LABELS,
    type InventoryRegistrationType,
    type QuickReasonValue,
} from "@/lib/inventory/reasons";
import { CATEGORY_OPTIONS_BY_PART } from "@/lib/inventory/categories";
import { parseDecimal,formatDecimalDisplay,roundDecimal,} from "@/lib/inventory/number";
import { formatNumber,parsePrice,formatMoneyDisplay,} from "@/lib/inventory/money";
import { isInCurrentBusinessDay } from "@/lib/inventory/business-day";

type InventoryItem = {
    id: number;
    item_name?: string | null;
    item_name_vi?: string | null;
    part?: string | null;
    category?: string | null;
    category_vi?: string | null;
    quantity?: string | number | null;
    unit?: string | null;
    note?: string | null;
    purchase_price?: string | number | null;
    supplier?: string | null;
    code?: string | null;
    low_stock_threshold?: string | number | null;
    image_path?: string | null;
    updated_at?: string | null;
    updated_by_name?: string | null;
};

type DuplicateInventoryItem = Pick<
    InventoryItem,
    "id" | "item_name" | "item_name_vi" | "code" | "part" | "category" | "category_vi"
>;

type InventoryItemMutationResult = {
    ok?: boolean;
    error?: string;
    message?: string;
    data?: InventoryItem;
    duplicateItem?: DuplicateInventoryItem;
};

type EditFormPendingSave = {
    id: number;
    payload: Record<string, unknown>;
};

type InventoryLog = {
    id: number;
    item_id?: number | null;
    item_name?: string | null;
    item_name_vi?: string | null;
    action?: string | null;
    part?: string | null;
    category?: string | null;
    category_vi?: string | null;
    prev_quantity?: string | number | null;
    new_quantity?: string | number | null;
    change_quantity?: string | number | null;
    prev_purchase_price?: string | number | null;
    new_purchase_price?: string | number | null;
    prev_note?: string | null;
    new_note?: string | null;
    prev_supplier?: string | null;
    new_supplier?: string | null;
    prev_code?: string | null;
    new_code?: string | null;
    prev_unit?: string | null;
    new_unit?: string | null;
    prev_category?: string | null;
    new_category?: string | null;
    prev_category_vi?: string | null;
    new_category_vi?: string | null;
    prev_part?: string | null;
    new_part?: string | null;
    prev_low_stock_threshold?: string | number | null;
    new_low_stock_threshold?: string | number | null;
    unit?: string | null;
    code?: string | null;
    created_at?: string | null;
    actor_name?: string | null;
    reason?: string | null;
    source?: string | null;
    business_date?: string | null;
};

type InventoryLogGroup = {
    item_id: number;
    noteKey: string;
    groupKey: string;
    latest: InventoryLog;
    logs: InventoryLog[];
};

const normalizeSearchText = (value: unknown) =>
    String(value ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .toLowerCase()
        .trim();

const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : "Server error";

const INVENTORY_IMAGE_BUCKET = "inventory-images";
const MAX_ORIGINAL_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_COMPRESSED_IMAGE_BYTES = 1024 * 1024;
const MAX_IMAGE_SIDE = 900;
const IMAGE_QUALITY = 0.72;
const JPEG_FALLBACK_QUALITY = 0.78;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const UNSUPPORTED_MOBILE_IMAGE_TYPES = new Set(["image/heic", "image/heif"]);
const UNSUPPORTED_IMAGE_MESSAGE =
    "이 사진 형식은 업로드할 수 없습니다. 카메라 설정에서 JPG로 촬영하거나, 갤러리에서 JPG/PNG로 변환 후 다시 시도해주세요.";
const COMPRESSED_IMAGE_TOO_LARGE_MESSAGE =
    "압축 후 이미지가 1MB를 초과했습니다. 조금 더 작은 사진으로 다시 시도해주세요.";

const getInventoryImageUrl = (imagePath?: string | null) => {
    if (!imagePath) return "";

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!supabaseUrl) return "";

    const encodedPath = imagePath
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/");

    return `${supabaseUrl}/storage/v1/object/public/${INVENTORY_IMAGE_BUCKET}/${encodedPath}`;
};

const getFileExtension = (fileName: string) => {
    const extension = fileName.split(".").pop()?.toLowerCase() || "";
    return extension;
};

const getImageType = (file: File) => {
    if (file.type) return file.type;

    const extension = getFileExtension(file.name);
    if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
    if (extension === "png") return "image/png";
    if (extension === "webp") return "image/webp";
    if (extension === "heic") return "image/heic";
    if (extension === "heif") return "image/heif";
    return "";
};

const canvasToBlob = (
    canvas: HTMLCanvasElement,
    type: "image/webp" | "image/jpeg",
    quality: number
) =>
    new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, type, quality);
    });

const getPhotoUploadErrorMessage = (error?: string, message?: string) => {
    if (error === "file_too_large") return COMPRESSED_IMAGE_TOO_LARGE_MESSAGE;
    if (error === "unsupported_file_type") return UNSUPPORTED_IMAGE_MESSAGE;
    if (error === "storage_bucket_not_found") {
        return "사진 저장소 설정을 찾을 수 없습니다. 관리자에게 문의해주세요.";
    }
    if (error === "storage_upload_failed") {
        return "사진 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
    }
    if (error === "missing_server_env") {
        return "서버 사진 업로드 설정이 누락되었습니다. 관리자에게 문의해주세요.";
    }
    if (error === "database_update_failed") {
        return "사진은 저장됐지만 품목 정보 업데이트에 실패했습니다. 관리자에게 문의해주세요.";
    }
    if (error === "form_data_parse_failed") {
        return "업로드 데이터를 읽지 못했습니다. 사진을 다시 선택해주세요.";
    }
    if (error === "missing_file") return "사진 파일을 찾을 수 없습니다. 다시 선택해주세요.";
    if (error === "invalid_user") return "사용자 확인에 실패했습니다. 다시 로그인해주세요.";

    return message || "사진 업로드에 실패했습니다.";
};

const compressInventoryImage = async (file: File) => {
    const imageType = getImageType(file);

    console.info("[INVENTORY_PHOTO_SELECTED_FILE]", {
        name: file.name,
        type: file.type || "(empty)",
        inferredType: imageType || "(unknown)",
        size: file.size,
    });

    if (UNSUPPORTED_MOBILE_IMAGE_TYPES.has(imageType)) {
        throw new Error(UNSUPPORTED_IMAGE_MESSAGE);
    }

    if (!ALLOWED_IMAGE_TYPES.has(imageType)) {
        throw new Error(UNSUPPORTED_IMAGE_MESSAGE);
    }

    if (file.size > MAX_ORIGINAL_IMAGE_BYTES) {
        throw new Error("원본 이미지가 5MB를 초과했습니다. 조금 더 작은 사진으로 다시 시도해주세요.");
    }

    const objectUrl = URL.createObjectURL(file);

    try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("Failed to load image"));
            img.src = objectUrl;
        });

        const ratio = Math.min(
            1,
            MAX_IMAGE_SIDE / Math.max(image.naturalWidth, image.naturalHeight)
        );
        const width = Math.max(1, Math.round(image.naturalWidth * ratio));
        const height = Math.max(1, Math.round(image.naturalHeight * ratio));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext("2d");
        if (!context) throw new Error("Failed to prepare image");

        context.drawImage(image, 0, 0, width, height);

        const webpBlob = await canvasToBlob(canvas, "image/webp", IMAGE_QUALITY);
        const blob =
            webpBlob && webpBlob.size > 0
                ? webpBlob
                : await canvasToBlob(canvas, "image/jpeg", JPEG_FALLBACK_QUALITY);
        const compressedType =
            webpBlob && webpBlob.size > 0 ? "image/webp" : "image/jpeg";

        if (!blob) throw new Error("Failed to compress image");

        if (blob.size > MAX_COMPRESSED_IMAGE_BYTES) {
            throw new Error(COMPRESSED_IMAGE_TOO_LARGE_MESSAGE);
        }

        return new File(
            [blob],
            compressedType === "image/webp" ? "main.webp" : "main.jpg",
            { type: compressedType }
        );
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
};


export default function InventoryPage() {

    const currentUser = getUser();
    const actorName = currentUser?.name || "";
    const actorUsername = currentUser?.username || "";
    const canDeleteInventoryItem = isAdmin(currentUser);

    const defaultPart: PartValue =
        PART_VALUES.includes(currentUser?.part as PartValue)
            ? (currentUser?.part as PartValue)
            : "kitchen";

    const { lang } = useLanguage();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const t = inventoryText[lang];
    const c = commonText[lang];
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
    const [formPhotoFile, setFormPhotoFile] = useState<File | null>(null);
    const [formPhotoPreviewUrl, setFormPhotoPreviewUrl] = useState("");
    const [isFormPhotoProcessing, setIsFormPhotoProcessing] = useState(false);

    const [inventoryList, setInventoryList] = useState<InventoryItem[]>([]);
    const [recentLogs, setRecentLogs] = useState<InventoryLog[]>([]);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [openItemId, setOpenItemId] = useState<number | null>(null);
    const [isFormOpen, setIsFormOpen] = useState(false);
    const [isRegistrationTypeModalOpen, setIsRegistrationTypeModalOpen] = useState(false);
    const [registrationType, setRegistrationType] =
        useState<InventoryRegistrationType | null>(null);

    const [search, setSearch] = useState("");
    const [partFilter, setPartFilter] = useState<PartValue>(defaultPart);
    const [categoryFilter, setCategoryFilter] = useState("all");
    const [showLowStockOnly, setShowLowStockOnly] = useState(false);
    const [showTodayUpdatedOnly, setShowTodayUpdatedOnly] = useState(false);
    const [quantityDrafts, setQuantityDrafts] = useState<Record<number, string>>({});
    const [latestSnapshotMap, setLatestSnapshotMap] = useState<Record<number, number>>({});
    const [latestSnapshotDate, setLatestSnapshotDate] = useState<string>("");
    const [quickSaveItem, setQuickSaveItem] = useState<InventoryItem | null>(null);
    const [quickSaveReason, setQuickSaveReason] = useState<
        QuickReasonValue | null
    >(null);
    const [quickSaveOtherText, setQuickSaveOtherText] = useState("");
    const [quickPurchaseSupplier, setQuickPurchaseSupplier] = useState("");
    const [quickPurchasePrice, setQuickPurchasePrice] = useState("");
    const [isQuickPurchaseCustomSupplier, setIsQuickPurchaseCustomSupplier] =
        useState(false);
    const [editFormPendingSave, setEditFormPendingSave] =
        useState<EditFormPendingSave | null>(null);
    const [isEditReasonSaving, setIsEditReasonSaving] = useState(false);
    const [logModalItem, setLogModalItem] = useState<InventoryItem | null>(null);
    const [itemLogs, setItemLogs] = useState<InventoryLog[]>([]);
    const [isItemLogsLoading, setIsItemLogsLoading] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isDeletingId, setIsDeletingId] = useState<number | null>(null);
    const [isQuickSaving, setIsQuickSaving] = useState(false);
    const [photoBusyItemId, setPhotoBusyItemId] = useState<number | null>(null);
    const [photoModalItem, setPhotoModalItem] = useState<InventoryItem | null>(null);
    const [handledDeepLinkKey, setHandledDeepLinkKey] = useState("");
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

    const getDisplayItemName = (item: InventoryItem) =>
        lang === "vi"
            ? item.item_name_vi || item.item_name || "-"
            : item.item_name || item.item_name_vi || "-";

    const getDisplayCategory = (item: InventoryItem) =>
        lang === "vi"
            ? item.category_vi || item.category || "-"
            : item.category || item.category_vi || "-";

    const getCategoryKey = (item: InventoryItem) =>
        item.category || item.category_vi || "-";

    const getDisplayLogItemName = (log: InventoryLog) =>
        lang === "vi"
            ? log.item_name_vi || log.item_name || "-"
            : log.item_name || log.item_name_vi || "-";

    const getDisplayLogCategory = (log: InventoryLog) =>
        lang === "vi"
            ? log.category_vi || log.category || "-"
            : log.category || log.category_vi || "-";

    const getDisplayPhotoLogNote = (note?: string | null) => {
        if (note === "품목 사진 추가") return t.photoAdded;
        if (note === "품목 사진 변경") return t.photoChanged;
        if (note === "품목 사진 삭제") return t.photoDeleted;
        return note || "-";
    };

    const getInventoryReasonLabel = (reason?: string | null) => {
        if (
            reason === "purchase" ||
            reason === "stock_check" ||
            reason === "service" ||
            reason === "other" ||
            reason === "sale_deduction" ||
            reason === "unclassified"
        ) {
            return INVENTORY_REASON_LABELS[lang][reason];
        }

        return INVENTORY_REASON_LABELS[lang].unclassified;
    };

    const getInventoryReasonBadgeText = (reason?: string | null) => {
        if (
            reason !== "purchase" &&
            reason !== "stock_check" &&
            reason !== "service" &&
            reason !== "other" &&
            reason !== "sale_deduction" &&
            reason !== "unclassified"
        ) {
            return "";
        }

        return `${INVENTORY_REASON_EMOJIS[reason]} ${getInventoryReasonLabel(reason)}`;
    };

    const isSalesInventoryLog = (log?: InventoryLog | null) =>
        log?.reason === "sale_deduction" || log?.source === "pos_sales";

    const getInventoryReasonBadgeStyle = (reason?: string | null) =>
        reason === "sale_deduction"
            ? {
                background: "#fff1f2",
                color: "#9f1239",
                border: "1px solid #fecdd3",
            }
            : undefined;

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

    const getLogChanges = (log: InventoryLog, lang: string) => {
        const changes: {
            label: string;
            before?: string;
            after: string;
            color?: string;
        }[] = [];

        if (log.action === "create") {
            changes.push({
                label: c.create,
                after: `${log.new_quantity ?? 0}${log.unit ? ` ${log.unit}` : ""}`,
                color: "seagreen",
            });
            return changes;
        }

        if (log.action === "delete") {
            changes.push({
                label: c.delete,
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
                label: c.quantity,
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

        if (log.source === "photo" && log.new_note) {
            changes.push({
                label: t.photoLogLabel,
                after: getDisplayPhotoLogNote(log.new_note),
            });
            return changes;
        }

        if (
            log.action === "update" &&
            log.source === "edit_form" &&
            roundDecimal(Number(log.change_quantity ?? 0)) === 0 &&
            log.reason
        ) {
            changes.push({
                label: c.note,
                after: `${t.editInfoUpdatedNote} (${getInventoryReasonLabel(log.reason)})`,
            });
        }

        if ((log.prev_note || "") !== (log.new_note || "") && log.new_note) {
            changes.push({
                label: c.note,
                after: log.new_note || "-",
            });
        }

        if ((log.prev_supplier || "") !== (log.new_supplier || "")) {
            changes.push({
                label: lang === "vi" ? "Nơi mua trước" : "이전구매처",
                before: log.prev_supplier || "-",
                after: log.new_supplier || "-",
            });
        }

        if ((log.prev_code || "") !== (log.new_code || "")) {
            changes.push({
                label: c.code,
                before: log.prev_code || "-",
                after: log.new_code || "-",
            });
        }

        if ((log.prev_unit || "") !== (log.new_unit || "")) {
            changes.push({
                label: c.unit,
                before: log.prev_unit || "-",
                after: log.new_unit || "-",
            });
        }

        if ((log.prev_category || "") !== (log.new_category || "")) {
            changes.push({
                label: c.category,
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
                label: c.part,
                before: log.prev_part
                    ? String(c[log.prev_part as keyof typeof c] || log.prev_part)
                    : "-",
                after: log.new_part
                    ? String(c[log.new_part as keyof typeof c] || log.new_part)
                    : "-",
            });
        }

        if (
            parseDecimal(log.prev_low_stock_threshold ?? 1) !==
            parseDecimal(log.new_low_stock_threshold ?? 1)
        ) {
            changes.push({
                label: t.lowStockThreshold,
                before: String(log.prev_low_stock_threshold ?? 1),
                after: String(log.new_low_stock_threshold ?? 1),
            });
        }

        if (
            log.prev_purchase_price !== log.new_purchase_price &&
            !(log.prev_purchase_price == null && log.new_purchase_price == null)
        ) {
            changes.push({
                label: lang === "vi" ? "Giá trước" : "이전가격",
                before: formatMoneyDisplay(log.prev_purchase_price),
                after: formatMoneyDisplay(log.new_purchase_price),
            });
        }

        if (changes.length === 0) {
            if (log.source === "edit_form") {
                changes.push({
                    label: c.itemName,
                    after: getDisplayLogItemName(log),
                });
                return changes;
            }

            changes.push({
                label: c.update,
                after: c.noData,
            });
        }

        return changes;
    };

    const getQuickReasonLabel = (
        reason: QuickReasonValue,
        customText?: string
    ) => {
        if (reason === "purchase") return INVENTORY_REASON_LABELS[lang].purchase;
        if (reason === "stock_check") return INVENTORY_REASON_LABELS[lang].stock_check;
        if (reason === "service") return INVENTORY_REASON_LABELS[lang].service;
        return customText?.trim() || c.etc;
    };

    const buildQuickChangeNote = ({
        currentQty,
        nextQty,
        reason,
        customText,
    }: {
        currentQty: number;
        nextQty: number;
        reason: QuickReasonValue;
        customText?: string;
    }) => {
        const diff = nextQty - currentQty;
        const diffText = `${diff > 0 ? "+" : ""}${formatDecimalDisplay(diff)}`;
        const reasonLabel = getQuickReasonLabel(reason, customText);
        return `${diffText} (${reasonLabel})`;
    };

    const fetchInventory = async () => {
        const url = "/api/inventory/items";

        try {
            const res = await fetch(url, {
                cache: "no-store",
            });
            const contentType = res.headers.get("content-type") || "";
            const bodyText = await res.text();
            const bodyPreview = bodyText.slice(0, 1000);
            let parseErrorMessage: string | null = null;
            let parsedJson: unknown = {};

            try {
                parsedJson = bodyText ? JSON.parse(bodyText) : {};
            } catch (error) {
                parseErrorMessage = error instanceof Error ? error.message : String(error);
            }

            const result = parsedJson && typeof parsedJson === "object"
                ? parsedJson as {
                    ok?: boolean;
                    data?: InventoryItem[];
                    error?: string;
                    message?: string;
                }
                : {};

            if (!res.ok || !result.ok) {
                console.warn("[inventory] fetchInventory failed", {
                    status: res.status,
                    statusText: res.statusText,
                    url,
                    contentType,
                    error: result.error,
                    message: result.message,
                    json: result,
                    bodyPreview,
                    parseError: parseErrorMessage,
                });
                return;
            }

            setInventoryList(result.data || []);
        } catch (error) {
            console.warn("[inventory] fetchInventory exception", {
                url,
                error,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    };

    const fetchRecentLogs = async () => {
        const url = "/api/inventory/logs/recent";

        try {
            const res = await fetch(url, {
                cache: "no-store",
            });
            const contentType = res.headers.get("content-type") || "";
            const bodyText = await res.text();
            const bodyPreview = bodyText.slice(0, 1000);
            let parseErrorMessage: string | null = null;
            let parsedJson: unknown = {};

            try {
                parsedJson = bodyText ? JSON.parse(bodyText) : {};
            } catch (error) {
                parseErrorMessage = error instanceof Error ? error.message : String(error);
            }

            const result = parsedJson && typeof parsedJson === "object"
                ? parsedJson as {
                    ok?: boolean;
                    data?: InventoryLog[];
                    error?: string;
                    message?: string;
                }
                : {};

            if (!res.ok || !result.ok) {
                console.warn("[inventory] fetchRecentLogs failed", {
                    status: res.status,
                    statusText: res.statusText,
                    url,
                    contentType,
                    error: result.error,
                    message: result.message,
                    json: result,
                    bodyPreview,
                    parseError: parseErrorMessage,
                });
                return;
            }

            setRecentLogs(result.data || []);
        } catch (error) {
            console.warn("[inventory] fetchRecentLogs exception", {
                url,
                error,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    };

    const fetchItemLogs = async (item: InventoryItem) => {
        setLogModalItem(item);
        setIsItemLogsLoading(true);

        try {
            const res = await fetch(`/api/inventory/items/${item.id}/logs`, {
                cache: "no-store",
            });

            const result = await res.json();

            if (!res.ok || !result.ok) {
                console.error(result);
                setItemLogs([]);
                return;
            }

            setItemLogs(result.data || []);
        } finally {
            setIsItemLogsLoading(false);
        }
    };

    const fetchLatestSnapshot = async () => {
        const res = await fetch("/api/inventory/snapshot/latest", {
            cache: "no-store",
        });

        const result = await res.json();

        if (!res.ok || !result.ok) {
            console.error(result);
            return;
        }

        setLatestSnapshotMap(result.data?.snapshotMap || {});
        setLatestSnapshotDate(result.data?.snapshotDate || "");
    };

    const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim();

    const clearFormPhotoDraft = () => {
        if (formPhotoPreviewUrl) {
            URL.revokeObjectURL(formPhotoPreviewUrl);
        }

        setFormPhotoFile(null);
        setFormPhotoPreviewUrl("");
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
        setRegistrationType(null);
        setIsCustomCategory(false);
        setIsCustomSupplier(false);
        setCategoryKo("");
        setCategoryVi("");
        clearFormPhotoDraft();
    };

    const getDuplicatePartLabel = (partValue?: string | null) => {
        if (partValue === "kitchen") return c.kitchen;
        if (partValue === "hall") return c.hall;
        if (partValue === "bar") return c.bar;
        if (partValue === "etc") return c.etc;
        return "";
    };

    const getDuplicateItemAlertMessage = (duplicateItem?: DuplicateInventoryItem | null) => {
        const partLabel = getDuplicatePartLabel(duplicateItem?.part);
        const categoryLabel =
            lang === "vi"
                ? duplicateItem?.category_vi || duplicateItem?.category || ""
                : duplicateItem?.category || duplicateItem?.category_vi || "";
        const location = [partLabel, categoryLabel].filter(Boolean).join("/");

        return location
            ? t.duplicateItemRegistered(location)
            : t.duplicateItemRegisteredFallback;
    };

    const isDuplicateInventoryItemResult = (
        res: Response,
        result: InventoryItemMutationResult
    ) =>
        res.status === 409 &&
        result.error === "inventory_item_duplicate_name_vi";

    const readInventoryItemMutationResult = async (
        res: Response,
        action: "save" | "edit"
    ): Promise<InventoryItemMutationResult | null> => {
        try {
            return await res.json();
        } catch (error) {
            console.error(`inventory ${action} invalid json response`, {
                status: res.status,
                error,
            });
            alert(action === "edit" ? c.editFail : c.saveFail);
            return null;
        }
    };

    const handleInventoryItemMutationFailure = (
        res: Response,
        result: InventoryItemMutationResult,
        action: "save" | "edit"
    ) => {
        if (isDuplicateInventoryItemResult(res, result)) {
            alert(getDuplicateItemAlertMessage(result.duplicateItem));
            return;
        }

        console.error(`inventory ${action} failed`, {
            status: res.status,
            result,
        });
        alert(result.message || (action === "edit" ? c.editFail : c.saveFail));
    };

    const closeEditReasonModal = () => {
        if (isEditReasonSaving) return;
        setEditFormPendingSave(null);
    };

    const handleEditReasonConfirm = async (reason: QuickReasonValue) => {
        if (!editFormPendingSave || isEditReasonSaving) return;

        setIsEditReasonSaving(true);

        try {
            const res = await fetch("/api/inventory/items", {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    id: editFormPendingSave.id,
                    payload: editFormPendingSave.payload,
                    actorName,
                    actorUsername,
                    source: "edit_form",
                    reason,
                }),
            });

            const result = await readInventoryItemMutationResult(res, "edit");
            if (!result) return;

            if (!res.ok || !result.ok) {
                handleInventoryItemMutationFailure(res, result, "edit");
                return;
            }

            alert(c.editSuccess);
            setEditFormPendingSave(null);
            await fetchInventory();
            await fetchRecentLogs();
            resetForm();
            setIsFormOpen(false);
            itemNameRef.current?.focus();
        } finally {
            setIsEditReasonSaving(false);
        }
    };

    const handleDelete = async (id: number) => {
        if (isDeletingId === id) return;

        const ok = confirm(c.deleteConfirm);
        if (!ok) return;

        setIsDeletingId(id);

        try {
            const targetItem = inventoryList.find((item) => item.id === id);

            if (!targetItem) {
                alert(c.noData);
                return;
            }

            const url = "/api/inventory/items";

            type DeleteInventoryResult = {
                ok?: boolean;
                error?: string;
                message?: string;
                warning?: string;
                inventoryLogCount?: number;
                inventoryPriceLogCount?: number;
                inventorySnapshotItemCount?: number;
                posMappingCount?: number;
                failedDeductionCount?: number;
                appliedDeductionCount?: number;
            };

            const deleteInventoryItem = async (deleteRelatedHistory = false) => {
                const res = await fetch(url, {
                    method: "DELETE",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        id,
                        actorName,
                        actorUsername,
                        ...(deleteRelatedHistory
                            ? { deleteRelatedHistory: true, deletePosReferences: true }
                            : {}),
                    }),
                });

                let result: DeleteInventoryResult;

                try {
                    result = await res.json();
                } catch (error) {
                    console.error("delete inventory item invalid json response", {
                        status: res.status,
                        url,
                        error,
                    });
                    return {
                        res,
                        result: {
                            ok: false,
                            message: c.deleteFail,
                        },
                    };
                }

                return { res, result };
            };

            const showDeleteFailure = (
                res: Response,
                result: DeleteInventoryResult
            ) => {
                console.error("delete inventory item failed", {
                    status: res.status,
                    url,
                    result,
                });

                if (res.status === 403) {
                    alert(c.noPermission);
                    return;
                }

                if (result.error === "pos_item_mappings_delete_failed") {
                    alert(result.message || t.deleteLinkedPosMappingFailed);
                    return;
                }

                if (result.error === "pos_inventory_deductions_delete_failed") {
                    alert(result.message || t.deleteLinkedPosReferenceFailed);
                    return;
                }

                if (
                    result.error === "inventory_logs_delete_failed" ||
                    result.error === "inventory_price_logs_delete_failed" ||
                    result.error === "inventory_snapshot_items_delete_failed"
                ) {
                    alert(result.message || c.deleteFail);
                    return;
                }

                alert(result.message || c.deleteFail);
            };

            const getDeleteRelatedHistoryConfirmMessage = (
                result: DeleteInventoryResult
            ) => {
                if ((result.appliedDeductionCount ?? 0) > 0) {
                    return t.deleteLinkedAppliedPosDeductionConfirm;
                }

                if (
                    (result.inventoryLogCount ?? 0) > 0 ||
                    (result.inventoryPriceLogCount ?? 0) > 0 ||
                    (result.inventorySnapshotItemCount ?? 0) > 0
                ) {
                    return t.deleteLinkedInventoryHistoryConfirm;
                }

                if ((result.failedDeductionCount ?? 0) > 0) {
                    return t.deleteLinkedFailedPosDeductionConfirm;
                }

                return t.deleteLinkedPosMappingConfirm;
            };

            const firstDelete = await deleteInventoryItem();
            const { res, result } = firstDelete;

            if (
                res.status === 409 &&
                (result.error === "inventory_item_has_related_history" ||
                    result.error === "inventory_item_has_pos_references" ||
                    result.error === "inventory_item_has_pos_mappings")
            ) {
                const confirmed = confirm(
                    getDeleteRelatedHistoryConfirmMessage(result)
                );
                if (!confirmed) return;

                const forceDelete = await deleteInventoryItem(true);

                if (!forceDelete.res.ok || !forceDelete.result.ok) {
                    showDeleteFailure(forceDelete.res, forceDelete.result);
                    return;
                }
            } else if (!res.ok || !result.ok) {
                showDeleteFailure(res, result);
                return;
            }

            await fetchInventory();
            await fetchRecentLogs();
        } finally {
            setIsDeletingId(null);
        }
    };

    const handleEdit = (item: InventoryItem) => {
        const nextPart: PartValue = PART_VALUES.includes(item.part as PartValue)
            ? (item.part as PartValue)
            : defaultPart;
        const nextCategory = lang === "vi" ? item.category_vi || "" : item.category || "";
        const nextCategoryOptions =
            CATEGORY_OPTIONS_BY_PART[nextPart as keyof typeof CATEGORY_OPTIONS_BY_PART] ?? [];
        const nextItemName =
            lang === "vi"
                ? item.item_name_vi || item.item_name || ""
                : item.item_name || item.item_name_vi || "";

        setIsFormOpen(true);
        setIsRegistrationTypeModalOpen(false);
        setRegistrationType(null);
        clearFormPhotoDraft();
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

            // ===================== 수정 =====================
            if (editingId) {
                if (nextQuantity < 0) {
                    alert(t.quantityCannotBeNegative);
                    return;
                }

                const targetItem = inventoryList.find((item) => item.id === editingId);

                if (!targetItem) {
                    alert(c.editFail);
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
                    normalizeText(targetItem.unit || "") !== normalizedUnit ||
                    normalizeText(targetItem.note || "") !== normalizedNote ||
                    (targetItem.part || "") !== part ||
                    parseDecimal(targetItem.quantity ?? 0) !== nextQuantity ||
                    (targetItem.purchase_price ?? null) !== nextPurchasePrice ||
                    normalizeText(targetItem.supplier || "") !== normalizedSupplier ||
                    normalizeText(targetItem.code || "") !== normalizedCode ||
                    parseDecimal(targetItem.low_stock_threshold ?? 1) !== nextLowStock;

                if (!hasChanges) {
                    alert(t.noAdditionalChanges);
                    return;
                }

                const payload =
                    lang === "ko"
                        ? {
                            item_name: normalizedItemName,
                            category: normalizedCategoryKo,
                            category_vi: normalizedCategoryVi,
                            purchase_price: nextPurchasePrice,
                            low_stock_threshold: nextLowStock,
                            quantity: nextQuantity,
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
                            purchase_price: nextPurchasePrice,
                            low_stock_threshold: nextLowStock,
                            quantity: nextQuantity,
                            unit: normalizedUnit,
                            note: normalizedNote,
                            part,
                            supplier: normalizedSupplier,
                            code: normalizedCode,
                            updated_at: new Date().toISOString(),
                            updated_by_name: actorName,
                            updated_by_username: actorUsername,
                        };

                setEditFormPendingSave({
                    id: editingId,
                    payload,
                });
                return;
            }

            // ===================== 생성 =====================
            else {
                const payload =
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

                const res = await fetch("/api/inventory/items", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        payload,
                        actorName,
                        actorUsername,
                        registrationType,
                    }),
                });

                const result = await readInventoryItemMutationResult(res, "save");
                if (!result) return;

                if (!res.ok || !result.ok) {
                    handleInventoryItemMutationFailure(res, result, "save");
                    return;
                }

                if (formPhotoFile && result.data?.id) {
                    const uploaded = await uploadInventoryPhoto(result.data.id, formPhotoFile);

                    if (!uploaded) {
                        alert("Item was saved, but image upload failed.");
                    }
                }

                alert(c.saveSuccess);
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

    const handleQuantitySave = (item: InventoryItem) => {
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
        setQuickSaveReason("stock_check");
        setQuickSaveOtherText("");
        setQuickPurchaseSupplier(item.supplier || "");
        setQuickPurchasePrice(formatNumber(item.purchase_price));
        setIsQuickPurchaseCustomSupplier(false);
    };

    const closeQuickSaveModal = () => {
        setQuickSaveItem(null);
        setQuickSaveReason(null);
        setQuickSaveOtherText("");
        setQuickPurchaseSupplier("");
        setQuickPurchasePrice("");
        setIsQuickPurchaseCustomSupplier(false);
    };

    const openQuickPurchaseConfirm = () => {
        if (!quickSaveItem) return;

        setQuickSaveReason("purchase");
        setQuickPurchaseSupplier(quickSaveItem.supplier || "");
        setQuickPurchasePrice(formatNumber(quickSaveItem.purchase_price));
        setIsQuickPurchaseCustomSupplier(
            !!quickSaveItem.supplier &&
            !mergedSupplierOptions.some(
                (option) =>
                    option.trim().toLowerCase() ===
                    String(quickSaveItem.supplier || "").trim().toLowerCase()
            )
        );
    };

    const handleQuickSaveConfirm = async (
        reason: QuickReasonValue
    ) => {
        if (isQuickSaving) return;
        setIsQuickSaving(true);

        try {
            if (!quickSaveItem) return;

            const draft = quantityDrafts[quickSaveItem.id];
            const nextQty = roundDecimal(parseDecimal(draft));
            const currentQty = roundDecimal(Number(quickSaveItem.quantity ?? 0));

            if (draft === undefined || String(draft).trim() === "") {
                alert(t.requiredFields);
                return;
            }

            if (nextQty < 0) {
                alert(t.quantityCannotBeNegative);
                return;
            }

            if (nextQty === currentQty) {
                alert(t.quantityNoChange);
                return;
            }

            if (reason === "other" && !quickSaveOtherText.trim()) {
                alert(t.otherReason);
                return;
            }

            const normalizedQuickSupplier = normalizeText(quickPurchaseSupplier);
            const nextPurchasePrice =
                quickPurchasePrice.trim() === ""
                    ? null
                    : parsePrice(quickPurchasePrice);

            const quickNote = buildQuickChangeNote({
                currentQty,
                nextQty,
                reason,
                customText: quickSaveOtherText,
            });

            const payload = {
                quantity: nextQty,
                note: quickNote,
                updated_at: new Date().toISOString(),
                updated_by_name: actorName,
                updated_by_username: actorUsername,
                ...(reason === "purchase"
                    ? {
                        supplier: normalizedQuickSupplier,
                        purchase_price: nextPurchasePrice,
                    }
                    : {}),
            };
            const savedItemId = quickSaveItem.id;

            const res = await fetch("/api/inventory/items", {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    mode: "quick-save",
                    id: savedItemId,
                    payload,
                    actorName,
                    actorUsername,
                    expectedQuantity: currentQty,
                    reason,
                }),
            });

            const result = await res.json();

            if (!res.ok || !result.ok) {
                console.error(result);

                if (res.status === 409) {
                    alert("현재 재고가 다른 사용자에 의해 변경되었습니다. 새로고침 후 다시 저장해주세요.");
                    await fetchInventory();
                    return;
                }

                alert(c.editFail);
                return;
            }

            setQuantityDrafts((prev) => ({
                ...prev,
                [savedItemId]: String(nextQty),
            }));

            closeQuickSaveModal();

            const refreshResults = await Promise.allSettled([
                fetchInventory(),
                fetchRecentLogs(),
            ]);

            refreshResults.forEach((result) => {
                if (result.status === "rejected") {
                    console.error(result.reason);
                }
            });
        } finally {
            setIsQuickSaving(false);
        }
    };

    const uploadInventoryPhoto = async (itemId: number, file: File) => {
        setPhotoBusyItemId(itemId);

        try {
            const formData = new FormData();
            formData.append("file", file);
            formData.append("actorUsername", actorUsername);

            const res = await fetch(`/api/inventory/items/${itemId}/photo`, {
                method: "POST",
                body: formData,
            });

            const result = await res.json();

            if (!res.ok || !result.ok) {
                console.error(result);
                alert(getPhotoUploadErrorMessage(result.error, result.message));
                return false;
            }

            setInventoryList((prev) =>
                prev.map((item) =>
                    item.id === itemId
                        ? {
                            ...item,
                            image_path: result.data?.image_path ?? null,
                            updated_at: result.data?.updated_at ?? item.updated_at,
                            updated_by_name:
                                result.data?.updated_by_name ?? item.updated_by_name,
                        }
                        : item
                )
            );

            alert(t.photoSaved);
            return true;
        } finally {
            setPhotoBusyItemId(null);
        }
    };

    const handleInventoryPhotoChange = async (
        e: ChangeEvent<HTMLInputElement>,
        itemId: number
    ) => {
        const file = e.target.files?.[0];
        e.target.value = "";

        if (!file) return;

        try {
            const compressedFile = await compressInventoryImage(file);
            const uploaded = await uploadInventoryPhoto(itemId, compressedFile);

            if (uploaded) {
                setPhotoModalItem(null);
            }
        } catch (error) {
            console.error(error);
            alert(getErrorMessage(error));
        }
    };

    const handleFormPhotoChange = async (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";

        if (!file) return;

        setIsFormPhotoProcessing(true);

        try {
            const compressedFile = await compressInventoryImage(file);

            if (editingId) {
                await uploadInventoryPhoto(editingId, compressedFile);
                clearFormPhotoDraft();
                return;
            }

            if (formPhotoPreviewUrl) {
                URL.revokeObjectURL(formPhotoPreviewUrl);
            }

            setFormPhotoFile(compressedFile);
            setFormPhotoPreviewUrl(URL.createObjectURL(compressedFile));
        } catch (error) {
            console.error(error);
            alert(getErrorMessage(error));
        } finally {
            setIsFormPhotoProcessing(false);
        }
    };

    const handleInventoryPhotoDelete = async (itemId: number) => {
        if (photoBusyItemId === itemId) return;

        setPhotoBusyItemId(itemId);

        try {
            const res = await fetch(`/api/inventory/items/${itemId}/photo`, {
                method: "DELETE",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    actorUsername,
                }),
            });

            const result = await res.json();

            if (!res.ok || !result.ok) {
                console.error(result);
                alert(result.message || "Image delete failed");
                return;
            }

            setInventoryList((prev) =>
                prev.map((item) =>
                    item.id === itemId
                        ? {
                            ...item,
                            image_path: result.data?.image_path ?? null,
                            updated_at: result.data?.updated_at ?? item.updated_at,
                            updated_by_name:
                                result.data?.updated_by_name ?? item.updated_by_name,
                        }
                        : item
                )
            );
            setPhotoModalItem(null);
            alert(t.photoDeletedSuccess);
        } finally {
            setPhotoBusyItemId(null);
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
        const itemIdParam = searchParams.get("itemId");
        const mode = searchParams.get("mode");
        const itemId = Number(itemIdParam);
        const deepLinkKey = `${itemIdParam || ""}:${mode || ""}`;

        if (!itemIdParam || handledDeepLinkKey === deepLinkKey) return;
        if (!Number.isFinite(itemId) || itemId <= 0) {
            setHandledDeepLinkKey(deepLinkKey);
            return;
        }

        const targetItem = inventoryList.find((item) => item.id === itemId);
        if (!targetItem) {
            if (inventoryList.length > 0) setHandledDeepLinkKey(deepLinkKey);
            return;
        }

        setPartFilter(
            PART_VALUES.includes(targetItem.part as PartValue)
                ? (targetItem.part as PartValue)
                : defaultPart
        );
        setCategoryFilter("all");
        setOpenItemId(targetItem.id);
        setQuantityDrafts((prev) => ({
            ...prev,
            [targetItem.id]: String(targetItem.quantity ?? ""),
        }));

        if (mode === "edit") {
            handleEdit(targetItem);
        }

        setHandledDeepLinkKey(deepLinkKey);
        // handleEdit intentionally stays out of deps so this deep link runs once per query key.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [defaultPart, handledDeepLinkKey, inventoryList, searchParams]);


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
            { key: "all", label: c.all },
            ...Array.from(
                new Map(
                    inventoryList
                        .filter((item) => item.part === partFilter)
                        .filter((item) => getCategoryKey(item) && getCategoryKey(item) !== "-")
                        .map((item) => [
                            getCategoryKey(item),
                            {
                                key: getCategoryKey(item),
                                label:
                                    lang === "vi"
                                        ? item.category_vi || item.category || "-"
                                        : item.category || item.category_vi || "-",
                            },
                        ])
                ).values()
            ),
        ];
    }, [inventoryList, partFilter, lang, c.all]);

    const getPartMeta = (value?: string | null) => {
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
            const keyword = normalizeSearchText(search);
            const displayItemName = getDisplayItemName(item);
            const displayCategory = getDisplayCategory(item);
            const categoryKey = getCategoryKey(item);
            const searchTargets = [
                displayItemName,
                item.item_name,
                item.item_name_vi,
                item.code,
                displayCategory,
                item.category,
                item.category_vi,
                item.supplier,
                item.unit,
            ];

            const matchSearch =
                !keyword ||
                searchTargets.some((target) =>
                    normalizeSearchText(target).includes(keyword)
                );

            const matchPart = item.part === partFilter;
            const matchCategory =
                categoryFilter === "all" || categoryKey === categoryFilter;
            const matchLowStock =
                !showLowStockOnly ||
                Number(item.quantity) <= Number(item.low_stock_threshold ?? 1);

            const matchTodayUpdated =
                !showTodayUpdatedOnly || isInCurrentBusinessDay(item.updated_at);

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

    const groupedInventory: Record<string, InventoryItem[]> = filteredInventory.reduce(
        (acc: Record<string, InventoryItem[]>, item) => {
            const categoryKey = getDisplayCategory(item) || "-";

            if (!acc[categoryKey]) {
                acc[categoryKey] = [];
            }

            acc[categoryKey].push(item);
            return acc;
        },
        {}
    );

    const itemLogGroups: InventoryLogGroup[] = logModalItem
        ? [
            {
                item_id: logModalItem.id,
                noteKey: itemLogs[0]?.new_note || itemLogs[0]?.prev_note || "",
                groupKey: `item-${logModalItem.id}`,
                latest: itemLogs[0] || null,
                logs: itemLogs,
            },
        ].filter((group): group is InventoryLogGroup => Boolean(group.latest))
        : [];

    const editingItem = editingId
        ? inventoryList.find((item) => item.id === editingId) || null
        : null;


    const labelStyle = {
        fontSize: 13,
        fontWeight: 700,
        color: "#374151",
        marginBottom: 6,
    };

    const inventoryTabs = getInventoryTabs(pathname, lang);

    return (
        <Container noPaddingTop>
            <SubNav tabs={inventoryTabs} />

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
                            { value: "kitchen", label: c.kitchen },
                            { value: "hall", label: c.hall },
                            { value: "bar", label: c.bar },
                            { value: "etc", label: c.etc },
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
                            {showLowStockOnly ? c.all : t.filterLowStock}
                        </button>

                        <button
                            onClick={() => setShowTodayUpdatedOnly(!showTodayUpdatedOnly)}
                            style={getFilterToggleButtonStyle(showTodayUpdatedOnly, "royalblue")}
                        >
                            {showTodayUpdatedOnly ? c.all : t.filterToday}
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
                        <div>{c.noData}</div>
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
                        {Object.entries(groupedInventory).map(([categoryName, items]) => (
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

                                                    <div
                                                        style={{
                                                            ...ui.metaText,
                                                            display: "flex",
                                                            alignItems: "center",
                                                            gap: 4,
                                                            minWidth: 0,
                                                        }}
                                                    >
                                                        <span
                                                            style={{
                                                                fontSize: 11,
                                                                minWidth: 0,
                                                                overflow: "hidden",
                                                                textOverflow: "ellipsis",
                                                                whiteSpace: "nowrap",
                                                            }}
                                                        >
                                                            {item.supplier || "-"}
                                                        </span>
                                                        <span>·</span>
                                                        <span>{formatMoneyDisplay(item.purchase_price)}</span>
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
                                                                : `${t.snapshotDiff} ${diffQty > 0 ? "+" : ""}${formatDecimalDisplay(diffQty)}`}
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
                                                        {isOpen ? c.close : c.detail}
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
                                                                placeholder={c.quantity}
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
                                                            {t.quickSave}
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
                                                        {t.quickGuide}
                                                    </div>

                                                    <div
                                                        style={{
                                                            display: "flex",
                                                            flexDirection: "column",
                                                            gap: 8,
                                                            marginBottom: 10,
                                                        }}
                                                    >
                                                        {item.image_path ? (
                                                            <button
                                                                type="button"
                                                                onClick={() => setPhotoModalItem(item)}
                                                                style={{
                                                                    width: "100%",
                                                                    padding: 0,
                                                                    border: 0,
                                                                    background: "transparent",
                                                                    cursor: "pointer",
                                                                }}
                                                            >
                                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                                <img
                                                                    src={getInventoryImageUrl(item.image_path)}
                                                                    alt={getDisplayItemName(item)}
                                                                    style={{
                                                                        width: "100%",
                                                                        maxHeight: 240,
                                                                        objectFit: "contain",
                                                                        borderRadius: 12,
                                                                        border: "1px solid #e5e7eb",
                                                                        background: "#f8fafc",
                                                                    }}
                                                                />
                                                            </button>
                                                        ) : (
                                                            <div
                                                                style={{
                                                                    display: "flex",
                                                                    justifyContent: "center",
                                                                    width: "100%",
                                                                }}
                                                            >
                                                                <input
                                                                    id={`inventory-photo-${item.id}`}
                                                                    type="file"
                                                                    accept="image/jpeg,image/png,image/webp"
                                                                    onChange={(e) => handleInventoryPhotoChange(e, item.id)}
                                                                    style={{ display: "none" }}
                                                                />
                                                                <label
                                                                    htmlFor={`inventory-photo-${item.id}`}
                                                                style={{
                                                                    ...ui.subButton,
                                                                    width: "100%",
                                                                    minWidth: 94,
                                                                    padding: "7px 12px",
                                                                    fontSize: 13,
                                                                    fontWeight: 700,
                                                                    display: "flex",
                                                                    alignItems: "center",
                                                                    justifyContent: "center",
                                                                    textAlign: "center",
                                                                    cursor:
                                                                        photoBusyItemId === item.id
                                                                            ? "not-allowed"
                                                                                : "pointer",
                                                                        opacity: photoBusyItemId === item.id ? 0.6 : 1,
                                                                        pointerEvents:
                                                                            photoBusyItemId === item.id ? "none" : "auto",
                                                                    }}
                                                                >
                                                                    {photoBusyItemId === item.id
                                                                        ? c.saving
                                                                        : `📷 ${t.photoAddButton}`}
                                                                </label>
                                                            </div>
                                                        )}
                                                    </div>

                                                    <div style={ui.detailGrid}>
                                                        <div style={ui.detailLabel}>{t.lowStockThreshold}</div>
                                                        <div style={ui.detailValue}>{item.low_stock_threshold ?? 1}</div>

                                                        <div style={ui.detailLabel}>{c.update}</div>
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

                                                        <div style={ui.detailLabel}>{c.note}</div>
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
                                                            {t.logItemTitle}
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
                                                            {c.edit}
                                                        </button>

                                                        {canDeleteInventoryItem && (
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
                                                                    ? (c.deleting)
                                                                    : c.delete}
                                                            </button>
                                                        )}
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
                onClick={() => {
                    if (isFormOpen) {
                        setIsFormOpen(false);
                        resetForm();
                        return;
                    }

                    setIsRegistrationTypeModalOpen(true);
                }}
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

            {isRegistrationTypeModalOpen && (
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
                    onClick={() => setIsRegistrationTypeModalOpen(false)}
                >
                    <div
                        onClick={(event) => event.stopPropagation()}
                        style={{
                            width: "100%",
                            maxWidth: 380,
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
                            {t.openInventoryForm}
                        </div>

                        {[
                            {
                                value: "existing_stock" as const,
                                emoji: "📦",
                                label: t.existingStockRegistration,
                                description: t.existingStockRegistrationDesc,
                            },
                            {
                                value: "new_purchase" as const,
                                emoji: "🛒",
                                label: t.newPurchaseRegistration,
                                description: t.newPurchaseRegistrationDesc,
                            },
                        ].map((option) => (
                            <button
                                key={option.value}
                                type="button"
                                onClick={() => {
                                    resetForm();
                                    setRegistrationType(option.value);
                                    setIsRegistrationTypeModalOpen(false);
                                    setIsFormOpen(true);
                                }}
                                style={{
                                    ...ui.subButton,
                                    width: "100%",
                                    padding: "12px 14px",
                                    textAlign: "left",
                                }}
                            >
                                <div
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 6,
                                        minWidth: 0,
                                        whiteSpace: "nowrap",
                                        fontSize: 14,
                                        fontWeight: 800,
                                    }}
                                >
                                    <span aria-hidden="true" style={{ flexShrink: 0 }}>
                                        {option.emoji}
                                    </span>
                                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {option.label}
                                    </span>
                                </div>
                                <div style={{ ...ui.metaText, marginTop: 4 }}>
                                    {option.description}
                                </div>
                            </button>
                        ))}

                        <button
                            type="button"
                            onClick={() => setIsRegistrationTypeModalOpen(false)}
                            style={ui.subButton}
                        >
                            {c.cancel}
                        </button>
                    </div>
                </div>
            )}

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
                                {c.part}
                            </div>
                            <div
                                style={{
                                    display: "grid",
                                    gridTemplateColumns: "repeat(4, 1fr)",
                                    gap: 8,
                                }}
                            >
                                {[
                                    { value: "kitchen", label: c.kitchen },
                                    { value: "hall", label: c.hall },
                                    { value: "bar", label: c.bar },
                                    { value: "etc", label: c.etc },
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
                                {c.category}
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
                                    {c.directInput}
                                </option>
                            </select>
                        </div>

                        {isCustomCategory && (
                            <div>
                                <div style={labelStyle}>
                                    {t.newCategory}
                                </div>
                                <input
                                    type="text"
                                    placeholder={t.newCategoryPlaceholder}
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
                                {c.code}
                            </div>
                            <input
                                type="text"
                                placeholder={c.selectInput}
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                                style={ui.input}
                            />
                        </div>

                        {/* 품목명 */}
                        <div>
                            <div style={labelStyle}>
                                {c.itemName}
                            </div>
                            <input
                                type="text"
                                placeholder={c.itemName}
                                value={itemName}
                                onChange={(e) => setItemName(e.target.value)}
                                style={ui.input}
                                ref={itemNameRef}
                                onKeyDown={(e) => handleKeyDown(e, supplierRef)}
                            />
                        </div>

                        <div>
                            <div style={labelStyle}>{t.photoLogLabel}</div>
                            {(formPhotoPreviewUrl || editingItem?.image_path) && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={
                                        formPhotoPreviewUrl ||
                                        getInventoryImageUrl(editingItem?.image_path)
                                    }
                                    alt={itemName || c.itemName}
                                    style={{
                                        width: "100%",
                                        maxHeight: 240,
                                        objectFit: "contain",
                                        borderRadius: 12,
                                        border: "1px solid #e5e7eb",
                                        background: "#f8fafc",
                                        marginBottom: 8,
                                    }}
                                />
                            )}

                            <div
                                style={{
                                    display: "flex",
                                    gap: 6,
                                    flexWrap: "wrap",
                                }}
                            >
                                <input
                                    id="inventory-form-photo"
                                    type="file"
                                    accept="image/jpeg,image/png,image/webp"
                                    onChange={handleFormPhotoChange}
                                    style={{ display: "none" }}
                                />
                                <label
                                    htmlFor="inventory-form-photo"
                                    style={{
                                        ...ui.subButton,
                                        width: "auto",
                                        minWidth: 84,
                                        padding: "8px 12px",
                                        fontSize: 13,
                                        fontWeight: 700,
                                        cursor:
                                            isFormPhotoProcessing ||
                                            (editingId && photoBusyItemId === editingId)
                                                ? "not-allowed"
                                                : "pointer",
                                        opacity:
                                            isFormPhotoProcessing ||
                                            (editingId && photoBusyItemId === editingId)
                                                ? 0.6
                                                : 1,
                                    }}
                                >
                                    {isFormPhotoProcessing ||
                                    (editingId && photoBusyItemId === editingId)
                                        ? c.saving
                                        : formPhotoPreviewUrl || editingItem?.image_path
                                            ? t.photoChangeButton
                                            : t.photoAddButton}
                                </label>

                                {formPhotoPreviewUrl && !editingId && (
                                    <button
                                        type="button"
                                        onClick={clearFormPhotoDraft}
                                        style={{
                                            ...ui.subButton,
                                            width: "auto",
                                            minWidth: 84,
                                            padding: "8px 12px",
                                            fontSize: 13,
                                            fontWeight: 700,
                                            color: "crimson",
                                            border: "1px solid #fecaca",
                                            background: "#fff5f5",
                                        }}
                                    >
                                        {t.photoDeleteButton}
                                    </button>
                                )}

                                {editingId && editingItem?.image_path && (
                                    <button
                                        type="button"
                                        onClick={() => handleInventoryPhotoDelete(editingId)}
                                        disabled={photoBusyItemId === editingId}
                                        style={{
                                            ...ui.subButton,
                                            width: "auto",
                                            minWidth: 84,
                                            padding: "8px 12px",
                                            fontSize: 13,
                                            fontWeight: 700,
                                            color: "crimson",
                                            border: "1px solid #fecaca",
                                            background: "#fff5f5",
                                            opacity: photoBusyItemId === editingId ? 0.6 : 1,
                                        }}
                                    >
                                        {t.photoDeleteButton}
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* 거래처 */}
                        <div>
                            <div style={labelStyle}>
                                {c.supplier}
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
                                <option value="">{c.supplier}</option>

                                {mergedSupplierOptions.map((option) => (
                                    <option key={option} value={option}>
                                        {option}
                                    </option>
                                ))}

                                <option value="__custom__">
                                    {c.directInput}
                                </option>
                            </select>
                        </div>

                        {isCustomSupplier && (
                            <div>
                                <div style={labelStyle}>
                                    {t.newSupplier}
                                </div>
                                <input
                                    type="text"
                                    placeholder={t.newSupplierPlaceholder}
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
                                {t.purchasePrice}
                            </div>
                            <input
                                type="text"
                                placeholder={t.purchasePrice}
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
                                {c.unit}
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
                                {c.quantity}
                            </div>
                            <input
                                type="number"
                                step="0.1"
                                placeholder={c.quantity}
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
                                {t.lowStockThreshold}
                            </div>
                            <input
                                type="number"
                                step="0.1"
                                placeholder={t.lowStockThreshold}
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
                                {c.note}
                            </div>
                            <input
                                type="text"
                                placeholder={c.note}
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
                                ? (c.saving)
                                : editingId
                                    ? c.save
                                    : c.save}
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
                                {c.cancel}
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
                <h2 style={ui.sectionTitle}>{t.logRecent}</h2>

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
                        <div>{c.noLogs}</div>
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
                                            {[
                                                log.part ? c[log.part as keyof typeof c] || log.part : "",
                                                getDisplayLogCategory(log)
                                            ].filter(Boolean).join(" · ")}
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

            {photoModalItem && photoModalItem.image_path && (
                <div
                    style={{
                        position: "fixed",
                        inset: 0,
                        background: "rgba(0,0,0,0.45)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        zIndex: 1000,
                        padding: 16,
                    }}
                    onClick={() => setPhotoModalItem(null)}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            width: "100%",
                            maxWidth: 520,
                            maxHeight: "90vh",
                            overflowY: "auto",
                            background: "#fff",
                            borderRadius: 14,
                            padding: 14,
                            boxShadow: "0 20px 50px rgba(0,0,0,0.2)",
                            display: "flex",
                            flexDirection: "column",
                            gap: 10,
                        }}
                    >
                        <div style={{ ...ui.metaText, fontWeight: 800 }}>
                            {getDisplayItemName(photoModalItem)}
                        </div>

                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                            src={getInventoryImageUrl(photoModalItem.image_path)}
                            alt={getDisplayItemName(photoModalItem)}
                            style={{
                                width: "100%",
                                maxHeight: "62vh",
                                objectFit: "contain",
                                borderRadius: 12,
                                background: "#f8fafc",
                                border: "1px solid #e5e7eb",
                            }}
                        />

                        <div
                            style={{
                                display: "grid",
                                gridTemplateColumns: "1fr 1fr",
                                gap: 8,
                            }}
                        >
                            <input
                                id={`inventory-photo-modal-${photoModalItem.id}`}
                                type="file"
                                accept="image/jpeg,image/png,image/webp"
                                onChange={(e) =>
                                    handleInventoryPhotoChange(e, photoModalItem.id)
                                }
                                style={{ display: "none" }}
                            />
                            <label
                                htmlFor={`inventory-photo-modal-${photoModalItem.id}`}
                                style={{
                                    ...ui.subButton,
                                    width: "100%",
                                    minWidth: 0,
                                    padding: "9px 10px",
                                    fontSize: 13,
                                    fontWeight: 800,
                                    textAlign: "center",
                                    cursor:
                                        photoBusyItemId === photoModalItem.id
                                            ? "not-allowed"
                                            : "pointer",
                                    opacity:
                                        photoBusyItemId === photoModalItem.id ? 0.6 : 1,
                                    pointerEvents:
                                        photoBusyItemId === photoModalItem.id ? "none" : "auto",
                                }}
                            >
                                {photoBusyItemId === photoModalItem.id
                                    ? c.saving
                                    : `📷 ${t.photoChangeButton}`}
                            </label>

                            <button
                                type="button"
                                onClick={() => handleInventoryPhotoDelete(photoModalItem.id)}
                                disabled={photoBusyItemId === photoModalItem.id}
                                style={{
                                    ...ui.subButton,
                                    width: "100%",
                                    minWidth: 0,
                                    padding: "9px 10px",
                                    fontSize: 13,
                                    fontWeight: 800,
                                    color: "crimson",
                                    border: "1px solid #fecaca",
                                    background: "#fff5f5",
                                    opacity:
                                        photoBusyItemId === photoModalItem.id ? 0.6 : 1,
                                }}
                            >
                                {`🗑️ ${t.photoDeleteButton}`}
                            </button>
                        </div>

                        <button
                            type="button"
                            onClick={() => setPhotoModalItem(null)}
                            style={ui.subButton}
                        >
                            {c.close}
                        </button>
                    </div>
                </div>
            )}

            {editFormPendingSave && (
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
                    onClick={closeEditReasonModal}
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
                            {t.editReasonModalTitle}
                        </div>

                        <div style={{ ...ui.metaText, marginBottom: 4 }}>
                            {t.editReasonModalDescription}
                        </div>

                        <div
                            style={{
                                display: "grid",
                                gridTemplateColumns: "1fr 1fr",
                                gap: 8,
                            }}
                        >
                            {(["stock_check", "purchase", "service", "other"] as const).map(
                                (reason) => (
                                    <button
                                        key={reason}
                                        type="button"
                                        onClick={() => handleEditReasonConfirm(reason)}
                                        disabled={isEditReasonSaving}
                                        style={{
                                            ...ui.subButton,
                                            opacity: isEditReasonSaving ? 0.6 : 1,
                                            cursor: isEditReasonSaving
                                                ? "not-allowed"
                                                : "pointer",
                                        }}
                                    >
                                        <span
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                gap: 6,
                                                whiteSpace: "nowrap",
                                            }}
                                        >
                                            <span aria-hidden="true">
                                                {INVENTORY_REASON_EMOJIS[reason]}
                                            </span>
                                            <span>{INVENTORY_REASON_LABELS[lang][reason]}</span>
                                        </span>
                                    </button>
                                )
                            )}
                        </div>

                        <button
                            type="button"
                            onClick={closeEditReasonModal}
                            disabled={isEditReasonSaving}
                            style={{
                                ...ui.subButton,
                                marginTop: 4,
                                opacity: isEditReasonSaving ? 0.6 : 1,
                            }}
                        >
                            {c.close}
                        </button>
                    </div>
                </div>
            )}

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
                    onClick={closeQuickSaveModal}
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
                            {lang === "vi" ? "Lưu nhanh" : "빠른저장"}
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
                                onClick={() => handleQuickSaveConfirm("stock_check")}
                                disabled={isQuickSaving}
                                style={{
                                    ...ui.subButton,
                                    opacity: isQuickSaving ? 0.6 : 1,
                                    cursor: isQuickSaving ? "not-allowed" : "pointer",
                                }}
                            >
                                <span
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: 6,
                                        whiteSpace: "nowrap",
                                    }}
                                >
                                    <span aria-hidden="true">✅</span>
                                    <span>{INVENTORY_REASON_LABELS[lang].stock_check}</span>
                                </span>
                            </button>

                            <button
                                type="button"
                                onClick={openQuickPurchaseConfirm}
                                disabled={isQuickSaving}
                                style={{
                                    ...ui.subButton,
                                    opacity: isQuickSaving ? 0.6 : 1,
                                    cursor: isQuickSaving ? "not-allowed" : "pointer",
                                }}
                            >
                                <span
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: 6,
                                        whiteSpace: "nowrap",
                                    }}
                                >
                                    <span aria-hidden="true">🛒</span>
                                    <span>{INVENTORY_REASON_LABELS[lang].purchase}</span>
                                </span>
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
                                <span
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: 6,
                                        whiteSpace: "nowrap",
                                    }}
                                >
                                    <span aria-hidden="true">🎁</span>
                                    <span>{INVENTORY_REASON_LABELS[lang].service}</span>
                                </span>
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
                                <span
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: 6,
                                        whiteSpace: "nowrap",
                                    }}
                                >
                                    <span aria-hidden="true">📝</span>
                                    <span>{c.etc}</span>
                                </span>
                            </button>
                        </div>

                        {quickSaveReason === "other" && (
                            <>
                                <input
                                    type="text"
                                    value={quickSaveOtherText}
                                    onChange={(e) => setQuickSaveOtherText(e.target.value)}
                                    placeholder={t.otherReason}
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
                                        ? (c.saving)
                                        : c.save}
                                </button>
                            </>
                        )}

                        {quickSaveReason === "purchase" && (
                            <div
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: 8,
                                    border: "1px solid #e5e7eb",
                                    borderRadius: 10,
                                    padding: 10,
                                    background: "#f9fafb",
                                }}
                            >
                                {(() => {
                                    const draft = quantityDrafts[quickSaveItem.id];
                                    const currentQty = roundDecimal(
                                        Number(quickSaveItem.quantity ?? 0)
                                    );
                                    const nextQty = roundDecimal(parseDecimal(draft));
                                    const changeQty = roundDecimal(nextQty - currentQty);

                                    return (
                                        <div
                                            style={{
                                                display: "grid",
                                                gridTemplateColumns: "1fr 1fr",
                                                gap: 6,
                                                fontSize: 12,
                                                fontWeight: 800,
                                                color: "#374151",
                                            }}
                                        >
                                            <span>
                                                {lang === "vi" ? "Hiện tại" : "현재수량"}:{" "}
                                                {formatDecimalDisplay(currentQty)}
                                            </span>
                                            <span>
                                                {lang === "vi" ? "Sau nhập" : "최종수량"}:{" "}
                                                {formatDecimalDisplay(nextQty)}
                                            </span>
                                            <span style={{ color: "seagreen" }}>
                                                {INVENTORY_REASON_LABELS[lang].purchase}: +
                                                {formatDecimalDisplay(changeQty)}
                                            </span>
                                        </div>
                                    );
                                })()}

                                <select
                                    value={
                                        isQuickPurchaseCustomSupplier
                                            ? "__custom__"
                                            : quickPurchaseSupplier
                                    }
                                    onChange={(e) => {
                                        const value = e.target.value;

                                        if (value === "__custom__") {
                                            setIsQuickPurchaseCustomSupplier(true);
                                            setQuickPurchaseSupplier("");
                                            return;
                                        }

                                        setIsQuickPurchaseCustomSupplier(false);
                                        setQuickPurchaseSupplier(value);
                                    }}
                                    style={ui.input}
                                >
                                    <option value="">{c.supplier}</option>
                                    {mergedSupplierOptions.map((option) => (
                                        <option key={option} value={option}>
                                            {option}
                                        </option>
                                    ))}
                                    <option value="__custom__">{c.directInput}</option>
                                </select>

                                {isQuickPurchaseCustomSupplier && (
                                    <input
                                        type="text"
                                        value={quickPurchaseSupplier}
                                        onChange={(e) => setQuickPurchaseSupplier(e.target.value)}
                                        placeholder={t.newSupplierPlaceholder}
                                        style={ui.input}
                                    />
                                )}

                                <input
                                    type="text"
                                    value={quickPurchasePrice}
                                    onChange={(e) => setQuickPurchasePrice(e.target.value)}
                                    placeholder={t.purchasePrice}
                                    style={ui.input}
                                />

                                <button
                                    type="button"
                                    onClick={() => handleQuickSaveConfirm("purchase")}
                                    disabled={isQuickSaving}
                                    style={{
                                        ...ui.button,
                                        opacity: isQuickSaving ? 0.6 : 1,
                                        cursor: isQuickSaving ? "not-allowed" : "pointer",
                                    }}
                                >
                                    {isQuickSaving
                                        ? c.saving
                                        : `${INVENTORY_REASON_LABELS[lang].purchase} ${c.save}`}
                                </button>
                            </div>
                        )}

                        <button
                            type="button"
                            onClick={closeQuickSaveModal}
                            style={{
                                ...ui.subButton,
                                marginTop: 4,
                            }}
                        >
                            {c.close}
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
                            {t.logItemTitle}
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
                                <div>{c.loading}</div>
                            ) : itemLogGroups.length === 0 ? (
                                <div>{c.noLogs}</div>
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
                                            reasonBadgeText={getInventoryReasonBadgeText(log.reason)}
                                            reasonBadgeStyle={getInventoryReasonBadgeStyle(log.reason)}
                                            readOnlyText={
                                                isSalesInventoryLog(log)
                                                    ? lang === "vi"
                                                        ? "Nhật ký trừ kho bán hàng chỉ xem."
                                                        : "판매차감 로그는 읽기 전용입니다."
                                                    : ""
                                            }
                                            partLabel={String(c[log.part as keyof typeof c] || log.part || "")}
                                            itemName={getDisplayLogItemName(log)}
                                            categoryName={getDisplayLogCategory(log)}
                                            detailLabel={c.detail}
                                            closeLabel={c.close}
                                            deleteLabel={c.delete}
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
                            {c.close}
                        </button>
                    </div>
                </div>
            )}
        </Container>
    );
}
