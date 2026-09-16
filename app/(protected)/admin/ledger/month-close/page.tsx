"use client";

import { useState } from "react";
import Link from "next/link";
import Container from "@/components/Container";
import MonthClosePanel from "../MonthClosePanel";

function previousBusinessMonth() {
  const current = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit",
  }).format(new Date());
  const [year, month] = current.split("-").map(Number);
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
}

export default function LedgerMonthClosePage() {
  const [month, setMonth] = useState(previousBusinessMonth);
  return (
    <Container>
      <main style={{ maxWidth: 720, margin: "0 auto" }}>
        <Link href="/admin/ledger">← 장부</Link>
        <h1>월마감 관리</h1>
        <label htmlFor="ledger-close-month">점검할 월</label>
        <input id="ledger-close-month" type="month" value={month}
          onChange={(event) => setMonth(event.target.value)}
          style={{ display: "block", marginTop: 8, marginBottom: 16 }} />
        {month ? <MonthClosePanel key={month} month={month} /> : null}
      </main>
    </Container>
  );
}
