import { NextResponse } from "next/server";
import { loginCukcuk } from "@/lib/pos/cukcuk/auth";
import { requirePosAdminSecret } from "@/lib/pos/api-guard";

const BASE_URL = process.env.CUKCUK_BASE_URL || "https://graphapi.cukcuk.vn";

type CukcukServiceResult<T = unknown> = {
  Code?: number;
  ErrorType?: number;
  ErrorMessage?: string;
  Success?: boolean;
  Data?: T;
  Environment?: string;
};

type SAInvoiceDetail = {
  RefDetailId?: string;
  RefDetailID?: string;
  RefID?: string;
  ItemID?: string;
  ItemCode?: string;
  ItemName?: string;
  Quantity?: number;
  UnitPrice?: number;
  UnitID?: string;
  UnitName?: string;
  Amount?: number;
  RefDetailType?: number;
  InventoryItemType?: number;
  OrderDetailID?: string;
  OrderDetailId?: string;
  ParentID?: string;
  ParentId?: string;
  Description?: string;
};

type SAInvoiceDetailResponse = {
  RefId?: string;
  RefID?: string;
  RefNo?: string;
  RefDate?: string;
  BranchId?: string;
  BranchID?: string;
  OrderId?: string;
  OrderID?: string;
  PaymentStatus?: number;
  TableName?: string;
  EmployeeName?: string;
  CustomerName?: string;
  TotalAmount?: number;
  SaleAmount?: number;
  TotalItem?: number;
  SAInvoiceDetails?: SAInvoiceDetail[];
  SAInvoicePayments?: unknown[];
  SAInvoiceCoupons?: unknown[];
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

function normalizeDetail(detail: SAInvoiceDetail) {
  return {
    refDetailId: detail.RefDetailId || detail.RefDetailID || null,
    refId: detail.RefID || null,
    itemId: detail.ItemID || null,
    itemCode: detail.ItemCode || null,
    itemName: detail.ItemName || "",
    quantity: Number(detail.Quantity ?? 0),
    unitPrice: Number(detail.UnitPrice ?? 0),
    unitId: detail.UnitID || null,
    unitName: detail.UnitName || "",
    amount: Number(detail.Amount ?? 0),
    refDetailType: detail.RefDetailType ?? null,
    inventoryItemType: detail.InventoryItemType ?? null,
    orderDetailId: detail.OrderDetailID || detail.OrderDetailId || null,
    parentId: detail.ParentID || detail.ParentId || null,
    description: detail.Description || "",
  };
}

function normalizeInvoice(invoice: SAInvoiceDetailResponse) {
  const details = Array.isArray(invoice.SAInvoiceDetails)
    ? invoice.SAInvoiceDetails
    : [];

  const normalizedDetails = details.map(normalizeDetail);

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
    tableName: invoice.TableName || "",
    employeeName: invoice.EmployeeName || "",
    customerName: invoice.CustomerName || "",
    totalAmount: Number(invoice.TotalAmount ?? 0),
    saleAmount: Number(invoice.SaleAmount ?? 0),
    totalItem: Number(invoice.TotalItem ?? 0),
    detailsCount: normalizedDetails.length,
    itemCodes: normalizedDetails
      .map((detail) => detail.itemCode)
      .filter(Boolean),
    details: normalizedDetails,
  };
}

export async function GET(
  req: Request,
  context: { params: Promise<{ refId: string }> }
) {
  const guardResponse = requirePosAdminSecret(req);
  if (guardResponse) return guardResponse;

  const { refId } = await context.params;

  if (!refId) {
    return NextResponse.json(
      {
        ok: false,
        error: "refId is required",
      },
      { status: 400 }
    );
  }

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

    const response = await fetch(
      `${BASE_URL}/api/v1/sainvoices/${encodeURIComponent(refId)}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          CompanyCode: companyCode,
          Authorization: `Bearer ${accessToken}`,
        },
        cache: "no-store",
      }
    );

    const result =
      (await response.json()) as CukcukServiceResult<SAInvoiceDetailResponse>;

    const invoice = result.Data;

    if (!response.ok || result.Success !== true || !invoice) {
      return NextResponse.json(
        {
          ok: false,
          request: {
            endpoint: `/api/v1/sainvoices/${refId}`,
            method: "GET",
            refId,
          },
          result: {
            httpStatus: response.status,
            code: result.Code,
            errorType: result.ErrorType,
            errorMessage: result.ErrorMessage,
            success: result.Success,
          },
        },
        { status: response.ok ? 500 : response.status }
      );
    }

    const normalized = normalizeInvoice(invoice);

    return NextResponse.json({
      ok: true,
      request: {
        endpoint: `/api/v1/sainvoices/${refId}`,
        method: "GET",
        refId,
      },
      result: {
        httpStatus: response.status,
        code: result.Code,
        success: result.Success,
        invoice: normalized,
      },
      raw: {
        invoiceKeys: Object.keys(invoice),
        detailKeys:
          Array.isArray(invoice.SAInvoiceDetails) &&
          invoice.SAInvoiceDetails.length > 0
            ? Object.keys(invoice.SAInvoiceDetails[0])
            : [],
        detailSample: Array.isArray(invoice.SAInvoiceDetails)
          ? invoice.SAInvoiceDetails.slice(0, 5)
          : [],
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
