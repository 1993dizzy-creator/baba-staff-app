"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/lib/language-context";
import Container from "@/components/Container";
import { ui } from "@/lib/styles/ui";
import { commonText, inventoryText } from "@/lib/text";
import SubNav from "@/components/SubNav";
import { usePathname, useRouter } from "next/navigation";
import { getInventoryTabs } from "@/lib/navigation/inventory-tabs";
import {PART_VALUES,PART_META,type PartValue,} from "@/lib/common/parts";
import { formatDecimalDisplay } from "@/lib/inventory/number";
import { getBusinessDate } from "@/lib/common/business-time";
import {
    INVENTORY_REASON_EMOJIS,
    INVENTORY_REASON_LABELS,
    QUICK_REASON_VALUES,
    type InventoryReasonValue,
    type QuickReasonValue,
} from "@/lib/inventory/reasons";


type SnapshotBatch = {
    id: number;
    snapshot_date: string;
};

type SnapshotItem = {
    id: number;
    syncLogIds?: number[];
    batch_id: number | null;
    item_id: number | null;
    item_name: string | null;
    item_name_vi: string | null;
    part: string | null;
    category: string | null;
    category_vi: string | null;
    quantity: number | null;
    unit: string | null;
    code: string | null;
    prev_quantity: number | null;
    change_quantity: number | null;
    purchase_price: number | null;
    prev_purchase_price?: number | null;
    new_purchase_price?: number | null;
    supplier: string | null;
    total_purchase_price: number | null;
    reason?: InventoryReasonValue | null;
    source?: string | null;
    business_date?: string | null;
    created_at?: string | null;
    actor_name?: string | null;
    new_note?: string | null;
    prev_note?: string | null;
};

type InventoryLog = {
    id: number;
    item_id: number | null;
    action: string | null;
    item_name: string | null;
    item_name_vi: string | null;
    part: string | null;
    category: string | null;
    category_vi: string | null;
    prev_quantity: number | null;
    new_quantity: number | null;
    change_quantity: number | null;
    unit: string | null;
    code: string | null;
    purchase_price?: number | null;
    prev_purchase_price?: number | null;
    new_purchase_price?: number | null;
    supplier?: string | null;
    new_supplier?: string | null;
    reason?: InventoryReasonValue | null;
    source?: string | null;
    business_date?: string | null;
    created_at: string | null;
    actor_name: string | null;
    new_note: string | null;
    prev_note: string | null;
};

type PriceTrend = "up" | "down" | null;
type MovementReasonTab = "stock_check" | "service" | "other" | "sale_deduction";

type MovementItemGroup = {
    key: string;
    representative: SnapshotItem;
    count: number;
    totalQuantity: number;
    totalAmount: number | null;
    latestTime: number;
    isApproxPrice: boolean;
    notes: string[];
};

const PURCHASE_GROUP_NO_SUPPLIER = "__no_supplier__";
const PURCHASE_GROUP_NO_PRICE = "__no_price__";

const getPurchaseSupplierGroupKey = (supplier?: string | null) =>
    supplier?.trim() || PURCHASE_GROUP_NO_SUPPLIER;

const getPurchasePriceGroupKey = (price?: string | number | null) => {
    if (price === null || price === undefined || price === "") {
        return PURCHASE_GROUP_NO_PRICE;
    }

    const numericPrice = Number(price);

    if (!Number.isFinite(numericPrice)) {
        return String(price).trim() || PURCHASE_GROUP_NO_PRICE;
    }

    return String(numericPrice);
};

const getPurchaseGroupKey = (item: SnapshotItem) => {
    const supplierKey = getPurchaseSupplierGroupKey(item.supplier);
    const priceKey = getPurchasePriceGroupKey(item.purchase_price);
    const itemId = Number(item.item_id);

    if (Number.isFinite(itemId) && itemId > 0) {
        return `item:${itemId}:supplier:${supplierKey}:price:${priceKey}`;
    }

    return [
        "fallback",
        `supplier:${supplierKey}`,
        `price:${priceKey}`,
        item.item_name || "",
        item.item_name_vi || "",
        item.unit || "",
        item.code || "",
    ].join(":");
};

const getSnapshotItemTime = (item: SnapshotItem) => {
    const time = item.created_at ? new Date(item.created_at).getTime() : NaN;
    return Number.isFinite(time) ? time : 0;
};

const getMovementNoteText = (item: SnapshotItem) =>
    String(item.new_note || item.prev_note || "").trim();

const buildDailyNetPurchasedItems = (items: SnapshotItem[]) => {
    const groups = new Map<
        string,
        {
            representative: SnapshotItem;
            quantity: number;
            totalPurchasePrice: number;
            hasPurchaseAmount: boolean;
            logIds: number[];
        }
    >();

    for (const item of items) {
        if (item.reason !== "purchase") continue;

        const changeQuantity = Number(item.change_quantity ?? 0);
        if (!Number.isFinite(changeQuantity) || changeQuantity === 0) continue;

        const key = getPurchaseGroupKey(item);
        const current = groups.get(key);
        const itemLogId = Number(item.id);
        const rawTotalPurchasePrice = item.total_purchase_price;
        const rawPurchasePrice = item.purchase_price;
        const purchasePrice = Number(rawPurchasePrice);
        const hasPurchaseAmount = rawTotalPurchasePrice !== null &&
            rawTotalPurchasePrice !== undefined &&
            Number.isFinite(Number(rawTotalPurchasePrice));
        const hasPurchasePrice = rawPurchasePrice !== null &&
            rawPurchasePrice !== undefined &&
            Number.isFinite(purchasePrice);
        const signedAmount = hasPurchaseAmount
            ? Number(item.total_purchase_price)
            : hasPurchasePrice
                ? changeQuantity * purchasePrice
                : 0;

        if (!current) {
            groups.set(key, {
                representative: item,
                quantity: changeQuantity,
                totalPurchasePrice: signedAmount,
                hasPurchaseAmount: hasPurchaseAmount || hasPurchasePrice,
                logIds: Number.isFinite(itemLogId) && itemLogId > 0 ? [itemLogId] : [],
            });
            continue;
        }

        const representative =
            getSnapshotItemTime(item) > getSnapshotItemTime(current.representative) ||
            (
                getSnapshotItemTime(item) === getSnapshotItemTime(current.representative) &&
                Number(item.id) > Number(current.representative.id)
            )
                ? item
                : current.representative;

        current.representative = representative;
        current.quantity += changeQuantity;
        current.totalPurchasePrice += signedAmount;
        current.hasPurchaseAmount = current.hasPurchaseAmount || hasPurchaseAmount || hasPurchasePrice;
        if (Number.isFinite(itemLogId) && itemLogId > 0) {
            current.logIds.push(itemLogId);
        }
    }

    return Array.from(groups.values())
        .map((group) => {
            const netQuantity = Number(group.quantity.toFixed(6));
            const netTotalPurchasePrice = Number(group.totalPurchasePrice.toFixed(2));

            return {
                ...group.representative,
                syncLogIds: group.logIds,
                change_quantity: netQuantity,
                total_purchase_price: group.hasPurchaseAmount ? netTotalPurchasePrice : null,
                reason: "purchase" as const,
            };
        })
        .filter((item) => Number(item.change_quantity ?? 0) > 0);
};

function getInventoryBusinessDateKey(date = new Date()) {
    return getBusinessDate(date);
}

function getInventoryBusinessMonthKey(date = new Date()) {
    return getInventoryBusinessDateKey(date).slice(0, 7);
}

export default function InventorySnapshotsPage() {
    const { lang } = useLanguage();
    const t = inventoryText[lang];
    const c = commonText[lang];
    const currentBusinessDateLabel =
        lang === "vi" ? "Ngày kinh doanh hiện tại" : "현재 영업일";
    const activeBusinessDateKey = getInventoryBusinessDateKey();
    const router = useRouter();

    const [batchList, setBatchList] = useState<SnapshotBatch[]>([]);
    const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
    const [snapshotItems, setSnapshotItems] = useState<SnapshotItem[]>([]);
    const [search, setSearch] = useState("");
    const [partFilter, setPartFilter] = useState<"all" | PartValue>("all");
    const [viewMode, setViewMode] = useState<"current" | "snapshot">("current");
    const [loadingBatches, setLoadingBatches] = useState(true);
    const [loadingItems, setLoadingItems] = useState(false);
    const [categoryFilter, setCategoryFilter] = useState("all");
    const [showChangedOnly, setShowChangedOnly] = useState(false);
    const [calendarMonth, setCalendarMonth] = useState(() => getInventoryBusinessMonthKey());
    const [purchaseDateMap, setPurchaseDateMap] = useState<Record<string, boolean>>({});
    const [supplierTab, setSupplierTab] = useState("all");
    const [movementItems, setMovementItems] = useState<SnapshotItem[]>([]);
    const [movementReasonTab, setMovementReasonTab] =
        useState<MovementReasonTab>("stock_check");
    const [loadingMovements, setLoadingMovements] = useState(false);
    const [logModalItem, setLogModalItem] = useState<SnapshotItem | null>(null);
    const [itemLogs, setItemLogs] = useState<InventoryLog[]>([]);
    const [isItemLogsLoading, setIsItemLogsLoading] = useState(false);
    const [itemLogsError, setItemLogsError] = useState("");
    const [changingReasonLogId, setChangingReasonLogId] = useState<number | null>(null);
    const [syncingPurchaseLogId, setSyncingPurchaseLogId] = useState<number | null>(null);
    const [purchaseLogGroupFilter, setPurchaseLogGroupFilter] = useState("all");

    const getSelectedBusinessDate = () => {
        if (viewMode === "snapshot") {
            const batch = batchList.find((item) => Number(item.id) === Number(selectedBatchId));
            if (batch?.snapshot_date) return batch.snapshot_date;
        }

        return activeBusinessDateKey;
    };

    const getReasonEmoji = (reason?: InventoryReasonValue | null) => {
        return INVENTORY_REASON_EMOJIS[reason || "unclassified"];
    };

    const getPurchasePriceTrend = (item: SnapshotItem): PriceTrend => {
        return getPriceTrend(item.prev_purchase_price, item.new_purchase_price ?? item.purchase_price);
    };

    const getPriceTrend = (
        previousPrice?: string | number | null,
        currentPrice?: string | number | null
    ): PriceTrend => {
        const prevPrice = Number(previousPrice ?? 0);
        const newPrice = Number(currentPrice ?? 0);

        if (!Number.isFinite(prevPrice) || !Number.isFinite(newPrice)) return null;
        if (prevPrice <= 0 || newPrice <= 0) return null;
        if (newPrice > prevPrice) return "up";
        if (newPrice < prevPrice) return "down";
        return null;
    };

    const getPurchasePriceTrendStyle = (trend: PriceTrend) => {
        if (trend === "up") {
            return { color: "#059669", fontWeight: 700 };
        }

        if (trend === "down") {
            return { color: "#dc2626", fontWeight: 700 };
        }

        return undefined;
    };

    const getCompactReasonLabel = (reason?: InventoryReasonValue | null) => {
        if (lang === "vi") {
            if (reason === "purchase") return "Nhập";
            if (reason === "stock_check") return "Kiểm";
            if (reason === "service") return "Tặng";
            if (reason === "other") return "Khác";
            if (reason === "sale_deduction") return "Trừ bán";
            return "Khác";
        }

        if (reason === "purchase") return "입고";
        if (reason === "stock_check") return "확인";
        if (reason === "service") return "증정";
        if (reason === "other") return "기타";
        if (reason === "sale_deduction") return "판매차감";
        return "기타";
    };

    const isSalesInventoryLog = (log?: InventoryLog | SnapshotItem | null) =>
        log?.reason === "sale_deduction" || log?.source === "pos_sales";

    const isKegReplaceInventoryLog = (log?: InventoryLog | SnapshotItem | null) =>
        log?.source === "keg_replace";

    const kegReplaceBadgeLabel = lang === "vi" ? "Đổi keg" : "케그 교체";

    const formatReasonItemName = (item: SnapshotItem) => {
        return [
            getReasonEmoji(item.reason),
            item.code ? `[${item.code}]` : "",
            getDisplayItemName(item),
        ]
            .filter(Boolean)
            .join(" ");
    };

    const getDisplayItemName = useCallback((item: SnapshotItem) => {
        return lang === "vi"
            ? item.item_name_vi || item.item_name || "-"
            : item.item_name || item.item_name_vi || "-";
    }, [lang]);

    const getDisplayCategory = useCallback((item: SnapshotItem) => {
        return lang === "vi"
            ? item.category_vi || item.category || "-"
            : item.category || item.category_vi || "-";
    }, [lang]);

    const getCategoryKey = (item: SnapshotItem) =>
        item.category || item.category_vi || "-";

    const getDisplayLogItemName = (log: InventoryLog) => {
        return lang === "vi"
            ? log.item_name_vi || log.item_name || "-"
            : log.item_name || log.item_name_vi || "-";
    };

    const formatCompactLogDateTime = (value?: string | null) => {
        if (!value) return "";

        const date = new Date(value);
        const mm = String(date.getMonth() + 1).padStart(2, "0");
        const dd = String(date.getDate()).padStart(2, "0");
        const hh = String(date.getHours()).padStart(2, "0");
        const min = String(date.getMinutes()).padStart(2, "0");

        return `${mm}.${dd} ${hh}:${min}`;
    };

    const getActionBadge = (action?: string | null) => {
        if (action === "create") return "NEW";
        if (action === "delete") return "DEL";
        return "UP";
    };

    const getActionColor = (action?: string | null) => {
        if (action === "create") return "seagreen";
        if (action === "delete") return "crimson";
        return "royalblue";
    };


    const fetchBatches = useCallback(async (month: string) => {
        setLoadingBatches(true);
        const url = `/api/inventory/snapshot/list${
            month ? `?month=${encodeURIComponent(month)}` : ""
        }`;

        try {
            const res = await fetch(url);
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

            const json = parsedJson && typeof parsedJson === "object"
                ? parsedJson as {
                    ok?: boolean;
                    batches?: SnapshotBatch[];
                    purchaseDateMap?: Record<string, boolean>;
                    error?: string;
                    message?: string;
                }
                : {};

            if (!res.ok || !json.ok) {
                console.warn("[inventory/snapshots] fetchBatches failed", {
                    status: res.status,
                    statusText: res.statusText,
                    url,
                    contentType,
                    json,
                    bodyPreview,
                    parseError: parseErrorMessage,
                });
                setBatchList([]);
                setSelectedBatchId(null);
                setPurchaseDateMap({});
                return;
            }

            const nextBatches = (json.batches || []) as SnapshotBatch[];

            setBatchList(nextBatches);
            setSelectedBatchId(null);
            setPurchaseDateMap(json.purchaseDateMap || {});

            if (!calendarMonth && nextBatches[0]?.snapshot_date) {
                setCalendarMonth(nextBatches[0].snapshot_date.slice(0, 7));
            }
        } catch (error) {
            console.warn("[inventory/snapshots] fetchBatches exception", {
                url,
                error,
                message: error instanceof Error ? error.message : String(error),
            });
            setBatchList([]);
            setSelectedBatchId(null);
            setPurchaseDateMap({});
        } finally {
            setLoadingBatches(false);
        }
    }, [calendarMonth]);

    const fetchSnapshotItems = async (
        batchId: number | string | null | undefined
    ) => {
        const safeBatchId = Number(batchId);

        if (!batchId || !Number.isFinite(safeBatchId) || safeBatchId <= 0) {
            console.warn("[SNAPSHOT_SKIP_INVALID_BATCH_ID]", batchId);
            return;
        }

        setLoadingItems(true);

        try {
            const url = `/api/inventory/snapshot/${safeBatchId}`;
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

            const json = parsedJson && typeof parsedJson === "object"
                ? parsedJson as {
                    ok?: boolean;
                    items?: SnapshotItem[];
                    error?: string;
                    message?: string;
                }
                : {};

            if (!res.ok || !json.ok) {
                console.warn("[inventory/snapshots] fetchSnapshotItems failed", {
                    status: res.status,
                    statusText: res.statusText,
                    url,
                    contentType,
                    batchId,
                    safeBatchId,
                    error: json.error,
                    message: json.message,
                    json,
                    bodyPreview,
                    parseError: parseErrorMessage,
                });
                setSnapshotItems([]);
                return;
            }

            setSnapshotItems(json.items || []);
        } catch (error) {
            console.warn("[inventory/snapshots] fetchSnapshotItems exception", {
                url: `/api/inventory/snapshot/${safeBatchId}`,
                batchId,
                safeBatchId,
                error,
                message: error instanceof Error ? error.message : String(error),
            });
            setSnapshotItems([]);
        } finally {
            setLoadingItems(false);
        }
    };

    const fetchItemLogs = async (item: SnapshotItem) => {
        const itemId = Number(item.item_id);

        setLogModalItem(item);
        setItemLogs([]);
        setItemLogsError("");
        setPurchaseLogGroupFilter("all");

        if (!Number.isFinite(itemId) || itemId <= 0) {
            setItemLogsError(c.noData);
            return;
        }

        setIsItemLogsLoading(true);

        try {
            const url = `/api/inventory/items/${itemId}/logs`;
            const res = await fetch(url, {
                cache: "no-store",
            });

            let result: {
                ok?: boolean;
                data?: InventoryLog[];
                error?: string;
                message?: string;
            };

            try {
                result = await res.json();
            } catch (error) {
                console.error("fetchItemLogs invalid json response", {
                    status: res.status,
                    url,
                    error,
                });
                setItemLogsError(c.loadFailed);
                setItemLogs([]);
                return;
            }

            if (!res.ok || !result.ok) {
                console.error("fetchItemLogs failed", {
                    status: res.status,
                    url,
                    result,
                });
                setItemLogsError(c.loadFailed);
                setItemLogs([]);
                return;
            }

            setItemLogs(result.data || []);
        } catch (error) {
            console.error("fetchItemLogs exception", error);
            setItemLogsError(c.loadFailed);
            setItemLogs([]);
        } finally {
            setIsItemLogsLoading(false);
        }
    };

    const mapLogToSnapshotItem = useCallback((log: InventoryLog): SnapshotItem => {
        const changeQuantity = Number(log.change_quantity ?? 0);
        const purchasePrice = log.new_purchase_price ?? log.prev_purchase_price ?? log.purchase_price ?? null;

        return {
            id: log.id,
            batch_id: null,
            item_id: log.item_id,
            item_name: log.item_name,
            item_name_vi: log.item_name_vi,
            part: log.part,
            category: log.category,
            category_vi: log.category_vi,
            quantity: log.new_quantity,
            prev_quantity: log.prev_quantity,
            change_quantity: log.change_quantity,
            unit: log.unit,
            code: log.code,
            purchase_price: purchasePrice,
            prev_purchase_price: log.prev_purchase_price ?? null,
            new_purchase_price: log.new_purchase_price ?? null,
            supplier: log.new_supplier ?? log.supplier ?? null,
            total_purchase_price: purchasePrice !== null ? changeQuantity * Number(purchasePrice) : null,
            reason: log.reason ?? null,
            source: log.source ?? null,
            business_date: log.business_date ?? null,
            created_at: log.created_at ?? null,
            actor_name: log.actor_name ?? null,
            new_note: log.new_note ?? null,
            prev_note: log.prev_note ?? null,
        };
    }, []);

    const fetchMovementItems = useCallback(async (businessDate: string) => {
        setLoadingMovements(true);
        setSupplierTab("all");

        try {
            const url = `/api/inventory/logs?mode=logs&businessDate=${encodeURIComponent(businessDate)}`;
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

            const json = parsedJson && typeof parsedJson === "object"
                ? parsedJson as {
                    ok?: boolean;
                    data?: InventoryLog[];
                    error?: string;
                    message?: string;
                }
                : {};

            if (!res.ok || !json.ok) {
                console.warn("[inventory/snapshots] fetchMovementItems failed", {
                    status: res.status,
                    statusText: res.statusText,
                    url,
                    contentType,
                    error: json.error,
                    message: json.message,
                    json,
                    bodyPreview,
                    parseError: parseErrorMessage,
                });
                setMovementItems([]);
                return;
            }

            setMovementItems((json.data || []).map(mapLogToSnapshotItem));
        } catch (error) {
            console.warn("[inventory/snapshots] fetchMovementItems exception", {
                url: `/api/inventory/logs?mode=logs&businessDate=${encodeURIComponent(businessDate)}`,
                error,
                message: error instanceof Error ? error.message : String(error),
            });
            setMovementItems([]);
        } finally {
            setLoadingMovements(false);
        }
    }, [mapLogToSnapshotItem]);

    const changeLogReason = async (log: InventoryLog, reason: QuickReasonValue) => {
        if (changingReasonLogId || log.reason === reason) return;

        setChangingReasonLogId(log.id);
        setItemLogsError("");

        try {
            const res = await fetch("/api/inventory/logs", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: log.id, reason }),
            });

            const result = await res.json();

            if (!res.ok || !result.ok) {
                setItemLogsError(result.message || c.loadFailed);
                return;
            }

            setItemLogs((prev) =>
                prev.map((item) =>
                    item.id === log.id ? { ...item, reason: result.data.reason } : item
                )
            );

            if (logModalItem) {
                await fetchItemLogs(logModalItem);
            }

            await fetchMovementItems(getSelectedBusinessDate());
        } catch (error) {
            console.error(error);
            setItemLogsError(c.loadFailed);
        } finally {
            setChangingReasonLogId(null);
        }
    };

    const getPurchaseSyncLogIdsForCard = (item: SnapshotItem) => {
        if (item.syncLogIds && item.syncLogIds.length > 0) {
            return item.syncLogIds;
        }

        const sameCardPurchaseItems = movementItems.filter(
            (candidate) =>
                candidate.reason === "purchase" &&
                candidate.item_id === item.item_id &&
                candidate.business_date === item.business_date &&
                (supplierTab === "all" ||
                    (candidate.supplier || "-") === (item.supplier || "-"))
        );

        return sameCardPurchaseItems
            .map((candidate) => Number(candidate.id))
            .filter((logId) => Number.isFinite(logId) && logId > 0);
    };

    const getSelectedPurchaseItemForModal = (item: SnapshotItem) => {
        const sameCardSyncLogIds = getPurchaseSyncLogIdsForCard(item);
        const clickedLogId = Number(item.id);
        const syncLogIds = sameCardSyncLogIds.length > 0
            ? sameCardSyncLogIds
            : [clickedLogId];

        return {
            ...item,
            syncLogIds: syncLogIds.length > 0 ? syncLogIds : [item.id],
        };
    };

    const openPurchaseLogModal = async (item: SnapshotItem) => {
        const selectedPurchaseItem = getSelectedPurchaseItemForModal(item);
        await fetchItemLogs(selectedPurchaseItem);
    };

    const openInventoryEdit = (item: SnapshotItem) => {
        const itemId = Number(item.item_id);
        if (!Number.isFinite(itemId) || itemId <= 0) {
            alert(c.noData);
            return;
        }

        router.push(`/inventory?itemId=${itemId}&mode=edit`);
    };

    const syncPurchaseInfoFromCurrentItem = async (item: SnapshotItem) => {
        if (syncingPurchaseLogId) return;
        setSyncingPurchaseLogId(item.id);
        const syncLogIds = [item.id]
            .map((logId) => Number(logId))
            .filter((logId) => Number.isFinite(logId) && logId > 0);
        const syncLogIdSet = new Set(syncLogIds);

        try {
            const res = await fetch("/api/inventory/logs", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    id: item.id,
                    logIds: syncLogIds,
                    businessDate: item.business_date,
                    syncCurrentItem: true,
                }),
            });
            const result = await res.json();

            if (!res.ok || !result.ok) {
                console.error(result);
                alert(c.editFail);
                return;
            }

            const syncedLogs = Array.isArray(result.data) ? result.data : [result.data];
            const syncedById = new Map<number, InventoryLog>(
                syncedLogs.map((log: InventoryLog) => [Number(log.id), log])
            );
            const representativeLog = syncedById.get(item.id) ?? syncedLogs[0];

            if (!representativeLog) {
                alert(c.editFail);
                return;
            }

            setMovementItems((prev) =>
                prev.map((movementItem) => {
                    if (!syncLogIdSet.has(Number(movementItem.id))) return movementItem;

                    const syncedLog = syncedById.get(Number(movementItem.id)) ?? representativeLog;
                    const nextPurchasePrice = syncedLog.new_purchase_price ?? null;
                    const nextSupplier = syncedLog.new_supplier ?? null;
                    const nextItemName = syncedLog.item_name ?? movementItem.item_name;
                    const nextItemNameVi = syncedLog.item_name_vi ?? movementItem.item_name_vi;
                    const nextCategory = syncedLog.category ?? movementItem.category;
                    const nextCategoryVi = syncedLog.category_vi ?? movementItem.category_vi;
                    const nextUnit = syncedLog.unit ?? movementItem.unit;
                    const changeQuantity = Number(movementItem.change_quantity ?? 0);
                    const totalPurchasePrice =
                        nextPurchasePrice === null
                            ? null
                            : changeQuantity * Number(nextPurchasePrice);

                    return {
                        ...movementItem,
                        item_name: nextItemName,
                        item_name_vi: nextItemNameVi,
                        category: nextCategory,
                        category_vi: nextCategoryVi,
                        unit: nextUnit,
                        supplier: nextSupplier,
                        purchase_price: nextPurchasePrice,
                        new_purchase_price: nextPurchasePrice,
                        total_purchase_price: totalPurchasePrice,
                    };
                })
            );

            setLogModalItem((prev) => {
                if (!prev || !syncLogIdSet.has(Number(prev.id))) return prev;

                const syncedLog = syncedById.get(Number(prev.id)) ?? representativeLog;
                const nextPurchasePrice = syncedLog.new_purchase_price ?? null;
                const nextSupplier = syncedLog.new_supplier ?? null;
                const nextItemName = syncedLog.item_name ?? prev.item_name;
                const nextItemNameVi = syncedLog.item_name_vi ?? prev.item_name_vi;
                const nextCategory = syncedLog.category ?? prev.category;
                const nextCategoryVi = syncedLog.category_vi ?? prev.category_vi;
                const nextUnit = syncedLog.unit ?? prev.unit;
                const changeQuantity = Number(prev.change_quantity ?? 0);
                const totalPurchasePrice =
                    nextPurchasePrice === null
                        ? null
                        : changeQuantity * Number(nextPurchasePrice);

                return {
                    ...prev,
                    item_name: nextItemName,
                    item_name_vi: nextItemNameVi,
                    category: nextCategory,
                    category_vi: nextCategoryVi,
                    unit: nextUnit,
                    supplier: nextSupplier,
                    purchase_price: nextPurchasePrice,
                    new_purchase_price: nextPurchasePrice,
                    total_purchase_price: totalPurchasePrice,
                };
            });

            setItemLogs((prev) =>
                prev.map((log) =>
                    syncLogIdSet.has(Number(log.id))
                        ? {
                            ...log,
                            item_name:
                                syncedById.get(Number(log.id))?.item_name ?? log.item_name,
                            item_name_vi:
                                syncedById.get(Number(log.id))?.item_name_vi ??
                                log.item_name_vi,
                            category:
                                syncedById.get(Number(log.id))?.category ?? log.category,
                            category_vi:
                                syncedById.get(Number(log.id))?.category_vi ??
                                log.category_vi,
                            unit: syncedById.get(Number(log.id))?.unit ?? log.unit,
                            new_supplier:
                                syncedById.get(Number(log.id))?.new_supplier ??
                                log.new_supplier,
                            new_purchase_price:
                                syncedById.get(Number(log.id))?.new_purchase_price ??
                                log.new_purchase_price,
                        }
                        : log
                )
            );
        } catch (error) {
            console.error(error);
            alert(c.editFail);
        } finally {
            setSyncingPurchaseLogId(null);
        }
    };


    const moveCalendarMonth = (diff: number) => {
        if (!calendarMonth) return;

        const [year, month] = calendarMonth.split("-").map(Number);
        const nextDate = new Date(year, month - 1 + diff, 1);

        const nextYear = nextDate.getFullYear();
        const nextMonth = String(nextDate.getMonth() + 1).padStart(2, "0");

        setCalendarMonth(`${nextYear}-${nextMonth}`);
    };

    useEffect(() => {
        if (!calendarMonth) return;
        fetchBatches(calendarMonth);
    }, [calendarMonth, fetchBatches]);

    useEffect(() => {
        setCategoryFilter("all");
    }, [partFilter]);

    useEffect(() => {
        if (viewMode !== "snapshot") return;

        setSupplierTab("all");

        if (!selectedBatchId) return;

        fetchSnapshotItems(selectedBatchId);
    }, [selectedBatchId, viewMode]);

    const selectedSnapshotDate = useMemo(() => {
        if (viewMode !== "snapshot") return null;

        const batch = batchList.find((item) => Number(item.id) === Number(selectedBatchId));
        return batch?.snapshot_date ?? null;
    }, [viewMode, batchList, selectedBatchId]);

    useEffect(() => {
        if (viewMode !== "current") return;
        fetchMovementItems(activeBusinessDateKey);
    }, [viewMode, activeBusinessDateKey, fetchMovementItems]);

    useEffect(() => {
        if (viewMode !== "snapshot" || !selectedSnapshotDate) return;
        fetchMovementItems(selectedSnapshotDate);
    }, [viewMode, selectedSnapshotDate, fetchMovementItems]);

    useEffect(() => {
        if (calendarMonth) return;
        if (batchList.length === 0) return;

        const latest = [...batchList]
            .map((batch) => batch.snapshot_date)
            .sort((a, b) => a.localeCompare(b))
            .at(-1);

        if (latest) {
            setCalendarMonth(latest.slice(0, 7)); // YYYY-MM
        }
    }, [batchList, calendarMonth]);

    const allLabel = c.all;

    const categoryTabs = useMemo(() => {
        return [
            { key: "all", label: allLabel },
            ...Array.from(
                new Map(
                    snapshotItems
                        .filter((item) => partFilter === "all" || item.part === partFilter)
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
    }, [snapshotItems, partFilter, allLabel, getDisplayCategory]);

    const filteredItems = useMemo(() => {
        return snapshotItems
            .filter((item) => {
                const keyword = search.trim().toLowerCase();
                const displayItemName = getDisplayItemName(item).toLowerCase();
                const displayCategory = getDisplayCategory(item).toLowerCase();
                const displayCode = String(item.code || "").toLowerCase();

                const matchSearch =
                    !keyword ||
                    displayItemName.includes(keyword) ||
                    displayCategory.includes(keyword) ||
                    displayCode.includes(keyword);

                const matchPart =
                    partFilter === "all" || item.part === partFilter;

                const categoryKey = getCategoryKey(item);

                const matchCategory =
                    categoryFilter === "all" || categoryKey === categoryFilter;

                const diffQty = Number(item.change_quantity ?? 0);
                const matchChanged = !showChangedOnly || diffQty !== 0;

                return matchSearch && matchPart && matchCategory && matchChanged;
            })
            .sort((a, b) => {
                const codeA = (a.code || "").toLowerCase();
                const codeB = (b.code || "").toLowerCase();

                if (codeA && !codeB) return -1;
                if (!codeA && codeB) return 1;

                const codeCompare = codeA.localeCompare(codeB, undefined, {
                    numeric: true,
                    sensitivity: "base",
                });

                if (codeCompare !== 0) return codeCompare;

                const nameA = getDisplayItemName(a).toLowerCase();
                const nameB = getDisplayItemName(b).toLowerCase();

                return nameA.localeCompare(nameB, undefined, {
                    numeric: true,
                    sensitivity: "base",
                });
            });
    }, [snapshotItems, search, partFilter, categoryFilter, showChangedOnly, getDisplayCategory, getDisplayItemName]);

    const groupedItems: Record<string, SnapshotItem[]> = filteredItems.reduce(
        (acc: Record<string, SnapshotItem[]>, item) => {
            const categoryKey = getDisplayCategory(item) || "-";

            if (!acc[categoryKey]) {
                acc[categoryKey] = [];
            }

            acc[categoryKey].push(item);
            return acc;
        },
        {}
    );

    const selectedBatch =
        batchList.find((batch) => Number(batch.id) === Number(selectedBatchId)) || null;

    const purchasedItems = useMemo(() => {
        const baseItems = buildDailyNetPurchasedItems(movementItems);

        return baseItems.sort((a, b) => {
            const supplierA = (a.supplier || "").toLowerCase();
            const supplierB = (b.supplier || "").toLowerCase();

            if (supplierA !== supplierB) {
                return supplierA.localeCompare(supplierB);
            }

            return getDisplayItemName(a).localeCompare(getDisplayItemName(b), undefined, {
                numeric: true,
                sensitivity: "base",
            });
        });
    }, [movementItems, getDisplayItemName]);

    const snapshotItemPriceMap = useMemo(() => {
        const map = new Map<number, number | null>();
        for (const item of snapshotItems) {
            if (item.item_id !== null && item.item_id !== undefined) {
                map.set(Number(item.item_id), item.purchase_price);
            }
        }
        return map;
    }, [snapshotItems]);

    const movementReasonCounts = useMemo(() => {
        const counts: Record<MovementReasonTab, number> = {
            sale_deduction: 0,
            stock_check: 0,
            service: 0,
            other: 0,
        };

        movementItems.forEach((item) => {
            const reason = item.reason as MovementReasonTab;
            if (!(reason in counts)) return;
            if (Number(item.change_quantity ?? 0) === 0) return;

            counts[reason] += 1;
        });

        return counts;
    }, [movementItems]);

    const otherMovementGroups = useMemo(() => {
        const groups = new Map<string, MovementItemGroup>();

        movementItems
            .filter(
                (item) =>
                    item.reason === movementReasonTab &&
                    Number(item.change_quantity ?? 0) !== 0
            )
            .forEach((item) => {
                const itemId = Number(item.item_id);
                const unit = item.unit || "";
                const key = Number.isFinite(itemId) && itemId > 0
                    ? `item:${itemId}:${item.reason}:${unit}`
                    : [
                        "fallback",
                        item.reason || "",
                        item.code || "",
                        item.item_name || "",
                        item.item_name_vi || "",
                        unit,
                    ].join(":");
                const quantity = Number(item.change_quantity ?? 0);
                const latestTime = item.created_at ? new Date(item.created_at).getTime() : 0;
                const safeLatestTime = Number.isFinite(latestTime) ? latestTime : 0;
                const isSaleDeduction = item.reason === "sale_deduction";
                const noteText = item.reason === "other" ? getMovementNoteText(item) : "";
                let displayPrice = item.purchase_price;
                let isApproxPrice = false;

                if (displayPrice === null && isSaleDeduction && item.item_id !== null) {
                    const fallback = snapshotItemPriceMap.get(Number(item.item_id)) ?? null;
                    if (fallback !== null) {
                        displayPrice = fallback;
                        isApproxPrice = true;
                    }
                }

                const numericPrice = Number(displayPrice);
                const amount = displayPrice === null ||
                    displayPrice === undefined ||
                    !Number.isFinite(numericPrice)
                    ? null
                    : quantity * numericPrice;
                const current = groups.get(key);

                if (!current) {
                    groups.set(key, {
                        key,
                        representative: item,
                        count: 1,
                        totalQuantity: quantity,
                        totalAmount: amount,
                        latestTime: safeLatestTime,
                        isApproxPrice,
                        notes: noteText ? [noteText] : [],
                    });
                    return;
                }

                current.count += 1;
                current.totalQuantity += quantity;
                current.isApproxPrice = current.isApproxPrice || isApproxPrice;
                if (noteText && !current.notes.includes(noteText)) {
                    current.notes.push(noteText);
                }
                if (amount !== null) {
                    current.totalAmount = (current.totalAmount ?? 0) + amount;
                }
                if (safeLatestTime > current.latestTime) {
                    current.latestTime = safeLatestTime;
                    current.representative = item;
                }
            });

        return Array.from(groups.values()).sort((a, b) => {
            if (b.latestTime !== a.latestTime) return b.latestTime - a.latestTime;
            return Number(b.representative.id) - Number(a.representative.id);
        });
    }, [movementItems, movementReasonTab, snapshotItemPriceMap]);

    const supplierTabs = useMemo(() => {
        const supplierCounts = purchasedItems.reduce((counts, item) => {
            const supplier = item.supplier || "-";
            counts.set(supplier, (counts.get(supplier) ?? 0) + 1);
            return counts;
        }, new Map<string, number>());

        return [
            { key: "all", label: allLabel, count: purchasedItems.length },
            ...Array.from(supplierCounts.entries()).map(([supplier, count]) => ({
                key: supplier,
                label: supplier,
                count,
            })),
        ];
    }, [purchasedItems, allLabel]);

    const filteredPurchasedItems = useMemo(() => {
        return purchasedItems.filter((item) => {
            const supplier = item.supplier || "-";
            return supplierTab === "all" || supplier === supplierTab;
        });
    }, [purchasedItems, supplierTab]);

    const purchaseTotalAmount = useMemo(() => {
        return filteredPurchasedItems.reduce((sum, item) => {
            return sum + Number(item.total_purchase_price ?? 0);
        }, 0);
    }, [filteredPurchasedItems]);

    const selectedLog = useMemo(() => {
        if (!logModalItem) return null;
        return itemLogs.find((log) => Number(log.id) === Number(logModalItem.id)) ?? null;
    }, [itemLogs, logModalItem]);
    const selectedTimelineReason = selectedLog?.reason ?? logModalItem?.reason ?? null;

    const noSupplierLabel = lang === "vi" ? "Không có nơi mua" : "거래처 없음";
    const allLogsLabel = lang === "vi" ? "Tất cả" : c.all;
    const priceChangeLabel = lang === "vi" ? "Đổi giá" : "가격변동";

    const getPurchaseLogSupplierKey = (log: InventoryLog) =>
        getPurchaseSupplierGroupKey(log.new_supplier ?? log.supplier ?? null);

    const getPurchaseLogSupplierLabel = useCallback(
        (log: InventoryLog) =>
            (log.new_supplier ?? log.supplier ?? "").trim() || noSupplierLabel,
        [noSupplierLabel]
    );

    const purchaseLogSupplierTabs = useMemo(() => {
        const map = new Map<
            string,
            {
                key: string;
                supplierLabel: string;
                count: number;
            }
        >();

        itemLogs.forEach((log) => {
            if (log.reason !== "purchase") return;

            const key = getPurchaseLogSupplierKey(log);
            const current = map.get(key);

            if (current) {
                current.count += 1;
                return;
            }

            map.set(key, {
                key,
                supplierLabel: getPurchaseLogSupplierLabel(log),
                count: 1,
            });
        });

        return Array.from(map.values());
    }, [itemLogs, getPurchaseLogSupplierLabel]);

    const purchasePriceChangeLogIds = useMemo(() => {
        const sortedPurchaseLogs = itemLogs
            .filter((log) => log.reason === "purchase")
            .sort((a, b) => {
                const createdCompare = String(a.created_at || "").localeCompare(
                    String(b.created_at || "")
                );
                if (createdCompare !== 0) return createdCompare;

                return Number(a.id) - Number(b.id);
            });
        const changedLogIds = new Set<number>();
        let previousPriceKey: string | null = null;

        sortedPurchaseLogs.forEach((log) => {
            const priceKey = getPurchasePriceGroupKey(log.new_purchase_price);
            if (priceKey === PURCHASE_GROUP_NO_PRICE) return;

            if (previousPriceKey !== null && priceKey !== previousPriceKey) {
                changedLogIds.add(Number(log.id));
            }

            previousPriceKey = priceKey;
        });

        return changedLogIds;
    }, [itemLogs]);

    const visibleTimelineLogs = useMemo(() => {
        let logs = selectedTimelineReason
            ? itemLogs.filter((log) => log.reason === selectedTimelineReason)
            : itemLogs;

        if (selectedTimelineReason === "purchase" && purchaseLogGroupFilter !== "all") {
            if (purchaseLogGroupFilter === "price_change") {
                logs = logs.filter(
                    (log) =>
                        log.reason === "purchase" &&
                        purchasePriceChangeLogIds.has(Number(log.id))
                );
            } else {
                logs = logs.filter(
                    (log) =>
                        log.reason === "purchase" &&
                        getPurchaseLogSupplierKey(log) === purchaseLogGroupFilter
                );
            }
        }

        return [...logs]
            .sort((a, b) => {
                const createdCompare = String(b.created_at || "").localeCompare(
                    String(a.created_at || "")
                );
                if (createdCompare !== 0) return createdCompare;

                return Number(b.id) - Number(a.id);
            });
    }, [itemLogs, selectedTimelineReason, purchaseLogGroupFilter, purchasePriceChangeLogIds]);

    const selectedPurchaseAggregate =
        logModalItem?.reason === "purchase" && (logModalItem.syncLogIds?.length ?? 0) > 1
            ? logModalItem
            : null;

    const renderLogCard = (log: InventoryLog) => {
        const changeQuantity = Number(log.change_quantity ?? 0);
        const changeText =
            changeQuantity === 0
                ? ""
                : `${changeQuantity > 0 ? "+" : ""}${formatDecimalDisplay(changeQuantity)}`;
        const quantityText = `${changeText || "0"} ${log.unit || ""}`.trim();
        const noteText = log.new_note || log.prev_note || "";
        const compactDate = formatCompactLogDateTime(log.created_at);
        const metaLead = noteText || changeText;
        const metaLine = [
            metaLead,
            compactDate,
            log.actor_name || "-",
        ].filter(Boolean).join(" · ");
        const unitPrice = Number(log.new_purchase_price ?? 0);
        const showPriceLine =
            log.reason === "purchase" &&
            Number.isFinite(unitPrice) &&
            unitPrice > 0 &&
            Math.abs(changeQuantity) > 0;
        const logPriceTrend = getPriceTrend(
            log.prev_purchase_price,
            log.new_purchase_price
        );
        const logPriceTrendStyle = getPurchasePriceTrendStyle(logPriceTrend);
        const priceLabel = lang === "vi" ? "Đơn giá" : "단가";
        const totalLabel = lang === "vi" ? "Tổng" : "합계";
        const totalPrice = Math.abs(changeQuantity) * unitPrice;
        return (
            <div
                key={`timeline-${log.id}`}
                style={{
                    ...ui.card,
                    padding: "7px 9px",
                    borderLeft: `4px solid ${getActionColor(log.action)}`,
                    background: "#fff",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 8,
                    }}
                >
                    <div
                        style={{
                            minWidth: 0,
                            flex: 1,
                            display: "flex",
                            alignItems: "center",
                            gap: 5,
                        }}
                    >
                        <span
                            style={{
                                ...ui.badgeMini,
                                flexShrink: 0,
                                background: getActionColor(log.action),
                            }}
                        >
                            {getActionBadge(log.action)}
                        </span>
                        <span
                            style={{
                                ...ui.badgeMini,
                                flexShrink: 0,
                                minWidth: "auto",
                                background: "#f3f4f6",
                                color: "#374151",
                                border: "1px solid #e5e7eb",
                            }}
                        >
                            {getReasonEmoji(log.reason)} {getCompactReasonLabel(log.reason)}
                        </span>
                        {isKegReplaceInventoryLog(log) && (
                            <span
                                style={{
                                    ...ui.badgeMini,
                                    flexShrink: 0,
                                    minWidth: "auto",
                                    background: "#fff7ed",
                                    color: "#9a3412",
                                    border: "1px solid #fed7aa",
                                }}
                            >
                                {kegReplaceBadgeLabel}
                            </span>
                        )}
                        <span
                            style={{
                                minWidth: 0,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                fontSize: 14,
                                fontWeight: 800,
                                color: "#111827",
                            }}
                        >
                            {getDisplayLogItemName(log)}
                        </span>
                    </div>

                    <div
                        style={{
                            flexShrink: 0,
                            textAlign: "right",
                            fontSize: 14,
                            fontWeight: 900,
                            color:
                                changeQuantity > 0
                                    ? "seagreen"
                                    : changeQuantity < 0
                                        ? "crimson"
                                        : "#111827",
                            whiteSpace: "nowrap",
                        }}
                    >
                        {quantityText}
                    </div>
                </div>

                {showPriceLine && (
                    <div
                        style={{
                            marginTop: 5,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            color: "#111827",
                            fontSize: 12,
                            fontWeight: 500,
                            lineHeight: 1.25,
                    }}
                >
                        {getPurchaseLogSupplierLabel(log)} ·{" "}
                        {priceLabel}{" "}
                        <span style={logPriceTrendStyle}>
                            {logPriceTrend === "up"
                                ? "▲"
                                : logPriceTrend === "down"
                                    ? "▼"
                                    : ""}
                            {unitPrice.toLocaleString()} ₫
                        </span>
                        {" / "}
                        {log.unit || "-"} · {totalLabel}{" "}
                        {totalPrice.toLocaleString()} ₫
                    </div>
                )}

                {metaLine && (
                    <div
                        style={{
                            ...ui.metaText,
                            marginTop: 3,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        }}
                    >
                        {metaLine}
                    </div>
                )}

            </div>
        );
    };

    const batchCalendar = useMemo(() => {
        const map = new Map<string, SnapshotBatch>();

        batchList.forEach((batch) => {
            map.set(batch.snapshot_date, batch);
        });

        const sortedDates = [...map.keys()].sort((a, b) => a.localeCompare(b));

        if (sortedDates.length === 0) {
            return {
                year: "",
                monthLabel: "",
                cells: [] as {
                    key: string;
                    day: number | null;
                    date: string | null;
                    batch: SnapshotBatch | null;
                }[],
            };
        }

        const baseMonth = calendarMonth || sortedDates[sortedDates.length - 1].slice(0, 7);
        const [year, month] = baseMonth.split("-");
        const firstDay = new Date(Number(year), Number(month) - 1, 1);
        const lastDate = new Date(Number(year), Number(month), 0).getDate();

        const startWeekday = firstDay.getDay(); // 0=Sun
        const cells: {
            key: string;
            day: number | null;
            date: string | null;
            batch: SnapshotBatch | null;
        }[] = [];

        for (let i = 0; i < startWeekday; i++) {
            cells.push({
                key: `empty-start-${i}`,
                day: null,
                date: null,
                batch: null,
            });
        }

        for (let day = 1; day <= lastDate; day++) {
            const date = `${year}-${month}-${String(day).padStart(2, "0")}`;
            cells.push({
                key: date,
                day,
                date,
                batch: map.get(date) || null,
            });
        }

        while (cells.length % 7 !== 0) {
            cells.push({
                key: `empty-end-${cells.length}`,
                day: null,
                date: null,
                batch: null,
            });
        }

        return {
            year,
            monthLabel: `${year}.${month}`,
            cells,
        };
    }, [batchList, calendarMonth]);

    const getPartMeta = (value?: string | null) => {
        const safePart: PartValue =
            value && PART_VALUES.includes(value as PartValue)
                ? (value as PartValue)
                : "etc";

        return PART_META[safePart];
    };

    const getPartButtonStyle = (
        value: PartValue,
        active: boolean
    ) => {
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
            fontSize: 13,
        };
    };

    const getCalendarCellStyle = (
        active: boolean,
        hasBatch: boolean,
        dayOfWeek: number
    ) => {
        const isSunday = dayOfWeek === 0;
        const isSaturday = dayOfWeek === 6;

        return {
            height: 44,
            borderRadius: 10,
            border: active
                ? "1px solid #111827"
                : "1px solid #e5e7eb",
            background: active ? "#111827" : "#ffffff",
            color: active
                ? "#fff"
                : isSunday
                    ? "crimson"
                    : isSaturday
                        ? "royalblue"
                        : "#111827",
            fontWeight: 800,
            fontSize: 13,
            cursor: hasBatch ? "pointer" : "default",
            display: "flex",
            flexDirection: "column" as const,
            alignItems: "center",
            justifyContent: "center",
            boxSizing: "border-box" as const,
            padding: 0,
            gap: 2,
            opacity: hasBatch || active ? 1 : 0.45,
        };
    };

    const pathname = usePathname();
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
                        paddingLeft: 40,
                        marginBottom: 0,
                    }}
                />
            </div>

            <div
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
                        gap: 8,
                    }}
                >
                    <span
                        style={{
                            fontSize: 15,
                            fontWeight: 700,
                            color: "#111827",
                        }}
                    >
                        {t.snapshotCalendar}
                    </span>

                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                        }}
                    >
                        <button
                            type="button"
                            onClick={() => moveCalendarMonth(-1)}
                            style={{
                                ...ui.subButton,
                                width: "auto",
                                minWidth: 32,
                                height: 32,
                                padding: "0 10px",
                                fontSize: 13,
                            }}
                        >
                            ◀
                        </button>

                        <span
                            style={{
                                minWidth: 64,
                                textAlign: "center",
                                fontSize: 13,
                                fontWeight: 700,
                                color: "#374151",
                            }}
                        >
                            {batchCalendar.monthLabel || "-"}
                        </span>

                        <button
                            type="button"
                            onClick={() => moveCalendarMonth(1)}
                            style={{
                                ...ui.subButton,
                                width: "auto",
                                minWidth: 32,
                                height: 32,
                                padding: "0 10px",
                                fontSize: 13,
                            }}
                        >
                            ▶
                        </button>
                    </div>
                </div>

                {loadingBatches ? (
                    <div
                        style={{
                            height: 120,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#9ca3af",
                            fontSize: 13,
                        }}
                    >
                        {c.loading}
                    </div>
                ) : batchList.length === 0 ? (
                    <div
                        style={{
                            height: 120,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#9ca3af",
                            fontSize: 13,
                        }}
                    >
                        {c.noData}
                    </div>
                ) : (
                    <>
                        <div
                            style={{
                                display: "grid",
                                gridTemplateColumns: "repeat(7, 1fr)",
                                gap: 6,
                                marginBottom: 6,
                            }}
                        >
                            {c.calendarWeekdays.map((label, index) => (
                                <div
                                    key={label}
                                    style={{
                                        textAlign: "center",
                                        fontSize: 11,
                                        fontWeight: 700,
                                        color:
                                            index === 0
                                                ? "crimson"
                                                : index === 6
                                                    ? "royalblue"
                                                    : "#6b7280",
                                        padding: "2px 0",
                                    }}
                                >
                                    {label}
                                </div>
                            ))}
                        </div>

                        <div
                            style={{
                                display: "grid",
                                gridTemplateColumns: "repeat(7, 1fr)",
                                gap: 6,
                            }}
                        >
                            {batchCalendar.cells.map((cell, index) => {
                                const isCurrentBusinessDate = cell.date === activeBusinessDateKey;
                                const active =
                                    viewMode === "snapshot"
                                        ? cell.batch?.id === selectedBatchId
                                        : isCurrentBusinessDate;
                                const hasBatch = !!cell.batch;
                                const hasPurchase = Boolean(
                                    cell.date && purchaseDateMap[cell.date]
                                );
                                const dayOfWeek = index % 7;

                                return (
                                    <button
                                        key={cell.key}
                                        type="button"
                                        disabled={!hasBatch && !isCurrentBusinessDate}
                                        onClick={() => {
                                            if (cell.batch?.id) {
                                                setViewMode("snapshot");
                                                setSelectedBatchId(Number(cell.batch.id));
                                                return;
                                            }

                                            if (isCurrentBusinessDate) {
                                                setViewMode("current");
                                                setSelectedBatchId(null);
                                            }
                                        }}
                                        style={getCalendarCellStyle(active, hasBatch || isCurrentBusinessDate, dayOfWeek)}
                                    >
                                        <>
                                            <span>{cell.day ?? ""}</span>

                                            <div
                                                style={{
                                                    display: "flex",
                                                    gap: 3,
                                                    marginTop: 3,
                                                    justifyContent: "center",
                                                    minHeight: 5,
                                                }}
                                            >
                                                {hasPurchase && (
                                                    <span
                                                        style={{
                                                            width: 5,
                                                            height: 5,
                                                            borderRadius: 999,
                                                            background: active ? "#fff" : "#2563eb",
                                                            display: "block",
                                                        }}
                                                    />
                                                )}

                                                {isCurrentBusinessDate && (
                                                    <span
                                                        style={{
                                                            width: 5,
                                                            height: 5,
                                                            borderRadius: 999,
                                                            background: active ? "#fff" : "#16a34a",
                                                            display: "block",
                                                        }}
                                                    />
                                                )}
                                            </div>
                                        </>
                                    </button>
                                );
                            })}
                        </div>
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 12,
                                marginTop: 10,
                                fontSize: 12,
                                fontWeight: 700,
                                color: "#6b7280",
                            }}
                        >
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                                <span
                                    style={{
                                        width: 6,
                                        height: 6,
                                        borderRadius: 999,
                                        background: "#2563eb",
                                        display: "inline-block",
                                    }}
                                />
                                {t.legendPurchase}
                            </span>

                            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                                <span
                                    style={{
                                        width: 6,
                                        height: 6,
                                        borderRadius: 999,
                                        background: "#16a34a",
                                        display: "inline-block",
                                    }}
                                />
                                {currentBusinessDateLabel}
                            </span>
                        </div>
                    </>
                )}
            </div>

            {purchasedItems.length > 0 && (
                <div
                    style={{
                        ...ui.card,
                        padding: 12,
                        marginBottom: 16,
                    }}
                >
                    <div
                        style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: 10,
                            gap: 8,
                        }}
                    >
                        <span
                            style={{
                                fontSize: 15,
                                fontWeight: 800,
                                color: "#111827",
                            }}
                        >
                            {t.snapshotTitle}
                        </span>

                        <span
                            style={{
                                fontSize: 12,
                                fontWeight: 700,
                                color: "#6b7280",
                            }}
                        >
                            {viewMode === "snapshot" && selectedBatch
                                ? selectedBatch.snapshot_date
                                : activeBusinessDateKey}
                        </span>
                    </div>

                    <div
                        style={{
                            display: "flex",
                            gap: 6,
                            overflowX: "auto",
                            paddingBottom: 6,
                            marginBottom: 10,
                        }}
                    >
                        {supplierTabs.map((tab) => {
                            const active = supplierTab === tab.key;

                            return (
                                <button
                                    key={tab.key}
                                    type="button"
                                    onClick={() => setSupplierTab(tab.key)}
                                    style={{
                                        padding: "7px 10px",
                                        borderRadius: 999,
                                        border: active ? "1px solid #111827" : "1px solid #d1d5db",
                                        background: active ? "#111827" : "#f9fafb",
                                        color: active ? "#fff" : "#111827",
                                        fontWeight: 700,
                                        fontSize: 12,
                                        whiteSpace: "nowrap",
                                        cursor: "pointer",
                                        flexShrink: 0,
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: 5,
                                    }}
                                >
                                    {tab.label}
                                    <span
                                        style={{
                                            minWidth: 18,
                                            height: 18,
                                            padding: "0 5px",
                                            borderRadius: 999,
                                            display: "inline-flex",
                                            alignItems: "center",
                                            justifyContent: "center",
                                            background: active
                                                ? "rgba(255,255,255,0.18)"
                                                : "#e5e7eb",
                                            color: active ? "#fff" : "#4b5563",
                                            fontSize: 10,
                                            lineHeight: 1,
                                        }}
                                    >
                                        {tab.count}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 8,
                            maxHeight: 320,
                            overflowY: "auto",
                            paddingRight: 4,
                            WebkitOverflowScrolling: "touch",
                        }}
                    >
                        {filteredPurchasedItems.map((item) => {
                            const qty = Number(item.change_quantity ?? 0);
                            const price = item.purchase_price;
                            const total = item.total_purchase_price;
                            const priceTrend = getPurchasePriceTrend(item);
                            const priceTrendStyle = getPurchasePriceTrendStyle(priceTrend);

                            return (
                                <div
                                    key={item.id}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => openPurchaseLogModal(item)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            openPurchaseLogModal(item);
                                        }
                                    }}
                                    style={{
                                        border: "1px solid #e5e7eb",
                                        borderLeft: `4px solid ${PART_META[(item.part || "etc") as keyof typeof PART_META]?.color || "#9ca3af"}`,
                                        borderRadius: 8,
                                        padding: "7px 9px",
                                        background: "#ffffff",
                                        cursor: "pointer",
                                    }}
                                >
                                    <div
                                        style={{
                                            display: "flex",
                                            justifyContent: "space-between",
                                            alignItems: "flex-start",
                                            gap: 8,
                                            marginBottom: 5,
                                        }}
                                    >
                                        <div
                                            style={{
                                                minWidth: 0,
                                                fontSize: 14,
                                                fontWeight: 700,
                                                color: "#111827",
                                                lineHeight: 1.2,
                                                wordBreak: "break-word",
                                            }}
                                        >
                                            {formatReasonItemName(item)}
                                            <span
                                                style={{
                                                    marginLeft: 4,
                                                    fontSize: 12,
                                                    fontWeight: 600,
                                                    color: "#6b7280",
                                                }}
                                            >
                                                / {getDisplayCategory(item)}
                                            </span>
                                        </div>

                                        <div
                                            style={{
                                                flexShrink: 0,
                                                textAlign: "right",
                                                fontSize: 12,
                                                fontWeight: 600,
                                                color: "#6b7280",
                                                lineHeight: 1.2,
                                                whiteSpace: "nowrap",
                                            }}
                                        >
                                            {price === null || price === undefined ? (
                                                "-"
                                            ) : (
                                                <span style={priceTrendStyle}>
                                                    {priceTrend === "up"
                                                        ? "▲ "
                                                        : priceTrend === "down"
                                                            ? "▼ "
                                                            : ""}
                                                    {Number(price).toLocaleString()} ₫
                                                </span>
                                            )}
                                            <span
                                                style={{
                                                    marginLeft: 3,
                                                    fontSize: 12,
                                                    fontWeight: 600,
                                                    color: "#6b7280",
                                                }}
                                            >
                                                / {item.unit || "-"}
                                            </span>
                                        </div>
                                    </div>

                                    <div
                                        style={{
                                            display: "flex",
                                            justifyContent: "space-between",
                                            alignItems: "center",
                                            paddingTop: 5,
                                            borderTop: "1px solid #f1f5f9",
                                            fontSize: 14,
                                            fontWeight: 700,
                                            lineHeight: 1.2,
                                        }}
                                    >
                                        <div style={{ color: "seagreen" }}>
                                            +{formatDecimalDisplay(qty)} {item.unit || ""}
                                        </div>

                                        <div
                                            style={{
                                                color: "#111827",
                                                textAlign: "right",
                                                fontSize: 12,
                                                fontWeight: 700,
                                                whiteSpace: "nowrap",
                                            }}
                                        >
                                            {total === null || total === undefined
                                                ? "-"
                                                : `${Number(total).toLocaleString()} ₫`}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    <div
                        style={{
                            marginTop: 10,
                            paddingTop: 10,
                            borderTop: "1px solid #e5e7eb",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            fontSize: 14,
                            fontWeight: 900,
                            color: "#111827",
                        }}
                    >
                        <span>{c.total}</span>
                        <span>{purchaseTotalAmount.toLocaleString()} ₫</span>
                    </div>
                </div>
            )}

            {(movementItems.length > 0 || loadingMovements) && (
                <div
                    style={{
                        ...ui.card,
                        padding: 12,
                        marginBottom: 16,
                    }}
                >
                    <div
                        style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: 10,
                            gap: 8,
                        }}
                    >
                        <span
                            style={{
                                fontSize: 15,
                                fontWeight: 800,
                                color: "#111827",
                            }}
                        >
                            {t.otherMovements}
                        </span>

                        <span style={{ ...ui.metaText, fontWeight: 700 }}>
                            {viewMode === "snapshot" && selectedBatch
                                ? selectedBatch.snapshot_date
                                : activeBusinessDateKey}
                        </span>
                    </div>

                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(2, 1fr)",
                            gap: 6,
                            marginBottom: 10,
                        }}
                    >
                        {[
                            { value: "sale_deduction" as const, label: INVENTORY_REASON_LABELS[lang].sale_deduction },
                            { value: "stock_check" as const, label: INVENTORY_REASON_LABELS[lang].stock_check },
                            { value: "service" as const, label: INVENTORY_REASON_LABELS[lang].service },
                            { value: "other" as const, label: INVENTORY_REASON_LABELS[lang].other },
                        ].map((option) => {
                            const active = movementReasonTab === option.value;
                            const count = movementReasonCounts[option.value];

                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => setMovementReasonTab(option.value)}
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: 6,
                                        padding: "7px 10px",
                                        borderRadius: 8,
                                        border: active ? "1px solid #111827" : "1px solid #d1d5db",
                                        background: active ? "#111827" : "#f9fafb",
                                        color: active ? "#fff" : "#111827",
                                        fontWeight: 700,
                                        fontSize: 12,
                                        cursor: "pointer",
                                    }}
                                >
                                    <span
                                        style={{
                                            minWidth: 0,
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                        }}
                                    >
                                        {option.label}
                                    </span>
                                    <span
                                        style={{
                                            minWidth: 22,
                                            padding: "1px 6px",
                                            borderRadius: 999,
                                            background: active ? "rgba(255,255,255,0.18)" : "#eef2f7",
                                            color: active ? "#fff" : "#4b5563",
                                            fontSize: 11,
                                            fontWeight: 800,
                                            lineHeight: 1.4,
                                        }}
                                    >
                                        {count}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    {loadingMovements ? (
                        <div>{c.loading}</div>
                    ) : otherMovementGroups.length === 0 ? (
                        <div style={ui.metaText}>{c.noData}</div>
                    ) : (
                        <div
                            style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 8,
                                maxHeight: 320,
                                overflowY: "auto",
                                paddingRight: 4,
                                WebkitOverflowScrolling: "touch",
                            }}
                        >
                            {otherMovementGroups.map((group) => {
                                const item = group.representative;
                                const qty = group.totalQuantity;
                                const qtyColor = qty > 0 ? "seagreen" : "crimson";
                                const total = group.totalAmount;
                                const noteSummary = group.notes.length === 0
                                    ? ""
                                    : group.notes.length === 1
                                        ? group.notes[0]
                                        : `${group.notes[0]} 외 ${group.notes.length - 1}개`;
                                const countLabel = lang === "vi"
                                    ? `${group.count} lượt`
                                    : `${group.count}건`;

                                return (
                                    <div
                                        key={group.key}
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => fetchItemLogs(item)}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter" || event.key === " ") {
                                                event.preventDefault();
                                                fetchItemLogs(item);
                                            }
                                        }}
                                        style={{
                                            border: "1px solid #e5e7eb",
                                            borderLeft: `4px solid ${PART_META[(item.part || "etc") as keyof typeof PART_META]?.color || "#9ca3af"}`,
                                            borderRadius: 8,
                                            padding: "9px 10px",
                                            background: "#ffffff",
                                            cursor: "pointer",
                                            boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
                                        }}
                                    >
                                        <div
                                            style={{
                                                display: "flex",
                                                justifyContent: "space-between",
                                                alignItems: "flex-start",
                                                gap: 8,
                                                marginBottom: 5,
                                            }}
                                        >
                                            <div
                                                style={{
                                                    minWidth: 0,
                                                    fontSize: 14,
                                                    fontWeight: 700,
                                                    color: "#111827",
                                                    lineHeight: 1.2,
                                                    wordBreak: "break-word",
                                                }}
                                            >
                                                {formatReasonItemName(item)}
                                                <span
                                                    style={{
                                                        marginLeft: 4,
                                                        fontSize: 12,
                                                        fontWeight: 600,
                                                        color: "#6b7280",
                                                    }}
                                                >
                                                    / {getDisplayCategory(item)}
                                                </span>
                                                {isKegReplaceInventoryLog(item) && (
                                                    <span
                                                        style={{
                                                            marginLeft: 4,
                                                            padding: "2px 6px",
                                                            borderRadius: 999,
                                                            background: "#fff7ed",
                                                            border: "1px solid #fed7aa",
                                                            color: "#9a3412",
                                                            fontSize: 11,
                                                            fontWeight: 800,
                                                            whiteSpace: "nowrap",
                                                        }}
                                                    >
                                                        {kegReplaceBadgeLabel}
                                                    </span>
                                                )}
                                            </div>

                                            <span
                                                style={{
                                                    flexShrink: 0,
                                                    padding: "2px 7px",
                                                    borderRadius: 999,
                                                    background: "#f3f4f6",
                                                    border: "1px solid #e5e7eb",
                                                    color: "#374151",
                                                    fontSize: 11,
                                                    fontWeight: 800,
                                                    whiteSpace: "nowrap",
                                                }}
                                            >
                                                {countLabel}
                                            </span>
                                        </div>

                                        <div
                                            style={{
                                                display: "flex",
                                                justifyContent: "space-between",
                                                alignItems: "center",
                                                paddingTop: 5,
                                                borderTop: "1px solid #f1f5f9",
                                                fontSize: 14,
                                                fontWeight: 700,
                                                lineHeight: 1.2,
                                            }}
                                        >
                                            <div
                                                style={{
                                                    display: "flex",
                                                    alignItems: "center",
                                                    gap: 4,
                                                    minWidth: 0,
                                                    color: qtyColor,
                                                }}
                                            >
                                                <span style={{ flexShrink: 0 }}>
                                                    {qty > 0 ? "+" : ""}
                                                    {formatDecimalDisplay(qty)} {item.unit || ""}
                                                </span>
                                                {noteSummary ? (
                                                    <span
                                                        title={noteSummary}
                                                        style={{
                                                            minWidth: 0,
                                                            maxWidth: 180,
                                                            overflow: "hidden",
                                                            textOverflow: "ellipsis",
                                                            whiteSpace: "nowrap",
                                                            color: "#6b7280",
                                                            fontSize: 12,
                                                            fontWeight: 600,
                                                        }}
                                                    >
                                                        ({noteSummary})
                                                    </span>
                                                ) : null}
                                            </div>

                                            <div
                                                style={{
                                                    color: "#111827",
                                                    textAlign: "right",
                                                    fontSize: 12,
                                                    fontWeight: 700,
                                                    whiteSpace: "nowrap",
                                                }}
                                            >
                                                {total === null || total === undefined
                                                    ? "-"
                                                    : `${group.isApproxPrice ? "≈ " : ""}${Number(total).toLocaleString()} ₫`}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}


            <div
                style={{
                    ...ui.card,
                    padding: 12,
                    marginBottom: 16,
                }}
            >
                <div style={ui.filterBox}>
                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(5, 1fr)",
                            gap: 6,
                            marginBottom: 10,
                        }}
                    >
                        <button
                            type="button"
                            onClick={() => setPartFilter("all")}
                            style={{
                                padding: "8px 10px",
                                borderRadius: 8,
                                border:
                                    partFilter === "all"
                                        ? "1px solid #111827"
                                        : "1px solid #d1d5db",
                                background:
                                    partFilter === "all" ? "#111827" : "#f9fafb",
                                color: partFilter === "all" ? "#fff" : "#111827",
                                fontWeight: 700,
                                fontSize: 13,
                                cursor: "pointer",
                                whiteSpace: "nowrap",
                            }}
                        >
                            {c.all}
                        </button>

                        {[
                            { value: "kitchen", label: c.kitchen },
                            { value: "hall", label: c.hall },
                            { value: "bar", label: c.bar },
                            { value: "etc", label: c.etc },
                        ].map((option) => {
                            const partValue = option.value as PartValue;
                            const active = partFilter === partValue;
                            const meta = PART_META[partValue];

                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => setPartFilter(partValue)}
                                    style={getPartButtonStyle(partValue, active)}
                                >
                                    {meta.emoji} {option.label}
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
                        }}
                    >
                        <button
                            type="button"
                            onClick={() => setShowChangedOnly(!showChangedOnly)}
                            style={getFilterToggleButtonStyle(showChangedOnly, "royalblue")}
                        >
                            {showChangedOnly ? c.all : t.filterChange}
                        </button>

                        <button
                            type="button"
                            onClick={() => {
                                setSearch("");
                                setPartFilter("all");
                                setCategoryFilter("all");
                                setShowChangedOnly(false);
                            }}
                            style={getFilterToggleButtonStyle(false, "#111827")}
                        >
                            {c.resetFilter}
                        </button>
                    </div>
                </div>

                <div
                    style={{
                        ...ui.metaText,
                        fontWeight: 700,
                    }}
                >
                    {t.resultCount}: {filteredItems.length}
                </div>
            </div>

            <div
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
                        {t.title}
                    </span>

                    {selectedBatch && (
                        <span
                            style={{
                                fontSize: 12,
                                fontWeight: 600,
                                color: "#6b7280",
                            }}
                        >
                            {selectedBatch.snapshot_date}
                        </span>
                    )}
                </div>

                {loadingItems ? (
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
                        <div style={{ fontSize: 22 }}>⏳</div>
                        <div>{c.loading}</div>
                    </div>
                ) : viewMode === "snapshot" && !selectedBatchId ? (
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
                ) : filteredItems.length === 0 ? (
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
                            maxHeight: 420,
                            overflowY: "auto",
                            paddingRight: 4,
                        }}
                    >
                        {Object.entries(groupedItems).map(([categoryName, items]) => (
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
                                    const snapshotQty = Number(item.quantity ?? 0);
                                    const diffQty = Number(item.change_quantity ?? 0);

                                    return (
                                        <div
                                            key={item.id}
                                            style={{
                                                ...ui.card,
                                                padding: "5px 8px",
                                                borderLeft: `4px solid ${getPartMeta(item.part).color}`,
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
                                                    </div>

                                                    <div style={ui.metaText}>
                                                        {[
                                                            item.part ? c[item.part as keyof typeof c] || item.part : "",
                                                            getDisplayCategory(item)
                                                        ].filter(Boolean).join(" · ")}
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
                                                            minWidth: 72,
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
                                                                    color: "#111827",
                                                                }}
                                                            >
                                                                {formatDecimalDisplay(snapshotQty)}
                                                            </span>{" "}
                                                            <span
                                                                style={{
                                                                    fontSize: 14,
                                                                    fontWeight: 700,
                                                                    color: "#111827",
                                                                }}
                                                            >
                                                                {item.unit || ""}
                                                            </span>
                                                        </div>

                                                        <div
                                                            style={{
                                                                marginTop: 2,
                                                                fontSize: 12,
                                                                fontWeight: 700,
                                                                color:
                                                                    diffQty > 0
                                                                        ? "seagreen"
                                                                        : diffQty < 0
                                                                            ? "crimson"
                                                                            : "#6b7280",
                                                            }}
                                                        >
                                                            {t.previousDay}{" "}
                                                            {diffQty > 0 ? "+" : ""}
                                                            {formatDecimalDisplay(diffQty)}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                )}
            </div>

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
                        setItemLogsError("");
                    }}
                >
                    <div
                        onClick={(event) => event.stopPropagation()}
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
                        <div
                            style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                gap: 10,
                            }}
                        >
                            <div style={{ fontSize: 17, fontWeight: 800, color: "#111827" }}>
                                {t.logItemTitle}
                            </div>
                            <div
                                style={{
                                    display: "flex",
                                    gap: 6,
                                    flexShrink: 0,
                                    flexWrap: "wrap",
                                    justifyContent: "flex-end",
                                }}
                            >
                                {selectedLog && !isSalesInventoryLog(selectedLog) && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            syncPurchaseInfoFromCurrentItem({
                                                ...logModalItem,
                                                id: selectedLog.id,
                                                business_date:
                                                    selectedLog.business_date ??
                                                    logModalItem.business_date,
                                                syncLogIds: [selectedLog.id],
                                            })
                                        }
                                        disabled={syncingPurchaseLogId === selectedLog.id}
                                        style={{
                                            width: "auto",
                                            minHeight: 30,
                                            padding: "6px 10px",
                                            borderRadius: 999,
                                            border: "1px solid #d1d5db",
                                            background: "#f9fafb",
                                            color: "#111827",
                                            fontSize: 12,
                                            fontWeight: 800,
                                            lineHeight: 1.2,
                                            whiteSpace: "nowrap",
                                            cursor:
                                                syncingPurchaseLogId === selectedLog.id
                                                    ? "not-allowed"
                                                    : "pointer",
                                            opacity:
                                                syncingPurchaseLogId === selectedLog.id
                                                    ? 0.6
                                                    : 1,
                                        }}
                                    >
                                        {syncingPurchaseLogId === selectedLog.id
                                            ? c.saving
                                            : t.syncLog}
                                    </button>
                                )}

                                <button
                                    type="button"
                                    onClick={() => openInventoryEdit(logModalItem)}
                                    style={{
                                        width: "auto",
                                        minHeight: 30,
                                        padding: "6px 10px",
                                        borderRadius: 999,
                                        border: "1px solid royalblue",
                                        background: "royalblue",
                                        color: "#fff",
                                        fontSize: 12,
                                        fontWeight: 800,
                                        lineHeight: 1.2,
                                        whiteSpace: "nowrap",
                                        cursor: "pointer",
                                    }}
                                >
                                    {t.editItem}
                                </button>
                            </div>
                        </div>

                        <div
                            style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 8,
                                paddingRight: 4,
                            }}
                        >
                            <div
                                style={{
                                    fontSize: 13,
                                    fontWeight: 800,
                                    color: "#111827",
                                }}
                            >
                                {selectedPurchaseAggregate
                                    ? lang === "vi" ? "Tổng hợp nhập đã chọn" : "선택한 입고 집계"
                                    : lang === "vi" ? "Nhật ký đã chọn" : "선택한 로그"}
                            </div>
                            {isItemLogsLoading ? (
                                <div>{c.loading}</div>
                            ) : itemLogsError ? (
                                <div>{itemLogsError}</div>
                            ) : selectedPurchaseAggregate ? (
                                (() => {
                                    const changeQuantity = Number(selectedPurchaseAggregate.change_quantity ?? 0);
                                    const changeText =
                                        changeQuantity === 0
                                            ? "0"
                                            : `${changeQuantity > 0 ? "+" : ""}${formatDecimalDisplay(changeQuantity)}`;
                                    const quantityText = `${changeText} ${selectedPurchaseAggregate.unit || ""}`.trim();
                                    const total = selectedPurchaseAggregate.total_purchase_price;
                                    const unitPrice = selectedPurchaseAggregate.purchase_price;
                                    const priceTrend = getPurchasePriceTrend(selectedPurchaseAggregate);
                                    const priceTrendStyle = getPurchasePriceTrendStyle(priceTrend);

                                    return (
                                        <div
                                            style={{
                                                ...ui.card,
                                                padding: "7px 9px",
                                                borderLeft: `4px solid ${PART_META[(selectedPurchaseAggregate.part || "etc") as keyof typeof PART_META]?.color || "#9ca3af"}`,
                                                background: "#fff",
                                            }}
                                        >
                                            <div
                                                style={{
                                                    display: "flex",
                                                    justifyContent: "space-between",
                                                    alignItems: "center",
                                                    gap: 8,
                                                }}
                                            >
                                                <div
                                                    style={{
                                                        minWidth: 0,
                                                        flex: 1,
                                                        display: "flex",
                                                        alignItems: "center",
                                                        gap: 5,
                                                    }}
                                                >
                                                    <span
                                                        style={{
                                                            ...ui.badgeMini,
                                                            flexShrink: 0,
                                                            minWidth: "auto",
                                                            background: "#f3f4f6",
                                                            color: "#374151",
                                                            border: "1px solid #e5e7eb",
                                                        }}
                                                    >
                                                        {getReasonEmoji("purchase")} {getCompactReasonLabel("purchase")}
                                                    </span>
                                                    <span
                                                        style={{
                                                            minWidth: 0,
                                                            overflow: "hidden",
                                                            textOverflow: "ellipsis",
                                                            whiteSpace: "nowrap",
                                                            fontSize: 14,
                                                            fontWeight: 800,
                                                            color: "#111827",
                                                        }}
                                                    >
                                                        {getDisplayItemName(selectedPurchaseAggregate)}
                                                    </span>
                                                </div>

                                                <div
                                                    style={{
                                                        flexShrink: 0,
                                                        textAlign: "right",
                                                        fontSize: 14,
                                                        fontWeight: 900,
                                                        color: "seagreen",
                                                        whiteSpace: "nowrap",
                                                    }}
                                                >
                                                    {quantityText}
                                                </div>
                                            </div>
                                            <div
                                                style={{
                                                    ...ui.metaText,
                                                    marginTop: 5,
                                                    overflow: "hidden",
                                                    textOverflow: "ellipsis",
                                                    whiteSpace: "nowrap",
                                                }}
                                            >
                                                {lang === "vi" ? "Số nhật ký" : "포함 로그"}{" "}
                                                {selectedPurchaseAggregate.syncLogIds?.length ?? 0}
                                                {" / "}
                                                {(selectedPurchaseAggregate.supplier || "").trim() || noSupplierLabel}
                                                {" / "}
                                                {unitPrice === null || unitPrice === undefined ? "-" : (
                                                    <span style={priceTrendStyle}>
                                                        {priceTrend === "up"
                                                            ? "↑"
                                                            : priceTrend === "down"
                                                                ? "↓"
                                                                : ""}
                                                        {Number(unitPrice).toLocaleString()} ₫
                                                    </span>
                                                )}
                                                {" / "}
                                                {total === null || total === undefined
                                                    ? "-"
                                                    : `${Number(total).toLocaleString()} ₫`}
                                            </div>
                                        </div>
                                    );
                                })()
                            ) : !selectedLog ? (
                                <div style={ui.metaText}>
                                    {lang === "vi"
                                        ? "Không tìm thấy nhật ký đã chọn."
                                        : "선택한 로그를 찾을 수 없습니다."}
                                </div>
                            ) : (
                                [selectedLog].map((log) => {
                                    const changeQuantity = Number(log.change_quantity ?? 0);
                                    const changeText =
                                        changeQuantity === 0
                                            ? ""
                                            : `${changeQuantity > 0 ? "+" : ""}${formatDecimalDisplay(changeQuantity)}`;
                                    const quantityText = `${changeText || "0"} ${log.unit || ""}`.trim();
                                    const noteText = log.new_note || log.prev_note || "";
                                    const compactDate = formatCompactLogDateTime(log.created_at);
                                    const metaLead = noteText || changeText;
                                    const metaLine = [
                                        metaLead,
                                        compactDate,
                                        log.actor_name || "-",
                                    ].filter(Boolean).join(" · ");
                                    const unitPrice = Number(log.new_purchase_price ?? 0);
                                    const showPriceLine =
                                        log.reason === "purchase" &&
                                        Number.isFinite(unitPrice) &&
                                        unitPrice > 0 &&
                                        Math.abs(changeQuantity) > 0;
                                    const logPriceTrend = getPriceTrend(
                                        log.prev_purchase_price,
                                        log.new_purchase_price
                                    );
                                    const logPriceTrendStyle =
                                        getPurchasePriceTrendStyle(logPriceTrend);
                                    const priceLabel = lang === "vi" ? "Đơn giá" : "단가";
                                    const totalLabel = lang === "vi" ? "Tổng" : "합계";
                                    const totalPrice = Math.abs(changeQuantity) * unitPrice;

                                    return (
                                        <div
                                            key={log.id}
                                            style={{
                                                ...ui.card,
                                                padding: "7px 9px",
                                                borderLeft: `4px solid ${getActionColor(log.action)}`,
                                                background: "#fff",
                                            }}
                                        >
                                            <div
                                                style={{
                                                    display: "flex",
                                                    justifyContent: "space-between",
                                                    alignItems: "center",
                                                    gap: 8,
                                                }}
                                            >
                                                <div
                                                    style={{
                                                        minWidth: 0,
                                                        flex: 1,
                                                        display: "flex",
                                                        alignItems: "center",
                                                        gap: 5,
                                                    }}
                                                >
                                                    <span
                                                        style={{
                                                            ...ui.badgeMini,
                                                            flexShrink: 0,
                                                            background: getActionColor(log.action),
                                                        }}
                                                    >
                                                        {getActionBadge(log.action)}
                                                    </span>
                                                    <span
                                                        style={{
                                                            ...ui.badgeMini,
                                                            flexShrink: 0,
                                                            minWidth: "auto",
                                                            background: "#f3f4f6",
                                                            color: "#374151",
                                                            border: "1px solid #e5e7eb",
                                                        }}
                                                    >
                                                        {getReasonEmoji(log.reason)} {getCompactReasonLabel(log.reason)}
                                                    </span>
                                                    {isKegReplaceInventoryLog(log) && (
                                                        <span
                                                            style={{
                                                                ...ui.badgeMini,
                                                                flexShrink: 0,
                                                                minWidth: "auto",
                                                                background: "#fff7ed",
                                                                color: "#9a3412",
                                                                border: "1px solid #fed7aa",
                                                            }}
                                                        >
                                                            {kegReplaceBadgeLabel}
                                                        </span>
                                                    )}
                                                    <span
                                                        style={{
                                                            minWidth: 0,
                                                            overflow: "hidden",
                                                            textOverflow: "ellipsis",
                                                            whiteSpace: "nowrap",
                                                            fontSize: 14,
                                                            fontWeight: 800,
                                                            color: "#111827",
                                                        }}
                                                    >
                                                        {getDisplayLogItemName(log)}
                                                    </span>
                                                </div>

                                                <div
                                                    style={{
                                                        flexShrink: 0,
                                                        textAlign: "right",
                                                        fontSize: 14,
                                                        fontWeight: 900,
                                                        color:
                                                            changeQuantity > 0
                                                                ? "seagreen"
                                                                : changeQuantity < 0
                                                                    ? "crimson"
                                                                    : "#111827",
                                                        whiteSpace: "nowrap",
                                                    }}
                                                >
                                                    {quantityText}
                                                </div>
                                            </div>
                                            {showPriceLine && (
                                                <div
                                                    style={{
                                                        marginTop: 5,
                                                        overflow: "hidden",
                                                        textOverflow: "ellipsis",
                                                        whiteSpace: "nowrap",
                                                        color: "#111827",
                                                        fontSize: 12,
                                                        fontWeight: 500,
                                                        lineHeight: 1.25,
                                                    }}
                                                >
                                                    {getPurchaseLogSupplierLabel(log)} ·{" "}
                                                    {priceLabel}{" "}
                                                    <span style={logPriceTrendStyle}>
                                                        {logPriceTrend === "up"
                                                            ? "▲ "
                                                            : logPriceTrend === "down"
                                                                ? "▼ "
                                                                : ""}
                                                        {unitPrice.toLocaleString()} ₫
                                                    </span>
                                                    {" / "}
                                                    {log.unit || "-"} · {totalLabel}{" "}
                                                    {totalPrice.toLocaleString()} ₫
                                                </div>
                                            )}
                                            {metaLine && (
                                                <div
                                                    style={{
                                                        ...ui.metaText,
                                                        marginTop: 3,
                                                        overflow: "hidden",
                                                        textOverflow: "ellipsis",
                                                        whiteSpace: "nowrap",
                                                    }}
                                                >
                                                    {metaLine}
                                                </div>
                                            )}
                                            {isSalesInventoryLog(log) && (
                                                <div style={{ ...ui.metaText, marginTop: 3, fontWeight: 800 }}>
                                                    {lang === "vi"
                                                        ? "Nhật ký trừ kho bán hàng chỉ xem."
                                                        : "판매차감 로그는 읽기 전용입니다."}
                                                </div>
                                            )}
                                            {!isSalesInventoryLog(log) && (
                                            <div
                                                style={{
                                                    display: "flex",
                                                    flexWrap: "nowrap",
                                                    gap: 5,
                                                    marginTop: 6,
                                                    overflowX: "auto",
                                                    WebkitOverflowScrolling: "touch",
                                                }}
                                            >
                                                {QUICK_REASON_VALUES.map((reason) => {
                                                    const active = log.reason === reason;
                                                    const disabled = changingReasonLogId === log.id;

                                                    return (
                                                        <button
                                                            key={reason}
                                                            type="button"
                                                            disabled={disabled}
                                                            onClick={() => changeLogReason(log, reason)}
                                                            style={{
                                                                padding: "3px 7px",
                                                                borderRadius: 999,
                                                                border: active
                                                                    ? "1px solid #111827"
                                                                    : "1px solid #d1d5db",
                                                                background: active ? "#111827" : "#ffffff",
                                                                color: active ? "#ffffff" : "#374151",
                                                                fontSize: 11,
                                                                fontWeight: 700,
                                                                lineHeight: 1.2,
                                                                whiteSpace: "nowrap",
                                                                flexShrink: 0,
                                                                cursor: disabled ? "default" : "pointer",
                                                                opacity: disabled && !active ? 0.55 : 1,
                                                            }}
                                                        >
                                                            {getReasonEmoji(reason)} {getCompactReasonLabel(reason)}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                            )}
                                        </div>
                                    );
                                })
                            )}
                        </div>

                        {!isItemLogsLoading && !itemLogsError && visibleTimelineLogs.length > 0 && (
                            <div
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    flex: "1 1 auto",
                                    gap: 8,
                                    paddingTop: 10,
                                    borderTop: "1px solid #e5e7eb",
                                    minHeight: 0,
                                }}
                            >
                                <div
                                    style={{
                                        fontSize: 13,
                                        fontWeight: 800,
                                        color: "#111827",
                                    }}
                                >
                                    {lang === "vi" ? "Tất cả nhật ký" : "전체 로그"}
                                </div>

                                {selectedTimelineReason === "purchase" &&
                                    (purchaseLogSupplierTabs.length >= 2 ||
                                        purchasePriceChangeLogIds.size > 0) && (
                                        <div
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: 5,
                                                overflowX: "auto",
                                                paddingBottom: 2,
                                                WebkitOverflowScrolling: "touch",
                                            }}
                                        >
                                            {[
                                                {
                                                    key: "all",
                                                    label: `${allLogsLabel} ${purchaseLogSupplierTabs.reduce(
                                                        (sum, tab) => sum + tab.count,
                                                        0
                                                    )}`,
                                                },
                                                ...purchaseLogSupplierTabs.map((tab) => ({
                                                    key: tab.key,
                                                    label: `${tab.supplierLabel} ${tab.count}`,
                                                })),
                                                ...(purchasePriceChangeLogIds.size > 0
                                                    ? [
                                                        {
                                                            key: "price_change",
                                                            label: `${priceChangeLabel} ${purchasePriceChangeLogIds.size}`,
                                                        },
                                                    ]
                                                    : []),
                                            ].map((tab) => {
                                                const active = purchaseLogGroupFilter === tab.key;

                                                return (
                                                    <button
                                                        key={tab.key}
                                                        type="button"
                                                        onClick={() => setPurchaseLogGroupFilter(tab.key)}
                                                        style={{
                                                            flexShrink: 0,
                                                            maxWidth: 220,
                                                            overflow: "hidden",
                                                            textOverflow: "ellipsis",
                                                            whiteSpace: "nowrap",
                                                            padding: "4px 8px",
                                                            borderRadius: 999,
                                                            border: active
                                                                ? "1px solid #111827"
                                                                : "1px solid #d1d5db",
                                                            background: active ? "#111827" : "#ffffff",
                                                            color: active ? "#ffffff" : "#374151",
                                                            fontSize: 11,
                                                            fontWeight: 800,
                                                            cursor: "pointer",
                                                        }}
                                                        title={tab.label}
                                                    >
                                                        {tab.label}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}

                                <div
                                    style={{
                                        display: "flex",
                                        flex: "1 1 auto",
                                        flexDirection: "column",
                                        gap: 8,
                                        maxHeight: "min(42vh, 360px)",
                                        minHeight: 0,
                                        overflowY: "auto",
                                        overflowX: "hidden",
                                        overscrollBehavior: "contain",
                                        paddingRight: 4,
                                        WebkitOverflowScrolling: "touch",
                                    }}
                                >
                                    {visibleTimelineLogs.map((log) => renderLogCard(log))}
                                </div>
                            </div>
                        )}

                        <button
                            type="button"
                            onClick={() => {
                                setLogModalItem(null);
                                setItemLogs([]);
                                setItemLogsError("");
                            }}
                            style={{ ...ui.subButton, flexShrink: 0 }}
                        >
                            {c.close}
                        </button>
                    </div>
                </div>
            )}
        </Container>
    );
}
