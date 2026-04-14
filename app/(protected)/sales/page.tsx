"use client";

import { useEffect, useMemo, useState } from "react";
import Container from "@/components/Container";
import { ui } from "@/lib/styles/ui";
import { useLanguage } from "@/lib/language-context";
import { supabase } from "@/lib/supabase/client";
import { salesText } from "@/lib/text";
import { getUser } from "@/lib/supabase/auth";

type PaymentMethod = "cash" | "transfer" | "card";

type DraftItem = {
    item_code: string;
    item_name_ko: string;
    item_name_vi: string;
    unit_price: number;
    qty: number;
    vat_rate: number;
    category_type: "food" | "drink" | "other";
    use_inventory_deduction: boolean;
    deduct_quantity_per_sale: number;
};

type CatalogItem = {
    item_code: string;
    item_name_ko: string;
    item_name_vi: string;
    group_code: string;
    category_type: "food" | "drink" | "other";
    vat_rate: number;
    unit_price: number;
    use_inventory_deduction: boolean;
    deduct_quantity_per_sale: number;
    is_active: boolean;
    sort_order: number;
};

type SalesOrderItemRow = {
    id: number;
    item_code: string;
    item_name_snapshot: string;
    qty: number;
    unit_price: number;
    line_subtotal: number;
    line_tax: number;
    line_total: number;
};

type SalesOrderRow = {
    id: number;
    sales_date: string;
    started_at: string;
    ended_at: string;
    table_no: string;
    payment_method: PaymentMethod;
    subtotal_amount: number;
    tax_amount: number;
    total_amount: number;
    actor_name: string;
    note: string | null;
    sales_order_items?: SalesOrderItemRow[];
};

const TABLE_OPTIONS = Array.from({ length: 18 }, (_, i) => `ban${i + 1}`);

const PAYMENT_OPTIONS: { value: PaymentMethod; ko: string; vi: string }[] = [
    { value: "cash", ko: "현금", vi: "Tiền mặt" },
    { value: "transfer", ko: "이체", vi: "Chuyển khoản" },
    { value: "card", ko: "카드", vi: "Thẻ" },
];

const GROUP_OPTIONS = [
    "CB",
    "A",
    "B",
    "C",
    "D",
    "E",
    "F",
    "G",
    "H",
    "I",
    "J",
    "K",
    "L",
    "M",
    "N",
    "O",
    "P",
    "Q",
    "R",
    "S",
    "T",
    "U",
    "V",
    "W",
    "X",
    "Y",
    "ETC",
];

export default function SalesPage() {
    const currentUser = getUser();
    const actorName = currentUser?.name || "Admin";
    const actorUsername = currentUser?.username || "";
    const { lang } = useLanguage();
    const t = salesText[lang];

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(
        now.getMinutes()
    ).padStart(2, "0")}`;

    const [catalog, setCatalog] = useState<CatalogItem[]>([]);
    const [orderList, setOrderList] = useState<SalesOrderRow[]>([]);

    const [salesDate, setSalesDate] = useState(today);
    const [startedAt, setStartedAt] = useState(currentTime);
    const [endedAt, setEndedAt] = useState(currentTime);
    const [tableNo, setTableNo] = useState("ban1");
    const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
    const [selectedGroup, setSelectedGroup] = useState("M");
    const [items, setItems] = useState<DraftItem[]>([]);
    const [note, setNote] = useState("");
    const [isFormOpen, setIsFormOpen] = useState(true);

    const [search, setSearch] = useState("");
    const [paymentFilter, setPaymentFilter] = useState<"all" | PaymentMethod>("all");
    const [openOrderId, setOpenOrderId] = useState<number | null>(null);

    const fetchCatalog = async () => {
        const { data, error } = await supabase
            .from("sales_menu_catalog")
            .select("*")
            .eq("is_active", true)
            .order("group_code", { ascending: true })
            .order("sort_order", { ascending: true });

        if (error) {
            console.error("catalog error:", error);
            return;
        }

        setCatalog((data as CatalogItem[]) || []);
    };

    const fetchOrders = async () => {
        const { data, error } = await supabase
            .from("sales_orders")
            .select(
                `
                *,
                sales_order_items (
                    id,
                    item_code,
                    item_name_snapshot,
                    qty,
                    unit_price,
                    line_subtotal,
                    line_tax,
                    line_total
                )
            `
            )
            .order("created_at", { ascending: false });

        if (error) {
            console.error("orders fetch error:", error);
            return;
        }

        setOrderList((data as SalesOrderRow[]) || []);
    };

    useEffect(() => {
        fetchCatalog();
        fetchOrders();
    }, []);

    const filteredCatalog = useMemo(() => {
        return catalog.filter((item) => item.group_code === selectedGroup);
    }, [catalog, selectedGroup]);

    const groupedOrderItems = useMemo(() => {
        const map = new Map<string, DraftItem>();

        for (const item of items) {
            const found = map.get(item.item_code);

            if (found) {
                found.qty += item.qty;
            } else {
                map.set(item.item_code, { ...item });
            }
        }

        return Array.from(map.values());
    }, [items]);

    const subtotalAmount = groupedOrderItems.reduce(
        (sum, item) => sum + item.unit_price * item.qty,
        0
    );

    const taxAmount = groupedOrderItems.reduce((sum, item) => {
        const lineSubtotal = item.unit_price * item.qty;
        return sum + (lineSubtotal * item.vat_rate) / 100;
    }, 0);

    const totalAmount = subtotalAmount + taxAmount;

    const filteredOrders = orderList.filter((order) => {
        const keyword = search.trim().toLowerCase();

        const matchSearch =
            !keyword ||
            order.table_no?.toLowerCase().includes(keyword) ||
            (order.sales_order_items || []).some(
                (item) =>
                    item.item_code?.toLowerCase().includes(keyword) ||
                    item.item_name_snapshot?.toLowerCase().includes(keyword)
            );

        const matchPayment =
            paymentFilter === "all" || order.payment_method === paymentFilter;

        return matchSearch && matchPayment;
    });

    const recentOrders = orderList.slice(0, 3);

    const addItem = (item: CatalogItem) => {
        setItems((prev) => [
            ...prev,
            {
                item_code: item.item_code,
                item_name_ko: item.item_name_ko,
                item_name_vi: item.item_name_vi,
                unit_price: Number(item.unit_price || 0),
                qty: 1,
                vat_rate: Number(item.vat_rate || 10),
                category_type: item.category_type,
                use_inventory_deduction: !!item.use_inventory_deduction,
                deduct_quantity_per_sale: Number(item.deduct_quantity_per_sale || 1),
            },
        ]);
    };

    const changeQty = (itemCode: string, diff: number) => {
        setItems((prev) =>
            prev
                .map((item) =>
                    item.item_code === itemCode
                        ? { ...item, qty: item.qty + diff }
                        : item
                )
                .filter((item) => item.qty > 0)
        );
    };

    const removeItem = (itemCode: string) => {
        setItems((prev) => prev.filter((item) => item.item_code !== itemCode));
    };

    const resetDraft = () => {
        const resetNow = new Date();
        const resetToday = resetNow.toISOString().slice(0, 10);
        const resetTime = `${String(resetNow.getHours()).padStart(2, "0")}:${String(
            resetNow.getMinutes()
        ).padStart(2, "0")}`;

        setSalesDate(resetToday);
        setStartedAt(resetTime);
        setEndedAt(resetTime);
        setTableNo("ban1");
        setPaymentMethod("cash");
        setSelectedGroup("M");
        setItems([]);
        setNote("");
    };

    const getDisplayName = (item: {
        item_name_ko?: string;
        item_name_vi?: string;
        item_name_snapshot?: string;
    }) => {
        if ("item_name_snapshot" in item && item.item_name_snapshot) {
            return item.item_name_snapshot;
        }

        return lang === "vi"
            ? item.item_name_vi || item.item_name_ko || "-"
            : item.item_name_ko || item.item_name_vi || "-";
    };

    const formatDateTimeShort = (value?: string | null) => {
        if (!value) return "-";

        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return value;

        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        return `${hh}:${mm}`;
    };

    const handleSave = async () => {
        if (groupedOrderItems.length === 0) {
            alert(lang === "vi" ? "Chưa có món" : "품목 없음");
            return;
        }

        try {
            const startedAtValue = `${salesDate}T${startedAt}:00+07:00`;
            const endedAtValue = `${salesDate}T${endedAt}:00+07:00`;

            const { data: order, error: orderError } = await supabase
                .from("sales_orders")
                .insert({
                    sales_date: salesDate,
                    started_at: startedAtValue,
                    ended_at: endedAtValue,
                    table_no: tableNo,
                    payment_method: paymentMethod,
                    subtotal_amount: subtotalAmount,
                    tax_amount: taxAmount,
                    total_amount: totalAmount,
                    actor_name: actorName,
                    actor_username: actorUsername,
                    note: note,
                })
                .select()
                .single();

            if (orderError) throw orderError;

            const orderItemsPayload = groupedOrderItems.map((item) => {
                const lineSubtotal = item.qty * item.unit_price;
                const lineTax = (lineSubtotal * item.vat_rate) / 100;
                const lineTotal = lineSubtotal + lineTax;

                return {
                    order_id: order.id,
                    item_code: item.item_code,
                    item_name_snapshot: item.item_name_ko || item.item_name_vi,
                    group_code: item.item_code.split("-")[0].replace(/[0-9]/g, ""),
                    category_type: item.category_type,
                    vat_rate: item.vat_rate,
                    qty: item.qty,
                    unit_price: item.unit_price,
                    line_subtotal: lineSubtotal,
                    line_tax: lineTax,
                    line_total: lineTotal,
                    use_inventory_deduction: item.use_inventory_deduction,
                    deduct_quantity_per_sale: item.deduct_quantity_per_sale,
                    is_manual: false,
                };
            });

            const { error: itemsError } = await supabase
                .from("sales_order_items")
                .insert(orderItemsPayload);

            if (itemsError) throw itemsError;

            for (const item of groupedOrderItems) {
                if (!item.use_inventory_deduction) continue;

                const { data: inv, error: invError } = await supabase
                    .from("inventory")
                    .select(
                        `
                        id,
                        quantity,
                        unit,
                        part,
                        category,
                        category_vi,
                        purchase_price,
                        note
                    `
                    )
                    .eq("code", item.item_code)
                    .single();

                if (invError || !inv) {
                    console.warn("inventory match skip:", item.item_code, invError);
                    continue;
                }

                const change = Number(item.qty) * Number(item.deduct_quantity_per_sale || 1);
                const prevQty = Number(inv.quantity || 0);
                const newQty = prevQty - change;

                if (newQty < 0) {
                    console.warn("재고 부족:", item.item_code);
                    continue;
                }

                const { error: updateInvError } = await supabase
                    .from("inventory")
                    .update({
                        quantity: newQty,
                        updated_by_name: actorName,
                        updated_by_username: actorUsername,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", inv.id);

                if (updateInvError) {
                    console.error("inventory update error:", updateInvError);
                    continue;
                }

                const { error: logError } = await supabase.from("inventory_logs").insert({
                    item_id: inv.id,
                    item_name: item.item_name_ko || null,
                    item_name_vi: item.item_name_vi || null,
                    action: "update",
                    part: inv.part ?? null,
                    category: inv.category ?? null,
                    category_vi: inv.category_vi ?? null,
                    prev_quantity: prevQty,
                    new_quantity: newQty,
                    change_quantity: -change,
                    prev_purchase_price: inv.purchase_price ?? null,
                    new_purchase_price: inv.purchase_price ?? null,
                    prev_note: inv.note ?? null,
                    new_note: inv.note ?? null,
                    unit: inv.unit ?? null,
                    code: item.item_code,
                    actor_name: actorName,
                    actor_username: actorUsername,
                });

                if (logError) {
                    console.error("inventory log error:", logError);
                }
            }

            alert(lang === "vi" ? "Lưu thành công" : "저장 완료");
            resetDraft();
            await fetchOrders();
        } catch (err: any) {
            console.error("save error:", err);
            console.error("save error message:", err?.message);
            console.error("save error details:", err?.details);
            console.error("save error hint:", err?.hint);
            alert(lang === "vi" ? "Lưu thất bại" : "저장 실패");
        }
    };

    return (
        <Container>
            <h1 style={ui.pageTitle}>{t.title}</h1>

            <div
                style={{
                    ...ui.card,
                    padding: 20,
                    marginBottom: 30,
                }}
            >
                <h2 style={ui.sectionTitle}>{t.recentOrders}</h2>

                {recentOrders.length === 0 ? (
                    <p>{t.noRecentOrders}</p>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {recentOrders.map((order) => (
                            <div
                                key={order.id}
                                style={{
                                    ...ui.card,
                                    padding: "8px 10px",
                                    borderLeft: "4px solid royalblue",
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
                                                    background: "royalblue",
                                                }}
                                            >
                                                NEW
                                            </span>

                                            <span
                                                style={{
                                                    fontSize: 14,
                                                    fontWeight: 700,
                                                    color: "#111827",
                                                }}
                                            >
                                                {order.table_no}
                                            </span>
                                        </div>

                                        <div style={ui.metaText}>
                                            {[
                                                formatDateTimeShort(order.ended_at),
                                                order.payment_method,
                                                order.actor_name || "-",
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
                                            }}
                                        >
                                            {Number(order.total_amount || 0).toLocaleString()} ₫
                                        </div>
                                        <div style={ui.metaText}>
                                            {(order.sales_order_items || []).length} items
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <button
                onClick={() => setIsFormOpen(!isFormOpen)}
                style={{
                    ...ui.subButton,
                    width: "100%",
                    marginBottom: 12,
                    padding: "8px 12px",
                }}
            >
                {isFormOpen ? t.closeForm : t.openForm}
            </button>

            {isFormOpen && (
                <div
                    style={{
                        ...ui.card,
                        padding: 20,
                        marginBottom: 30,
                    }}
                >
                    <h2 style={ui.sectionTitle}>{t.inputTitle}</h2>

                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        <input
                            type="date"
                            value={salesDate}
                            onChange={(e) => setSalesDate(e.target.value)}
                            style={ui.input}
                        />

                        <div
                            style={{
                                display: "grid",
                                gridTemplateColumns: "1fr 1fr",
                                gap: 8,
                            }}
                        >
                            <input
                                type="time"
                                value={startedAt}
                                onChange={(e) => setStartedAt(e.target.value)}
                                style={ui.input}
                            />
                            <input
                                type="time"
                                value={endedAt}
                                onChange={(e) => setEndedAt(e.target.value)}
                                style={ui.input}
                            />
                        </div>

                        <div
                            style={{
                                display: "grid",
                                gridTemplateColumns: "repeat(3, 1fr)",
                                gap: 8,
                            }}
                        >
                            {TABLE_OPTIONS.map((table) => {
                                const active = tableNo === table;

                                return (
                                    <button
                                        key={table}
                                        type="button"
                                        onClick={() => setTableNo(table)}
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
                                        {table}
                                    </button>
                                );
                            })}
                        </div>

                        <div
                            style={{
                                display: "grid",
                                gridTemplateColumns: "repeat(3, 1fr)",
                                gap: 8,
                            }}
                        >
                            {PAYMENT_OPTIONS.map((option) => {
                                const active = paymentMethod === option.value;

                                return (
                                    <button
                                        key={option.value}
                                        type="button"
                                        onClick={() => setPaymentMethod(option.value)}
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
                                        {lang === "vi" ? option.vi : option.ko}
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
                            }}
                        >
                            {GROUP_OPTIONS.map((group) => {
                                const active = selectedGroup === group;

                                return (
                                    <button
                                        key={group}
                                        type="button"
                                        onClick={() => setSelectedGroup(group)}
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
                                        {group}
                                    </button>
                                );
                            })}
                        </div>

                        <div
                            style={{
                                display: "grid",
                                gridTemplateColumns: "repeat(2, 1fr)",
                                gap: 8,
                            }}
                        >
                            {filteredCatalog.map((item) => (
                                <button
                                    key={item.item_code}
                                    type="button"
                                    onClick={() => addItem(item)}
                                    style={{
                                        ...ui.subButton,
                                        padding: "10px 12px",
                                        textAlign: "left",
                                    }}
                                >
                                    <div
                                        style={{
                                            display: "flex",
                                            flexDirection: "column",
                                            gap: 4,
                                        }}
                                    >
                                        <span style={{ fontSize: 13, fontWeight: 700 }}>
                                            [{item.item_code}] {getDisplayName(item)}
                                        </span>
                                        <span style={ui.metaText}>
                                            {Number(item.unit_price || 0).toLocaleString()} ₫
                                        </span>
                                    </div>
                                </button>
                            ))}

                            <button
                                type="button"
                                style={{
                                    ...ui.button,
                                    padding: "10px 12px",
                                }}
                            >
                                {t.customInput}
                            </button>
                        </div>

                        <div
                            style={{
                                ...ui.card,
                                padding: 14,
                                boxShadow: "none",
                            }}
                        >
                            <h3
                                style={{
                                    marginBottom: 12,
                                    fontSize: 16,
                                    fontWeight: "bold",
                                }}
                            >
                                {t.currentOrder}
                            </h3>

                            {groupedOrderItems.length === 0 ? (
                                <div style={ui.metaText}>{t.noItems}</div>
                            ) : (
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    {groupedOrderItems.map((item) => (
                                        <div
                                            key={item.item_code}
                                            style={{
                                                ...ui.card,
                                                padding: "8px 10px",
                                                background: "#fff",
                                                boxShadow: "none",
                                            }}
                                        >
                                            <div style={ui.cardRow}>
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <div
                                                        style={{
                                                            fontSize: 14,
                                                            fontWeight: 700,
                                                            color: "#111827",
                                                            wordBreak: "break-word",
                                                        }}
                                                    >
                                                        [{item.item_code}] {getDisplayName(item)}
                                                    </div>
                                                    <div style={ui.metaText}>
                                                        {Number(item.unit_price || 0).toLocaleString()} ₫ · VAT{" "}
                                                        {item.vat_rate}%
                                                    </div>
                                                </div>

                                                <div
                                                    style={{
                                                        display: "flex",
                                                        alignItems: "center",
                                                        gap: 8,
                                                        flexShrink: 0,
                                                        marginLeft: 10,
                                                    }}
                                                >
                                                    <button
                                                        type="button"
                                                        onClick={() => changeQty(item.item_code, -1)}
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
                                                            minWidth: 24,
                                                            textAlign: "center",
                                                            fontWeight: 700,
                                                        }}
                                                    >
                                                        {item.qty}
                                                    </div>

                                                    <button
                                                        type="button"
                                                        onClick={() => changeQty(item.item_code, 1)}
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

                                                    <button
                                                        type="button"
                                                        onClick={() => removeItem(item.item_code)}
                                                        style={{
                                                            ...ui.subButton,
                                                            width: "auto",
                                                            minWidth: 54,
                                                            padding: "6px 10px",
                                                            background: "crimson",
                                                            color: "white",
                                                            border: "1px solid crimson",
                                                        }}
                                                    >
                                                        삭제
                                                    </button>
                                                </div>
                                            </div>

                                            <div
                                                style={{
                                                    marginTop: 8,
                                                    textAlign: "right",
                                                    fontSize: 14,
                                                    fontWeight: 700,
                                                }}
                                            >
                                                {(item.qty * item.unit_price).toLocaleString()} ₫
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            <div
                                style={{
                                    borderTop: "1px solid #eee",
                                    marginTop: 12,
                                    paddingTop: 12,
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: 6,
                                }}
                            >
                                <div style={ui.cardRow}>
                                    <span style={ui.detailLabel}>{t.subtotal}</span>
                                    <span style={ui.detailValue}>
                                        {subtotalAmount.toLocaleString()} ₫
                                    </span>
                                </div>
                                <div style={ui.cardRow}>
                                    <span style={ui.detailLabel}>{t.tax}</span>
                                    <span style={ui.detailValue}>
                                        {taxAmount.toLocaleString()} ₫
                                    </span>
                                </div>
                                <div style={ui.cardRow}>
                                    <span
                                        style={{
                                            fontSize: 15,
                                            fontWeight: 700,
                                            color: "#111827",
                                        }}
                                    >
                                        {t.total}
                                    </span>
                                    <span
                                        style={{
                                            fontSize: 18,
                                            fontWeight: 700,
                                            color: "#111827",
                                        }}
                                    >
                                        {totalAmount.toLocaleString()} ₫
                                    </span>
                                </div>
                            </div>
                        </div>

                        <input
                            type="text"
                            placeholder={lang === "vi" ? "Ghi chú" : "메모"}
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            style={ui.input}
                        />

                        <div
                            style={{
                                display: "grid",
                                gridTemplateColumns: "1fr 1fr",
                                gap: 8,
                            }}
                        >
                            <button type="button" style={ui.button} onClick={handleSave}>
                                {t.save}
                            </button>

                            <button type="button" onClick={resetDraft} style={ui.subButton}>
                                {t.reset}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div
                style={{
                    ...ui.card,
                    padding: 20,
                }}
            >
                <h2 style={ui.sectionTitle}>{t.orderList}</h2>

                <div style={ui.filterBox}>
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
                            gridTemplateColumns: "repeat(4, 1fr)",
                            gap: 8,
                        }}
                    >
                        <button
                            type="button"
                            onClick={() => setPaymentFilter("all")}
                            style={{
                                padding: "10px 12px",
                                borderRadius: 8,
                                border:
                                    paymentFilter === "all"
                                        ? "1px solid #111827"
                                        : "1px solid #d1d5db",
                                background: paymentFilter === "all" ? "#111827" : "#f9fafb",
                                color: paymentFilter === "all" ? "white" : "#111827",
                                fontWeight: 700,
                                fontSize: 14,
                                cursor: "pointer",
                                whiteSpace: "nowrap",
                            }}
                        >
                            {t.all}
                        </button>

                        {PAYMENT_OPTIONS.map((option) => {
                            const active = paymentFilter === option.value;

                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => setPaymentFilter(option.value)}
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
                                    {lang === "vi" ? option.vi : option.ko}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {filteredOrders.length === 0 ? (
                    <p>{lang === "vi" ? "Không có dữ liệu" : "데이터 없음"}</p>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        {filteredOrders.map((order) => (
                            <div
                                key={order.id}
                                style={{
                                    ...ui.card,
                                    padding: "8px 10px",
                                    borderLeft: "4px solid #d1d5db",
                                    background: "#fff",
                                }}
                            >
                                <div
                                    onClick={() =>
                                        setOpenOrderId(openOrderId === order.id ? null : order.id)
                                    }
                                    style={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                        alignItems: "center",
                                        cursor: "pointer",
                                        padding: "2px 0",
                                        minHeight: 32,
                                        marginBottom: openOrderId === order.id ? 10 : 0,
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
                                                }}
                                            >
                                                {order.table_no}
                                            </span>
                                        </div>

                                        <div style={ui.metaText}>
                                            {[
                                                order.sales_date,
                                                `${formatDateTimeShort(order.started_at)}~${formatDateTimeShort(
                                                    order.ended_at
                                                )}`,
                                                order.payment_method,
                                            ].join(" · ")}
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
                                        <div
                                            style={{
                                                textAlign: "right",
                                                lineHeight: 1.2,
                                                whiteSpace: "nowrap",
                                            }}
                                        >
                                            <div
                                                style={{
                                                    fontSize: 14,
                                                    fontWeight: 700,
                                                    color: "#111827",
                                                }}
                                            >
                                                {Number(order.total_amount || 0).toLocaleString()} ₫
                                            </div>
                                            <div style={ui.metaText}>{order.actor_name || "-"}</div>
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
                                            {openOrderId === order.id ? "▴" : "▾"}
                                        </span>
                                    </div>
                                </div>

                                {openOrderId === order.id && (
                                    <div
                                        style={{
                                            borderTop: "1px solid #eee",
                                            paddingTop: 10,
                                            marginTop: 2,
                                        }}
                                    >
                                        <div style={ui.detailGrid}>
                                            <div style={ui.detailLabel}>{lang === "vi" ? "Bàn" : "테이블"}</div>
                                            <div style={ui.detailValue}>{order.table_no}</div>

                                            <div style={ui.detailLabel}>{lang === "vi" ? "Thanh toán" : "결제"}</div>
                                            <div style={ui.detailValue}>{order.payment_method}</div>

                                            <div style={ui.detailLabel}>{lang === "vi" ? "Cung cấp" : "공급가"}</div>
                                            <div style={ui.detailValue}>
                                                {Number(order.subtotal_amount || 0).toLocaleString()} ₫
                                            </div>

                                            <div style={ui.detailLabel}>{lang === "vi" ? "Thuế" : "세금"}</div>
                                            <div style={ui.detailValue}>
                                                {Number(order.tax_amount || 0).toLocaleString()} ₫
                                            </div>

                                            <div style={ui.detailLabel}>{lang === "vi" ? "Tổng" : "총액"}</div>
                                            <div style={ui.detailValue}>
                                                {Number(order.total_amount || 0).toLocaleString()} ₫
                                            </div>

                                            <div style={ui.detailLabel}>{lang === "vi" ? "Người nhập" : "입력자"}</div>
                                            <div style={ui.detailValue}>{order.actor_name || "-"}</div>

                                            <div style={ui.detailLabel}>{lang === "vi" ? "Ghi chú" : "메모"}</div>
                                            <div style={ui.detailValue}>{order.note || "-"}</div>
                                        </div>

                                        <div
                                            style={{
                                                marginTop: 12,
                                                paddingTop: 12,
                                                borderTop: "1px solid #eee",
                                            }}
                                        >
                                            <div
                                                style={{
                                                    marginBottom: 8,
                                                    fontSize: 13,
                                                    fontWeight: 700,
                                                }}
                                            >
                                                {lang === "vi" ? "Chi tiết món" : "품목 상세"}
                                            </div>

                                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                                {(order.sales_order_items || []).map((item, idx) => (
                                                    <div
                                                        key={`${order.id}-${idx}`}
                                                        style={{
                                                            display: "flex",
                                                            justifyContent: "space-between",
                                                            gap: 10,
                                                            fontSize: 13,
                                                        }}
                                                    >
                                                        <div style={{ color: "#111827" }}>
                                                            [{item.item_code}] {item.item_name_snapshot} × {item.qty}
                                                        </div>
                                                        <div style={{ color: "#111827", fontWeight: 700 }}>
                                                            {Number(item.line_total || 0).toLocaleString()} ₫
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>

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
                                                type="button"
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
                                                {lang === "vi" ? "Sửa" : "수정"}
                                            </button>

                                            <button
                                                type="button"
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
                                                {lang === "vi" ? "Xóa" : "삭제"}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </Container>
    );
}