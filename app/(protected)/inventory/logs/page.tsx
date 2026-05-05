"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/lib/language-context";
import { PART_META } from "@/lib/common/parts";
import { commonText, inventoryText } from "@/lib/text";
import Container from "@/components/Container";
import { ui } from "@/lib/styles/ui";
import { getUser } from "@/lib/supabase/auth";
import InventoryLogGroupCard from "@/components/InventoryLogGroupCard";
import SubNav from "@/components/SubNav";
import { usePathname } from "next/navigation";
import { getInventoryTabs } from "@/lib/navigation/inventory-tabs";
import { getPartLabel } from "@/lib/common/part-label";


export default function InventoryLogsPage() {
    const [logs, setLogs] = useState<any[]>([]);
    const [filterType, setFilterType] = useState<"all" | "create" | "update" | "delete">("all");
    const [search, setSearch] = useState("");
    const [partFilter, setPartFilter] = useState("all");
    const [openGroupKey, setOpenGroupKey] = useState<string | null>(null);
    const [inventoryNoteMap, setInventoryNoteMap] = useState<Record<string, string>>({});

    const fetchLogs = async () => {
        const res = await fetch("/api/inventory/logs?mode=logs", {
            cache: "no-store",
        });

        const result = await res.json();

        if (!res.ok || !result.ok) {
            console.error(result);
            return;
        }

        setLogs(result.data || []);
    };

    const handleDeleteSingleLog = async (logId: number) => {
        if (!isMaster) return;

        const ok = confirm(c.deleteConfirm);

        if (!ok) return;

        const res = await fetch("/api/inventory/logs", {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                logId,
                actorUsername: currentUser?.username || "",
            }),
        });

        const result = await res.json();

        if (!res.ok || !result.ok) {
            console.error(result);

            if (res.status === 403) {
                alert(c.noPermission);
                return;
            }

            alert(c.deleteFail);
            return;
        }

        alert(c.deleteSuccess);
        await fetchLogs();
    };

    const fetchInventoryNotes = async () => {
        const res = await fetch("/api/inventory/logs?mode=notes", {
            cache: "no-store",
        });

        const result = await res.json();

        if (!res.ok || !result.ok) {
            console.error(result);
            return;
        }

        const nextMap: Record<string, string> = {};

        (result.data || []).forEach((item: any) => {
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


    const currentUser = getUser();
    const isMaster = currentUser?.role === "master";

    const { lang } = useLanguage();
    const t = inventoryText[lang];
    const c = commonText[lang];

    const getActionFilterButtonStyle = (active: boolean, activeColor: string) => {
        return {
            width: "100%",
            padding: "8px 10px",
            borderRadius: 8,
            border: active ? `1px solid ${activeColor}` : "1px solid #d1d5db",
            background: active ? activeColor : "#f9fafb",
            color: active ? "#fff" : "#111827",
            fontWeight: 700,
            fontSize: 13,
            cursor: "pointer",
            lineHeight: 1.25,
        };
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
            const keyword = search.trim().toLowerCase();

            const matchType = filterType === "all" || log.action === filterType;

            const displayItemName = getDisplayLogItemName(log).toLowerCase();
            const displayCategory = getDisplayLogCategory(log).toLowerCase();
            const displayCode = String(log.code || "").toLowerCase();

            const matchSearch =
                !keyword ||
                displayItemName.includes(keyword) ||
                displayCategory.includes(keyword) ||
                displayCode.includes(keyword);

            const matchPart =
                partFilter === "all" || log.part === partFilter;

            return matchType && matchSearch && matchPart;
        })
        .sort(
            (a, b) =>
                new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );

    const groupedLogsMap: Record<string, any[]> = filteredLogs.reduce(
        (acc: Record<string, any[]>, log) => {
            const key = getGroupKey(log);

            if (!acc[key]) {
                acc[key] = [];
            }

            acc[key].push(log);
            return acc;
        },
        {}
    );

    const groupedLogs = Object.entries(groupedLogsMap).map(
        ([groupKey, items]: [string, any[]]) => {
            const sortedItems = [...items].sort(
                (a, b) =>
                    new Date(b.created_at).getTime() -
                    new Date(a.created_at).getTime()
            );

            const latest = sortedItems[0];

            return {
                groupKey,
                latest,
                logs: sortedItems,
            };
        }
    );

    const visibleGroups = groupedLogs;

    type ChangeFieldType = "number" | "price" | "text";

    type ChangeFieldConfig = {
        label: string;
        type: ChangeFieldType;
    };

    const changeFieldConfig = {
        quantity: {
            label: t.quantity,
            type: "number",
        },
        purchase_price: {
            label: t.purchasePrice,
            type: "price",
        },
        note: {
            label: c.note,
            type: "text",
        },
        supplier: {
            label: t.supplier,
            type: "text",
        },
        code: {
            label: t.code,
            type: "text",
        },
        unit: {
            label: t.unit,
            type: "text",
        },
        category: {
            label: t.category,
            type: "text",
        },
        part: {
            label: t.part,
            type: "text",
        },
        low_stock_threshold: {
            label: t.lowStockThreshold,
            type: "number",
        },
    } satisfies Record<string, ChangeFieldConfig>;

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
                    label: c.create,
                    after: t.createDone,
                    color: "#111827",
                },
            ];
        }

        if (log.action === "delete") {
            return [
                {
                    label: c.delete,
                    after: c.deleteSuccess,
                    color: "#6b7280",
                },
            ];
        }

        (Object.keys(changeFieldConfig) as Array<keyof typeof changeFieldConfig>).forEach((field) => {
            const config = changeFieldConfig[field];

            const prev = log[`prev_${String(field)}`];
            const next = log[`new_${String(field)}`];

            const label = config.label;

            let before = "";
            let after = "";
            let color = "#111827";

            if (config.type === "number") {
                const prevNum = Number(prev ?? 0);
                const nextNum = Number(next ?? 0);

                if (prevNum === nextNum) return;

                before = `${prevNum}`;
                after = `${nextNum}${log.unit ? ` ${log.unit}` : ""}`;

                color =
                    nextNum > prevNum
                        ? "seagreen"
                        : nextNum < prevNum
                            ? "crimson"
                            : "#111827";
            }

            if (config.type === "price") {
                const prevNum = prev !== null && prev !== undefined ? Number(prev) : null;
                const nextNum = next !== null && next !== undefined ? Number(next) : null;

                if (prevNum === nextNum) return;

                before =
                    prevNum !== null
                        ? prevNum.toLocaleString() + " ₫"
                        : "-";

                after =
                    nextNum !== null
                        ? nextNum.toLocaleString() + " ₫"
                        : "-";

                color = "#2563eb";
            }

            if (config.type === "text") {
                const prevText = String(prev ?? "").trim();
                const nextText = String(next ?? "").trim();

                if (prevText === nextText) return;

                before = prevText || "-";
                after = nextText || "-";
                color = "#2563eb";
            }

            changes.push({ label, before, after, color });
        });

        if (changes.length === 0) {
            return [
                {
                    label: c.edit,
                    after: c.noChanges,
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

            {/* 필터 카드 */}
            <div
                style={{
                    ...ui.card,
                    padding: 16,
                    marginBottom: 20,
                }}
            >
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
                            { value: "all", label: c.all },
                            { value: "create", label: c.create },
                            { value: "update", label: c.edit },
                            { value: "delete", label: c.delete },
                        ].map((option) => {
                            const active = filterType === option.value;

                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    onClick={() =>
                                        setFilterType(option.value as "all" | "create" | "update" | "delete")
                                    }
                                    style={getActionFilterButtonStyle(
                                        active,
                                        option.value === "create"
                                            ? "seagreen"
                                            : option.value === "update"
                                                ? "royalblue"
                                                : option.value === "delete"
                                                    ? "crimson"
                                                    : "#111827"
                                    )}
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
                            { value: "all", label: c.all },
                            { value: "kitchen", label: c.kitchen },
                            { value: "hall", label: c.hall },
                            { value: "bar", label: c.bar },
                            { value: "etc", label: c.etc },
                        ].map((option) => {
                            const active = partFilter === option.value;

                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => setPartFilter(option.value)}
                                    style={{
                                        padding: "8px 10px",
                                        borderRadius: 8,
                                        border:
                                            option.value !== "all" && active
                                                ? `1px solid ${PART_META[option.value as keyof typeof PART_META].color}`
                                                : "1px solid #d1d5db",
                                        background:
                                            option.value !== "all" && active
                                                ? PART_META[option.value as keyof typeof PART_META].color
                                                : active
                                                    ? "#111827"
                                                    : "#f9fafb",
                                        color: active ? "white" : "#111827",
                                        fontWeight: 700,
                                        fontSize: 13,
                                        cursor: "pointer",
                                        whiteSpace: "nowrap",
                                    }}
                                >
                                    {option.value !== "all"
                                        ? `${PART_META[option.value as keyof typeof PART_META].emoji} ${option.label}`
                                        : option.label}
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
                    <p>{c.noLogs}</p>
                ) : (
                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                            maxHeight: 560,
                            overflowY: "auto",
                            paddingRight: 4,
                        }}
                    >
                        {visibleGroups.map((group) => {
                            const log = group.latest;
                            const isOpen = openGroupKey === group.groupKey;

                            return (
                                <InventoryLogGroupCard
                                    key={group.groupKey}
                                    group={group}
                                    isOpen={isOpen}
                                    lang={lang}
                                    noteText={inventoryNoteMap[group.groupKey] || "-"}
                                    partLabel={getPartLabel(log.part || "", t)}
                                    itemName={getDisplayLogItemName(log)}
                                    categoryName={getDisplayLogCategory(log)}
                                    detailLabel={c.detail}
                                    closeLabel={c.close}
                                    deleteLabel={c.delete}
                                    isMaster={isMaster}
                                    onToggle={() =>
                                        setOpenGroupKey(isOpen ? null : group.groupKey)
                                    }
                                    onDeleteSingleLog={handleDeleteSingleLog}
                                    getActionBadge={getActionBadge}
                                    getActionColor={getActionColor}
                                    formatDateTime={formatDateTime}
                                    getLogChanges={getLogChanges}
                                />
                            );
                        })}


                    </div>
                )}
            </div>
        </Container>
    );
}