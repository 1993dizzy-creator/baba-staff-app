"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase/client";
import { useLanguage } from "@/lib/language-context";
import { inventoryText } from "@/lib/text";
import Container from "@/components/Container";
import { ui } from "@/lib/styles/ui";
import { getUser } from "@/lib/supabase/auth";

export default function InventoryPage() {
    const currentUser = getUser();
    const actorName = currentUser?.name || "";
    const actorUsername = currentUser?.username || "";
    const { lang } = useLanguage();
    const [itemName, setItemName] = useState("");
    const [quantity, setQuantity] = useState("");
    const [unit, setUnit] = useState("");
    const [note, setNote] = useState("");
    const [part, setPart] = useState("");
    const [category, setCategory] = useState("");
    const [purchasePrice, setPurchasePrice] = useState("");
    const [supplier, setSupplier] = useState("");
    const [lowStockThreshold, setLowStockThreshold] = useState("");
    const [code, setCode] = useState("");
    const [inventoryList, setInventoryList] = useState<any[]>([]);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [search, setSearch] = useState("");
    const [partFilter, setPartFilter] = useState("all");
    const [categoryFilter, setCategoryFilter] = useState("all");
    const [showLowStockOnly, setShowLowStockOnly] = useState(false);
    const [recentLogs, setRecentLogs] = useState<any[]>([]);
    const [openItemId, setOpenItemId] = useState<number | null>(null);
    const [isFormOpen, setIsFormOpen] = useState(true);
    const [visibleCount, setVisibleCount] = useState(20);
    const categoryRef = useRef<HTMLInputElement>(null);
    const itemNameRef = useRef<HTMLInputElement>(null);
    const supplierRef = useRef<HTMLInputElement>(null);
    const priceRef = useRef<HTMLInputElement>(null);
    const unitRef = useRef<HTMLInputElement>(null);
    const quantityRef = useRef<HTMLInputElement>(null);
    const noteRef = useRef<HTMLInputElement>(null);
    const formRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const lowStockThresholdRef = useRef<HTMLInputElement>(null);

    const t = inventoryText[lang];

    const getDisplayItemName = (item: any) => {
        return lang === "vi"
            ? item.item_name_vi || item.item_name || "-"
            : item.item_name || item.item_name_vi || "-";
    };

    const getDisplayCategory = (item: any) => {
        return lang === "vi"
            ? item.category_vi || item.category || "-"
            : item.category || item.category_vi || "-";
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

    const categoryTabs = [
        "all",
        ...Array.from(
            new Set(
                inventoryList
                    .filter((item) => partFilter === "all" || item.part === partFilter)
                    .map((item) => getDisplayCategory(item))
                    .filter((value) => value && value !== "-")
            )
        ),
    ];

    const lowStockItems = inventoryList.filter(
        (item) => Number(item.quantity) <= Number(item.low_stock_threshold ?? 0)
    );

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

    const handleQuickChange = async (item: any, diff: number) => {
        const currentQty = Number(item.quantity || 0);
        const nextQty = currentQty + diff;

        if (nextQty < 0) {
            alert(t.quantityCannotBeNegative);
            return;
        }

        const { error: updateError } = await supabase
            .from("inventory")
            .update({
                quantity: nextQty,
                updated_at: new Date().toISOString(),
                updated_by_name: actorName,
                updated_by_username: actorUsername,
            })
            .eq("id", item.id);

        if (updateError) {
            console.error(updateError);
            alert(t.quickChangeFail);
            return;
        }

        const { error: logError } = await supabase.from("inventory_logs").insert([
            {
                item_id: item.id,
                item_name: item.item_name,
                item_name_vi: item.item_name_vi ?? null,
                action: "update",
                part: item.part,
                category: item.category,
                category_vi: item.category_vi ?? null,
                prev_quantity: currentQty,
                new_quantity: nextQty,
                change_quantity: diff,
                prev_purchase_price: item.purchase_price ?? null,
                new_purchase_price: item.purchase_price ?? null,
                prev_note: item.note ?? null,
                new_note: item.note ?? null,
                unit: item.unit,
                code: item.code,
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
    };

    const handleDelete = async (id: number) => {
        const ok = confirm(t.deleteConfirm);

        if (!ok) return;

        const targetItem = inventoryList.find((item) => item.id === id);

        if (!targetItem) {
            alert(t.deleteTargetNotFound);
            return;
        }

        const { error: logError } = await supabase.from("inventory_logs").insert([
            {
                item_id: id,
                item_name: targetItem.item_name,
                item_name_vi: targetItem.item_name_vi ?? null,
                action: "delete",

                part: targetItem.part,
                category: targetItem.category,
                category_vi: targetItem.category_vi ?? null,

                prev_quantity: targetItem.quantity,
                new_quantity: 0,
                change_quantity: -Number(targetItem.quantity),

                prev_purchase_price: targetItem.purchase_price ?? null,
                new_purchase_price: null,

                prev_note: targetItem.note ?? null,
                new_note: null,
                unit: targetItem.unit,
                code: targetItem.code,
                actor_name: actorName,
                actor_username: actorUsername,
            },
        ]);

        if (logError) {
            console.error(logError);
            alert(t.deleteLogSaveFail);
            return;
        }

        const { error: deleteError } = await supabase
            .from("inventory")
            .delete()
            .eq("id", id);

        if (deleteError) {
            console.error(deleteError);
            alert(t.deleteFail);
            return;
        }

        alert(t.deleteSuccess);
        await fetchInventory();
        await fetchRecentLogs();
    };

    const handleEdit = (item: any) => {
        setIsFormOpen(true);
        setEditingId(item.id);
        setOpenItemId(item.id);
        setItemName(lang === "vi" ? item.item_name_vi || "" : item.item_name || "");
        setCategory(lang === "vi" ? item.category_vi || "" : item.category || "");;
        setQuantity(String(item.quantity));
        setUnit(item.unit);
        setNote(item.note || "");
        setPart(item.part || "");
        setPurchasePrice(
            item.purchase_price !== null && item.purchase_price !== undefined
                ? Number(item.purchase_price).toLocaleString()
                : ""
        );
        setSupplier(item.supplier || "");
        setCode(item.code || "");
        setTimeout(() => {
            formRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
            });
        }, 0);
        setLowStockThreshold(String(item.low_stock_threshold ?? 1));
    };

    const formatNumber = (value: string) => {
        const number = value.replace(/,/g, "");
        if (!number) return "";
        return Number(number).toLocaleString();
    };

    const parsePrice = (value: string) => {
        const raw = value.replace(/,/g, "");
        return raw ? Number(raw) : null;
    };

    const normalizeText = (value: string) => {
        return value.replace(/\s+/g, " ").trim();
    };

    const resetForm = () => {
        setItemName("");
        setQuantity("");
        setUnit("");
        setNote("");
        setPart("");
        setCategory("");
        setPurchasePrice("");
        setSupplier("");
        setCode("");
        setLowStockThreshold("");
        setEditingId(null);
    };

    const handleSubmit = async () => {
        const normalizedItemName = normalizeText(itemName);
        const normalizedCategory = normalizeText(category);
        const normalizedSupplier = normalizeText(supplier);
        const normalizedUnit = normalizeText(unit);
        const normalizedNote = normalizeText(note);
        const normalizedCode = normalizeText(code);
        if (!normalizedItemName || !quantity || !normalizedUnit) {
            alert(t.requiredFields);
            return;
        }

        if (editingId) {
            const targetItem = inventoryList.find((item) => item.id === editingId);

            const updatePayload =
                lang === "ko"
                    ? {
                        item_name: normalizedItemName,
                        category: normalizedCategory,
                        quantity: Number(quantity),
                        unit: normalizedUnit,
                        note: normalizedNote,
                        part: part,
                        purchase_price: parsePrice(purchasePrice),
                        supplier: normalizedSupplier,
                        code: normalizedCode,
                        low_stock_threshold: lowStockThreshold ? Number(lowStockThreshold) : 1,
                        updated_at: new Date().toISOString(),
                        updated_by_name: actorName,
                        updated_by_username: actorUsername,
                    }
                    : {
                        item_name_vi: normalizedItemName,
                        category_vi: normalizedCategory,
                        quantity: Number(quantity),
                        unit: normalizedUnit,
                        note: normalizedNote,
                        part: part,
                        purchase_price: parsePrice(purchasePrice),
                        supplier: normalizedSupplier,
                        code: normalizedCode,
                        low_stock_threshold: lowStockThreshold ? Number(lowStockThreshold) : 1,
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
                    item_name: lang === "ko" ? itemName : targetItem?.item_name ?? null,
                    item_name_vi: lang === "vi" ? itemName : targetItem?.item_name_vi ?? null,
                    action: "update",
                    part: part,
                    category: lang === "ko" ? category : targetItem?.category ?? null,
                    category_vi: lang === "vi" ? category : targetItem?.category_vi ?? null,
                    prev_quantity: targetItem?.quantity ?? 0,
                    new_quantity: Number(quantity),
                    change_quantity: Number(quantity) - (targetItem?.quantity ?? 0),

                    prev_purchase_price: targetItem?.purchase_price ?? null,
                    new_purchase_price: parsePrice(purchasePrice),
                    prev_note: targetItem?.note ?? null,
                    new_note: note,
                    unit: unit,
                    code: code,
                    actor_name: actorName,
                    actor_username: actorUsername,
                },
            ]);

            alert(t.editSuccess);
        } else {
            const insertPayload =
                lang === "ko"
                    ? {
                        item_name: normalizedItemName,
                        category: normalizedCategory,
                        item_name_vi: "",
                        category_vi: "",
                        quantity: Number(quantity),
                        unit: normalizedUnit,
                        note: normalizedNote,
                        part: part,
                        purchase_price: parsePrice(purchasePrice),
                        supplier: normalizedSupplier,
                        code: normalizedCode,
                        low_stock_threshold: lowStockThreshold ? Number(lowStockThreshold) : 1,
                        updated_at: new Date().toISOString(),
                        updated_by_name: actorName,
                        updated_by_username: actorUsername,
                    }
                    : {
                        item_name: "",
                        category: "",
                        item_name_vi: normalizedItemName,
                        category_vi: normalizedCategory,
                        quantity: Number(quantity),
                        unit: normalizedUnit,
                        note: normalizedNote,
                        part: part,
                        purchase_price: parsePrice(purchasePrice),
                        supplier: normalizedSupplier,
                        code: normalizedCode,
                        low_stock_threshold: lowStockThreshold ? Number(lowStockThreshold) : 1,
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
                    unit: insertedData.unit,
                    code: insertedData.code ?? null,
                    actor_name: actorName,
                    actor_username: actorUsername,
                },
            ]);

            alert(t.saveSuccess);
        }

        await fetchInventory();
        await fetchRecentLogs();

        resetForm();
        categoryRef.current?.focus();
        setIsFormOpen(false);
    };

    const handleKeyDown = (
        e: React.KeyboardEvent,
        nextRef: React.RefObject<HTMLInputElement | HTMLSelectElement | null>
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
    }, []);

    useEffect(() => {
        const savedPartFilter = localStorage.getItem("inventory_part_filter");
        if (savedPartFilter) {
            setPartFilter(savedPartFilter);
        }
    }, []);

    useEffect(() => {
        localStorage.setItem("inventory_part_filter", partFilter);
    }, [partFilter]);

    useEffect(() => {
        setVisibleCount(20);
    }, [search, partFilter, showLowStockOnly]);

    useEffect(() => {
        setCategoryFilter("all");
    }, [partFilter]);

    const lowStockCount = inventoryList.filter(
        (item) => Number(item.quantity) <= Number(item.low_stock_threshold ?? 1)
    ).length;

    const filteredInventory = inventoryList
        .filter((item) => {
            const keyword = search.toLowerCase();

            const displayItemName = getDisplayItemName(item).toLowerCase();
            const displayCategory = getDisplayCategory(item);

            const matchSearch =
                displayItemName.includes(keyword) ||
                displayCategory.toLowerCase().includes(keyword);

            const matchPart =
                partFilter === "all" || item.part === partFilter;

            const matchCategory =
                categoryFilter === "all" || displayCategory === categoryFilter;

            const matchLowStock =
                !showLowStockOnly ||
                Number(item.quantity) <= Number(item.low_stock_threshold ?? 1);

            return matchSearch && matchPart && matchCategory && matchLowStock;
        })
        .sort(
            (a, b) =>
                new Date(b.updated_at || b.created_at).getTime() -
                new Date(a.updated_at || a.created_at).getTime()
        );

    const visibleInventory = filteredInventory.slice(0, visibleCount);

    return (
        <Container>

            {/* 재고부족 알림창 */}
            {lowStockItems.length > 0 && (
                <div
                    onClick={() => {
                        setSearch("");
                        setPartFilter("all");
                        setCategoryFilter("all");
                        setShowLowStockOnly(true);

                        setTimeout(() => {
                            listRef.current?.scrollIntoView({
                                behavior: "smooth",
                                block: "start",
                            });
                        }, 0);
                    }}
                    style={{
                        marginBottom: 16,
                        padding: "12px 16px",
                        borderRadius: 10,
                        background: "#fff5f5",
                        border: "1px solid #f3caca",
                        color: "crimson",
                        fontWeight: 600,
                        cursor: "pointer",
                    }}
                >
                    {t.lowStockBanner(lowStockItems.length)}
                </div>
            )}

            <h1 style={ui.pageTitle}>{t.title}</h1>

            {/* 재고 로그 보기 */}
            <div style={{ marginBottom: 20 }}>
                <Link
                    href="/inventory/logs"
                    style={{
                        ...ui.button,
                        width: "100%",
                    }}
                >
                    {t.viewLogs}
                </Link>
            </div>


            {/* 최근 변경 로그 */}
            <div
                style={{
                    ...ui.card,
                    padding: 20,
                    marginBottom: 30,
                }}
            >
                <h2 style={ui.sectionTitle}>{t.recentLogs}</h2>

                {recentLogs.length === 0 ? (
                    <p>{t.noLogs}</p>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {recentLogs.map((log) => (
                            <div
                                key={log.id}
                                style={{
                                    ...ui.card,
                                    padding: "6px 10px",
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
                                                {log.action === "create" ? "NEW" : log.action === "delete" ? "DEL" : "UP"}
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
                                                {log.change_quantity ?? 0}
                                            </span>{" "}
                                            <span style={{ color: "#111827" }}>
                                                {log.unit || ""}
                                            </span>
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


            {/* 입력폼 접기 */}

            <button
                onClick={() => setIsFormOpen(!isFormOpen)}
                style={{
                    ...ui.subButton,
                    width: "100%",
                    marginBottom: 12,
                    padding: "8px 12px",
                }}
            >
                {isFormOpen ? t.closeInventoryForm : t.openInventoryForm}
            </button>

            {/* 재고입력 */}

            {isFormOpen && (
                <div
                    ref={formRef}
                    style={{
                        ...ui.card,
                        padding: 20,
                        marginBottom: 30,
                    }}
                >
                    <h2 style={ui.sectionTitle}>{t.inputTitle}</h2>

                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        <select
                            value={part}
                            onChange={(e) => setPart(e.target.value)}
                            style={ui.input}
                        >
                            <option value="">{t.selectPart}</option>
                            <option value="kitchen">{t.kitchen}</option>
                            <option value="hall">{t.hall}</option>
                            <option value="bar">{t.bar}</option>
                            <option value="etc">{t.etc}</option>
                        </select>

                        <input
                            type="text"
                            placeholder={t.categoryPlaceholder}
                            value={category}
                            onChange={(e) => setCategory(e.target.value)}
                            style={ui.input}
                            ref={categoryRef}
                            onKeyDown={(e) => handleKeyDown(e, itemNameRef)}
                        />

                        <input
                            type="text"
                            placeholder={t.codePlaceholder}
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                            style={ui.input}
                        />

                        <input
                            type="text"
                            placeholder={t.itemNamePlaceholder}
                            value={itemName}
                            onChange={(e) => setItemName(e.target.value)}
                            style={ui.input}
                            ref={itemNameRef}
                            onKeyDown={(e) => handleKeyDown(e, supplierRef)}
                        />

                        <input
                            type="text"
                            placeholder={t.supplierPlaceholder}
                            value={supplier}
                            onChange={(e) => setSupplier(e.target.value)}
                            style={ui.input}
                            ref={supplierRef}
                            onKeyDown={(e) => handleKeyDown(e, priceRef)}
                        />

                        <input
                            type="text"
                            placeholder={t.purchasePricePlaceholder}
                            value={purchasePrice}
                            onChange={(e) => {
                                const raw = e.target.value.replace(/[^0-9]/g, "");
                                setPurchasePrice(formatNumber(raw));
                            }}
                            style={ui.input}
                            ref={priceRef}
                            onKeyDown={(e) => handleKeyDown(e, unitRef)}
                        />

                        <input
                            type="text"
                            placeholder={t.unitPlaceholder}
                            value={unit}
                            onChange={(e) => setUnit(e.target.value)}
                            style={ui.input}
                            ref={unitRef}
                            onKeyDown={(e) => handleKeyDown(e, quantityRef)}
                        />

                        <input
                            type="number"
                            placeholder={t.quantityPlaceholder}
                            value={quantity}
                            onChange={(e) => setQuantity(e.target.value)}
                            style={ui.input}
                            ref={quantityRef}
                            onKeyDown={(e) => handleKeyDown(e, lowStockThresholdRef)}
                        />

                        <input
                            type="number"
                            placeholder={t.lowStockThresholdPlaceholder}
                            value={lowStockThreshold}
                            onChange={(e) => setLowStockThreshold(e.target.value)}
                            style={ui.input}
                            ref={lowStockThresholdRef}
                            onKeyDown={(e) => handleKeyDown(e, noteRef)}
                        />

                        <input
                            type="text"
                            placeholder={t.notePlaceholder}
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            style={ui.input}
                            ref={noteRef}
                            onKeyDown={(e) => handleKeyDown(e)}
                        />

                        <button
                            onClick={handleSubmit}
                            style={ui.button}
                        >
                            {editingId ? t.editSave : t.save}
                        </button>

                        {editingId && (
                            <button
                                onClick={() => {
                                    resetForm();
                                }}
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


            {/* 재고목록 */}
            <div
                ref={listRef}
                style={{
                    ...ui.card,
                    padding: 20,
                }}
            >
                <h2 style={ui.sectionTitle}>{t.listTitle}</h2>

                <div
                    style={ui.filterBox}
                >


                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(5, 1fr)",
                            gap: 8,
                            marginBottom: 16,
                        }}
                    >
                        {[
                            { value: "all", label: t.allPart },
                            { value: "kitchen", label: t.kitchen },
                            { value: "hall", label: t.hall },
                            { value: "bar", label: t.bar },
                            { value: "etc", label: t.etc },
                        ].map((partOption) => {
                            const active = partFilter === partOption.value;

                            return (
                                <button
                                    key={partOption.value}
                                    type="button"
                                    onClick={() => setPartFilter(partOption.value)}
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
                                    {partOption.label}
                                </button>
                            );
                        })}
                    </div>

                    <input
                        type="text"
                        placeholder={t.searchPlaceholder}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        style={{
                            ...ui.input,
                            marginBottom: 16,
                        }}
                    />

                    <div
                        style={{
                            display: "flex",
                            gap: 8,
                            overflowX: "auto",
                            paddingBottom: 6,
                            marginBottom: 16,
                        }}
                    >
                        {categoryTabs.map((cat) => {
                            const active = categoryFilter === cat;

                            return (
                                <button
                                    key={cat}
                                    type="button"
                                    onClick={() => setCategoryFilter(cat)}
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
                                    {cat === "all" ? t.allPart : cat}
                                </button>
                            );
                        })}
                    </div>


                    <div
                        style={{
                            display: "flex",
                            gap: 8,
                            marginTop: 12,
                            paddingTop: 2,
                        }}
                    >
                        <button
                            onClick={() => setShowLowStockOnly(!showLowStockOnly)}
                            style={{
                                flex: 1,
                                padding: "10px 14px",
                                background: showLowStockOnly ? "crimson" : "#f5f5f5",
                                color: showLowStockOnly ? "white" : "black",
                                border: showLowStockOnly ? "1px solid crimson" : "1px solid #ddd",
                                borderRadius: 8,
                                cursor: "pointer",
                                fontWeight: 600,
                            }}
                        >
                            {showLowStockOnly ? t.viewAllItems : t.viewLowStockOnly}
                        </button>

                        <button
                            onClick={() => {
                                setSearch("");
                                setPartFilter("all");
                                setCategoryFilter("all");
                                setShowLowStockOnly(false);
                            }}
                            style={{
                                ...ui.subButton,
                                flex: 1,
                                padding: "10px 14px",
                            }}
                        >
                            {t.reset}
                        </button>
                    </div>
                </div>

                {filteredInventory.length === 0 ? (
                    <p>{t.noData}</p>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        {visibleInventory.map((item) => (
                            <div
                                key={item.id}
                                style={{
                                    ...ui.card,
                                    padding: "8px 10px",
                                    borderLeft:
                                        Number(item.quantity) <= Number(item.low_stock_threshold ?? 1)
                                            ? "4px solid crimson"
                                            : "4px solid #d1d5db",
                                    background: "#fff",
                                }}
                            >
                                <div
                                    onClick={() => setOpenItemId(openItemId === item.id ? null : item.id)}
                                    style={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                        alignItems: "center",
                                        cursor: "pointer",
                                        padding: "2px 0",
                                        minHeight: 32,
                                        marginBottom: openItemId === item.id ? 10 : 0,
                                    }}
                                >
                                    <div style={{ minWidth: 0 }}>
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
                                            fontSize: 14,
                                            flexShrink: 0,
                                            marginLeft: 10,
                                        }}
                                    >
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleQuickChange(item, -1);
                                            }}
                                            style={{
                                                ...ui.subButton,
                                                width: "auto",
                                                minWidth: 30,
                                                padding: "4px 8px",
                                                lineHeight: 1,
                                            }}
                                        >
                                            -
                                        </button>

                                        <div
                                            style={{
                                                minWidth: 58,
                                                textAlign: "center",
                                                lineHeight: 1.2,
                                                whiteSpace: "nowrap",
                                            }}
                                        >
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

                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleQuickChange(item, 1);
                                            }}
                                            style={{
                                                ...ui.subButton,
                                                width: "auto",
                                                minWidth: 30,
                                                padding: "4px 8px",
                                                lineHeight: 1,
                                            }}
                                        >
                                            +
                                        </button>

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
                                            {openItemId === item.id ? "▴" : "▾"}
                                        </span>
                                    </div>
                                </div>

                                {openItemId === item.id && (
                                    <div
                                        style={{
                                            borderTop: "1px solid #eee",
                                            paddingTop: 10,
                                            marginTop: 2,
                                        }}
                                    >
                                        <div style={ui.detailGrid}>
                                            <div style={ui.detailLabel}>{t.supplier}</div>
                                            <div style={ui.detailValue}>{item.supplier || "-"}</div>

                                            <div style={ui.detailLabel}>{t.purchasePrice}</div>
                                            <div style={ui.detailValue}>
                                                {item.purchase_price !== null && item.purchase_price !== undefined
                                                    ? Number(item.purchase_price).toLocaleString() + " ₫"
                                                    : "-"}
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
                                                gap: 8,
                                                marginTop: 12,
                                                paddingTop: 2,
                                                justifyContent: "flex-end",
                                            }}
                                        >
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleEdit(item);
                                                }}
                                                style={{
                                                    ...ui.subButton,
                                                    width: "auto",
                                                    minWidth: 64,
                                                    padding: "8px 14px",
                                                    background: "royalblue",
                                                    color: "white",
                                                    border: "1px solid royalblue",
                                                    fontSize: 14,
                                                    fontWeight: 700,
                                                }}
                                            >
                                                {t.edit}
                                            </button>

                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleDelete(item.id);
                                                }}
                                                style={{
                                                    ...ui.subButton,
                                                    width: "auto",
                                                    minWidth: 64,
                                                    padding: "8px 14px",
                                                    background: "crimson",
                                                    color: "white",
                                                    border: "1px solid crimson",
                                                    fontSize: 14,
                                                    fontWeight: 700,
                                                }}
                                            >
                                                {t.delete}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}
                        {filteredInventory.length > visibleCount && (
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
                                        ? `${t.loadMore} (${visibleInventory.length}/${filteredInventory.length})`
                                        : `더 보기 (${visibleInventory.length}/${filteredInventory.length})`}
                                </button>
                            </div>
                        )}
                    </div>

                )}
            </div>
        </Container>
    );
}