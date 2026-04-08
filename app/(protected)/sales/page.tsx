"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { useLanguage } from "@/lib/language-context";
import { salesText, commonText } from "@/lib/text";
import { ui } from "@/lib/styles/ui";
import Container from "@/components/Container";

export default function SalesPage() {
    const { lang } = useLanguage();

    const t = salesText[lang];
    const c = commonText[lang];

    const [date, setDate] = useState("");
    const [amount, setAmount] = useState("");
    const [note, setNote] = useState("");
    const [salesList, setSalesList] = useState<any[]>([]);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [filterDate, setFilterDate] = useState("");

    const filteredSalesList = filterDate
        ? salesList.filter((sale) => sale.sales_date === filterDate)
        : salesList;

    const totalAmount = filteredSalesList.reduce((sum, sale) => sum + sale.amount, 0);

    const monthlySummary = salesList.reduce((acc: Record<string, number>, sale) => {
        const month = sale.sales_date.slice(0, 7);

        if (!acc[month]) {
            acc[month] = 0;
        }

        acc[month] += sale.amount;
        return acc;
    }, {});

    const fetchSales = async () => {
        const { data, error } = await supabase
            .from("sales")
            .select("*")
            .order("sales_date", { ascending: false });

        if (error) {
            console.error(error);
            return;
        }

        setSalesList(data || []);
    };

    const handleDelete = async (id: number) => {
        const ok = confirm(t.confirmDelete);

        if (!ok) return;

        const { error } = await supabase.from("sales").delete().eq("id", id);

        if (error) {
            console.error(error);
            alert(t.deleteFail);
            return;
        }

        alert(t.deleteSuccess);
        await fetchSales();
    };

    const handleEdit = (sale: any) => {
        setEditingId(sale.id);
        setDate(sale.sales_date);
        setAmount(String(sale.amount));
        setNote(sale.note || "");
    };

    const resetForm = () => {
        setDate("");
        setAmount("");
        setNote("");
        setEditingId(null);
    };

    const handleSubmit = async () => {
        if (!date || !amount) {
            alert(t.requireDateAmount);
            return;
        }

        if (editingId) {
            const { error } = await supabase
                .from("sales")
                .update({
                    sales_date: date,
                    amount: Number(amount),
                    note: note,
                })
                .eq("id", editingId);

            if (error) {
                console.error(error);
                alert(t.editFail);
                return;
            }

            alert(t.editSuccess);
        } else {
            const { error } = await supabase.from("sales").insert([
                {
                    sales_date: date,
                    amount: Number(amount),
                    note: note,
                },
            ]);

            if (error) {
                console.error(error);
                alert(t.saveFail);
                return;
            }

            alert(t.saveSuccess);
        }

        await fetchSales();
        resetForm();
    };

    useEffect(() => {
        fetchSales();
    }, []);

    return (
        <Container>
            <h1 style={{ fontSize: 32, fontWeight: "bold", marginBottom: 20 }}>
                {t.title}
            </h1>

            <div
                style={{
                    ...ui.card,
                    padding: 20,
                    marginBottom: 30,
                }}
            >
                <h2 style={{ marginBottom: 16 }}>
                    {editingId ? t.formEdit : t.formAdd}
                </h2>

                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <input
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        style={ui.input}
                    />

                    <input
                        type="number"
                        placeholder={t.amountPlaceholder}
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        style={ui.input}
                    />

                    <input
                        type="text"
                        placeholder={t.notePlaceholder}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        style={ui.input}
                    />

                    <div style={{ display: "flex", gap: 10 }}>
                        <button
                            onClick={handleSubmit}
                            style={{
                                ...ui.button,
                                flex: 1,
                            }}
                        >
                            {editingId ? t.submitEdit : c.save}
                        </button>

                        {editingId && (
                            <button
                                onClick={resetForm}
                                style={{
                                    ...ui.button,
                                    flex: 1,
                                    background: "white",
                                    color: "black",
                                    border: "1px solid #d1d5db",
                                }}
                            >
                                {c.cancel}
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <div
                style={{
                    ...ui.card,
                    padding: 16,
                    marginBottom: 20,
                }}
            >
                <h2 style={{ marginBottom: 12 }}>{t.dateSearch}</h2>

                <input
                    type="date"
                    value={filterDate}
                    onChange={(e) => setFilterDate(e.target.value)}
                    style={ui.input}
                />
            </div>

            <div
                style={{
                    ...ui.card,
                    padding: 20,
                }}
            >
                <h2 style={{ marginBottom: 16 }}>{t.salesList}</h2>

                <div
                    style={{
                        marginBottom: 16,
                        padding: 12,
                        background: "#f5f5f5",
                        borderRadius: 10,
                        fontWeight: "bold",
                    }}
                >
                    {t.totalSales}: {totalAmount.toLocaleString()} VND
                </div>

                <div
                    style={{
                        ...ui.card,
                        padding: 16,
                        marginBottom: 20,
                        boxShadow: "none",
                    }}
                >
                    <h2 style={{ marginBottom: 12 }}>{t.monthlySummary}</h2>

                    {Object.keys(monthlySummary).length === 0 ? (
                        <p>{c.noData}</p>
                    ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            {Object.entries(monthlySummary)
                                .sort((a, b) => b[0].localeCompare(a[0]))
                                .map(([month, amount]) => (
                                    <div
                                        key={month}
                                        style={{
                                            padding: 12,
                                            border: "1px solid #eee",
                                            borderRadius: 10,
                                        }}
                                    >
                                        <div>{t.month}: {month}</div>
                                        <div>{t.sum}: {amount.toLocaleString()} VND</div>
                                    </div>
                                ))}
                        </div>
                    )}
                </div>

                {filteredSalesList.length === 0 ? (
                    <p>{c.noData}</p>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        {filteredSalesList.map((sale) => (
                            <div
                                key={sale.id}
                                style={{
                                    padding: 14,
                                    border: "1px solid #eee",
                                    borderRadius: 10,
                                }}
                            >
                                <div style={{ marginBottom: 6 }}>
                                    {t.date}: {sale.sales_date}
                                </div>
                                <div style={{ marginBottom: 6 }}>
                                    {t.amount}: {sale.amount.toLocaleString()} VND
                                </div>
                                <div style={{ marginBottom: 10 }}>
                                    {t.note}: {sale.note || "-"}
                                </div>

                                <div style={{ display: "flex", gap: 8 }}>
                                    <button
                                        onClick={() => handleEdit(sale)}
                                        style={{
                                            padding: "8px 12px",
                                            background: "royalblue",
                                            color: "white",
                                            border: "none",
                                            borderRadius: 8,
                                            cursor: "pointer",
                                        }}
                                    >
                                        {c.edit}
                                    </button>

                                    <button
                                        onClick={() => handleDelete(sale.id)}
                                        style={{
                                            padding: "8px 12px",
                                            background: "crimson",
                                            color: "white",
                                            border: "none",
                                            borderRadius: 8,
                                            cursor: "pointer",
                                        }}
                                    >
                                        {c.delete}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </Container>
    );
}