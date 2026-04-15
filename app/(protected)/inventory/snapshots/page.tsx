"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase/client";
import { useLanguage } from "@/lib/language-context";
import Container from "@/components/Container";
import { ui } from "@/lib/styles/ui";
import { inventorySnapshotText } from "@/lib/text";




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
};

export default function InventorySnapshotsPage() {
    const { lang } = useLanguage();
    const t = inventorySnapshotText[lang];


    const [batchList, setBatchList] = useState<SnapshotBatch[]>([]);
    const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
    const [snapshotItems, setSnapshotItems] = useState<SnapshotItem[]>([]);
    const [search, setSearch] = useState("");
    const [partFilter, setPartFilter] = useState("all");
    const [loadingBatches, setLoadingBatches] = useState(true);
    const [loadingItems, setLoadingItems] = useState(false);
    const [currentQuantityMap, setCurrentQuantityMap] = useState<Record<number, number>>({});
    const [categoryFilter, setCategoryFilter] = useState("all");
    const [showChangedOnly, setShowChangedOnly] = useState(false);

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

    const fetchBatches = async () => {
        setLoadingBatches(true);

        const { data, error } = await supabase
            .from("inventory_snapshot_batches")
            .select("id, snapshot_date")
            .order("snapshot_date", { ascending: false });

        if (error) {
            console.error(error);
            setBatchList([]);
            setSelectedBatchId(null);
            setLoadingBatches(false);
            return;
        }

        const nextBatches = (data || []) as SnapshotBatch[];
        setBatchList(nextBatches);
        setSelectedBatchId(nextBatches[0]?.id ?? null);
        setLoadingBatches(false);
    };

    const fetchSnapshotItems = async (batchId: number) => {
        setLoadingItems(true);

        const { data, error } = await supabase
            .from("inventory_snapshot_items")
            .select(`
                id,
                batch_id,
                item_id,
                item_name,
                item_name_vi,
                part,
                category,
                category_vi,
                quantity,
                unit,
                code
            `)
            .eq("batch_id", batchId);

        if (error) {
            console.error(error);
            setSnapshotItems([]);
            setLoadingItems(false);
            return;
        }

        setSnapshotItems((data || []) as SnapshotItem[]);
        setLoadingItems(false);
    };


    const fetchCurrentInventory = async () => {
        const { data, error } = await supabase
            .from("inventory")
            .select("id, quantity");

        if (error) {
            console.error(error);
            setCurrentQuantityMap({});
            return;
        }

        const nextMap: Record<number, number> = {};

        (data || []).forEach((item) => {
            if (item.id !== null && item.id !== undefined) {
                nextMap[Number(item.id)] = Number(item.quantity ?? 0);
            }
        });

        setCurrentQuantityMap(nextMap);
    };

    useEffect(() => {
        fetchBatches();
        fetchCurrentInventory();
    }, []);

    useEffect(() => {
        setCategoryFilter("all");
    }, [partFilter]);

    useEffect(() => {
        if (!selectedBatchId) {
            setSnapshotItems([]);
            return;
        }

        fetchSnapshotItems(selectedBatchId);
    }, [selectedBatchId]);


    const categoryTabs = useMemo(() => {
        return [
            { key: "all", label: t.partAll },
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

                const matchSearch =
                    !keyword ||
                    displayItemName.includes(keyword) ||
                    displayCategory.includes(keyword);

                const matchPart =
                    partFilter === "all" || item.part === partFilter;

                const categoryKey = getCategoryKey(item);

                const matchCategory =
                    categoryFilter === "all" || categoryKey === categoryFilter;

                const snapshotQty = Number(item.quantity ?? 0);
                const currentQty =
                    item.item_id !== null && item.item_id !== undefined
                        ? Number(currentQuantityMap[item.item_id] ?? 0)
                        : 0;
                const diffQty = currentQty - snapshotQty;

                const matchChanged =
                    !showChangedOnly || diffQty !== 0;

                return matchSearch && matchPart && matchCategory && matchChanged;
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

                // 3. 코드 같으면 이름 비교
                const nameA = getDisplayItemName(a).toLowerCase();
                const nameB = getDisplayItemName(b).toLowerCase();

                return nameA.localeCompare(nameB, undefined, {
                    numeric: true,
                    sensitivity: "base",
                });
            });
    }, [snapshotItems, search, partFilter, categoryFilter, showChangedOnly, currentQuantityMap, lang]);

    const selectedBatch =
        batchList.find((batch) => batch.id === selectedBatchId) || null;

    return (
        <Container>
            <h1 style={ui.pageTitle}>{t.title}</h1>


            <div style={{ marginBottom: 20 }}>
                <Link
                    href="/inventory"
                    style={{
                        ...ui.button,
                        width: "100%",
                    }}
                >
                    {t.backToInventory}
                </Link>
            </div>

            <div
                style={{
                    ...ui.card,
                    padding: 16,
                    marginBottom: 20,
                }}
            >
                <h2 style={ui.sectionTitle}>{t.snapshotDates}</h2>

                {loadingBatches ? (
                    <p style={{ margin: 0 }}>Loading...</p>
                ) : batchList.length === 0 ? (
                    <p style={{ margin: 0 }}>{t.noBatches}</p>
                ) : (
                    <div
                        style={{
                            display: "flex",
                            gap: 8,
                            overflowX: "auto",
                            paddingBottom: 4,
                        }}
                    >
                        {batchList.map((batch) => {
                            const active = selectedBatchId === batch.id;

                            return (
                                <button
                                    key={batch.id}
                                    type="button"
                                    onClick={() => setSelectedBatchId(batch.id)}
                                    style={{
                                        padding: "8px 12px",
                                        borderRadius: 999,
                                        border: active ? "1px solid #111827" : "1px solid #d1d5db",
                                        background: active ? "#111827" : "#f9fafb",
                                        color: active ? "#fff" : "#111827",
                                        fontWeight: 700,
                                        fontSize: 13,
                                        whiteSpace: "nowrap",
                                        cursor: "pointer",
                                        flexShrink: 0,
                                    }}
                                >
                                    {batch.snapshot_date}
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>

            {selectedBatch && (
                <div
                    style={{
                        ...ui.card,
                        padding: 14,
                        marginBottom: 20,
                        background: "#f9fafb",
                        border: "1px solid #e5e7eb",
                    }}
                >
                    <div
                        style={{
                            fontSize: 14,
                            fontWeight: 700,
                            color: "#111827",
                            marginBottom: 4,
                        }}
                    >
                        {t.baseDateLabel}: {selectedBatch.snapshot_date}
                    </div>

                    <div
                        style={{
                            ...ui.metaText,
                            fontWeight: 700,
                            color: "#4b5563",
                        }}
                    >
                        {t.compareNowLabel}
                    </div>
                </div>
            )}

            <div
                style={{
                    ...ui.card,
                    padding: 16,
                    marginBottom: 20,
                }}
            >
                <input
                    type="text"
                    placeholder={t.searchPlaceholder}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={{
                        ...ui.input,
                        marginBottom: 12,
                    }}
                />

                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(5, 1fr)",
                        gap: 8,
                        marginBottom: 12,
                    }}
                >
                    {[
                        { value: "all", label: t.partAll },
                        { value: "kitchen", label: t.partKitchen },
                        { value: "hall", label: t.partHall },
                        { value: "bar", label: t.partBar },
                        { value: "etc", label: t.partEtc },
                    ].map((option) => {
                        const active = partFilter === option.value;

                        return (
                            <button
                                key={option.value}
                                type="button"
                                onClick={() => setPartFilter(option.value)}
                                style={{
                                    padding: "10px 12px",
                                    borderRadius: 8,
                                    border: active ? "1px solid #111827" : "1px solid #d1d5db",
                                    background: active ? "#111827" : "#f9fafb",
                                    color: active ? "white" : "#111827",
                                    fontWeight: 700,
                                    fontSize: 14,
                                    cursor: "pointer",
                                    whiteSpace: "nowrap",
                                }}
                            >
                                {option.label}
                            </button>
                        );
                    })}
                </div>

                <div
                    style={{
                        display: "flex",
                        gap: 8,
                        overflowX: "auto",
                        paddingBottom: 6,
                        marginBottom: 12,
                    }}
                >
                    {categoryTabs.map((cat) => {
                        const active = categoryFilter === cat.key;

                        return (
                            <button
                                key={cat.key}
                                type="button"
                                onClick={() => setCategoryFilter(cat.key)}
                                style={{
                                    padding: "8px 12px",
                                    borderRadius: 999,
                                    border: active ? "1px solid #111827" : "1px solid #d1d5db",
                                    background: active ? "#111827" : "#f9fafb",
                                    color: active ? "#fff" : "#111827",
                                    fontWeight: 700,
                                    fontSize: 13,
                                    whiteSpace: "nowrap",
                                    cursor: "pointer",
                                    flexShrink: 0,
                                }}
                            >
                                {cat.label}
                            </button>
                        );
                    })}
                </div>

                <button
                    type="button"
                    onClick={() => setShowChangedOnly(!showChangedOnly)}
                    style={{
                        width: "100%",
                        padding: "10px 14px",
                        background: showChangedOnly ? "#111827" : "#f5f5f5",
                        color: showChangedOnly ? "white" : "black",
                        border: showChangedOnly ? "1px solid #111827" : "1px solid #ddd",
                        borderRadius: 8,
                        cursor: "pointer",
                        fontWeight: 700,
                        marginBottom: 12,
                    }}
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
                    style={{
                        ...ui.subButton,
                        width: "100%",
                        padding: "12px 14px",
                    }}
                >
                    {t.resetFilter}
                </button>

                <div
                    style={{
                        marginTop: 10,
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
                    padding: 20,
                }}
            >
                {loadingItems ? (
                    <p style={{ margin: 0 }}>Loading...</p>
                ) : !selectedBatchId ? (
                    <p style={{ margin: 0 }}>{t.noBatches}</p>
                ) : filteredItems.length === 0 ? (
                    <p style={{ margin: 0 }}>{t.noItems}</p>
                ) : (
                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 12,
                            maxHeight: 500,
                            overflowY: "auto",
                            paddingRight: 4,
                        }}
                    >
                        {filteredItems.map((item) => {
                            const snapshotQty = Number(item.quantity ?? 0);
                            const currentQty =
                                item.item_id !== null && item.item_id !== undefined
                                    ? Number(currentQuantityMap[item.item_id] ?? 0)
                                    : 0;
                            const diffQty = currentQty - snapshotQty;

                            return (
                                <div
                                    key={item.id}
                                    style={{
                                        ...ui.card,
                                        padding: "8px 10px",
                                        background: "#fff",
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
                                        <div style={{ minWidth: 0, flex: 1 }}>
                                            <div
                                                style={{
                                                    fontSize: 14,
                                                    fontWeight: 700,
                                                    color: "#111827",
                                                    lineHeight: 1.2,
                                                    wordBreak: "break-word",
                                                }}
                                            >
                                                {[item.code ? `[${item.code}]` : "", getDisplayItemName(item)]
                                                    .filter(Boolean)
                                                    .join(" ")}
                                            </div>

                                            <div style={ui.metaText}>
                                                {[getPartLabel(item.part), getDisplayCategory(item)].join(" · ")}
                                            </div>
                                        </div>

                                        <div
                                            style={{
                                                textAlign: "right",
                                                flexShrink: 0,
                                                whiteSpace: "nowrap",
                                                minWidth: 72,
                                            }}
                                        >
                                            <div
                                                style={{
                                                    fontSize: 14,
                                                    fontWeight: 700,
                                                    color: "#111827",
                                                }}
                                            >
                                                {snapshotQty} {item.unit || ""}
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
                                                {diffQty > 0 ? "+" : ""}
                                                {diffQty}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </Container>
    );
}