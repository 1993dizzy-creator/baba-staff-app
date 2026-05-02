"use client";

import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/lib/language-context";
import Container from "@/components/Container";
import { ui } from "@/lib/styles/ui";
import { inventorySnapshotText } from "@/lib/text";
import SubNav from "@/components/SubNav";
import { usePathname } from "next/navigation";
import { getInventoryTabs } from "@/lib/navigation/inventory-tabs";


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

export default function InventorySnapshotsPage() {
    const { lang } = useLanguage();
    const t = inventorySnapshotText[lang];

    const [batchList, setBatchList] = useState<SnapshotBatch[]>([]);
    const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
    const [snapshotItems, setSnapshotItems] = useState<SnapshotItem[]>([]);
    const [search, setSearch] = useState("");
    const [partFilter, setPartFilter] = useState<"all" | PartValue>("all");
    const [loadingBatches, setLoadingBatches] = useState(true);
    const [loadingItems, setLoadingItems] = useState(false);
    const [currentQuantityMap, setCurrentQuantityMap] = useState<Record<number, number>>({});
    const [categoryFilter, setCategoryFilter] = useState("all");
    const [showChangedOnly, setShowChangedOnly] = useState(false);
    const [calendarMonth, setCalendarMonth] = useState("");
    const [purchaseBatchMap, setPurchaseBatchMap] = useState<Record<number, boolean>>({});
    const [supplierTab, setSupplierTab] = useState("all");

    const getPartLabel = (value: string | null) => {
        switch (value) {
            case "kitchen":
                return t.partKitchen;
            case "hall":
                return t.partHall;
            case "bar":
                return t.partBar;
            case "etc":
                return t.partEtc;
            default:
                return value || "-";
        }
    };

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

    const formatDecimalDisplay = (value: string | number | null | undefined) => {
        if (value === null || value === undefined || value === "") return "0";

        const num =
            typeof value === "number"
                ? value
                : Number(String(value).replace(/,/g, "").trim());

        if (!Number.isFinite(num)) return "0";

        return num.toFixed(2).replace(/\.?0+$/, "");
    };

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
        setSelectedBatchId(nextBatches[0]?.id ?? null);
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

const fetchSnapshotItems = async (batchId: number) => {
    setLoadingItems(true);

    try {
        const res = await fetch(`/api/inventory/snapshot/${batchId}`);
        const json = await res.json();

        if (!res.ok || !json.ok) {
            console.error(json.message);
            setSnapshotItems([]);
            setLoadingItems(false);
            return;
        }

        setSnapshotItems((json.items || []) as SnapshotItem[]);
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
    }, []);

    useEffect(() => {
        setCategoryFilter("all");
    }, [partFilter]);

    useEffect(() => {
        setSupplierTab("all");

        if (!selectedBatchId) {
            setSnapshotItems([]);
            return;
        }

        fetchSnapshotItems(selectedBatchId);
    }, [selectedBatchId]);

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
            { key: "all", label: lang === "vi" ? "Tất cả" : "전체" },
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
        batchList.find((batch) => batch.id === selectedBatchId) || null;

    const purchasedItems = useMemo(() => {
        return snapshotItems
            .filter((item) => Number(item.change_quantity ?? 0) > 0)
            .sort((a, b) => {
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
    }, [snapshotItems, lang]);

    const supplierTabs = useMemo(() => {
        return [
            { key: "all", label: lang === "vi" ? "Tất cả" : "전체" },
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
                        {lang === "vi" ? "Lịch snapshot" : "스냅샷 캘린더"}
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
                        Loading...
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
                        {t.noBatches}
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
                            {(lang === "vi"
                                ? ["CN", "T2", "T3", "T4", "T5", "T6", "T7"]
                                : ["일", "월", "화", "수", "목", "금", "토"]
                            ).map((label, index) => (
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
                                const active = cell.batch?.id === selectedBatchId;
                                const hasBatch = !!cell.batch;
                                const dayOfWeek = index % 7;

                                return (
                                    <button
                                        key={cell.key}
                                        type="button"
                                        disabled={!hasBatch}
                                        onClick={() => {
                                            if (cell.batch) {
                                                setSelectedBatchId(cell.batch.id);
                                            }
                                        }}
                                        style={getCalendarCellStyle(active, hasBatch, dayOfWeek)}
                                    >
                                        <>
                                            <span>{cell.day ?? ""}</span>

                                            {hasBatch && purchaseBatchMap[cell.batch!.id] && (
                                                <span
                                                    style={{
                                                        width: 5,
                                                        height: 5,
                                                        borderRadius: 999,
                                                        background: active ? "#fff" : "#2563eb",
                                                        display: "block",
                                                        marginTop: 3,
                                                    }}
                                                />
                                            )}
                                        </>
                                    </button>
                                );
                            })}
                        </div>
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                                marginTop: 10,
                                fontSize: 12,
                                fontWeight: 700,
                                color: "#6b7280",
                            }}
                        >
                            <span
                                style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: 999,
                                    background: "#2563eb",
                                    display: "inline-block",
                                }}
                            />
                            <span>
                                {lang === "vi"
                                    ? "Dấu chấm = có hàng nhập trong ngày kiểm kho"
                                    : "점 = 해당 재고확인일에 입고 상품 있음"}
                            </span>
                        </div>
                    </>
                )}
            </div>

            {selectedBatch && purchasedItems.length > 0 && (
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
                            {lang === "vi" ? "Hàng nhập trong ngày" : "일자별 입고 상품"}
                        </span>

                        <span
                            style={{
                                fontSize: 12,
                                fontWeight: 700,
                                color: "#6b7280",
                            }}
                        >
                            {selectedBatch.snapshot_date}
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
                                        borderRadius: 10,
                                        padding: 10,
                                        background: "#ffffff",
                                    }}
                                >
                                    <div
                                        style={{
                                            display: "flex",
                                            justifyContent: "space-between",
                                            gap: 10,
                                            alignItems: "flex-start",
                                        }}
                                    >
                                        <div style={{ minWidth: 0 }}>
                                            <div
                                                style={{
                                                    fontSize: 14,
                                                    fontWeight: 800,
                                                    color: "#111827",
                                                    wordBreak: "break-word",
                                                }}
                                            >
                                                {[item.code ? `[${item.code}]` : "", getDisplayItemName(item)]
                                                    .filter(Boolean)
                                                    .join(" ")}
                                            </div>

                                            <div
                                                style={{
                                                    marginTop: 3,
                                                    fontSize: 12,
                                                    fontWeight: 600,
                                                    color: "#6b7280",
                                                }}
                                            >
                                                {item.supplier || "-"}
                                            </div>
                                        </div>

                                        <div
                                            style={{
                                                textAlign: "right",
                                                fontSize: 13,
                                                fontWeight: 700,
                                                color: "#111827",
                                                whiteSpace: "nowrap",
                                            }}
                                        >
                                            +{formatDecimalDisplay(qty)} {item.unit || ""}
                                        </div>
                                    </div>

                                    <div
                                        style={{
                                            display: "grid",
                                            gridTemplateColumns: "1fr 1fr 1fr",
                                            gap: 6,
                                            marginTop: 8,
                                            fontSize: 12,
                                        }}
                                    >
                                        <div>
                                            <div style={{ color: "#9ca3af", fontWeight: 700 }}>
                                                {lang === "vi" ? "Đơn giá" : "단가"}
                                            </div>
                                            <div style={{ fontWeight: 800 }}>
                                                {price === null || price === undefined
                                                    ? "-"
                                                    : `${Number(price).toLocaleString()} ₫`}
                                            </div>
                                        </div>

                                        <div>
                                            <div style={{ color: "#9ca3af", fontWeight: 700 }}>
                                                {lang === "vi" ? "Số lượng" : "수량"}
                                            </div>
                                            <div style={{ fontWeight: 800 }}>
                                                {formatDecimalDisplay(qty)} {item.unit || ""}
                                            </div>
                                        </div>

                                        <div style={{ textAlign: "right" }}>
                                            <div style={{ color: "#9ca3af", fontWeight: 700 }}>
                                                {lang === "vi" ? "Thành tiền" : "금액"}
                                            </div>
                                            <div style={{ fontWeight: 900 }}>
                                                {total === null || total === undefined
                                                    ? "-"
                                                    : `${Number(total).toLocaleString()} ₫`}
                                            </div>
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
                        <span>{lang === "vi" ? "Tổng cộng" : "총 합계"}</span>
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
                            {t.partAll}
                        </button>

                        {[
                            { value: "kitchen", label: t.partKitchen },
                            { value: "hall", label: t.partHall },
                            { value: "bar", label: t.partBar },
                            { value: "etc", label: t.partEtc },
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
                            {lang === "vi"
                                ? showChangedOnly
                                    ? "Xem tất cả"
                                    : "Chỉ xem mặt hàng có thay đổi"
                                : showChangedOnly
                                    ? "전체 보기"
                                    : "변화 있는 품목만 보기"}
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
                            {t.resetFilter}
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
                        <div>Loading...</div>
                    </div>
                ) : !selectedBatchId ? (
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
                        <div>{t.noBatches}</div>
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
                        <div>{t.noItems}</div>
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
                                                        {[getPartLabel(item.part), getDisplayCategory(item)].join(" · ")}
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
                                                            {lang === "vi" ? "So với hôm trước" : "전일대비"}{" "}
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