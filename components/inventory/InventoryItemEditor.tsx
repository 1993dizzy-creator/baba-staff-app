"use client";
import { normalizeInventoryEditText } from "@/lib/inventory/edit-validation";
import { ledgerSyncNotice } from "@/lib/inventory/ledger-sync-contract";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "@/lib/language-context";
import { commonText, inventoryText } from "@/lib/text";
import { ui } from "@/lib/styles/ui";
import InventoryLoadingCard from "./InventoryLoadingCard";
import { fetchInventoryApi } from "@/lib/inventory/client-auth";
import { type PurchaseRoot } from "@/lib/inventory/purchase-correction-policy";
import { PART_META } from "@/lib/common/parts";
import { INVENTORY_PART_VALUES, type InventoryPartValue, isInventoryPart, resolveInventoryDefaultPart } from "@/lib/inventory/parts";
import { INVENTORY_REASON_EMOJIS, INVENTORY_REASON_LABELS, type QuickReasonValue } from "@/lib/inventory/reasons";
import { CATEGORY_OPTIONS_BY_PART, getInventoryCategoryLabel, resolveInventoryCategoryOption } from "@/lib/inventory/categories";
import { parseDecimal } from "@/lib/inventory/number";
import { formatNumber, parsePrice } from "@/lib/inventory/money";
import { InventoryImageCompressionError, compressInventoryImage, formatFileSize } from "@/lib/inventory/image-compression";
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
    supplier_partner_id?: number | null;
    supplier_partner_name?: string | null;
    code?: string | null;
    low_stock_threshold?: string | number | null;
    low_stock_enabled?: boolean | null;
    package_content_quantity?: string | number | null;
    package_content_unit?: string | null;
    is_active?: boolean | null;
    has_active_keg_tracking?: boolean | null;
    lastStockCheckDate?: string | null;
    daysSinceStockCheck?: number | null;
    needsStockCheck?: boolean | null;
    kegProgress?: {
        activeSessionId: number;
        startedAt: string;
        capacityMl: number;
        soldMl: number;
        usagePercent: number;
        remainingPercent: number;
        salesBreakdown?: KegSalesBreakdown;
    } | null;
    image_path?: string | null;
    updated_at?: string | null;
    updated_by_name?: string | null;
};
type SupplierPartnerOption = {
    id: number;
    name: string;
};
type SupplierAliasOption = {
    id: number;
    supplierName: string;
    status: "pending" | "linked" | "ignored";
    businessPartnerId: number | null;
};
type DuplicateInventoryItem = Pick<InventoryItem, "id" | "item_name" | "item_name_vi" | "code" | "part" | "category" | "category_vi" | "is_active">;
type InventoryItemMutationResult = {
    ok?: boolean;
    error?: string;
    message?: string;
    data?: InventoryItem;
    duplicateItem?: DuplicateInventoryItem;
    candidates?: PurchaseRoot[];
    recommended?: boolean;
};
type EditFormPendingSave = {
    id: number;
    payload: Record<string, unknown>;
    expectedQuantity: number;
    expectedUpdatedAt?: string | null;
};
type KegSalesBreakdown = {
    totalUnits: number;
    expectedTotalMl?: number;
    regularUnits: number;
    regularSoldMl: number;
    regularAllocatedMl?: number;
    regularAverageMl: number | null;
    towerUnits: number;
    towerSoldMl: number;
    towerAllocatedMl?: number;
    towerAverageMl: number | null;
    otherUnits: number;
    otherSoldMl: number;
    otherAllocatedMl?: number;
    otherAverageMl?: number | null;
    averageCapacityMlPerUnit?: number;
};
const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : "Server error";
const INVENTORY_PHOTO_CAMERA_ACCEPT = "image/*";
const INVENTORY_PHOTO_LIBRARY_ACCEPT = "image/*,image/heic,image/heif";
const getInventoryImageUrl = (imagePath?: string | null, version?: string | null) => {
    if (!imagePath)
        return "";
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!supabaseUrl)
        return "";
    const encodedPath = imagePath
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/");
    const url = `${supabaseUrl}/storage/v1/object/public/${INVENTORY_IMAGE_BUCKET}/${encodedPath}`;
    const cacheVersion = version || imagePath;
    return cacheVersion ? `${url}?v=${encodeURIComponent(cacheVersion)}` : url;
};
const getPhotoUploadErrorMessage = (error?: string, message?: string) => {
    if (error === "file_too_large")
        return COMPRESSED_IMAGE_TOO_LARGE_MESSAGE;
    if (error === "unsupported_file_type")
        return UNSUPPORTED_IMAGE_MESSAGE;
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
    if (error === "missing_file")
        return "사진 파일을 찾을 수 없습니다. 다시 선택해주세요.";
    if (error === "invalid_user")
        return "사용자 확인에 실패했습니다. 다시 로그인해주세요.";
    return message || "사진 업로드에 실패했습니다.";
};
const INVENTORY_IMAGE_BUCKET = "inventory-images";
const UNSUPPORTED_IMAGE_MESSAGE = "이 사진 형식은 브라우저에서 처리할 수 없습니다. 카메라 설정을 JPG로 변경하거나 다른 사진을 선택해주세요.";
const COMPRESSED_IMAGE_TOO_LARGE_MESSAGE = "사진을 100KB 이하로 줄일 수 없습니다. 조금 더 단순한 배경에서 다시 찍어주세요.";
export default function InventoryItemEditor({ itemId, initialItem, initialSuppliers, initialAliases, focusLanguage, embedded = false, onSaved, onClose, onBusyChange }: {
    itemId: number;
    initialItem?: InventoryItem;
    initialSuppliers?: SupplierPartnerOption[];
    initialAliases?: SupplierAliasOption[];
    focusLanguage?: "ko" | "vi";
    embedded?: boolean;
    onSaved?: (item: InventoryItem) => void;
    onClose?: () => void;
    onBusyChange?: (busy: boolean) => void;
}) {
    const [otherItemName, setOtherItemName] = useState("");
    const otherItemNameRef = useRef<HTMLInputElement>(null);
    const photoActionLockRef = useRef(false);
    const [loadError, setLoadError] = useState("");
    const [ready, setReady] = useState(false);
    const requestRef = useRef<Promise<{
        data: InventoryItem[];
        supplierPartners?: SupplierPartnerOption[];
        supplierAliases?: SupplierAliasOption[];
    }> | null>(null);
    const defaultPart = resolveInventoryDefaultPart(null, initialItem?.part);
    const { lang } = useLanguage();
    const nameLanguageRef = useRef(lang);
    const t = inventoryText[lang];
    const c = commonText[lang];
    const [itemName, setItemName] = useState("");
    const [quantity, setQuantity] = useState("");
    const [unit, setUnit] = useState("");
    const [note, setNote] = useState("");
    const [part, setPart] = useState<InventoryPartValue>(defaultPart);
    const [category, setCategory] = useState("");
    const [categoryKo, setCategoryKo] = useState("");
    const [categoryVi, setCategoryVi] = useState("");
    const [isCustomCategory, setIsCustomCategory] = useState(false);
    const [isCustomSupplier, setIsCustomSupplier] = useState(false);
    const [purchasePrice, setPurchasePrice] = useState("");
    const [supplier, setSupplier] = useState("");
    const [supplierPartnerId, setSupplierPartnerId] = useState<number | null>(null);
    const [supplierPartners, setSupplierPartners] = useState<SupplierPartnerOption[]>(initialSuppliers ?? []);
    const [supplierAliases, setSupplierAliases] = useState<SupplierAliasOption[]>(initialAliases ?? []);
    const [lowStockThreshold, setLowStockThreshold] = useState("");
    const [lowStockEnabled, setLowStockEnabled] = useState(false);
    const [packageContentQuantity, setPackageContentQuantity] = useState("");
    const [packageContentUnit, setPackageContentUnit] = useState("");
    const [code, setCode] = useState("");
    const [formPhotoPreviewUrl, setFormPhotoPreviewUrl] = useState("");
    const [isFormPhotoProcessing, setIsFormPhotoProcessing] = useState(false);
    const [photoCompressionMessage, setPhotoCompressionMessage] = useState("");
    const [inventoryList, setInventoryList] = useState<InventoryItem[]>(initialItem ? [initialItem] : []);
    const editingId = itemId;
    const [editFormPendingSave, setEditFormPendingSave] = useState<EditFormPendingSave | null>(null);
    const [isEditReasonSaving, setIsEditReasonSaving] = useState(false);
    const [purchaseCorrectionRoots, setPurchaseCorrectionRoots] = useState<PurchaseRoot[] | null>(null);
    const [selectedPurchaseRootId, setSelectedPurchaseRootId] = useState<number | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [photoBusyItemId, setPhotoBusyItemId] = useState<number | null>(null);
    const itemNameRef = useRef<HTMLInputElement>(null);
    const supplierRef = useRef<HTMLInputElement>(null);
    const priceRef = useRef<HTMLInputElement>(null);
    const unitRef = useRef<HTMLInputElement>(null);
    const packageContentQuantityRef = useRef<HTMLInputElement>(null);
    const quantityRef = useRef<HTMLInputElement>(null);
    const noteRef = useRef<HTMLInputElement>(null);
    const formRef = useRef<HTMLDivElement>(null);
    const lowStockThresholdRef = useRef<HTMLInputElement>(null);
    const categoryOptions = useMemo(() => CATEGORY_OPTIONS_BY_PART[part as keyof typeof CATEGORY_OPTIONS_BY_PART] ?? [], [part]);
    const customCategoryOptions = useMemo(() => Array.from(new Set(inventoryList
        .filter((item) => item.part === part)
        .map((item) => getInventoryCategoryLabel(item.part, item.category, item.category_vi, lang))
        .map((value) => value.trim())
        .filter(Boolean))), [inventoryList, part, lang]);
    const mergedCategoryOptions = useMemo(() => [
        ...categoryOptions.map((option) => ({
            label: lang === "vi" ? option.vi : option.ko,
            ko: option.ko,
            vi: option.vi,
        })),
        ...customCategoryOptions
            .filter((value) => !categoryOptions.some((option) => {
            const label = lang === "vi" ? option.vi : option.ko;
            return label.trim().toLowerCase() === value.trim().toLowerCase();
        }))
            .map((value) => ({
            label: value,
            ko: lang === "ko" ? value : "",
            vi: lang === "vi" ? value : "",
        })),
    ], [categoryOptions, customCategoryOptions, lang]);
    const normalizeText = normalizeInventoryEditText;
    const clearFormPhotoDraft = () => {
        if (formPhotoPreviewUrl) {
            URL.revokeObjectURL(formPhotoPreviewUrl);
        }
        setFormPhotoPreviewUrl("");
        setPhotoCompressionMessage("");
    };
    const getDuplicatePartLabel = (partValue?: string | null) => {
        if (partValue === "kitchen")
            return c.kitchen;
        if (partValue === "hall")
            return c.hall;
        if (partValue === "bar")
            return c.bar;
        if (partValue === "etc")
            return c.etc;
        return "";
    };
    const getDuplicateItemAlertMessage = (duplicateItem?: DuplicateInventoryItem | null) => {
        if (duplicateItem?.is_active === false) {
            return lang === "ko"
                ? "동일한 품목이 비활성 상태로 등록되어 있습니다. 기존 품목을 확인해주세요."
                : "Mặt hàng trùng đã được đăng ký ở trạng thái không hoạt động. Vui lòng kiểm tra mặt hàng hiện có.";
        }
        const partLabel = getDuplicatePartLabel(duplicateItem?.part);
        const categoryLabel = getInventoryCategoryLabel(duplicateItem?.part, duplicateItem?.category, duplicateItem?.category_vi, lang);
        const location = [partLabel, categoryLabel].filter(Boolean).join("/");
        return location
            ? t.duplicateItemRegistered(location)
            : t.duplicateItemRegisteredFallback;
    };
    const isDuplicateInventoryItemResult = (res: Response, result: InventoryItemMutationResult) => res.status === 409 &&
        (result.error === "inventory_item_duplicate_name_vi" ||
            result.error === "inventory_item_duplicate_name_code");
    const readInventoryItemMutationResult = async (res: Response, action: "save" | "edit"): Promise<InventoryItemMutationResult | null> => {
        try {
            const result = await res.json();
            if (res.ok && result.ok) {
                const notice = ledgerSyncNotice(result.ledgerSync, lang === "vi");
                if (notice)
                    alert(notice);
            }
            return result;
        }
        catch (error) {
            console.error(`inventory ${action} invalid json response`, {
                status: res.status,
                error,
            });
            alert(action === "edit" ? c.editFail : c.saveFail);
            return null;
        }
    };
    const handleInventoryItemMutationFailure = (res: Response, result: InventoryItemMutationResult, action: "save" | "edit") => {
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
        if (isEditReasonSaving)
            return;
        setEditFormPendingSave(null);
        setPurchaseCorrectionRoots(null);
        setSelectedPurchaseRootId(null);
    };
    const editSaveLockRef = useRef(false);
    const handleEditReasonConfirm = async (reason: QuickReasonValue) => {
        if (!editFormPendingSave || isEditReasonSaving || editSaveLockRef.current || photoActionLockRef.current)
            return;
        editSaveLockRef.current = true;
        onBusyChange?.(true);
        setIsEditReasonSaving(true);
        try {
            const res = await fetchInventoryApi("/api/inventory/items", {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    id: editFormPendingSave.id,
                    payload: editFormPendingSave.payload,
                    source: "edit_form",
                    reason,
                    expectedQuantity: editFormPendingSave.expectedQuantity,
                    expectedUpdatedAt: editFormPendingSave.expectedUpdatedAt,
                    ...(reason === "purchase" && selectedPurchaseRootId !== null ? {
                        selectedPurchaseRootId,
                        expectedQuantity: editFormPendingSave.expectedQuantity,
                    } : {}),
                }),
            });
            const result = await readInventoryItemMutationResult(res, "edit");
            if (!result)
                return;
            if (!res.ok || !result.ok) {
                if (reason === "purchase" && result.error === "purchase_correction_selection_required") {
                    setPurchaseCorrectionRoots(result.candidates ?? []);
                    setSelectedPurchaseRootId(result.recommended ? result.candidates?.[0]?.id ?? null : null);
                    return;
                }
                if (reason === "purchase" && result.error === "purchase_correction_root_not_found") {
                    alert(lang === "vi" ? "Không tìm thấy lô nhập gốc có thể liên kết. Vui lòng kiểm tra lịch sử kho." : "연결 가능한 원입고를 찾지 못했습니다. 재고 이력을 확인해주세요.");
                    return;
                }
                handleInventoryItemMutationFailure(res, result, "edit");
                return;
            }
            onSaved?.({ ...inventoryList[0], ...editFormPendingSave.payload } as InventoryItem);
        }
        catch {
            alert(c.editFail);
        }
        finally {
            editSaveLockRef.current = false;
            onBusyChange?.(false);
            setIsEditReasonSaving(false);
        }
    };
    const formatExistingPurchasePrice = (value: InventoryItem["purchase_price"]) => value == null ? "" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 20 });
    const preserveUnchangedPurchasePrice = (draft: string, original: InventoryItem["purchase_price"]) => draft === formatExistingPurchasePrice(original) ? (original == null ? null : Number(original)) : parsePrice(draft);
    const handleEdit = (item: InventoryItem, aliases = supplierAliases) => {
        const nextPart: InventoryPartValue = isInventoryPart(item.part)
            ? item.part
            : defaultPart;
        const matchedCategory = resolveInventoryCategoryOption(nextPart, item.category, item.category_vi);
        const nextCategory = matchedCategory
            ? matchedCategory[lang]
            : getInventoryCategoryLabel(nextPart, item.category, item.category_vi, lang);
        const nextCategoryOptions = CATEGORY_OPTIONS_BY_PART[nextPart as keyof typeof CATEGORY_OPTIONS_BY_PART] ?? [];
        const nextItemName = lang === "vi"
            ? item.item_name_vi || ""
            : item.item_name || "";
        clearFormPhotoDraft();
        setOtherItemName(lang === "ko" ? item.item_name_vi || "" : item.item_name || "");
        setPart(nextPart);
        setItemName(nextItemName);
        setCategory(nextCategory);
        setCategoryKo(matchedCategory?.ko || item.category || "");
        setCategoryVi(matchedCategory?.vi || item.category_vi || "");
        const matched = matchedCategory || nextCategoryOptions.find((option) => (lang === "vi" ? option.vi : option.ko) === nextCategory);
        setIsCustomCategory(!matched && !!nextCategory);
        setQuantity(String(item.quantity ?? ""));
        setUnit(item.unit || "");
        setNote(item.note || "");
        setPurchasePrice(formatExistingPurchasePrice(item.purchase_price));
        setSupplier(item.supplier_partner_name || item.supplier || "");
        setSupplierPartnerId(item.supplier_partner_id ?? null);
        setIsCustomSupplier(!!item.supplier &&
            !item.supplier_partner_id &&
            !aliases.some((alias) => alias.status === "pending" && alias.supplierName.trim().toLowerCase() === String(item.supplier).trim().toLowerCase()));
        setCode(item.code || "");
        setLowStockThreshold(String(item.low_stock_threshold ?? 1));
        setLowStockEnabled(item.low_stock_enabled === true);
        setPackageContentQuantity(item.package_content_quantity === null || item.package_content_quantity === undefined
            ? ""
            : String(item.package_content_quantity));
        setPackageContentUnit(item.package_content_unit || "");
    };
    const handleSubmit = async () => {
        if (isSubmitting || editSaveLockRef.current || photoActionLockRef.current || editFormPendingSave)
            return;
        setIsSubmitting(true);
        try {
            const normalizedItemName = normalizeText(itemName);
            const normalizedCategoryKo = normalizeText(categoryKo || (lang === "ko" ? category : ""));
            const normalizedCategoryVi = normalizeText(categoryVi || (lang === "vi" ? category : ""));
            const normalizedSupplier = normalizeText(supplier);
            const normalizedUnit = normalizeText(unit);
            const normalizedNote = normalizeText(note);
            const normalizedCode = normalizeText(code);
            if (!isInventoryPart(part) || !normalizedItemName || !quantity || !normalizedUnit) {
                alert(t.requiredFields);
                return;
            }
            const nextLowStock = lowStockThreshold ? parseDecimal(lowStockThreshold) : 1;
            const nextLowStockEnabled = lowStockEnabled === true;
            const normalizedPackageContentUnit = packageContentUnit.trim().toLowerCase();
            const nextPackageContentQuantity = packageContentQuantity.trim() === ""
                ? null
                : parseDecimal(packageContentQuantity);
            const nextPackageContentUnit = normalizedPackageContentUnit === ""
                ? null
                : normalizedPackageContentUnit;
            if (nextLowStock < 0) {
                alert(t.quantityCannotBeNegative);
                return;
            }
            if (nextPackageContentQuantity !== null &&
                nextPackageContentQuantity <= 0) {
                alert(t.packageContentQuantityMustBePositive);
                return;
            }
            if ((nextPackageContentQuantity === null) !==
                (nextPackageContentUnit === null)) {
                alert(t.packageContentPairRequired);
                return;
            }
            if (nextPackageContentUnit !== null &&
                !["ml", "g"].includes(nextPackageContentUnit)) {
                alert(t.packageContentUnitInvalid);
                return;
            }
            const nextQuantity = parseDecimal(quantity);
            const nextPurchasePrice = purchasePrice.trim() === "" ? null : preserveUnchangedPurchasePrice(purchasePrice, inventoryList.find(item => item.id === editingId)?.purchase_price);
            if (nextQuantity < 0) {
                alert(t.quantityCannotBeNegative);
                return;
            }
            const targetItem = inventoryList.find((item) => item.id === editingId);
            if (!targetItem) {
                alert(c.editFail);
                return;
            }
            const currentItemName = lang === "vi"
                ? targetItem.item_name_vi || ""
                : targetItem.item_name || "";
            const hasChanges = normalizeText((lang === "ko" ? targetItem.item_name_vi : targetItem.item_name) || "") !== normalizeText(otherItemName) ||
                normalizeText(currentItemName) !== normalizedItemName ||
                normalizeText(targetItem.category || "") !== normalizedCategoryKo ||
                normalizeText(targetItem.category_vi || "") !== normalizedCategoryVi ||
                normalizeText(targetItem.unit || "") !== normalizedUnit ||
                normalizeText(targetItem.note || "") !== normalizedNote ||
                (targetItem.part || "") !== part ||
                parseDecimal(targetItem.quantity ?? 0) !== nextQuantity ||
                (targetItem.purchase_price ?? null) !== nextPurchasePrice ||
                normalizeText(targetItem.supplier || "") !== normalizedSupplier ||
                (targetItem.supplier_partner_id ?? null) !== supplierPartnerId ||
                normalizeText(targetItem.code || "") !== normalizedCode ||
                (targetItem.package_content_quantity === null ||
                    targetItem.package_content_quantity === undefined
                    ? null
                    : parseDecimal(targetItem.package_content_quantity)) !==
                    nextPackageContentQuantity ||
                (targetItem.package_content_unit || "").toLowerCase() !==
                    (nextPackageContentUnit || "") ||
                parseDecimal(targetItem.low_stock_threshold ?? 1) !== nextLowStock ||
                (targetItem.low_stock_enabled === true) !== nextLowStockEnabled;
            if (!hasChanges) {
                alert(t.noAdditionalChanges);
                return;
            }
            const payload: Record<string, unknown> = lang === "ko"
                ? {
                    item_name: normalizedItemName,
                    category: normalizedCategoryKo,
                    category_vi: normalizedCategoryVi,
                    purchase_price: nextPurchasePrice,
                    low_stock_threshold: nextLowStock,
                    low_stock_enabled: nextLowStockEnabled,
                    package_content_quantity: nextPackageContentQuantity,
                    package_content_unit: nextPackageContentUnit,
                    quantity: nextQuantity,
                    unit: normalizedUnit,
                    note: normalizedNote,
                    part,
                    supplier: normalizedSupplier,
                    supplierPartnerId,
                    code: normalizedCode,
                    updated_at: new Date().toISOString(),
                }
                : {
                    item_name_vi: normalizedItemName,
                    category: normalizedCategoryKo,
                    category_vi: normalizedCategoryVi,
                    purchase_price: nextPurchasePrice,
                    low_stock_threshold: nextLowStock,
                    low_stock_enabled: nextLowStockEnabled,
                    package_content_quantity: nextPackageContentQuantity,
                    package_content_unit: nextPackageContentUnit,
                    quantity: nextQuantity,
                    unit: normalizedUnit,
                    note: normalizedNote,
                    part,
                    supplier: normalizedSupplier,
                    supplierPartnerId,
                    code: normalizedCode,
                    updated_at: new Date().toISOString(),
                };
            payload[lang === "ko" ? "item_name_vi" : "item_name"] = normalizeText(otherItemName);
            setEditFormPendingSave({
                id: editingId,
                payload,
                expectedQuantity: Number(inventoryList.find(item => item.id === editingId)?.quantity),
                expectedUpdatedAt: targetItem.updated_at ?? null,
            });
            return;
        }
        finally {
            setIsSubmitting(false);
        }
    };
    const uploadInventoryPhoto = async (itemId: number, file: File) => {
        setPhotoBusyItemId(itemId);
        try {
            const formData = new FormData();
            formData.append("file", file);
            const res = await fetchInventoryApi(`/api/inventory/items/${itemId}/photo`, {
                method: "POST",
                body: formData,
            });
            const result = await res.json();
            if (!res.ok || !result.ok) {
                console.error(result);
                alert(getPhotoUploadErrorMessage(result.error, result.message));
                return false;
            }
            setInventoryList((prev) => prev.map((item) => item.id === itemId
                ? {
                    ...item,
                    image_path: result.data?.image_path ?? null,
                    updated_at: result.data?.updated_at ?? item.updated_at,
                    updated_by_name: result.data?.updated_by_name ?? item.updated_by_name,
                }
                : item));
            alert(t.photoSaved);
            return true;
        }
        finally {
            setPhotoBusyItemId(null);
        }
    };
    const handleFormPhotoChange = async (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file || photoActionLockRef.current || editSaveLockRef.current)
            return;
        photoActionLockRef.current = true;
        onBusyChange?.(true);
        setIsFormPhotoProcessing(true);
        setPhotoCompressionMessage(t.photoCompressing);
        try {
            const compressed = await compressInventoryImage(file);
            const compressedFile = compressed.file;
            setPhotoCompressionMessage(t.photoCompressed(formatFileSize(compressed.originalBytes), formatFileSize(compressed.compressedBytes)));
            const uploaded = await uploadInventoryPhoto(editingId, compressedFile);
            if (uploaded)
                clearFormPhotoDraft();
            else
                setPhotoCompressionMessage("");
        }
        catch (error) {
            console.error(error);
            setPhotoCompressionMessage("");
            if (error instanceof InventoryImageCompressionError) {
                alert(error.code === "unsupported_format"
                    ? t.photoUnsupportedFormat
                    : t.photoCompressionFailed);
                return;
            }
            alert(getErrorMessage(error));
        }
        finally {
            setIsFormPhotoProcessing(false);
            photoActionLockRef.current = false;
            onBusyChange?.(false);
        }
    };
    const handleInventoryPhotoDelete = async (itemId: number) => {
        if (photoBusyItemId === itemId || photoActionLockRef.current || editSaveLockRef.current)
            return;
        photoActionLockRef.current = true;
        onBusyChange?.(true);
        setPhotoBusyItemId(itemId);
        setPhotoCompressionMessage("");
        try {
            const res = await fetchInventoryApi(`/api/inventory/items/${itemId}/photo`, {
                method: "DELETE",
            });
            const result = await res.json();
            if (!res.ok || !result.ok) {
                console.error(result);
                alert(result.message || "Image delete failed");
                return;
            }
            setInventoryList((prev) => prev.map((item) => item.id === itemId
                ? {
                    ...item,
                    image_path: result.data?.image_path ?? null,
                    updated_at: result.data?.updated_at ?? item.updated_at,
                    updated_by_name: result.data?.updated_by_name ?? item.updated_by_name,
                }
                : item));
            alert(t.photoDeletedSuccess);
        }
        finally {
            setPhotoBusyItemId(null);
            photoActionLockRef.current = false;
            onBusyChange?.(false);
        }
    };
    const handleKeyDown = (e: React.KeyboardEvent, nextRef?: React.RefObject<HTMLInputElement | HTMLSelectElement | null>) => {
        if (e.key === "Enter") {
            e.preventDefault();
            if (nextRef?.current) {
                nextRef.current.focus();
            }
            else {
                handleSubmit();
            }
        }
    };
    const inventoryPartLabels: Record<InventoryPartValue, string> = {
        kitchen: c.kitchen,
        hall: c.hall,
        bar: c.bar,
        etc: c.etc,
    };
    const inventoryPartOptions = INVENTORY_PART_VALUES.map((value) => ({
        value,
        label: inventoryPartLabels[value],
    }));
    const getPartButtonStyle = (value: InventoryPartValue, active: boolean) => {
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
    const getCategoryTabButtonStyle = (active: boolean) => {
        return {
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
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
    const editingItem = useMemo(() => editingId
        ? inventoryList.find((item) => item.id === editingId) || null
        : null, [inventoryList, editingId]);
    const labelStyle = {
        fontSize: 13,
        fontWeight: 700,
        color: "#374151",
        marginBottom: embedded ? 8 : 6,
    };
    useEffect(() => {
        let active = true;
        if (!requestRef.current)
            requestRef.current = initialItem ? Promise.resolve({ data: [initialItem], supplierPartners: initialSuppliers, supplierAliases: initialAliases }) : fetchInventoryApi(`/api/inventory/items?itemId=${itemId}`, { cache: "no-store" }).then(async (response) => { const result = await response.json(); if (!response.ok || !result.ok || result.data?.[0]?.id !== itemId)
                throw new Error(result.message || c.loadFailed || c.editFail); return result; });
        requestRef.current.then(result => { if (!active)
            return; setInventoryList(result.data); setSupplierPartners(result.supplierPartners ?? []); setSupplierAliases(result.supplierAliases ?? []); handleEdit(result.data[0], result.supplierAliases ?? []); setReady(true); }).catch(error => { if (active)
            setLoadError(error instanceof Error ? error.message : c.editFail); });
        return () => { active = false; };
        // The keyed editor initializes once; draft values survive unrelated parent refreshes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [itemId]);
    useEffect(() => {
        if (nameLanguageRef.current === lang) return;
        nameLanguageRef.current = lang;
        setItemName(otherItemName);
        setOtherItemName(itemName);
    }, [lang, itemName, otherItemName]);
    useEffect(() => { if (!ready)
        return; const input = focusLanguage && focusLanguage !== lang ? otherItemNameRef.current : itemNameRef.current; input?.focus({ preventScroll: true }); }, [ready, focusLanguage, lang]);
    useEffect(() => { onBusyChange?.(isEditReasonSaving || isSubmitting || isFormPhotoProcessing || photoBusyItemId !== null); }, [isEditReasonSaving, isSubmitting, isFormPhotoProcessing, photoBusyItemId, onBusyChange]);
    if (loadError)
        return <div role="alert">{loadError}</div>;
    if (!ready)
        return embedded ? <InventoryLoadingCard lang={lang} minHeight="min(512px, 52dvh)" testId="inventory-editor-loading" /> : <div role="status">{c.loading}</div>;
    const content = <>
    <div ref={formRef} data-testid="inventory-edit-form" style={{
            ...ui.card,
            padding: embedded ? 0 : 20,
            marginBottom: embedded ? 0 : 24,
            ...(embedded ? { border: "none", boxShadow: "none", borderRadius: 0 } : {}),
        }}>
                    {!embedded && <h2 style={ui.sectionTitle}>{t.inputTitle}</h2>}

                    <div style={{ display: "flex", flexDirection: "column", gap: embedded ? 20 : 14 }}>
                        {/* 파트 */}
                        <div>
                            <div style={labelStyle}>
                                {c.part}
                            </div>
                            <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 8,
        }}>
                                {inventoryPartOptions.map((partOption) => {
            const partValue = partOption.value;
            const active = part === partValue;
            const meta = PART_META[partValue];
            return (<button key={partOption.value} type="button" onClick={() => setPart(partValue)} style={getPartButtonStyle(partValue, active)}>
                                            {meta.emoji} {partOption.label}
                                        </button>);
        })}
                            </div>
                        </div>

                        {/* 카테고리 */}
                        <div>
                            <div style={labelStyle}>
                                {c.category}
                            </div>
                            <select value={isCustomCategory ? "__custom__" : category} onChange={(e) => {
            const value = e.target.value;
            if (value === "__custom__") {
                setIsCustomCategory(true);
                setCategory("");
                setCategoryKo("");
                setCategoryVi("");
                return;
            }
            const selected = mergedCategoryOptions.find((option) => option.label === value);
            setIsCustomCategory(false);
            setCategory(value);
            if (selected) {
                setCategoryKo(selected.ko);
                setCategoryVi(selected.vi);
            }
            else {
                if (lang === "vi") {
                    setCategoryKo("");
                    setCategoryVi(value);
                }
                else {
                    setCategoryKo(value);
                    setCategoryVi("");
                }
            }
        }} style={ui.input}>
                                <option value="">{t.categoryPlaceholder}</option>

                                {mergedCategoryOptions.map((option) => (<option key={`${part}-${option.label}`} value={option.label}>
                                        {option.label}
                                    </option>))}

                                <option value="__custom__">
                                    {c.directInput}
                                </option>
                            </select>
                        </div>

                        {isCustomCategory && (<div>
                                <div style={labelStyle}>
                                    {t.newCategory}
                                </div>
                                <input type="text" placeholder={t.newCategoryPlaceholder} value={category} onChange={(e) => {
                const value = e.target.value;
                setCategory(value);
                if (lang === "vi") {
                    setCategoryKo("");
                    setCategoryVi(value);
                }
                else {
                    setCategoryKo(value);
                    setCategoryVi("");
                }
            }} style={ui.input} onKeyDown={(e) => handleKeyDown(e, itemNameRef)}/>
                            </div>)}

                        {/* 코드 */}
                        <div>
                            <div style={labelStyle}>
                                {c.code}
                            </div>
                            <input type="text" placeholder={c.selectInput} value={code} onChange={(e) => setCode(e.target.value)} style={ui.input}/>
                        </div>

                        {/* 품목명 */}
                        <div>
                            <div style={labelStyle}>
                                {lang === "ko" ? "한국어 품목명" : "Tên tiếng Việt"}
                            </div>
                            <input type="text" placeholder={c.itemName} value={itemName} onChange={(e) => setItemName(e.target.value)} style={ui.input} ref={itemNameRef} data-name-language={lang} onKeyDown={(e) => handleKeyDown(e, supplierRef)}/>
                            
                        </div>

                        <div>
                            <div style={labelStyle}>{t.photoLogLabel}</div>
                            {(formPhotoPreviewUrl || editingItem?.image_path) && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={formPhotoPreviewUrl ||
                getInventoryImageUrl(editingItem?.image_path, editingItem?.updated_at)} alt={itemName || c.itemName} style={{
                width: "100%",
                maxHeight: 240,
                objectFit: "contain",
                borderRadius: 12,
                border: "1px solid #e5e7eb",
                background: "#f8fafc",
                marginBottom: 8,
            }}/>)}

                            <div style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
        }}>
                                <input id="inventory-form-photo-camera" type="file" accept={INVENTORY_PHOTO_CAMERA_ACCEPT} capture="environment" onChange={handleFormPhotoChange} style={{ display: "none" }}/>
                                <input id="inventory-form-photo-library" type="file" accept={INVENTORY_PHOTO_LIBRARY_ACCEPT} onChange={handleFormPhotoChange} style={{ display: "none" }}/>
                                <label htmlFor="inventory-form-photo-camera" style={{
            ...ui.subButton,
            width: "auto",
            minWidth: 84,
            padding: "8px 12px",
            fontSize: 13,
            fontWeight: 700,
            cursor: isFormPhotoProcessing ||
                (editingId && photoBusyItemId === editingId)
                ? "not-allowed"
                : "pointer",
            opacity: isFormPhotoProcessing ||
                (editingId && photoBusyItemId === editingId)
                ? 0.6
                : 1,
        }}>
                                    {isFormPhotoProcessing ||
            (editingId && photoBusyItemId === editingId)
            ? c.saving
            : t.photoCameraButton}
                                </label>
                                <label htmlFor="inventory-form-photo-library" style={{
            ...ui.subButton,
            width: "auto",
            minWidth: 84,
            padding: "8px 12px",
            fontSize: 13,
            fontWeight: 700,
            cursor: isFormPhotoProcessing ||
                (editingId && photoBusyItemId === editingId)
                ? "not-allowed"
                : "pointer",
            opacity: isFormPhotoProcessing ||
                (editingId && photoBusyItemId === editingId)
                ? 0.6
                : 1,
        }}>
                                    {isFormPhotoProcessing ||
            (editingId && photoBusyItemId === editingId)
            ? c.saving
            : t.photoLibraryButton}
                                </label>

                                {formPhotoPreviewUrl && !editingId && (<button type="button" onClick={clearFormPhotoDraft} style={{
                ...ui.subButton,
                width: "auto",
                minWidth: 84,
                padding: "8px 12px",
                fontSize: 13,
                fontWeight: 700,
                color: "crimson",
                border: "1px solid #fecaca",
                background: "#fff5f5",
            }}>
                                        {t.photoDeleteButton}
                                    </button>)}

                                {editingId && editingItem?.image_path && (<button type="button" onClick={() => handleInventoryPhotoDelete(editingId)} disabled={photoBusyItemId === editingId} style={{
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
            }}>
                                        {t.photoDeleteButton}
                                    </button>)}
                            </div>
                            {photoCompressionMessage && (<div style={{
                fontSize: 12,
                color: "#6b7280",
                lineHeight: 1.35,
                marginTop: 6,
            }}>
                                    {photoCompressionMessage}
                                </div>)}
                        </div>

                        <div><div style={labelStyle}>{lang === "ko" ? "베트남어 품목명" : "Tên tiếng Hàn"}</div><input ref={otherItemNameRef} data-name-language={lang === "ko" ? "vi" : "ko"} value={otherItemName} onChange={event => setOtherItemName(event.target.value)} style={ui.input}/></div>
                        {/* 거래처 */}
                        <div>
                            <div style={labelStyle}>
                                {c.supplier}
                            </div>

                            <select value={isCustomSupplier
            ? "__custom__"
            : supplierPartnerId
                ? `partner:${supplierPartnerId}`
                : supplierAliases.find((alias) => alias.status === "pending" && alias.supplierName.trim().toLowerCase() === supplier.trim().toLowerCase())
                    ? `alias:${supplierAliases.find((alias) => alias.status === "pending" && alias.supplierName.trim().toLowerCase() === supplier.trim().toLowerCase())?.id}`
                    : ""} onChange={(e) => {
            const value = e.target.value;
            if (value === "__custom__") {
                setIsCustomSupplier(true);
                setSupplier("");
                setSupplierPartnerId(null);
                return;
            }
            setIsCustomSupplier(false);
            if (value.startsWith("partner:")) {
                const partner = supplierPartners.find((row) => row.id === Number(value.slice(8)));
                setSupplierPartnerId(partner?.id ?? null);
                setSupplier(partner?.name ?? "");
            }
            else if (value.startsWith("alias:")) {
                const alias = supplierAliases.find((row) => row.id === Number(value.slice(6)));
                setSupplierPartnerId(null);
                setSupplier(alias?.supplierName ?? "");
            }
            else {
                setSupplierPartnerId(null);
                setSupplier("");
            }
        }} style={ui.input}>
                                <option value="">{c.supplier}</option>

                                <optgroup label={lang === "vi" ? "Đối tác chính thức" : "정규 거래처"}>
                                    {supplierPartners.map((option) => <option key={option.id} value={`partner:${option.id}`}>{option.name}</option>)}
                                </optgroup>
                                <optgroup label={lang === "vi" ? "Cần xác nhận" : "확인 필요"}>
                                    {supplierAliases.filter((alias) => alias.status === "pending").map((alias) => <option key={alias.id} value={`alias:${alias.id}`}>{alias.supplierName}</option>)}
                                </optgroup>

                                <option value="__custom__">
                                    {c.directInput}
                                </option>
                            </select>
                        </div>

                        {isCustomSupplier && (<div>
                                <div style={labelStyle}>
                                    {t.newSupplier}
                                </div>
                                <input type="text" placeholder={t.newSupplierPlaceholder} value={supplier} onChange={(e) => { setSupplier(e.target.value); setSupplierPartnerId(null); }} style={ui.input} ref={supplierRef} onKeyDown={(e) => handleKeyDown(e, priceRef)}/>
                            </div>)}

                        {/* 구매가 */}
                        <div>
                            <div style={labelStyle}>
                                {t.purchasePrice}
                            </div>
                            <input type="text" placeholder={t.purchasePrice} value={purchasePrice} onChange={(e) => {
            setPurchasePrice(formatNumber(e.target.value));
        }} style={ui.input} ref={priceRef} onKeyDown={(e) => handleKeyDown(e, unitRef)}/>
                        </div>

                        {/* 단위 */}
                        <div>
                            <div style={labelStyle}>
                                {c.unit}
                            </div>
                            <input type="text" placeholder={t.unitPlaceholder} value={unit} onChange={(e) => setUnit(e.target.value)} style={ui.input} ref={unitRef} onKeyDown={(e) => handleKeyDown(e, packageContentQuantityRef)}/>
                        </div>

                        <div style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            marginTop: -6,
        }}>
                            {["Kg", "g", "L", "ml", lang === "vi" ? "Chai" : "병"].map((u) => {
            const active = unit === u;
            return (<button key={u} type="button" onClick={() => setUnit(u)} style={getCategoryTabButtonStyle(active)}>
                                        {u}
                                    </button>);
        })}
                        </div>

                        {/* 1단위 내용량 */}
                        <div>
                            <div style={labelStyle}>
                                {t.packageContentLabel}
                            </div>
                            <div style={{ display: "flex", gap: 8 }}>
                                <input type="number" step="any" min="0.0001" placeholder="320, 700, 1000" value={packageContentQuantity} onChange={(e) => setPackageContentQuantity(e.target.value)} style={{ ...ui.input, flex: 1 }} ref={packageContentQuantityRef} onKeyDown={(e) => handleKeyDown(e, quantityRef)}/>
                                <select value={packageContentUnit} onChange={(e) => setPackageContentUnit(e.target.value)} style={{ ...ui.input, width: 92 }}>
                                    <option value="">-</option>
                                    <option value="ml">ml</option>
                                    <option value="g">g</option>
                                </select>
                            </div>
                            <div style={{
            marginTop: 6,
            color: "#6b7280",
            fontSize: 12,
            lineHeight: 1.4,
        }}>
                                {t.packageContentHelp}
                            </div>
                        </div>

                        {/* 수량 */}
                        <div>
                            <div style={labelStyle}>
                                {c.quantity}
                            </div>
                            <input type="number" step="0.1" placeholder={c.quantity} value={quantity} onChange={(e) => setQuantity(e.target.value)} style={ui.input} ref={quantityRef} onKeyDown={(e) => handleKeyDown(e, lowStockEnabled ? lowStockThresholdRef : noteRef)}/>
                        </div>

                        {/* 부족기준 */}
                        <div>
                            <label style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            fontWeight: 800,
            color: "#374151",
            marginBottom: 6,
        }}>
                                <input type="checkbox" checked={lowStockEnabled} onChange={(e) => setLowStockEnabled(e.target.checked)} style={{ width: 16, height: 16 }}/>
                                {t.lowStockEnabled}
                            </label>

                            <div style={{
            marginBottom: lowStockEnabled ? 8 : 0,
            color: "#6b7280",
            fontSize: 12,
            lineHeight: 1.4,
        }}>
                                {t.lowStockEnabledHelp}
                            </div>

                            {lowStockEnabled && (<>
                                    <div style={labelStyle}>
                                        {t.lowStockThreshold}
                                    </div>
                                    <input type="number" step="0.1" placeholder={t.lowStockThreshold} value={lowStockThreshold} onChange={(e) => setLowStockThreshold(e.target.value)} style={ui.input} ref={lowStockThresholdRef} onKeyDown={(e) => handleKeyDown(e, noteRef)}/>
                                </>)}
                        </div>

                        {/* 비고 */}
                        <div>
                            <div style={labelStyle}>
                                {c.note}
                            </div>
                            <input type="text" placeholder={c.note} value={note} onChange={(e) => setNote(e.target.value)} style={ui.input} ref={noteRef} onKeyDown={(e) => handleKeyDown(e)}/>
                        </div>

                        <button onClick={handleSubmit} disabled={isSubmitting || isFormPhotoProcessing || photoBusyItemId !== null || !!editFormPendingSave} style={{
            ...ui.button,
            opacity: isSubmitting ? 0.6 : 1,
            cursor: isSubmitting ? "not-allowed" : "pointer",
        }}>
                            {isSubmitting
            ? (c.saving)
            : editingId
                ? c.save
                : c.save}
                        </button>

                        {editingId && (<button onClick={() => onClose?.()} disabled={isEditReasonSaving || isSubmitting || isFormPhotoProcessing || photoBusyItemId !== null} style={{
                ...ui.button,
                background: "#e5e7eb",
                color: "black",
                border: "1px solid #d1d5db",
            }}>
                                {c.cancel}
                            </button>)}
                    </div>
                </div>
        {editFormPendingSave && (<div style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.45)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1000,
                padding: 20,
            }} onClick={closeEditReasonModal}>
                    <div onClick={(e) => e.stopPropagation()} style={{
                width: "100%",
                maxWidth: 420,
                background: "#fff",
                borderRadius: 14,
                padding: 18,
                boxShadow: "0 20px 50px rgba(0,0,0,0.2)",
                display: "flex",
                flexDirection: "column",
                gap: 10,
            }}>
                        <div style={{ fontSize: 17, fontWeight: 800, color: "#111827" }}>
                            {t.editReasonModalTitle}
                        </div>

                        <div style={{ ...ui.metaText, marginBottom: 4 }}>
                            {t.editReasonModalDescription}
                        </div>

                        {purchaseCorrectionRoots ? <>
                            <p>{lang === "vi" ? "Đây là sửa lô nhập gốc. Chọn lô nhập để liên kết; số tiền trong sổ sẽ được tính lại theo chính sách hiện có." : "원입고 수정입니다. 연결할 원입고를 선택하면 기존 정책에 따라 장부금액이 다시 계산됩니다."}</p>
                            <label>{lang === "vi" ? "Chọn lô nhập gốc" : "원입고 선택"}
                                <select value={selectedPurchaseRootId ?? ""} disabled={isEditReasonSaving} onChange={event => setSelectedPurchaseRootId(Number(event.target.value) || null)} style={ui.input}>
                                    <option value="">{lang === "vi" ? "Chọn lô nhập" : "원입고를 선택해 주세요"}</option>
                                    {purchaseCorrectionRoots.map(root => <option key={root.id} value={root.id}>
                                        {root.business_date} · +{root.change_quantity}{root.unit ?? ""} · {root.new_supplier} · {root.new_purchase_price}₫
                                    </option>)}
                                </select>
                            </label>
                            <button type="button" disabled={isEditReasonSaving || selectedPurchaseRootId === null} onClick={() => handleEditReasonConfirm("purchase")} style={ui.button}>
                                {lang === "vi" ? "Liên kết lô nhập gốc và lưu thay đổi" : "원입고에 연결하고 수정 저장"}
                            </button>
                        </> : null}

                        <div style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
            }}>
                            {(["stock_check", "purchase", "service", "other"] as const).map((reason) => (<button key={reason} type="button" onClick={() => handleEditReasonConfirm(reason)} disabled={isEditReasonSaving || purchaseCorrectionRoots !== null} style={{
                    ...ui.subButton,
                    opacity: isEditReasonSaving ? 0.6 : 1,
                    cursor: isEditReasonSaving
                        ? "not-allowed"
                        : "pointer",
                }}>
                                        <span style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    whiteSpace: "nowrap",
                }}>
                                            <span aria-hidden="true">
                                                {INVENTORY_REASON_EMOJIS[reason]}
                                            </span>
                                            <span>{INVENTORY_REASON_LABELS[lang][reason]}</span>
                                        </span>
                                    </button>))}
                        </div>

                        <button type="button" onClick={closeEditReasonModal} disabled={isEditReasonSaving} style={{
                ...ui.subButton,
                marginTop: 4,
                opacity: isEditReasonSaving ? 0.6 : 1,
            }}>
                            {c.close}
                        </button>
                    </div>
                </div>)}
    </>;
    return content;
}
