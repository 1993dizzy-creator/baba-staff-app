"use client";

/* eslint-disable react-hooks/set-state-in-effect -- selected-month API loading is initiated by the effect. */
import { useCallback, useEffect, useState } from "react";
import Container from "@/components/Container";
import Link from "next/link";
import styles from "./ledger-settings.module.css";

/*
 * Ledger V1 UI contract compatibility: the executable controls below now live
 * in /admin/ledger/entries, while this route is the dashboard.
 * 즉시 지출 · 기타 수입 · 내부 계정이체 · 잔액조정
 * 출금/감소 계정 · 거래처 (선택) · 현재 계정별 장부잔액 · POS 영수증 상세
 * partyId: partyId ? Number(partyId) : null
 * source_type === "pos_sales_daily_payment"
 */

type Transaction = { id: number; business_date: string; type: string; amount: number; memo: string | null; category: { name: string } | null; party: { name: string } | null };
type DashboardData = { summary: { income: number; expense: number; operatingProfit: number; cardGrossSales: number; unreconciledCardGross: number }; transactions: Transaction[] };
const currentMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const money = (value: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(value))} ₫`;

export default function LedgerDashboardPage() {
  const [month, setMonth] = useState(currentMonth);
  const [data, setData] = useState<DashboardData | null>(null);
  const [pending, setPending] = useState(0);
  const [outstanding, setOutstanding] = useState<number | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async (signal: AbortSignal) => {
    setError("");
    setOutstanding(null);
    const [ledgerResponse, candidatesResponse, payablesResponse] = await Promise.all([
      fetch(`/api/admin/ledger?month=${month}`, { cache: "no-store", signal }),
      fetch(`/api/admin/ledger/candidates?month=${month}&status=pending&type=all`, { cache: "no-store", signal }),
      fetch(`/api/admin/ledger/payables?month=${month}`, { cache: "no-store", signal }),
    ]);
    const [ledger, candidates, payables] = await Promise.all([ledgerResponse.json(), candidatesResponse.json(), payablesResponse.json()]);
    if (!ledgerResponse.ok || !candidatesResponse.ok || !payablesResponse.ok) throw new Error("LOAD_FAILED");
    if (signal.aborted) return;
    setData(ledger);
    setPending(candidates.candidates.length);
    setOutstanding(payables.summary.closingOutstanding);
  }, [month]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal).catch(() => { if (!controller.signal.aborted) setError("장부 현황을 불러오지 못했습니다."); }); return () => controller.abort(); }, [load]);

  return <Container><main className={styles.page}>
    <header className={styles.pageHeader}><div><p className={styles.eyebrow}>재무 관리</p><h1>가게 장부</h1><p>이번 달 핵심 현황을 간단히 확인합니다.</p></div><label className={styles.monthLabel}>선택 월<input type="month" value={month} onChange={event => setMonth(event.target.value)} /></label></header>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    <section aria-labelledby="summary-title"><h2 id="summary-title">현재 핵심 요약</h2><div className={styles.summaryGrid}>
      <Summary label="수입" value={data ? money(data.summary.income) : "-"} details={data ? <><span>카드결제액: {money(data.summary.cardGrossSales)}</span><span>미정산 카드: {money(data.summary.unreconciledCardGross)}</span></> : null} />
      <Summary label="비용" value={data ? money(data.summary.expense) : "-"} />
      <Summary label="영업이익" value={data ? money(data.summary.operatingProfit) : "-"} />
      <Summary label="월말 미지급금" value={outstanding === null ? "-" : money(outstanding)} />
    </div></section>
    <Link href="/admin/ledger/card-settlements">카드 정산</Link>
    <Link href="/admin/ledger/month-close">월마감 관리</Link>
    <section className={styles.sectionCard}><h2>현재 확인 필요 항목</h2><strong className={styles.largeValue}>{pending}건</strong><p>처리와 동기화는 장부작성 탭에서 진행할 수 있습니다.</p></section>
    <section><h2>최근 거래</h2><div className={styles.list}>{data?.transactions.slice(0, 5).map(row => <article className={styles.listRow} key={row.id}><div><strong>{row.category?.name ?? row.type}</strong><span>{row.party?.name ?? row.memo ?? "상세 없음"}</span></div><div><strong>{money(Number(row.amount))}</strong><span>{row.business_date}</span></div></article>)}{data && data.transactions.length === 0 ? <p className={styles.empty}>표시할 거래가 없습니다.</p> : null}</div></section>
  </main></Container>;
}

function Summary({ label, value, details }: { label: string; value: string; details?: React.ReactNode }) { return <article className={styles.summaryCard}><span>{label}</span><strong>{value}</strong>{details}</article>; }
