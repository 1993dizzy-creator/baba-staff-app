"use client";

import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/lib/language-context";
import Container from "@/components/Container";
import { ui } from "@/lib/styles/ui";
import { commonText, inventoryText } from "@/lib/text";
import SubNav from "@/components/SubNav";
import { usePathname } from "next/navigation";
import { getInventoryTabs } from "@/lib/navigation/inventory-tabs";
import {PART_VALUES,PART_META,type PartValue,} from "@/lib/common/parts";
import { isInCurrentBusinessDay } from "@/lib/inventory/business-day";
import { formatDecimalDisplay } from "@/lib/inventory/number";


type SnapshotBatch = {
    id: number;
    snapshot_date: string;
};

type SnapshotItem = {
    id: number;
    batch_id: number;
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
    supplier: string | null;
    total_purchase_price: number | null;
};

export default function InventorySnapshotsPage() {
    const { lang } = useLanguage();
    const t = inventoryText[lang];
    const c = commonText[lang];

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
    const [calendarMonth, setCalendarMonth] = useState("");
    const [purchaseBatchMap, setPurchaseBatchMap] = useState<Record<number, boolean>>({});
    const [supplierTab, setSupplierTab] = useState("all");

    const getDisplayItemName = (item: SnapshotItem) => {
        return lang === "vi"
            ? item.item_name_vi || item.item_name || "-"
            : item.item_name || item.item_name_vi || "-";
    };

    const getDisplayCategory = (item: SnapshotItem) => {
        return lang === "vi"
            ? item.category_vi || item.category || "-"
            : item.category || item.category_vi || "-";
    };

    const getCategoryKey = (item: SnapshotItem) =>
        item.category || item.category_vi || "-";


    const fetchBatches = async () => {
        setLoadingBatches(true);

        try {
            const res = await fetch("/api/inventory/snapshot/list");
            const json = await res.json();

            if (!res.ok || !json.ok) {
                console.error(json.message);
                setBatchList([]);
                setSelectedBatchId(null);
                setLoadingBatches(false);
                return;
            }

            const nextBatches = (json.batches || []) as SnapshotBatch[];

            setBatchList(nextBatches);
            setSelectedBatchId(null);
            setPurchaseBatchMap(json.purchaseBatchMap || {});

            if (nextBatches[0]?.snapshot_date) {
                setCalendarMonth(nextBatches[0].snapshot_date.slice(0, 7));
            }
        } catch (error) {
            console.error(error);
            setBatchList([]);
            setSelectedBatchId(null);
        } finally {
            setLoadingBatches(false);
        }
    };

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
            const res = await fetch(`/api/inventory/snapshot/${safeBatchId}`, {
                cache: "no-store",
            });

            const json = await res.json();

            if (!res.ok || !json.ok) {
                console.error("[SNAPSHOT_FETCH_ERROR]", {
                    batchId,
                    safeBatchId,
                    message: json.message,
                });
                setSnapshotItems([]);
                return;
            }

            setSnapshotItems(json.items || []);
        } catch (error) {
            console.error("[SNAPSHOT_FETCH_EXCEPTION]", error);
            setSnapshotItems([]);
        } finally {
            setLoadingItems(false);
        }
    };

    const fetchTodayPurchasedItems = async () => {
        setLoadingItems(true);
        setSnapshotItems([]);
        setSupplierTab("all");

        try {
            const res = await fetch("/api/inventory/logs?mode=logs", {
                cache: "no-store",
            });

            const json = await res.json();

            if (!res.ok || !json.ok) {
                console.error(json.message);
                setSnapshotItems([]);
                return;
            }

            const todayItems = (json.data || [])
                .filter((log: any) => {
                    const isPurchase = Number(log.change_quantity ?? 0) > 0;
                    const isToday = isInCurrentBusinessDay(log.created_at);

                    return isPurchase && isToday;
                })
                .map((log: any) => ({
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
                    purchase_price: log.new_purchase_price ?? log.purchase_price,
                    supplier: log.new_supplier ?? log.supplier,
                    total_purchase_price:
                        Number(log.change_quantity ?? 0) *
                        Number(log.new_purchase_price ?? log.purchase_price ?? 0),
                }));

            setSnapshotItems(todayItems as SnapshotItem[]);
        } catch (error) {
            console.error(error);
            setSnapshotItems([]);
        } finally {
            setLoadingItems(false);
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
        fetchBatches();
        fetchTodayPurchasedItems();
    }, []);

    useEffect(() => {
        setCategoryFilter("all");
    }, [partFilter]);

    useEffect(() => {
        if (viewMode !== "snapshot") return;

        setSupplierTab("all");

        if (!selectedBatchId) return;

        fetchSnapshotItems(selectedBatchId);
    }, [selectedBatchId, viewMode]);

    useEffect(() => {
        if (batchList.length === 0) return;

        const latest = [...batchList]
            .map((batch) => batch.snapshot_date)
            .sort((a, b) => a.localeCompare(b))
            .at(-1);

        if (latest) {
            setCalendarMonth(latest.slice(0, 7)); // YYYY-MM
        }
    }, [batchList]);

    const categoryTabs = useMemo(() => {
        return [
            { key: "all", label: c.all },
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
    }, [snapshotItems, partFilter, lang]);

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
    }, [snapshotItems, search, partFilter, categoryFilter, showChangedOnly, lang]);

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
        const baseItems =
            viewMode === "snapshot"
                ? snapshotItems.filter((item) => Number(item.change_quantity ?? 0) > 0)
                : snapshotItems;

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
    }, [snapshotItems, lang, viewMode]);

    const supplierTabs = useMemo(() => {
        return [
            { key: "all", label: c.all },
            ...Array.from(
                new Set(
                    purchasedItems.map((item) => item.supplier || "-")
                )
            ).map((supplier) => ({
                key: supplier,
                label: supplier,
            })),
        ];
    }, [purchasedItems, lang]);

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

    const todayDateKey = new Date(
        new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" })
    )
        .toISOString()
        .slice(0, 10);

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
                                const isToday = cell.date === todayDateKey;
                                const active =
                                    viewMode === "snapshot"
                                        ? cell.batch?.id === selectedBatchId
                                        : isToday;
                                const hasBatch = !!cell.batch;
                                const dayOfWeek = index % 7;

                                return (
                                    <button
                                        key={cell.key}
                                        type="button"
                                        disabled={!hasBatch && !isToday}
                                        onClick={() => {
                                            if (cell.batch?.id) {
                                                setViewMode("snapshot");
                                                setSelectedBatchId(Number(cell.batch.id));
                                                return;
                                            }

                                            if (isToday) {
                                                setViewMode("current");
                                                setSelectedBatchId(null);
                                                fetchTodayPurchasedItems();
                                            }
                                        }}
                                        style={getCalendarCellStyle(active, hasBatch || isToday, dayOfWeek)}
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
                                                {hasBatch && purchaseBatchMap[cell.batch!.id] && (
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

                                                {isToday && (
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
                                {c.today}
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
                                : c.today}
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
                                    }}
                                >
                                    {tab.label}
                                </button>
                            );
                        })}
                    </div>

                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 8,
                        }}
                    >
                        {filteredPurchasedItems.map((item) => {
                            const qty = Number(item.change_quantity ?? 0);
                            const price = item.purchase_price;
                            const total = item.total_purchase_price;

                            return (
                                <div
                                    key={item.id}
                                    style={{
                                        border: "1px solid #e5e7eb",
                                        borderLeft: `4px solid ${PART_META[(item.part || "etc") as keyof typeof PART_META]?.color || "#9ca3af"}`,
                                        borderRadius: 10,
                                        padding: "8px 10px",
                                        background: "#ffffff",
                                    }}
                                >
                                    <div
                                        style={{
                                            display: "flex",
                                            justifyContent: "space-between",
                                            alignItems: "flex-start",
                                            gap: 10,
                                            marginBottom: 7,
                                        }}
                                    >
                                        <div
                                            style={{
                                                minWidth: 0,
                                                fontSize: 14,
                                                fontWeight: 800,
                                                color: "#111827",
                                                lineHeight: 1.25,
                                                wordBreak: "break-word",
                                            }}
                                        >
                                            {[item.code ? `[${item.code}]` : "", getDisplayItemName(item)]
                                                .filter(Boolean)
                                                .join(" ")}
                                            <span
                                                style={{
                                                    marginLeft: 4,
                                                    fontSize: 11,
                                                    fontWeight: 700,
                                                    color: "#9ca3af",
                                                }}
                                            >
                                                / {getDisplayCategory(item)}
                                            </span>
                                        </div>

                                        <div
                                            style={{
                                                flexShrink: 0,
                                                textAlign: "right",
                                                fontSize: 11,
                                                fontWeight: 800,
                                                color: "#6b7280",
                                                whiteSpace: "nowrap",
                                            }}
                                        >
                                            {price === null || price === undefined
                                                ? "-"
                                                : `${Number(price).toLocaleString()} ₫`}
                                            <span
                                                style={{
                                                    marginLeft: 3,
                                                    fontSize: 11,
                                                    fontWeight: 700,
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
                                            paddingTop: 6,
                                            borderTop: "1px solid #f1f5f9",
                                            fontSize: 12,
                                            fontWeight: 800,
                                            color: "#111827",
                                        }}
                                    >
                                        <div>
                                            {formatDecimalDisplay(qty)} {item.unit || ""}
                                        </div>

                                        <div style={{ textAlign: "right", fontWeight: 900 }}>
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
                                    const prevQty = item.prev_quantity;
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
        </Container>
    );
}