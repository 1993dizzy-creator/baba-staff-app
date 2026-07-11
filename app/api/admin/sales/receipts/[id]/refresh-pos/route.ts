import { NextResponse } from "next/server";
import { loginCukcuk } from "@/lib/pos/cukcuk/auth";
import { supabaseServer } from "@/lib/supabase/server";
import {
  SOURCE,
  fetchSaInvoiceDetail,
  getDetailsFromInvoicePayload,
  getPaymentsFromInvoicePayload,
  getInvoiceRefId,
  buildReceiptRow,
  buildLineRow,
  buildPaymentRow,
  saveReceipts,
  saveLines,
  savePayments,
} from "@/lib/pos/cukcuk/sales-receipt-sync";

export const runtime = "nodejs";

type BlockReason = "pending" | "canceled" | "pos_lookup_failed" | null;

type ReceiptRow = {
  id: number;
  source: string | null;
  ref_id: string | null;
  business_date: string;
  ref_date: string | null;
  payment_status: number | null;
  is_canceled: boolean | null;
  is_modified: boolean | null;
};

function parseReceiptId(value: string) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function canManageSalesReceipt(role: unknown) {
  return role === "owner" || role === "master" || role === "manager";
}

async function getAdminActor(actorUsername: unknown) {
  if (typeof actorUsername !== "string" || !actorUsername.trim()) {
    return null;
  }

  const { data, error } = await supabaseServer
    .from("users")
    .select("id, username, name, role, is_active")
    .eq("username", actorUsername.trim())
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to verify admin actor: ${error.message}`);
  }

  if (!canManageSalesReceipt(data?.role)) {
    return null;
  }

  return data;
}

// 실제 화면 문구는 lib/text/sales.ts의 receiptsEdit 문구를 blockReason 기준으로
// 프론트에서 선택해 표시한다. 여기 메시지는 서버 로그·비-UI 용도의 한국어 기본값이다.
const MESSAGES = {
  pending: "아직 결제가 완료되지 않은 영수증입니다. 결제 완료 후 다시 시도해주세요.",
  canceled: "취소된 영수증은 수정할 수 없습니다.",
  lookupFailed: "최신 POS 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.",
  refreshFailed: "영수증 정보를 갱신하지 못했습니다. 잠시 후 다시 시도해주세요.",
  editable: "",
} as const;

function buildResponse(params: {
  ok: boolean;
  receiptId: number;
  refId: string | null;
  paymentStatus: number | null;
  isCanceled: boolean;
  refreshed: boolean;
  editable: boolean;
  blockReason: BlockReason;
  message: string;
}) {
  return NextResponse.json({
    ok: params.ok,
    receiptId: params.receiptId,
    refId: params.refId,
    paymentStatus: params.paymentStatus,
    isCanceled: params.isCanceled,
    refreshed: params.refreshed,
    editable: params.editable,
    blockReason: params.blockReason,
    message: params.message,
  });
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const receiptId = parseReceiptId(id);

  if (!receiptId) {
    return NextResponse.json(
      { ok: false, error: "Invalid receipt id" },
      { status: 400 }
    );
  }

  try {
    const body = (await req.json().catch(() => ({}))) as {
      actorUsername?: string;
    };

    const actor = await getAdminActor(body.actorUsername);
    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "Forbidden" },
        { status: 403 }
      );
    }

    const { data: receipt, error: receiptError } = await supabaseServer
      .from("pos_sales_receipts")
      .select(
        "id, source, ref_id, business_date, ref_date, payment_status, is_canceled, is_modified"
      )
      .eq("id", receiptId)
      .maybeSingle();

    if (receiptError) {
      throw new Error(`Failed to fetch sales receipt: ${receiptError.message}`);
    }

    const receiptRow = receipt as ReceiptRow | null;

    if (!receiptRow) {
      return NextResponse.json(
        { ok: false, error: "Receipt not found" },
        { status: 404 }
      );
    }

    // 자체(수기) 영수증은 CUKCUK 조회 대상이 아니며 항상 결제완료 상태로
    // 생성되므로, 기존 수정 흐름을 그대로 허용한다.
    if (receiptRow.source !== SOURCE || !receiptRow.ref_id) {
      return buildResponse({
        ok: true,
        receiptId,
        refId: receiptRow.ref_id,
        paymentStatus: receiptRow.payment_status,
        isCanceled: receiptRow.is_canceled === true,
        refreshed: false,
        editable: receiptRow.is_canceled !== true,
        blockReason: receiptRow.is_canceled === true ? "canceled" : null,
        message:
          receiptRow.is_canceled === true ? MESSAGES.canceled : MESSAGES.editable,
      });
    }

    // 이미 결제완료 + 미취소면 불필요한 POS 재조회 없이 즉시 허용한다.
    if (receiptRow.payment_status === 3 && receiptRow.is_canceled !== true) {
      return buildResponse({
        ok: true,
        receiptId,
        refId: receiptRow.ref_id,
        paymentStatus: receiptRow.payment_status,
        isCanceled: false,
        refreshed: false,
        editable: true,
        blockReason: null,
        message: MESSAGES.editable,
      });
    }

    // 이미 취소로 확인된 영수증은 재조회 없이 차단한다.
    if (receiptRow.is_canceled === true) {
      return buildResponse({
        ok: true,
        receiptId,
        refId: receiptRow.ref_id,
        paymentStatus: receiptRow.payment_status,
        isCanceled: true,
        refreshed: false,
        editable: false,
        blockReason: "canceled",
        message: MESSAGES.canceled,
      });
    }

    let detailPayload: Record<string, unknown>;
    try {
      const login = await loginCukcuk();
      detailPayload = await fetchSaInvoiceDetail({
        accessToken: login.accessToken,
        companyCode: login.companyCode,
        refId: receiptRow.ref_id,
      });
    } catch (lookupError) {
      console.error("[SALES_REFRESH_POS_LOOKUP_FAILED]", {
        receiptId,
        refId: receiptRow.ref_id,
        error:
          lookupError instanceof Error
            ? lookupError.message
            : String(lookupError),
      });

      return buildResponse({
        ok: false,
        receiptId,
        refId: receiptRow.ref_id,
        paymentStatus: receiptRow.payment_status,
        isCanceled: false,
        refreshed: false,
        editable: false,
        blockReason: "pos_lookup_failed",
        message: MESSAGES.lookupFailed,
      });
    }

    if (getInvoiceRefId(detailPayload) !== receiptRow.ref_id) {
      console.error("[SALES_REFRESH_POS_REF_ID_MISMATCH]", {
        receiptId,
        expectedRefId: receiptRow.ref_id,
        responseRefId: getInvoiceRefId(detailPayload),
      });

      return buildResponse({
        ok: false,
        receiptId,
        refId: receiptRow.ref_id,
        paymentStatus: receiptRow.payment_status,
        isCanceled: false,
        refreshed: false,
        editable: false,
        blockReason: "pos_lookup_failed",
        message: MESSAGES.lookupFailed,
      });
    }

    const syncedAt = new Date().toISOString();
    const receiptForSave = buildReceiptRow({
      invoice: detailPayload,
      detailPayload,
      businessDate: receiptRow.business_date,
      syncedAt,
    });

    try {
      await saveReceipts([receiptForSave]);

      const details = getDetailsFromInvoicePayload(detailPayload);
      const lineRows = details.map((detail, index) =>
        buildLineRow({
          receiptId,
          receiptRefId: receiptForSave.ref_id,
          detail,
          businessDate: receiptRow.business_date,
          refDate: receiptForSave.ref_date,
          paymentStatus: receiptForSave.payment_status,
          isCanceled: receiptForSave.is_canceled,
          sortOrder: index + 1,
          syncedAt,
        })
      );
      await saveLines(lineRows);

      const payments = getPaymentsFromInvoicePayload(detailPayload);
      const paymentRows = payments.map((payment) =>
        buildPaymentRow({
          receiptId,
          receiptRefId: receiptForSave.ref_id,
          businessDate: receiptRow.business_date,
          refDate: receiptForSave.ref_date,
          payment,
          syncedAt,
        })
      );
      await savePayments(paymentRows);
    } catch (saveError) {
      console.error("[SALES_REFRESH_POS_SAVE_FAILED]", {
        receiptId,
        refId: receiptRow.ref_id,
        error:
          saveError instanceof Error ? saveError.message : String(saveError),
      });

      return buildResponse({
        ok: false,
        receiptId,
        refId: receiptRow.ref_id,
        paymentStatus: receiptRow.payment_status,
        isCanceled: false,
        refreshed: false,
        editable: false,
        blockReason: "pos_lookup_failed",
        message: MESSAGES.refreshFailed,
      });
    }

    // is_modified 영수증은 saveReceipts/saveLines/savePayments 내부에서
    // 이미 갱신 대상에서 제외되므로, 실제 DB 상태를 다시 읽어 판정한다.
    const { data: refreshedReceipt, error: refreshedError } =
      await supabaseServer
        .from("pos_sales_receipts")
        .select("payment_status, is_canceled")
        .eq("id", receiptId)
        .maybeSingle();

    if (refreshedError) {
      throw new Error(
        `Failed to re-fetch sales receipt after refresh: ${refreshedError.message}`
      );
    }

    const finalPaymentStatus =
      (refreshedReceipt?.payment_status as number | null) ?? null;
    const finalIsCanceled = refreshedReceipt?.is_canceled === true;
    const editable = finalPaymentStatus === 3 && !finalIsCanceled;
    const blockReason: BlockReason = editable
      ? null
      : finalIsCanceled
        ? "canceled"
        : "pending";

    return buildResponse({
      ok: true,
      receiptId,
      refId: receiptRow.ref_id,
      paymentStatus: finalPaymentStatus,
      isCanceled: finalIsCanceled,
      refreshed: true,
      editable,
      blockReason,
      message: editable
        ? MESSAGES.editable
        : blockReason === "canceled"
          ? MESSAGES.canceled
          : MESSAGES.pending,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Unknown refresh-pos error",
      },
      { status: 500 }
    );
  }
}
