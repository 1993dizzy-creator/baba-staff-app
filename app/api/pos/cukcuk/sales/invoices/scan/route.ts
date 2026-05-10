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
};

type SAInvoiceSummary = {
    RefId?: string;
    RefID?: string;
    RefNo?: string;
    RefDate?: string;
    BranchId?: string;
    BranchID?: string;
    PaymentStatus?: number;
    TotalAmount?: number;
    SaleAmount?: number;
};

type SAInvoiceDetail = {
    RefDetailId?: string;
    RefDetailID?: string;
    RefDetailType?: number;
    RefID?: string;
    ItemID?: string;
    ItemCode?: string;
    ItemName?: string;
    Quantity?: number;
    UnitPrice?: number;
    UnitName?: string;
    Amount?: number;
    InventoryItemType?: number;
    OrderDetailID?: string;
    OrderDetailId?: string;

    ParentID?: string;
    ParentId?: string;
    SortOrder?: number;
    Description?: string;
    DiscountRate?: number;
    PromotionType?: number;
};

type SAInvoiceDetailResponse = {
    RefId?: string;
    RefID?: string;
    RefNo?: string;
    RefDate?: string;
    PaymentStatus?: number;
    TotalAmount?: number;
    SaleAmount?: number;
    SAInvoiceDetails?: SAInvoiceDetail[];
};

function getDateDaysAgo(days: number) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString();
}

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

function getRefId(invoice: SAInvoiceSummary) {
    return invoice.RefId || invoice.RefID || "";
}

function getRefNo(invoice: SAInvoiceSummary | SAInvoiceDetailResponse) {
    return invoice.RefNo || "";
}

function getRefDate(invoice: SAInvoiceSummary | SAInvoiceDetailResponse) {
    return invoice.RefDate || "";
}

async function fetchInvoiceDetail(params: {
    refId: string;
    accessToken: string;
    companyCode: string;
}) {
    const response = await fetch(
        `${BASE_URL}/api/v1/sainvoices/${encodeURIComponent(params.refId)}`,
        {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                CompanyCode: params.companyCode,
                Authorization: `Bearer ${params.accessToken}`,
            },
            cache: "no-store",
        }
    );

    const result =
        (await response.json()) as CukcukServiceResult<SAInvoiceDetailResponse>;

    return {
        response,
        result,
    };
}

export async function GET(req: Request) {
    const guardResponse = requirePosAdminSecret(req);
    if (guardResponse) return guardResponse;

    const { searchParams } = new URL(req.url);

    const page = Number(searchParams.get("page") || 1);
    const limit = Math.min(Number(searchParams.get("limit") || 20), 100);
    const days = Number(searchParams.get("days") || 7);
    const detailLimit = Math.min(
        Number(searchParams.get("detailLimit") || limit),
        50
    );

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

        const pagingBody = {
            Page: page,
            Limit: limit,
            BranchId: branchId,
            LastSyncDate: lastSyncDate,
        };

        const pagingResponse = await fetch(`${BASE_URL}/api/v1/sainvoices/paging`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                CompanyCode: companyCode,
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify(pagingBody),
            cache: "no-store",
        });

        const pagingResult =
            (await pagingResponse.json()) as CukcukServiceResult<SAInvoiceSummary[]>;

        const invoices = Array.isArray(pagingResult.Data) ? pagingResult.Data : [];

        const paidInvoices = invoices.filter(
            (invoice) => invoice.PaymentStatus === 3 && getRefId(invoice)
        );

        const targetInvoices = paidInvoices.slice(0, detailLimit);

        const itemCodeMap = new Map<
            string,
            {
                itemCode: string;
                itemName: string;
                inventoryItemType: number | null;
                unitName: string;
                lineCount: number;
                totalQuantity: number;
                totalAmount: number;
                refNos: string[];
            }
        >();

        const missingItemCodeLines: any[] = [];
        const optionLines: any[] = [];
        const failedDetails: unknown[] = [];
        const lines: any[] = [];

        for (const invoice of targetInvoices) {
            const refId = getRefId(invoice);

            const { response, result } = await fetchInvoiceDetail({
                refId,
                accessToken,
                companyCode,
            });

            if (!response.ok || result.Success !== true || !result.Data) {
                failedDetails.push({
                    refId,
                    refNo: getRefNo(invoice),
                    httpStatus: response.status,
                    code: result.Code,
                    errorType: result.ErrorType,
                    errorMessage: result.ErrorMessage,
                    success: result.Success,
                });
                continue;
            }

            const detailInvoice = result.Data;
            const details = Array.isArray(detailInvoice.SAInvoiceDetails)
                ? detailInvoice.SAInvoiceDetails
                : [];

            const sortedDetails = [...details].sort(
                (a, b) => Number(a.SortOrder ?? 0) - Number(b.SortOrder ?? 0)
            );

            let lastMainLine: any = null;

            for (const detail of sortedDetails) {

                const itemCode = detail.ItemCode || "";
                const quantity = Number(detail.Quantity ?? 0);
                const amount = Number(detail.Amount ?? 0);

                const line = {
                    invoiceRefId: detailInvoice.RefId || detailInvoice.RefID || refId,
                    invoiceRefNo: getRefNo(detailInvoice) || getRefNo(invoice),
                    invoiceRefDate: getRefDate(detailInvoice) || getRefDate(invoice),
                    paymentStatus: detailInvoice.PaymentStatus ?? invoice.PaymentStatus,

                    refDetailId: detail.RefDetailId || detail.RefDetailID || null,
                    refDetailType: detail.RefDetailType ?? null,
                    sortOrder: detail.SortOrder ?? null,

                    parentId: detail.ParentID || detail.ParentId || null,

                    itemId: detail.ItemID || null,
                    itemCode: itemCode || null,
                    itemName: detail.ItemName || "",
                    quantity,
                    unitPrice: Number(detail.UnitPrice ?? 0),
                    unitName: detail.UnitName || "",
                    amount,

                    inventoryItemType: detail.InventoryItemType ?? null,
                    orderDetailId: detail.OrderDetailID || detail.OrderDetailId || null,

                    description: detail.Description || "",
                    discountRate: detail.DiscountRate ?? null,
                    promotionType: detail.PromotionType ?? null,
                };

                lines.push(line);

                if (!itemCode) {
                    const optionLine = {
                        ...line,
                        lineKind: "option_or_modifier",
                        deductInventory: false,
                        inferredParent: lastMainLine
                            ? {
                                refDetailId: lastMainLine.refDetailId,
                                itemCode: lastMainLine.itemCode,
                                itemName: lastMainLine.itemName,
                                quantity: lastMainLine.quantity,
                                sortOrder: lastMainLine.sortOrder,
                                amount: lastMainLine.amount,
                            }
                            : null,
                    };

                    missingItemCodeLines.push(optionLine);
                    optionLines.push(optionLine);
                    continue;
                }

                lastMainLine = line;

                const prev = itemCodeMap.get(itemCode);

                if (prev) {
                    prev.lineCount += 1;
                    prev.totalQuantity += quantity;
                    prev.totalAmount += amount;

                    const refNo = getRefNo(detailInvoice) || getRefNo(invoice);
                    if (refNo && !prev.refNos.includes(refNo)) {
                        prev.refNos.push(refNo);
                    }
                } else {
                    itemCodeMap.set(itemCode, {
                        itemCode,
                        itemName: detail.ItemName || "",
                        inventoryItemType: detail.InventoryItemType ?? null,
                        unitName: detail.UnitName || "",
                        lineCount: 1,
                        totalQuantity: quantity,
                        totalAmount: amount,
                        refNos: [getRefNo(detailInvoice) || getRefNo(invoice)].filter(
                            Boolean
                        ),
                    });
                }
            }
        }

        const itemCodeSummary = Array.from(itemCodeMap.values()).sort((a, b) =>
            a.itemCode.localeCompare(b.itemCode, "en")
        );

        const inventoryItemTypeSummary = itemCodeSummary.reduce<
            Record<string, number>
        >((acc, item) => {
            const key =
                item.inventoryItemType === null ? "null" : String(item.inventoryItemType);

            acc[key] = (acc[key] || 0) + item.lineCount;
            return acc;
        }, {});

        return NextResponse.json({
            ok: true,
            request: {
                endpoint: "/api/v1/sainvoices/paging + /api/v1/sainvoices/{refId}",
                page,
                limit,
                detailLimit,
                branchId,
                lastSyncDate,
            },
            result: {
                paging: {
                    httpStatus: pagingResponse.status,
                    code: pagingResult.Code,
                    success: pagingResult.Success,
                    total: pagingResult.Total,
                    fetched: invoices.length,
                    paidInvoices: paidInvoices.length,
                    detailedInvoices: targetInvoices.length,
                },
                details: {
                    lineCount: lines.length,
                    uniqueItemCodeCount: itemCodeSummary.length,
                    missingItemCodeCount: missingItemCodeLines.length,
                    optionLineCount: optionLines.length,
                    failedDetailCount: failedDetails.length,
                    inventoryItemTypeSummary,
                    itemCodeSummary,
                },
            },
            samples: {
                lines: lines.slice(0, 30),
                optionLines: optionLines.slice(0, 10),
                missingItemCodeLines: missingItemCodeLines.slice(0, 10),
                failedDetails,
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
