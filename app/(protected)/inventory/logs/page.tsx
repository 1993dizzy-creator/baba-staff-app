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
    const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");
    const [partFilter, setPartFilter] = useState("all");
    const [openLogId, setOpenLogId] = useState<number | null>(null);
    const [visibleCount, setVisibleCount] = useState(20);
    const [selectedLogIds, setSelectedLogIds] = useState<number[]>([]);

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

    useEffect(() => {
        fetchLogs();
    }, []);

    useEffect(() => {
        setVisibleCount(20);
    }, [search, filterType, partFilter, sortOrder]);

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
        .sort((a, b) => {
            if (sortOrder === "desc") {
                return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
            } else {
                return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
            }
        });

    const visibleLogs = filteredLogs.slice(0, visibleCount);

    const formatDateTime = (value: string) => {
        const date = new Date(value);

        const yy = String(date.getFullYear()).slice(2);
        const mm = String(date.getMonth() + 1).padStart(2, "0");
        const dd = String(date.getDate()).padStart(2, "0");
        const hh = String(date.getHours()).padStart(2, "0");
        const min = String(date.getMinutes()).padStart(2, "0");

        return `${yy}.${mm}.${dd} ${hh}:${min}`;
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

    const handleDeleteSelectedLogs = async () => {
        if (!isMaster) return;

        if (selectedLogIds.length === 0) {
            alert("삭제할 로그를 선택해 주세요.");
            return;
        }

        const ok = confirm(`선택한 로그 ${selectedLogIds.length}개를 삭제할까요?`);
        if (!ok) return;

        const { error } = await supabase
            .from("inventory_logs")
            .delete()
            .in("id", selectedLogIds);

        if (error) {
            console.error(error);
            alert("로그 삭제에 실패했습니다.");
            return;
        }

        alert("선택한 로그를 삭제했습니다.");
        setSelectedLogIds([]);
        setOpenLogId(null);
        await fetchLogs();
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

                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: "1fr 1fr",
                            gap: 10,
                        }}
                    >
                        <select
                            value={sortOrder}
                            onChange={(e) => setSortOrder(e.target.value as "desc" | "asc")}
                            style={ui.input}
                        >
                            <option value="desc">{t.sortDesc}</option>
                            <option value="asc">{t.sortAsc}</option>
                        </select>

                        <button
                            onClick={() => {
                                setSearch("");
                                setFilterType("all");
                                setPartFilter("all");
                                setSortOrder("desc");
                            }}
                            style={{
                                ...ui.subButton,
                                padding: "12px 14px",
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

            {isMaster && (
                <div
                    style={{
                        ...ui.card,
                        padding: 12,
                        marginBottom: 16,
                        display: "flex",
                        gap: 8,
                        flexWrap: "wrap",
                        alignItems: "center",
                    }}
                >
                    <button
                        type="button"
                        onClick={() => setSelectedLogIds(visibleLogs.map((log) => log.id))}
                        style={{
                            ...ui.subButton,
                            width: "auto",
                            padding: "8px 12px",
                            fontWeight: 700,
                        }}
                    >
                        전체선택
                    </button>

                    <button
                        type="button"
                        onClick={() => setSelectedLogIds([])}
                        style={{
                            ...ui.subButton,
                            width: "auto",
                            padding: "8px 12px",
                            fontWeight: 700,
                        }}
                    >
                        전체해제
                    </button>

                    <button
                        type="button"
                        onClick={handleDeleteSelectedLogs}
                        style={{
                            ...ui.subButton,
                            width: "auto",
                            padding: "8px 12px",
                            fontWeight: 700,
                            background: "crimson",
                            color: "white",
                            border: "1px solid crimson",
                        }}
                    >
                        선택삭제
                    </button>

                    <span
                        style={{
                            ...ui.metaText,
                            fontWeight: 700,
                            marginLeft: "auto",
                        }}
                    >
                        선택됨: {selectedLogIds.length}
                    </span>
                </div>
            )}

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
                        {visibleLogs.map((log) => (
                            <div
                                key={log.id}
                                onClick={() => setOpenLogId(openLogId === log.id ? null : log.id)}
                                style={{
                                    ...ui.card,
                                    padding: "6px 10px",
                                    borderLeft: `4px solid ${getActionColor(log.action)}`,
                                    background: "#fff",
                                    cursor: "pointer",
                                }}
                            >
                                <div style={ui.cardRow}>

                                    {isMaster && (
                                        <div
                                            onClick={(e) => e.stopPropagation()}
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                marginRight: 8,
                                            }}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={selectedLogIds.includes(log.id)}
                                                onChange={(e) => {
                                                    const checked = e.target.checked;

                                                    setSelectedLogIds((prev) =>
                                                        checked
                                                            ? [...prev, log.id]
                                                            : prev.filter((id) => id !== log.id)
                                                    );
                                                }}
                                                style={{
                                                    width: 16,
                                                    height: 16,
                                                    cursor: "pointer",
                                                }}
                                            />
                                        </div>
                                    )}

                                    {/* LEFT */}
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
                                                {[
                                                    log.code ? `[${log.code}]` : "",
                                                    getDisplayLogItemName(log),
                                                ]
                                                    .filter(Boolean)
                                                    .join(" ")}
                                            </span>
                                        </div>

                                        <div style={ui.metaText}>
                                            {[
                                                getPartLabel(log.part || ""),
                                                getDisplayLogCategory(log),
                                            ].join(" · ")}
                                        </div>
                                    </div>

                                    {/* RIGHT */}
                                    <div
                                        style={{
                                            textAlign: "right",
                                            flexShrink: 0,
                                            marginLeft: 10,
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 8,
                                        }}
                                    >
                                        <div>
                                            {Number(log.change_quantity ?? 0) !== 0 ? (
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
                                                                log.action === "delete"
                                                                    ? "#999"
                                                                    : Number(log.change_quantity) > 0
                                                                        ? "green"
                                                                        : "crimson",
                                                        }}
                                                    >
                                                        {Number(log.change_quantity) > 0 ? "+" : ""}
                                                        {log.change_quantity}
                                                    </span>{" "}
                                                    <span style={{ color: "#111827" }}>
                                                        {log.unit || ""}
                                                    </span>
                                                </div>
                                            ) : null}

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

                                        <span
                                            style={{
                                                color: "#999",
                                                fontSize: 14,
                                                fontWeight: "bold",
                                                lineHeight: 1,
                                                width: 16,
                                                textAlign: "center",
                                            }}
                                        >
                                            {openLogId === log.id ? "▴" : "▾"}
                                        </span>
                                    </div>
                                </div>

                                {/* 펼침 영역 유지 */}
                                {openLogId === log.id && (
                                    <div
                                        style={{
                                            marginTop: 10,
                                            paddingTop: 10,
                                            borderTop: "1px solid #eee",
                                        }}
                                    >
                                        <div style={ui.detailGrid}>
                                            {Number(log.prev_quantity ?? 0) !== Number(log.new_quantity ?? 0) && (
                                                <>
                                                    <div style={ui.detailLabel}>{t.quantity}</div>
                                                    <div style={ui.detailValue}>
                                                        {(log.prev_quantity ?? 0)} →{" "}
                                                        <span
                                                            style={{
                                                                color:
                                                                    (log.new_quantity ?? 0) > (log.prev_quantity ?? 0)
                                                                        ? "green"
                                                                        : "crimson",
                                                                fontWeight: "bold",
                                                            }}
                                                        >
                                                            {log.new_quantity ?? 0}
                                                        </span>{" "}
                                                        {log.unit || ""}
                                                    </div>
                                                </>
                                            )}

                                            {Number(log.prev_purchase_price ?? 0) !== Number(log.new_purchase_price ?? 0) && (
                                                <>
                                                    <div style={ui.detailLabel}>{t.price}</div>
                                                    <div style={ui.detailValue}>
                                                        {log.prev_purchase_price !== null && log.prev_purchase_price !== undefined
                                                            ? Number(log.prev_purchase_price).toLocaleString()
                                                            : "-"} ₫
                                                        {" → "}
                                                        <span
                                                            style={{
                                                                color:
                                                                    (log.new_purchase_price ?? 0) > (log.prev_purchase_price ?? 0)
                                                                        ? "green"
                                                                        : "crimson",
                                                                fontWeight: "bold",
                                                            }}
                                                        >
                                                            {log.new_purchase_price !== null && log.new_purchase_price !== undefined
                                                                ? Number(log.new_purchase_price).toLocaleString()
                                                                : "-"} ₫
                                                        </span>
                                                    </div>
                                                </>
                                            )}

                                            <div style={ui.detailLabel}>{t.updatedAt}</div>
                                            <div style={ui.detailValue}>
                                                {log.created_at
                                                    ? `${formatDateTime(log.created_at)} · ${log.actor_name || "-"} (${log.actor_username || "-"})`
                                                    : "-"}
                                            </div>

                                            {(log.prev_note ?? "") !== (log.new_note ?? "") && (
                                                <>
                                                    <div style={ui.detailLabel}>{t.note}</div>
                                                    <div style={ui.detailValue}>
                                                        {log.prev_note || "-"} →{" "}
                                                        <span style={{ color: "royalblue", fontWeight: "bold" }}>
                                                            {log.new_note || "-"}
                                                        </span>
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}

                        {filteredLogs.length > visibleCount && (
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
                                    {t.loadMore
                                        ? `${t.loadMore} (${visibleLogs.length}/${filteredLogs.length})`
                                        : `더 보기 (${visibleLogs.length}/${filteredLogs.length})`}
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </Container>
    );
}