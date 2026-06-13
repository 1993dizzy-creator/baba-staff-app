"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { getBusinessDate } from "@/lib/common/business-time";
import { useLanguage } from "@/lib/language-context";
import { ui } from "@/lib/styles/ui";
import { getUser } from "@/lib/supabase/auth";
import { commonText, salesText } from "@/lib/text";

const salesTabs = [
  { href: "/admin/sales", key: "daily" },
  { href: "/admin/sales/receipts", key: "receipts" },
  { href: "/admin/sales/monthly", key: "monthly" },
] as const;

type SalesMonthlyText =
  (typeof salesText)[keyof typeof salesText]["monthly"];
type SalesCommonText = (typeof salesText)[keyof typeof salesText]["common"];
type CommonText = (typeof commonText)[keyof typeof commonText];
type SalesMonthlyViewText = SalesCommonText &
  SalesMonthlyText &
  Pick<
    CommonText,
    "noData" | "loading" | "error" | "loadFailed" | "cash" | "transfer" | "card" | "totalTax" | "vat"
  > & {
    other: CommonText["etc"];
    weekdays: CommonText["calendarWeekdays"];
  };

const SALES_UI_EMOJIS = {
  monthly: "\u{1F4C5}",
  totalSales: "\u{1F4B0}",
  receipts: "\u{1F9FE}",
  averageReceiptAmount: "\u{1F9EE}",
  paymentSummary: "\u{1F4B3}",
  taxSummary: "\u{1F9FE}",
  dailySales: "\u{1F4CA}",
  menuSales: "\u{1F37D}\u{FE0F}",
  taxSaving: "\u{1F4B8}",
  amountDifference: "\u2194\uFE0F",
} as const;

function withEmoji(emoji: string, label: string) {
  return `${emoji} ${label}`;
}

type PaymentSummary = {
  cashAmount: number;
  transferAmount: number;
  cardAmount: number;
  otherAmount: number;
  paymentTotalAmount: number;
};

type TaxSummary = {
  totalTaxAmount: number;
  taxSavingAmount: number;
  amountDifferenceAmount: number;
  taxByRate: {
    taxRate: number;
    taxAmount: number;
    lineCount: number;
  }[];
};

type MonthlyDay = {
  businessDate: string;
  receiptCount: number;
  salesAmount?: number;
  totalFinalAmount: number;
  paymentTotalAmount: number;
  cashAmount: number;
  transferAmount: number;
  cardAmount: number;
  otherAmount: number;
  taxAmount: number;
  taxSavingAmount: number;
  amountDifferenceAmount: number;
};

type MenuSalesOption = {
  key: string;
  optionName: string;
  quantity: number;
  amount: number;
};

type CategoryGroupType = "food" | "drink" | "uncategorized";
type MenuSalesGroupKey = "all" | CategoryGroupType;

type MenuSalesItem = {
  key: string;
  itemId: string | null;
  itemCode: string | null;
  itemName: string;
  categoryName: string | null;
  groupType: CategoryGroupType;
  quantity: number;
  amount: number;
  receiptCount: number;
  optionAmount: number;
  options: MenuSalesOption[];
};

type MenuSalesCategory = {
  key: string;
  name: string | null;
  groupType: CategoryGroupType;
  quantity: number;
  amount: number;
  itemCount: number;
};

type MenuSalesGroup = {
  key: MenuSalesGroupKey;
  name: string;
  quantity: number;
  amount: number;
  itemCount: number;
};

type MenuSales = {
  sortDefault: "quantity";
  totalItemAmount: number;
  unlinkedOptionAmount: number;
  unlinkedOptionCount: number;
  groups: MenuSalesGroup[];
  categories: MenuSalesCategory[];
  items: MenuSalesItem[];
};

type SalesMonthlyResponse = {
  ok: boolean;
  month?: string;
  error?: string;
  summary?: {
    totalSales: number;
    receiptCount: number;
    totalReceiptCount: number;
    canceledReceiptCount: number;
    averageReceiptAmount: number;
  };
  paymentSummary?: PaymentSummary;
  taxSummary?: TaxSummary;
  menuSales?: MenuSales;
  days?: MonthlyDay[];
};

type DetailTab = "daily" | "menu";
type MenuSalesSort = "quantity" | "amount";
type MenuSalesDirection = "desc" | "asc";

function formatVnd(value?: number) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function formatNumber(value?: number) {
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 2,
  }).format(value || 0);
}

function getWeekdayInfo(
  dateKey: string,
  labels: CommonText["calendarWeekdays"]
) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const dayIndex = date.getDay();

  return {
    label: labels[dayIndex] || "",
    tone: dayIndex === 0 ? "sun" : dayIndex === 6 ? "sat" : "weekday",
  };
}

function getWeekdayStyle(tone: string) {
  if (tone === "sun") return sundayTextStyle;
  if (tone === "sat") return saturdayTextStyle;
  return weekdayTextStyle;
}

function getCurrentMonth() {
  return getBusinessDate().slice(0, 7);
}

function isValidBusinessDate(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function getMonthStartDate(month: string) {
  return `${month}-01`;
}

function getInitialMonth(searchParams: ReturnType<typeof useSearchParams>) {
  const queryMonth = searchParams.get("month");
  if (queryMonth) return queryMonth;

  const sharedBusinessDate = searchParams.get("businessDate");
  if (isValidBusinessDate(sharedBusinessDate)) {
    return sharedBusinessDate.slice(0, 7);
  }

  return getCurrentMonth();
}

function shiftMonth(month: string, diff: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + diff, 1));
  return date.toISOString().slice(0, 7);
}

function getDailyFinalAmount(day: MonthlyDay) {
  const paymentTotal = Number(day.paymentTotalAmount || 0);
  if (paymentTotal > 0) return paymentTotal;

  const totalFinal = Number(day.totalFinalAmount || 0);
  if (totalFinal > 0) return totalFinal;

  return Number(day.salesAmount || 0);
}

export default function SalesMonthlyPage() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { lang } = useLanguage();
  const t = salesText[lang];
  const c = commonText[lang];
  const s = t.common;
  const monthlyText = useMemo(
    () => ({
      ...s,
      ...t.monthly,
      noData: c.noData,
      loading: c.loading,
      error: c.error,
      loadFailed: c.loadFailed,
      cash: c.cash,
      transfer: c.transfer,
      card: c.card,
      other: c.etc,
      totalTax: c.totalTax,
      vat: c.vat,
      weekdays: c.calendarWeekdays,
    }),
    [c, s, t.monthly]
  );
  const initialMonth = getInitialMonth(searchParams);
  const [month, setMonth] = useState(initialMonth);
  const [monthlyData, setMonthlyData] = useState<SalesMonthlyResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [activeDetailTab, setActiveDetailTab] = useState<DetailTab>("daily");
  const [menuSalesSort, setMenuSalesSort] =
    useState<MenuSalesSort>("quantity");
  const [menuSalesDirection, setMenuSalesDirection] =
    useState<MenuSalesDirection>("desc");
  const [menuSalesGroup, setMenuSalesGroup] =
    useState<MenuSalesGroupKey>("all");
  const [currentUser, setCurrentUser] =
    useState<ReturnType<typeof getUser>>(null);
  const [savingCategoryName, setSavingCategoryName] = useState("");
  const [categoryGroupMessage, setCategoryGroupMessage] = useState("");
  const [categoryGroupError, setCategoryGroupError] = useState("");
  const sharedBusinessDate = getMonthStartDate(month);
  const canManageCategoryGroups =
    currentUser?.role === "owner" ||
    currentUser?.role === "master" ||
    currentUser?.role === "manager";

  const tabs = salesTabs.map((tab) => ({
    label: t.tabs[tab.key],
    href:
      tab.href === "/admin/sales/monthly"
        ? `${tab.href}?month=${encodeURIComponent(month)}&businessDate=${encodeURIComponent(sharedBusinessDate)}`
        : `${tab.href}?businessDate=${encodeURIComponent(sharedBusinessDate)}`,
    active:
      tab.href === "/admin/sales"
        ? pathname === "/admin/sales" || pathname === "/admin/sales/"
        : pathname.startsWith(tab.href),
  }));

  const fetchMonthlySales = useCallback(
    async (signal?: AbortSignal) => {
      setIsLoading(true);
      setErrorMessage("");

      try {
        const res = await fetch(
          `/api/admin/sales/monthly?month=${encodeURIComponent(month)}`,
          {
            cache: "no-store",
            signal,
          }
        );
        const result = (await res.json()) as SalesMonthlyResponse;

        if (!res.ok || !result.ok) {
          throw new Error(result.error || monthlyText.loadFailed);
        }

        setMonthlyData(result);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setErrorMessage(
          error instanceof Error
            ? error.message
            : monthlyText.loadFailed
        );
        setMonthlyData(null);
      } finally {
        if (!signal?.aborted) setIsLoading(false);
      }
    },
    [month, monthlyText.loadFailed]
  );

  useEffect(() => {
    setCurrentUser(getUser());
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    fetchMonthlySales(controller.signal);

    return () => controller.abort();
  }, [fetchMonthlySales]);

  function handleMonthChange(nextMonth: string) {
    setMonth(nextMonth);
    setMenuSalesDirection("desc");
    setMenuSalesGroup("all");
    router.replace(
      `${pathname}?month=${encodeURIComponent(nextMonth)}&businessDate=${encodeURIComponent(getMonthStartDate(nextMonth))}`,
      {
        scroll: false,
      }
    );
  }

  async function handleCategoryGroupUpdate(
    categoryName: string,
    groupType: CategoryGroupType
  ) {
    if (!currentUser?.username || !canManageCategoryGroups) {
      setCategoryGroupError(monthlyText.noPermission);
      setCategoryGroupMessage("");
      return;
    }

    setSavingCategoryName(categoryName);
    setCategoryGroupMessage("");
    setCategoryGroupError("");

    try {
      const res = await fetch("/api/admin/sales/category-groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          actorUsername: currentUser.username,
          categoryName,
          groupType,
        }),
      });
      const result = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;

      if (!res.ok || !result?.ok) {
        throw new Error(
          res.status === 403
            ? monthlyText.noPermission
            : monthlyText.categoryGroupSaveFailed
        );
      }

      setCategoryGroupMessage(monthlyText.categoryGroupSaved);
      await fetchMonthlySales();
    } catch (error) {
      setCategoryGroupError(
        error instanceof Error
          ? error.message
          : monthlyText.categoryGroupSaveFailed
      );
    } finally {
      setSavingCategoryName("");
    }
  }

  const summary = monthlyData?.summary;
  const paymentSummary = monthlyData?.paymentSummary;
  const taxSummary = monthlyData?.taxSummary;
  const menuSales = monthlyData?.menuSales;
  const days = monthlyData?.days || [];
  const salesDays = days.filter(
    (day) => getDailyFinalAmount(day) > 0 || day.receiptCount > 0
  );
  const totalDailyFinalAmount = salesDays.reduce(
    (sum, day) => sum + getDailyFinalAmount(day),
    0
  );
  const averageDailyFinalAmount =
    salesDays.length > 0 ? totalDailyFinalAmount / salesDays.length : 0;
  const hasError = Boolean(errorMessage);

  const summaryCards = useMemo(
    () => [
      {
        label: withEmoji(SALES_UI_EMOJIS.totalSales, monthlyText.totalSales),
        value: isLoading
          ? monthlyText.loading
          : hasError
            ? monthlyText.error
            : formatVnd(summary?.totalSales),
        meta: monthlyText.paidReceiptBase,
      },
      {
        label: withEmoji(SALES_UI_EMOJIS.receipts, monthlyText.receipts),
        value: isLoading
          ? monthlyText.loading
          : hasError
            ? monthlyText.error
            : `${formatNumber(summary?.receiptCount)}${monthlyText.receiptCountSuffix}`,
        meta: `${withEmoji(
          SALES_UI_EMOJIS.averageReceiptAmount,
          monthlyText.averageReceiptAmount
        )} ${formatVnd(summary?.averageReceiptAmount)}`,
      },
    ],
    [hasError, isLoading, monthlyText, summary]
  );

  const paymentRows = useMemo(
    () => [
      { label: monthlyText.cash, value: formatVnd(paymentSummary?.cashAmount) },
      {
        label: monthlyText.transfer,
        value: formatVnd(paymentSummary?.transferAmount),
      },
      { label: monthlyText.card, value: formatVnd(paymentSummary?.cardAmount) },
      { label: monthlyText.other, value: formatVnd(paymentSummary?.otherAmount) },
    ],
    [monthlyText, paymentSummary]
  );

  return (
    <Container noPaddingTop>
      <SubNav tabs={tabs} />

      <div style={sectionStyle}>
        <section style={noticeCardStyle}>
          <div style={noticeHeaderStyle}>
            <span style={noticeBadgeStyle}>{monthlyText.badge}</span>
            <span style={noticeTitleStyle}>
              {withEmoji(SALES_UI_EMOJIS.monthly, monthlyText.title)}
            </span>
          </div>
          <div style={monthControlStyle}>
            <button
              type="button"
              onClick={() => handleMonthChange(shiftMonth(month, -1))}
              style={monthButtonStyle}
            >
              {monthlyText.previousMonth}
            </button>
            <input
              type="month"
              value={month}
              onChange={(event) => handleMonthChange(event.target.value)}
              style={monthInputStyle}
            />
            <button
              type="button"
              onClick={() => handleMonthChange(shiftMonth(month, 1))}
              style={monthButtonStyle}
            >
              {monthlyText.nextMonth}
            </button>
          </div>
          {errorMessage ? <p style={errorTextStyle}>{errorMessage}</p> : null}
        </section>

        <section style={summaryGridStyle}>
          {summaryCards.map((card) => (
            <SummaryCard
              key={card.label}
              label={card.label}
              value={card.value}
              meta={card.meta}
            />
          ))}
        </section>

        <section style={cardStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>
              {withEmoji(SALES_UI_EMOJIS.paymentSummary, monthlyText.paymentSummary)}
            </h2>
            <span style={sectionMetaStyle}>{monthlyText.paymentTotal}</span>
          </div>

          <div style={paymentMethodGridStyle}>
            {paymentRows.map((row) => (
              <div key={row.label} style={paymentMethodStyle}>
                <span style={paymentMethodLabelStyle}>{row.label}</span>
                <strong style={paymentMethodValueStyle}>
                  {isLoading ? monthlyText.loading : hasError ? monthlyText.error : row.value}
                </strong>
              </div>
            ))}
          </div>

          <div style={paymentTotalStyle}>
            <span style={paymentTotalLabelStyle}>{monthlyText.paymentTotal}</span>
            <strong style={paymentTotalValueStyle}>
              {isLoading
                ? monthlyText.loading
                : hasError
                  ? monthlyText.error
                  : formatVnd(paymentSummary?.paymentTotalAmount)}
            </strong>
          </div>
        </section>

        <section style={cardStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>
              {withEmoji(SALES_UI_EMOJIS.taxSummary, monthlyText.taxSummary)}
            </h2>
            <span style={sectionMetaStyle}>
              {monthlyText.totalTax} {isLoading ? "-" : formatVnd(taxSummary?.totalTaxAmount)}
            </span>
          </div>

          <TaxSummaryList
            isLoading={isLoading}
            hasError={hasError}
            text={monthlyText}
            taxByRate={taxSummary?.taxByRate || []}
            taxSavingAmount={taxSummary?.taxSavingAmount || 0}
            amountDifferenceAmount={taxSummary?.amountDifferenceAmount || 0}
          />
        </section>

        <div style={detailTabListStyle}>
          <button
            type="button"
            onClick={() => setActiveDetailTab("daily")}
            style={{
              ...detailTabButtonStyle,
              ...(activeDetailTab === "daily"
                ? detailTabButtonActiveStyle
                : null),
            }}
          >
            {monthlyText.dailySales}
          </button>
          <button
            type="button"
            onClick={() => setActiveDetailTab("menu")}
            style={{
              ...detailTabButtonStyle,
              ...(activeDetailTab === "menu"
                ? detailTabButtonActiveStyle
                : null),
            }}
          >
            {monthlyText.menuSales}
          </button>
        </div>

        {activeDetailTab === "daily" ? (
          <section style={cardStyle}>
            <div style={sectionHeaderStyle}>
              <h2 style={sectionTitleStyle}>
                {withEmoji(SALES_UI_EMOJIS.dailySales, monthlyText.dailySales)}
              </h2>
              <span style={sectionMetaStyle}>
                {monthlyText.dailyAverageSales}{" "}
                {formatVnd(averageDailyFinalAmount)}
              </span>
            </div>

            <DailySalesList
              isLoading={isLoading}
              hasError={hasError}
              text={monthlyText}
              totalFinalSales={totalDailyFinalAmount}
              days={days}
            />
          </section>
        ) : (
          <section style={cardStyle}>
            <div style={menuGroupTabListStyle}>
              {(menuSales?.groups || []).map((group) => (
                <button
                  type="button"
                  key={group.key}
                  onClick={() => setMenuSalesGroup(group.key)}
                  style={{
                    ...menuGroupTabButtonStyle,
                    ...(menuSalesGroup === group.key
                      ? menuGroupTabButtonActiveStyle
                      : null),
                    ...(group.key === "uncategorized" && group.itemCount > 0
                      ? menuGroupTabWarningStyle
                      : null),
                  }}
                >
                  {group.key === "all"
                    ? monthlyText.all
                    : group.key === "food"
                      ? monthlyText.food
                      : group.key === "drink"
                        ? monthlyText.drink
                        : monthlyText.uncategorized}
                  <span style={menuGroupCountStyle}>{group.itemCount}</span>
                </button>
              ))}
            </div>
            <div style={menuSortControlRowStyle}>
              <span style={menuSortButtonsStyle}>
                <button
                  type="button"
                  onClick={() =>
                    setMenuSalesSort((current) =>
                      current === "quantity" ? "amount" : "quantity"
                    )
                  }
                  style={{
                    ...menuSortButtonStyle,
                    ...(menuSalesSort === "quantity"
                      ? menuSortButtonQuantityStyle
                      : menuSortButtonAmountStyle),
                  }}
                >
                  {menuSalesSort === "quantity"
                    ? monthlyText.salesQuantity
                    : monthlyText.itemSalesAmount}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setMenuSalesDirection((current) =>
                      current === "desc" ? "asc" : "desc"
                    )
                  }
                  style={{
                    ...menuSortButtonStyle,
                    ...(menuSalesDirection === "desc"
                      ? menuSortButtonDescStyle
                      : menuSortButtonAscStyle),
                  }}
                >
                  {menuSalesDirection === "desc"
                    ? monthlyText.sortHighToLow
                    : monthlyText.sortLowToHigh}
                </button>
              </span>
            </div>
            {categoryGroupMessage ? (
              <span style={categoryGroupSuccessStyle}>
                {categoryGroupMessage}
              </span>
            ) : null}
            {categoryGroupError ? (
              <span style={categoryGroupErrorStyle}>{categoryGroupError}</span>
            ) : null}

            <MenuSalesList
              key={`${month}:${menuSalesGroup}`}
              isLoading={isLoading}
              hasError={hasError}
              text={monthlyText}
              menuSales={menuSales}
              sort={menuSalesSort}
              direction={menuSalesDirection}
              group={menuSalesGroup}
              canManageCategoryGroups={canManageCategoryGroups}
              savingCategoryName={savingCategoryName}
              onCategoryGroupUpdate={handleCategoryGroupUpdate}
            />
          </section>
        )}
      </div>
    </Container>
  );
}

function SummaryCard({
  label,
  value,
  meta,
}: {
  label: string;
  value: string;
  meta: string;
}) {
  return (
    <div style={summaryCardStyle}>
      <div style={summaryLabelStyle}>{label}</div>
      <div style={summaryValueStyle}>{value}</div>
      <div style={summaryMetaStyle}>{meta}</div>
    </div>
  );
}

function TaxSummaryList({
  isLoading,
  hasError,
  text,
  taxByRate,
  taxSavingAmount,
  amountDifferenceAmount,
}: {
  isLoading: boolean;
  hasError: boolean;
  text: SalesMonthlyViewText;
  taxByRate: TaxSummary["taxByRate"];
  taxSavingAmount: number;
  amountDifferenceAmount: number;
}) {
  if (isLoading) {
    return <EmptyState title={text.loading} text={text.taxDataLoading} />;
  }

  if (hasError) {
    return <EmptyState title={text.error} text={text.taxDataLoadFailed} />;
  }

  return (
    <div style={itemListStyle}>
      {taxByRate.length === 0 ? (
        <div style={taxRowStyle}>
          <span style={taxRateStyle}>{text.vat}</span>
          <strong style={statusValueStyle}>{formatVnd(0)}</strong>
          <span style={taxLineCountStyle}>{text.noTaxData}</span>
        </div>
      ) : (
        taxByRate.map((item) => (
          <div key={item.taxRate} style={taxRowStyle}>
            <span style={taxRateStyle}>
              {text.vat} {formatNumber(item.taxRate)}%
            </span>
            <strong style={statusValueStyle}>{formatVnd(item.taxAmount)}</strong>
            <span style={taxLineCountStyle}>
              {formatNumber(item.lineCount)}{text.itemCountSuffix}
            </span>
          </div>
        ))
      )}
      <div style={taxRowStyle}>
        <span style={taxRateStyle}>
          {withEmoji(SALES_UI_EMOJIS.taxSaving, text.taxSaving)}
        </span>
        <strong style={statusValueStyle}>{formatVnd(taxSavingAmount)}</strong>
        <span style={taxLineCountStyle}>{text.adjustedReceiptBase}</span>
      </div>
      <div style={taxRowStyle}>
        <span style={taxRateStyle}>
          {withEmoji(SALES_UI_EMOJIS.amountDifference, text.amountDifference)}
        </span>
        <strong style={statusValueStyle}>
          {formatVnd(amountDifferenceAmount)}
        </strong>
        <span style={taxLineCountStyle}>{text.adjustedReceiptBase}</span>
      </div>
    </div>
  );
}

function MenuSalesList({
  isLoading,
  hasError,
  text,
  menuSales,
  sort,
  direction,
  group,
  canManageCategoryGroups,
  savingCategoryName,
  onCategoryGroupUpdate,
}: {
  isLoading: boolean;
  hasError: boolean;
  text: SalesMonthlyViewText;
  menuSales: MenuSales | undefined;
  sort: MenuSalesSort;
  direction: MenuSalesDirection;
  group: MenuSalesGroupKey;
  canManageCategoryGroups: boolean;
  savingCategoryName: string;
  onCategoryGroupUpdate: (
    categoryName: string,
    groupType: CategoryGroupType
  ) => Promise<void>;
}) {
  const [selectedCategory, setSelectedCategory] = useState("all");

  if (isLoading) {
    return <EmptyState title={text.loading} text={text.menuSalesDataLoading} />;
  }

  if (hasError) {
    return (
      <EmptyState title={text.error} text={text.menuSalesDataLoadFailed} />
    );
  }

  const groupItems = (menuSales?.items || []).filter(
    (item) => group === "all" || item.groupType === group
  );
  const categories = (menuSales?.categories || []).filter(
    (category) => group === "all" || category.groupType === group
  );
  const availableCategoryKeys = new Set(categories.map((item) => item.key));
  const activeCategory =
    selectedCategory === "all" || availableCategoryKeys.has(selectedCategory)
      ? selectedCategory
      : "all";
  const filteredItems = groupItems.filter(
    (item) =>
      activeCategory === "all" ||
      (item.categoryName
        ? `category:${item.categoryName}` === activeCategory
        : activeCategory === "__uncategorized__")
  );
  const items = [...filteredItems]
    .sort((a, b) => {
      if (sort === "amount") {
        if (a.amount !== b.amount) {
          return direction === "desc"
            ? b.amount - a.amount
            : a.amount - b.amount;
        }
        if (a.quantity !== b.quantity) {
          return direction === "desc"
            ? b.quantity - a.quantity
            : a.quantity - b.quantity;
        }
      } else {
        if (a.quantity !== b.quantity) {
          return direction === "desc"
            ? b.quantity - a.quantity
            : a.quantity - b.quantity;
        }
        if (a.amount !== b.amount) {
          return direction === "desc"
            ? b.amount - a.amount
            : a.amount - b.amount;
        }
      }

      return a.itemName.localeCompare(b.itemName);
    });

  if (items.length === 0) {
    return <EmptyState title={text.noData} text={text.noMenuSalesData} />;
  }

  const maxMenuValue = Math.max(
    ...items.map((item) => (sort === "quantity" ? item.quantity : item.amount)),
    0
  );
  const maxCategoryAmount = Math.max(
    ...categories.map((category) => category.amount),
    0
  );

  return (
    <div style={menuSalesContentStyle}>
      {group === "uncategorized" && categories.some((item) => item.name) ? (
        <div style={categoryManagementStyle}>
          <strong style={categoryManagementTitleStyle}>
            {text.categoryManagement}
          </strong>
          <span style={categoryManagementNoticeStyle}>
            {text.unclassifiedCategoriesNotice}
          </span>
          <span style={categoryManagementHelpStyle}>
            {text.sameCategoryMovesTogether}
          </span>
          {canManageCategoryGroups ? (
            <div style={categoryManagementListStyle}>
              {categories
                .filter((category) => category.name)
                .map((category) => (
                  <div key={category.key} style={categoryManagementRowStyle}>
                    <strong style={categoryManagementNameStyle}>
                      {category.name}
                    </strong>
                    <div style={categoryManagementActionsStyle}>
                      <button
                        type="button"
                        disabled={Boolean(savingCategoryName)}
                        onClick={() =>
                          onCategoryGroupUpdate(category.name as string, "food")
                        }
                        style={categoryManagementButtonStyle}
                      >
                        {text.assignToFood}
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(savingCategoryName)}
                        onClick={() =>
                          onCategoryGroupUpdate(category.name as string, "drink")
                        }
                        style={categoryManagementButtonStyle}
                      >
                        {text.assignToDrink}
                      </button>
                      <button
                        type="button"
                        disabled
                        style={categoryManagementButtonDisabledStyle}
                      >
                        {text.keepUncategorized}
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {categories.length > 1 ? (
        <div style={categoryTabListStyle}>
          <button
            type="button"
            onClick={() => setSelectedCategory("all")}
            style={{
              ...categoryTabButtonStyle,
              ...(activeCategory === "all"
                ? categoryTabButtonActiveStyle
                : null),
            }}
          >
            {text.all} · {groupItems.length}
          </button>
          {categories.map((category) => (
            <button
              type="button"
              key={category.key}
              onClick={() => setSelectedCategory(category.key)}
              style={{
                ...categoryTabButtonStyle,
                ...(activeCategory === category.key
                  ? categoryTabButtonActiveStyle
                  : null),
              }}
            >
              {category.name || text.uncategorized} · {category.itemCount}
            </button>
          ))}
        </div>
      ) : null}

      <div style={categoryChartStyle}>
        {categories.map((category) => {
          const ratio =
            maxCategoryAmount > 0
              ? Math.min((category.amount / maxCategoryAmount) * 100, 100)
              : 0;

          return (
            <button
              type="button"
              key={category.key}
              onClick={() => setSelectedCategory(category.key)}
              style={{
                ...categoryChartItemStyle,
                ...(activeCategory === category.key
                  ? categoryChartItemActiveStyle
                  : null),
              }}
            >
              <span style={categoryChartLabelStyle}>
                {category.name || text.uncategorized}
              </span>
              <span style={categoryChartValueStyle}>
                {formatVnd(category.amount)}
              </span>
              <span style={categoryChartTrackStyle}>
                <span
                  style={{
                    ...categoryChartFillStyle,
                    width: `${ratio}%`,
                  }}
                />
              </span>
            </button>
          );
        })}
      </div>

      <span style={menuSalesScrollNoticeStyle}>
        {text.menuSalesScrollNotice}
      </span>

      <div style={menuSalesScrollStyle}>
        <div style={menuSalesListStyle}>
          {items.map((item, index) => {
            const value = sort === "quantity" ? item.quantity : item.amount;
            const ratio =
              maxMenuValue > 0
                ? Math.min((value / maxMenuValue) * 100, 100)
                : 0;

            return (
              <div key={item.key} style={menuSalesRowStyle}>
                <span
                  style={{
                    ...menuSalesBarStyle,
                    width: `${ratio}%`,
                  }}
                />
                <div style={menuSalesMainRowStyle}>
                  <span style={menuSalesRankStyle}>{index + 1}</span>
                  <span style={menuSalesNameBlockStyle}>
                    <strong style={menuSalesNameStyle}>{item.itemName}</strong>
                    <span style={menuSalesMetricStyle}>
                      {text.salesQuantity} {formatNumber(item.quantity)} ·{" "}
                      {text.salesReceiptCount}{" "}
                      {formatNumber(item.receiptCount)}
                    </span>
                  </span>
                  <strong style={menuSalesAmountStyle}>
                    {formatVnd(item.amount)}
                  </strong>
                </div>
                {item.options.length > 0 ? (
                  <div style={menuOptionListStyle}>
                    {item.options.map((option) => (
                      <div key={option.key} style={menuOptionRowStyle}>
                        <span style={menuOptionNameStyle}>
                          {text.option} · {option.optionName}
                        </span>
                        <span style={menuOptionMetricStyle}>
                          {text.selection} {formatNumber(option.quantity)}
                        </span>
                        <strong style={menuOptionAmountStyle}>
                          {formatVnd(option.amount)}
                        </strong>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {(menuSales?.unlinkedOptionCount || 0) > 0 ? (
        <div style={unlinkedOptionWarningStyle}>
          <strong>
            {text.unlinkedOptions}{" "}
            {formatNumber(menuSales?.unlinkedOptionCount)}
          </strong>
          <span>{text.unlinkedOptionsWarning}</span>
          <span>{formatVnd(menuSales?.unlinkedOptionAmount)}</span>
        </div>
      ) : null}
    </div>
  );
}

function DailySalesList({
  isLoading,
  hasError,
  text,
  totalFinalSales,
  days,
}: {
  isLoading: boolean;
  hasError: boolean;
  text: SalesMonthlyViewText;
  totalFinalSales: number;
  days: MonthlyDay[];
}) {
  if (isLoading) {
    return <EmptyState title={text.loading} text={text.dailyDataLoading} />;
  }

  if (hasError) {
    return <EmptyState title={text.error} text={text.dailyDataLoadFailed} />;
  }

  if (days.length === 0) {
    return <EmptyState title={text.noData} text={text.noMonthlySalesData} />;
  }

  const activeDays = days.filter(
    (day) => day.receiptCount > 0 || getDailyFinalAmount(day) > 0
  );
  const activeSalesAmounts = activeDays.map(getDailyFinalAmount);
  const maxSales =
    activeSalesAmounts.length > 0 ? Math.max(...activeSalesAmounts) : 0;
  const minSales =
    activeSalesAmounts.length > 0 ? Math.min(...activeSalesAmounts) : 0;
  const hasSingleActiveDay = activeDays.length === 1;

  return (
    <div style={itemListStyle}>
      {days.map((day) => {
        const salesAmount = getDailyFinalAmount(day);
        const ratio = totalFinalSales > 0 ? (salesAmount / totalFinalSales) * 100 : 0;
        const barWidth = `${Math.min(Math.max(ratio, 0), 100)}%`;
        const isActiveDay = day.receiptCount > 0 || salesAmount > 0;
        const normalized =
          isActiveDay && maxSales === minSales
            ? 0.55
            : isActiveDay && maxSales > minSales
              ? (salesAmount - minSales) / (maxSales - minSales)
              : 0;
        const rowBackground = `rgba(79, 70, 229, ${0.035 + normalized * 0.11})`;
        const barBackground = `rgba(79, 70, 229, ${0.32 + normalized * 0.5})`;
        const isBestDay = isActiveDay && salesAmount === maxSales;
        const isWorstDay =
          isActiveDay && !hasSingleActiveDay && salesAmount === minSales;
        const weekday = getWeekdayInfo(day.businessDate, text.weekdays);

        return (
          <div
            key={day.businessDate}
            style={{ ...dayRowStyle, background: rowBackground }}
          >
            <div style={dayRowContentStyle}>
              <strong style={dayDateStyle}>
                <span>{day.businessDate}</span>
                <span style={getWeekdayStyle(weekday.tone)}>
                  ({weekday.label})
                </span>
                {isBestDay ? <span style={dayMarkerStyle}>🔥</span> : null}
                {isWorstDay ? <span style={dayMarkerStyle}>❄️</span> : null}
              </strong>
              <strong style={dayAmountStyle}>{formatVnd(salesAmount)}</strong>
              <span style={dayReceiptStyle}>
                {formatNumber(day.receiptCount)}{text.receiptCountSuffix}
              </span>
              <span style={dayRatioStyle}>{formatNumber(ratio)}%</span>
            </div>
            <div style={dayBarTrackStyle}>
              <div
                style={{
                  ...dayBarFillStyle,
                  width: barWidth,
                  background: barBackground,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div style={emptyBoxStyle}>
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const noticeCardStyle: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
};

const noticeHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 6,
};

const noticeBadgeStyle: CSSProperties = {
  ...ui.badgeMini,
  minWidth: 0,
  background: "#111827",
};

const noticeTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "#111827",
};

const monthControlStyle: CSSProperties = {
  marginTop: 8,
  display: "grid",
  gridTemplateColumns: "auto 1fr auto",
  gap: 8,
};

const monthButtonStyle: CSSProperties = {
  ...ui.button,
  padding: "9px 10px",
  borderRadius: 10,
  fontSize: 12,
  fontWeight: 800,
};

const monthInputStyle: CSSProperties = {
  ...ui.input,
  width: "100%",
  minWidth: 0,
  padding: "9px 10px",
  fontSize: 13,
  borderRadius: 10,
};

const errorTextStyle: CSSProperties = {
  margin: "8px 0 0",
  fontSize: 12,
  lineHeight: 1.45,
  color: "#dc2626",
  fontWeight: 700,
};

const summaryGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
};

const summaryCardStyle: CSSProperties = {
  ...ui.card,
  padding: 12,
  minWidth: 0,
};

const summaryLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#6b7280",
  marginBottom: 6,
  lineHeight: 1.2,
};

const summaryValueStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 900,
  color: "#111827",
  lineHeight: 1.2,
};

const summaryMetaStyle: CSSProperties = {
  ...ui.metaText,
  marginTop: 6,
  fontWeight: 700,
};

const cardStyle: CSSProperties = {
  ...ui.card,
  padding: 14,
};

const detailTabListStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 4,
  padding: 4,
  borderRadius: 10,
  background: "#e5e7eb",
};

const detailTabButtonStyle: CSSProperties = {
  border: 0,
  borderRadius: 8,
  padding: "8px 10px",
  background: "transparent",
  color: "#6b7280",
  fontSize: 12,
  lineHeight: 1.3,
  fontWeight: 900,
  cursor: "pointer",
};

const detailTabButtonActiveStyle: CSSProperties = {
  background: "#ffffff",
  color: "#111827",
  boxShadow: "0 1px 2px rgba(15, 23, 42, 0.12)",
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  marginBottom: 10,
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 900,
  color: "#111827",
};

const sectionMetaStyle: CSSProperties = {
  ...ui.metaText,
  fontWeight: 700,
  whiteSpace: "nowrap",
};

const paymentMethodGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 6,
};

const paymentMethodStyle: CSSProperties = {
  padding: "8px 9px",
  border: "1px solid #eef0f3",
  borderRadius: 10,
  background: "#f9fafb",
  minWidth: 0,
};

const paymentMethodLabelStyle: CSSProperties = {
  display: "block",
  fontSize: 11,
  lineHeight: 1.25,
  fontWeight: 700,
  color: "#6b7280",
};

const paymentMethodValueStyle: CSSProperties = {
  display: "block",
  marginTop: 4,
  fontSize: 12,
  lineHeight: 1.25,
  fontWeight: 900,
  color: "#111827",
  wordBreak: "break-word",
};

const paymentTotalStyle: CSSProperties = {
  marginTop: 8,
  padding: "9px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 10,
  background: "#111827",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
};

const paymentTotalLabelStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.3,
  fontWeight: 800,
  color: "#e5e7eb",
};

const paymentTotalValueStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.3,
  fontWeight: 900,
  color: "#ffffff",
};

const itemListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const menuGroupTabListStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 4,
  marginBottom: 8,
  minWidth: 0,
};

const menuGroupTabButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  minWidth: 0,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "#d1d5db",
  borderRadius: 8,
  padding: "8px 4px",
  background: "#ffffff",
  color: "#4b5563",
  fontSize: 10,
  lineHeight: 1.2,
  fontWeight: 900,
  cursor: "pointer",
};

const menuGroupTabButtonActiveStyle: CSSProperties = {
  borderColor: "#111827",
  background: "#111827",
  color: "#ffffff",
};

const menuGroupTabWarningStyle: CSSProperties = {
  boxShadow: "inset 0 0 0 1px #f59e0b",
};

const menuGroupCountStyle: CSSProperties = {
  flexShrink: 0,
  padding: "1px 4px",
  borderRadius: 999,
  background: "rgba(148, 163, 184, 0.2)",
  fontSize: 9,
};

const menuSortControlRowStyle: CSSProperties = {
  display: "flex",
  width: "100%",
  marginBottom: 8,
  minWidth: 0,
};

const menuSortButtonsStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  width: "100%",
  gap: 4,
  padding: 3,
  borderRadius: 8,
  background: "#f3f4f6",
};

const menuSortButtonStyle: CSSProperties = {
  width: "100%",
  border: 0,
  borderRadius: 6,
  padding: "8px 10px",
  background: "transparent",
  color: "#6b7280",
  fontSize: 11,
  lineHeight: 1.2,
  fontWeight: 900,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

// const menuSortButtonActiveStyle: CSSProperties = {
//   background: "#111827",
//   color: "#ffffff",
// };

const menuSortButtonQuantityStyle: CSSProperties = {
  background: "#111827",
  color: "#ffffff",
};

const menuSortButtonAmountStyle: CSSProperties = {
  background: "#ffffff",
  color: "#111827",
  boxShadow: "inset 0 0 0 1px #d1d5db",
};

const menuSortButtonDescStyle: CSSProperties = {
  background: "#065f46",
  color: "#ffffff",
};

const menuSortButtonAscStyle: CSSProperties = {
  background: "#991b1b",
  color: "#ffffff",
};

const menuSalesContentStyle: CSSProperties = {
  display: "grid",
  gap: 8,
  minWidth: 0,
};

const categoryManagementStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  padding: 9,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "#f59e0b",
  borderRadius: 10,
  background: "#fffbeb",
};

const categoryManagementTitleStyle: CSSProperties = {
  fontSize: 12,
  color: "#92400e",
};

const categoryManagementNoticeStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: "#92400e",
};

const categoryManagementHelpStyle: CSSProperties = {
  fontSize: 10,
  lineHeight: 1.35,
  color: "#a16207",
};

const categoryManagementListStyle: CSSProperties = {
  display: "grid",
  gap: 6,
};

const categoryManagementRowStyle: CSSProperties = {
  display: "grid",
  gap: 5,
  padding: 7,
  borderRadius: 8,
  background: "#ffffff",
  minWidth: 0,
};

const categoryManagementNameStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 11,
  color: "#374151",
};

const categoryManagementActionsStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  minWidth: 0,
  overflowX: "auto",
};

const categoryManagementButtonStyle: CSSProperties = {
  flexShrink: 0,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "#d1d5db",
  borderRadius: 6,
  padding: "5px 7px",
  background: "#ffffff",
  color: "#374151",
  fontSize: 9,
  fontWeight: 900,
  cursor: "pointer",
};

const categoryManagementButtonDisabledStyle: CSSProperties = {
  ...categoryManagementButtonStyle,
  background: "#f3f4f6",
  color: "#9ca3af",
  cursor: "default",
};

const categoryGroupSuccessStyle: CSSProperties = {
  display: "block",
  marginBottom: 8,
  fontSize: 11,
  fontWeight: 800,
  color: "#047857",
};

const categoryGroupErrorStyle: CSSProperties = {
  display: "block",
  marginBottom: 8,
  fontSize: 11,
  fontWeight: 800,
  color: "#b91c1c",
};

const categoryTabListStyle: CSSProperties = {
  display: "flex",
  gap: 5,
  minWidth: 0,
  overflowX: "auto",
  overflowY: "hidden",
  paddingBottom: 2,
};

const categoryTabButtonStyle: CSSProperties = {
  flexShrink: 0,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "#d1d5db",
  borderRadius: 999,
  padding: "6px 9px",
  background: "#ffffff",
  color: "#4b5563",
  fontSize: 10,
  lineHeight: 1.2,
  fontWeight: 900,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const categoryTabButtonActiveStyle: CSSProperties = {
  borderColor: "#111827",
  background: "#111827",
  color: "#ffffff",
};

const categoryChartStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  minWidth: 0,
  overflowX: "auto",
  overflowY: "hidden",
  paddingBottom: 2,
};

const categoryChartItemStyle: CSSProperties = {
  flex: "0 0 132px",
  display: "grid",
  gap: 4,
  minWidth: 0,
  padding: "7px 8px",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "#e5e7eb",
  borderRadius: 8,
  background: "#f9fafb",
  textAlign: "left",
  cursor: "pointer",
};

const categoryChartItemActiveStyle: CSSProperties = {
  borderColor: "#6366f1",
  background: "#eef2ff",
};

const categoryChartLabelStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 10,
  lineHeight: 1.2,
  fontWeight: 900,
  color: "#374151",
};

const categoryChartValueStyle: CSSProperties = {
  fontSize: 10,
  lineHeight: 1.2,
  fontWeight: 800,
  color: "#6b7280",
  whiteSpace: "nowrap",
};

const categoryChartTrackStyle: CSSProperties = {
  display: "block",
  height: 4,
  overflow: "hidden",
  borderRadius: 999,
  background: "#e5e7eb",
};

const categoryChartFillStyle: CSSProperties = {
  display: "block",
  height: "100%",
  borderRadius: 999,
  background: "#6366f1",
};

const menuSalesScrollNoticeStyle: CSSProperties = {
  fontSize: 10,
  lineHeight: 1.35,
  fontWeight: 700,
  color: "#6b7280",
};

const menuSalesScrollStyle: CSSProperties = {
  maxHeight: "min(55vh, 440px)",
  minWidth: 0,
  overflowY: "auto",
  overflowX: "hidden",
  overscrollBehavior: "contain",
  paddingRight: 2,
};

const menuSalesListStyle: CSSProperties = {
  display: "grid",
  gap: 7,
  minWidth: 0,
};

const menuSalesRowStyle: CSSProperties = {
  position: "relative",
  display: "grid",
  gap: 5,
  padding: "9px 10px",
  border: "1px solid #eef0f3",
  borderRadius: 10,
  background: "#f9fafb",
  minWidth: 0,
  overflow: "hidden",
};

const menuSalesBarStyle: CSSProperties = {
  position: "absolute",
  inset: "0 auto 0 0",
  background: "rgba(99, 102, 241, 0.09)",
  pointerEvents: "none",
};

const menuSalesMainRowStyle: CSSProperties = {
  position: "relative",
  zIndex: 1,
  display: "grid",
  gridTemplateColumns: "24px minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
};

const menuSalesRankStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  borderRadius: 999,
  background: "#111827",
  color: "#ffffff",
  fontSize: 11,
  lineHeight: 1,
  fontWeight: 900,
};

const menuSalesNameBlockStyle: CSSProperties = {
  display: "grid",
  gap: 2,
  minWidth: 0,
};

const menuSalesNameStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 12,
  lineHeight: 1.3,
  fontWeight: 900,
  color: "#111827",
};

const menuSalesMetricStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 10,
  lineHeight: 1.3,
  fontWeight: 700,
  color: "#6b7280",
};

const menuSalesAmountStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.3,
  fontWeight: 900,
  color: "#111827",
  whiteSpace: "nowrap",
};

const menuOptionListStyle: CSSProperties = {
  position: "relative",
  zIndex: 1,
  display: "grid",
  gap: 3,
  marginLeft: 32,
  minWidth: 0,
};

const menuOptionRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto auto",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
  padding: "5px 7px",
  borderRadius: 7,
  border: "1px dashed #cbd5e1",
  background: "#ffffff",
};

const menuOptionNameStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 10,
  lineHeight: 1.3,
  fontWeight: 800,
  color: "#475569",
};

const menuOptionMetricStyle: CSSProperties = {
  fontSize: 10,
  lineHeight: 1.3,
  fontWeight: 700,
  color: "#64748b",
  whiteSpace: "nowrap",
};

const menuOptionAmountStyle: CSSProperties = {
  fontSize: 10,
  lineHeight: 1.3,
  fontWeight: 900,
  color: "#334155",
  whiteSpace: "nowrap",
};

const unlinkedOptionWarningStyle: CSSProperties = {
  display: "grid",
  gap: 3,
  padding: "8px 9px",
  borderRadius: 8,
  border: "1px solid #fde68a",
  background: "#fffbeb",
  color: "#92400e",
  fontSize: 11,
  lineHeight: 1.4,
};

const statusValueStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 900,
  color: "#111827",
};

const taxRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "72px 1fr auto",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  border: "1px solid #eef0f3",
  borderRadius: 10,
  background: "#f9fafb",
};

const taxRateStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 900,
  color: "#374151",
};

const taxLineCountStyle: CSSProperties = {
  ...ui.metaText,
  fontWeight: 700,
  whiteSpace: "nowrap",
};

const dayRowStyle: CSSProperties = {
  position: "relative",
  overflow: "hidden",
  padding: "8px 9px",
  border: "1px solid #eef0f3",
  borderRadius: 8,
  background: "#f9fafb",
};

const dayRowContentStyle: CSSProperties = {
  position: "relative",
  zIndex: 1,
  display: "grid",
  gridTemplateColumns: "126px minmax(82px, 1fr) 44px 48px",
  alignItems: "center",
  gap: 6,
};

const dayDateStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  fontSize: 12,
  fontWeight: 900,
  color: "#111827",
  whiteSpace: "nowrap",
};

const weekdayTextStyle: CSSProperties = {
  color: "#6b7280",
};

const saturdayTextStyle: CSSProperties = {
  color: "#2563eb",
};

const sundayTextStyle: CSSProperties = {
  color: "#dc2626",
};

const dayMarkerStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1,
};

const dayAmountStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.25,
  fontWeight: 900,
  color: "#111827",
  textAlign: "right",
  minWidth: 0,
  wordBreak: "break-word",
};

const dayReceiptStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.25,
  fontWeight: 800,
  color: "#6b7280",
  textAlign: "right",
  whiteSpace: "nowrap",
};

const dayRatioStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.25,
  fontWeight: 900,
  color: "#3730a3",
  textAlign: "right",
  whiteSpace: "nowrap",
};

const dayBarTrackStyle: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  height: 3,
  background: "#e5e7eb",
};

const dayBarFillStyle: CSSProperties = {
  height: "100%",
  borderRadius: 999,
  background: "#4f46e5",
};

const emptyBoxStyle: CSSProperties = {
  border: "1px dashed #d1d5db",
  borderRadius: 10,
  padding: 14,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  color: "#6b7280",
  fontSize: 13,
};
