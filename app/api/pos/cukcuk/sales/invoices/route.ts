import { NextResponse } from "next/server";
import { loginCukcuk } from "@/lib/pos/cukcuk/auth";
import { requirePosAdminSecret } from "@/lib/pos/api-guard";

const BASE_URL = process.env.CUKCUK_BASE_URL || "https://graphapi.cukcuk.vn";

const BABA_BRANCH_ID = "c39228ba-a452-4cf9-bf34-424ffb151fb8";


type CukcukServiceResult<T = unknown> = {
    Code?: number;
    ErrorType?: number;
    ErrorMessage?: string;
    Success?: boolean;
    Data?: T;
    Total?: number;
    Environment?: string;
};

type SAInvoiceSummary = {
    RefId?: string;
    RefID?: string;
    RefNo?: string;
    RefDate?: string;
    BranchId?: string;
    BranchID?: string;
    OrderId?: string;
    OrderID?: string;
    PaymentStatus?: number;
    CustomerName?: string;
    EmployeeName?: string;
    TotalAmount?: number;
    SaleAmount?: number;
};

function resolveLoginData(loginResult: any) {
    const data = loginResult?.Data || loginResult?.data || loginResult;

    return {
        accessToken:
            data?.AccessToken ||
            data?.accessToken ||
            loginResult?.AccessToken ||
            loginResult?.accessToken ||
            null,

        companyCode:
            data?.CompanyCode ||
            data?.companyCode ||
            loginResult?.CompanyCode ||
            loginResult?.companyCode ||
            process.env.CUKCUK_DOMAIN ||
            null,
    };
}

function getDateDaysAgo(days: number) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString();
}

function normalizeInvoice(invoice: SAInvoiceSummary) {
    return {
        refId: invoice.RefId || invoice.RefID || null,
        refNo: invoice.RefNo || null,
        refDate: invoice.RefDate || null,
        branchId: invoice.BranchId || invoice.BranchID || null,
        orderId: invoice.OrderId || invoice.OrderID || null,
        paymentStatus: invoice.PaymentStatus ?? null,
        paymentStatusLabel:
            invoice.PaymentStatus === 3
                ? "paid"
                : invoice.PaymentStatus === 4
                    ? "cancelled"
                    : invoice.PaymentStatus === 5
                        ? "temporary_cancelled"
                        : "other",
        customerName: invoice.CustomerName || "",
        employeeName: invoice.EmployeeName || "",
        totalAmount: invoice.TotalAmount ?? 0,
        saleAmount: invoice.SaleAmount ?? 0,
    };
}

export async function GET(req: Request) {
    const guardResponse = requirePosAdminSecret(req);
    if (guardResponse) return guardResponse;

    const { searchParams } = new URL(req.url);

    const page = Number(searchParams.get("page") || 1);
    const limit = Math.min(Number(searchParams.get("limit") || 20), 100);
    const days = Number(searchParams.get("days") || 7);
    const onlyPaid = searchParams.get("onlyPaid") !== "false";

    const branchId = searchParams.get("branchId") || BABA_BRANCH_ID;
    const lastSyncDate = searchParams.get("lastSyncDate") || getDateDaysAgo(days);

    try {
        const rawLoginResult = await loginCukcuk();
        const loginResult = rawLoginResult as any;

        const { accessToken, companyCode } = resolveLoginData(loginResult);

        if (!accessToken) {
            return NextResponse.json(
                {
                    ok: false,
                    step: "login",
                    error: "CUKCUK login failed: AccessToken missing",
                    debug: {
                        hasLoginResult: !!loginResult,
                        loginResultKeys:
                            loginResult && typeof loginResult === "object"
                                ? Object.keys(loginResult)
                                : [],
                        dataKeys:
                            loginResult?.Data && typeof loginResult.Data === "object"
                                ? Object.keys(loginResult.Data)
                                : [],
                    },
                },
                { status: 500 }
            );
        }

        if (!companyCode) {
            return NextResponse.json(
                {
                    ok: false,
                    step: "login",
                    error: "CUKCUK CompanyCode missing",
                },
                { status: 500 }
            );
        }

        const requestBody = {
            Page: page,
            Limit: limit,
            BranchId: branchId,
            LastSyncDate: lastSyncDate,
        };

        const response = await fetch(`${BASE_URL}/api/v1/sainvoices/paging`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                CompanyCode: companyCode,
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify(requestBody),
            cache: "no-store",
        });

        const result = (await response.json()) as CukcukServiceResult<SAInvoiceSummary[]>;

        const invoices = Array.isArray(result.Data) ? result.Data : [];
        const normalized = invoices.map(normalizeInvoice);
        const paidInvoices = normalized.filter((invoice) => invoice.paymentStatus === 3);

        return NextResponse.json({
            ok: response.ok && result.Success === true,
            request: {
                endpoint: "/api/v1/sainvoices/paging",
                method: "POST",
                page,
                limit,
                branchId,
                lastSyncDate,
                onlyPaid,
            },
            result: {
                httpStatus: response.status,
                code: result.Code,
                errorType: result.ErrorType,
                errorMessage: result.ErrorMessage,
                success: result.Success,
                total: result.Total,
                fetched: normalized.length,
                paidCount: paidInvoices.length,
                invoices: onlyPaid ? paidInvoices : normalized,
            },
            raw: {
                dataSample: invoices.slice(0, 3),
            },
        });
    } catch (error) {
        return NextResponse.json(
            {
                ok: false,
                error: error instanceof Error ? error.message : "Unknown error",
            },
            { status: 500 }
        );
    }
}
