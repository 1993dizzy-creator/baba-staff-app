"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import Link from "next/link";
import { useLanguage } from "@/lib/language-context";
import { inventoryLogsText } from "@/lib/text";
import Container from "@/components/Container";
import { ui } from "@/lib/styles/ui";
import { getUser } from "@/lib/supabase/auth";

export default function InventoryLogsPage() {
    const [logs, setLogs] = useState<any[]>([]);
    const [filterType, setFilterType] = useState<"all" | "create" | "update" | "delete">("all");
    const [search, setSearch] = useState("");
    const [partFilter, setPartFilter] = useState("all");
    const [openGroupKey, setOpenGroupKey] = useState<string | null>(null);
    const [visibleCount, setVisibleCount] = useState(20);
    const [inventoryNoteMap, setInventoryNoteMap] = useState<Record<string, string>>({});

    const fetchLogs = async () => {
        const { data, error } = await supabase
            .from("inventory_logs")
            .select("*")
            .order("created_at", { ascending: false });

        if (error) {
            console.error(error);
            return;
        }

        setLogs(data || []);
    };

    const handleDeleteSingleLog = async (logId: number) => {
        if (!isMaster) return;

        const ok = confirm(t.deleteLogConfirm);

        if (!ok) return;

        const { error } = await supabase
            .from("inventory_logs")
            .delete()
            .eq("id", logId);

        if (error) {
            console.error(error);
            alert(t.deleteLogFail);
            return;
        }

        alert(t.deleteLogSuccess);
        await fetchLogs();
    };

    const fetchInventoryNotes = async () => {
        const { data, error } = await supabase
            .from("inventory")
            .select("id, part, code, item_name, item_name_vi, note");

        if (error) {
            console.error(error);
            return;
        }

        const nextMap: Record<string, string> = {};

        (data || []).forEach((item) => {
            const keyById =
                item.id !== null && item.id !== undefined ? `item-${item.id}` : null;

            const keyByFallback = [
                item.part || "",
                item.code || "",
                item.item_name || "",
                item.item_name_vi || "",
            ].join("|");

            if (keyById) {
                nextMap[keyById] = item.note || "-";
            }

            nextMap[keyByFallback] = item.note || "-";
        });

        setInventoryNoteMap(nextMap);
    };

    useEffect(() => {
        fetchLogs();
        fetchInventoryNotes();
    }, []);

    useEffect(() => {
        setVisibleCount(20);
    }, [search, filterType, partFilter]);

    const currentUser = getUser();
    const isMaster = currentUser?.role === "master";

    const { lang } = useLanguage();
    const t = inventoryLogsText[lang];

    const getPartLabel = (value: string) => {
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

    const getDisplayLogItemName = (log: any) => {
        return lang === "vi"
            ? log.item_name_vi || log.item_name || "-"
            : log.item_name || log.item_name_vi || "-";
    };

    const getDisplayLogCategory = (log: any) => {
        return lang === "vi"
            ? log.category_vi || log.category || "-"
            : log.category || log.category_vi || "-";
    };

    const formatDateTime = (value: string) => {
        const date = new Date(value);

        const yy = String(date.getFullYear()).slice(2);
        const mm = String(date.getMonth() + 1).padStart(2, "0");
        const dd = String(date.getDate()).padStart(2, "0");
        const hh = String(date.getHours()).padStart(2, "0");
        const min = String(date.getMinutes()).padStart(2, "0");

        return `${yy}.${mm}.${dd} ${hh}:${min}`;
    };

    const getGroupKey = (log: any) => {
        if (log.item_id !== null && log.item_id !== undefined) {
            return `item-${log.item_id}`;
        }

        return [
            log.part || "",
            log.code || "",
            log.item_name || "",
            log.item_name_vi || "",
        ].join("|");
    };


    const filteredLogs = logs
        .filter((log) => {
            const keyword = search.toLowerCase();

            const matchType = filterType === "all" || log.action === filterType;

            const displayItemName = getDisplayLogItemName(log).toLowerCase();
            const displayCategory = getDisplayLogCategory(log).toLowerCase();

            const matchSearch =
                displayItemName.includes(keyword) ||
                displayCategory.includes(keyword);

            const matchPart =
                partFilter === "all" || log.part === partFilter;

            return matchType && matchSearch && matchPart;
        })
        .sort(
            (a, b) =>
                new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );

    const groupedLogsMap = filteredLogs.reduce((acc, log) => {
        const key = getGroupKey(log);

        if (!acc[key]) {
            acc[key] = [];
        }

        acc[key].push(log);
        return acc;
    }, {} as Record<string, any[]>);

    const groupedLogs = Object.entries(groupedLogsMap).map(([groupKey, items]) => {
        const sortedItems = [...items].sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );

        const latest = sortedItems[0];

        return {
            groupKey,
            latest,
            logs: sortedItems,
        };
    });

    const visibleGroups = groupedLogs.slice(0, visibleCount);



    const changeFieldConfig = [
        {
            key: "quantity",
            labelKo: "수량",
            labelVi: "Số lượng",
            type: "number",
        },
        {
            key: "purchase_price",
            labelKo: "구매가",
            labelVi: "Giá nhập",
            type: "price",
        },
        {
            key: "note",
            labelKo: "비고",
            labelVi: "Ghi chú",
            type: "text",
        },
        {
            key: "supplier",
            labelKo: "거래처",
            labelVi: "Nhà cung cấp",
            type: "text",
        },
        {
            key: "code",
            labelKo: "코드",
            labelVi: "Mã",
            type: "text",
        },
        {
            key: "unit",
            labelKo: "단위",
            labelVi: "Đơn vị",
            type: "text",
        },
        {
            key: "category",
            labelKo: "카테고리",
            labelVi: "Danh mục",
            type: "text",
        },
        {
            key: "category_vi",
            labelKo: "카테고리(vi)",
            labelVi: "Danh mục (vi)",
            type: "text",
        },
        {
            key: "part",
            labelKo: "파트",
            labelVi: "Bộ phận",
            type: "text",
        },
    ];

    function getLogChanges(log: any, lang: string) {
        const changes: Array<{
            label: string;
            before?: string;
            after: string;
            color?: string;
        }> = [];

        if (log.action === "create") {
            return [
                {
                    label: t.filterCreate,
                    after: t.createDone,
                    color: "#111827",
                },
            ];
        }

        if (log.action === "delete") {
            return [
                {
                    label: t.filterDelete,
                    after: t.deleteDone,
                    color: "#6b7280",
                },
            ];
        }

        changeFieldConfig.forEach((field) => {
            const prev = log[`prev_${field.key}`];
            const next = log[`new_${field.key}`];

            if ((prev ?? "") === (next ?? "")) return;

            const label = lang === "vi" ? field.labelVi : field.labelKo;

            let before = "";
            let after = "";
            let color = "#111827";

            if (field.type === "number") {
                const prevNum = Number(prev ?? 0);
                const nextNum = Number(next ?? 0);

                before = `${prevNum}`;
                after = `${nextNum}${log.unit ? ` ${log.unit}` : ""}`;

                color =
                    nextNum > prevNum
                        ? "seagreen"
                        : nextNum < prevNum
                            ? "crimson"
                            : "#111827";
            }

            if (field.type === "price") {
                const prevStr =
                    prev !== null && prev !== undefined
                        ? Number(prev).toLocaleString() + " ₫"
                        : "-";

                const nextStr =
                    next !== null && next !== undefined
                        ? Number(next).toLocaleString() + " ₫"
                        : "-";

                before = prevStr;
                after = nextStr;
                color = "#2563eb";
            }

            if (field.type === "text") {
                before = prev || "-";
                after = next || "-";
                color = "#2563eb";
            }

            changes.push({ label, before, after, color });
        });

        if (changes.length === 0) {
            return [
                {
                    label: t.filterUpdate,
                    after: t.noChangeDetail,
                    color: "#111827",
                },
            ];
        }

        return changes;
    }



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

            {/* 필터 카드 */}
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
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                        marginBottom: 10,
                    }}
                >
                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(4, 1fr)",
                            gap: 8,
                        }}
                    >
                        {[
                            { value: "all", label: t.filterAll },
                            { value: "create", label: t.filterCreate },
                            { value: "update", label: t.filterUpdate },
                            { value: "delete", label: t.filterDelete },
                        ].map((option) => {
                            const active = filterType === option.value;

                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    onClick={() =>
                                        setFilterType(option.value as "all" | "create" | "update" | "delete")
                                    }
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
                            display: "grid",
                            gridTemplateColumns: "repeat(5, 1fr)",
                            gap: 8,
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

                    <div>
                        <button
                            onClick={() => {
                                setSearch("");
                                setFilterType("all");
                                setPartFilter("all");
                            }}
                            style={{
                                ...ui.subButton,
                                padding: "12px 14px",
                                width: "100%",
                            }}
                        >
                            {t.resetFilter}
                        </button>
                    </div>
                </div>

                <div
                    style={{
                        marginTop: 10,
                        ...ui.metaText,
                        fontWeight: 700,
                    }}
                >
                    {t.logCount}: {filteredLogs.length}
                </div>
            </div>

            {/* 리스트 카드 */}
            <div
                style={{
                    ...ui.card,
                    padding: 20,
                }}
            >
                {filteredLogs.length === 0 ? (
                    <p>{t.noLogs}</p>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        {visibleGroups.map((group) => {
                            const log = group.latest;
                            const isOpen = openGroupKey === group.groupKey;

                            return (
                                <div
                                    key={group.groupKey}
                                    style={{
                                        ...ui.card,
                                        padding: "8px 10px",
                                        borderLeft: `4px solid ${getActionColor(log.action)}`,
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
                                                        background: getActionColor(log.action),
                                                    }}
                                                >
                                                    {getActionBadge(log.action)}
                                                </span>

                                                <span
                                                    style={{
                                                        fontSize: 14,
                                                        fontWeight: 700,
                                                        lineHeight: 1.2,
                                                        color: "#111827",
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

                                            <div
                                                style={{
                                                    marginTop: 4,
                                                    fontSize: 13,
                                                    color: "#4b5563",
                                                    wordBreak: "break-word",
                                                }}
                                            >
                                                {inventoryNoteMap[group.groupKey] || "-"}
                                            </div>
                                        </div>

                                        <div
                                            style={{
                                                textAlign: "right",
                                                flexShrink: 0,
                                                marginLeft: 10,
                                            }}
                                        >
                                            <div style={ui.metaText}>
                                                {log.created_at ? formatDateTime(log.created_at) : "-"}
                                            </div>
                                            <div style={ui.metaText}>
                                                {log.actor_name || "-"}
                                            </div>

                                            <button
                                                type="button"
                                                onClick={() =>
                                                    setOpenGroupKey(isOpen ? null : group.groupKey)
                                                }
                                                style={{
                                                    ...ui.subButton,
                                                    width: "auto",
                                                    minWidth: 72,
                                                    padding: "6px 10px",
                                                    marginTop: 6,
                                                    fontWeight: 700,
                                                }}
                                            >
                                                {isOpen ? t.close : t.detail}
                                            </button>
                                        </div>
                                    </div>

                                    {isOpen && (
                                        <div
                                            style={{
                                                marginTop: 10,
                                                paddingTop: 10,
                                                borderTop: "1px solid #eee",
                                                display: "flex",
                                                flexDirection: "column",
                                                gap: 8,
                                            }}
                                        >
                                            {group.logs.map((history) => {
                                                const changes = getLogChanges(history, lang);

                                                return (
                                                    <div
                                                        key={history.id}
                                                        style={{
                                                            display: "flex",
                                                            justifyContent: "space-between",
                                                            gap: 10,
                                                            padding: "8px 0",
                                                            borderBottom: "1px solid #f3f4f6",
                                                        }}
                                                    >
                                                        <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                                                            {changes.map((change, index) => (
                                                                <div
                                                                    key={`${history.id}-${index}`}
                                                                    style={{
                                                                        display: "flex",
                                                                        alignItems: "center",
                                                                        gap: 8,
                                                                        minWidth: 0,
                                                                    }}
                                                                >
                                                                    <span
                                                                        style={{
                                                                            ...ui.badgeMini,
                                                                            background: "#111827",
                                                                            flexShrink: 0,
                                                                        }}
                                                                    >
                                                                        {change.label}
                                                                    </span>

                                                                    <div
                                                                        style={{
                                                                            fontSize: 13,
                                                                            fontWeight: 700,
                                                                            wordBreak: "break-word",
                                                                            minWidth: 0,
                                                                        }}
                                                                    >
                                                                        {change.before ? (
                                                                            <>
                                                                                <span style={{ color: "#111827" }}>{change.before}</span>
                                                                                <span style={{ color: "#9ca3af" }}> → </span>
                                                                                <span style={{ color: change.color || "#111827" }}>{change.after}</span>
                                                                            </>
                                                                        ) : (
                                                                            <span style={{ color: change.color || "#111827" }}>{change.after}</span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>

                                                        <div
                                                            style={{
                                                                textAlign: "right",
                                                                flexShrink: 0,
                                                                fontSize: 12,
                                                                color: "#6b7280",
                                                                whiteSpace: "nowrap",
                                                                display: "flex",
                                                                flexDirection: "column",
                                                                alignItems: "flex-end",
                                                                gap: 6,
                                                            }}
                                                        >
                                                            <div>{history.created_at ? formatDateTime(history.created_at) : "-"}</div>
                                                            <div>{history.actor_name || "-"}</div>

                                                            {isMaster && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => handleDeleteSingleLog(history.id)}
                                                                    style={{
                                                                        ...ui.subButton,
                                                                        width: "auto",
                                                                        minWidth: 52,
                                                                        padding: "4px 8px",
                                                                        background: "crimson",
                                                                        color: "white",
                                                                        border: "1px solid crimson",
                                                                        fontSize: 12,
                                                                        fontWeight: 700,
                                                                    }}
                                                                >
                                                                    {t.delete}
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        })}

                        {groupedLogs.length > visibleCount && (
                            <div style={{ marginTop: 16 }}>
                                <button
                                    type="button"
                                    onClick={() => setVisibleCount((prev) => prev + 20)}
                                    style={{
                                        ...ui.subButton,
                                        width: "100%",
                                        padding: "10px 14px",
                                        fontWeight: 700,
                                    }}
                                >
                                    {`${t.loadMore} (${visibleGroups.length}/${groupedLogs.length})`}
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </Container>
    );
}