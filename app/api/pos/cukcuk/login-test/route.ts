import { NextResponse } from "next/server";
import crypto from "crypto";

const BASE_URL =
  process.env.CUKCUK_BASE_URL?.replace(/^["']|["']$/g, "").trim() ||
  "https://graphapi.cukcuk.vn";

const DOMAIN =
  process.env.CUKCUK_DOMAIN?.replace(/^["']|["']$/g, "").trim() || "";

const APP_ID =
  process.env.CUKCUK_APP_ID?.replace(/^["']|["']$/g, "").trim() || "";

const SECRET_KEY =
  process.env.CUKCUK_SECRET_KEY?.replace(/^["']|["']$/g, "").trim() || "";

const LOGIN_URL = `${BASE_URL}/api/Account/Login`;

/**
 * 🔑 Signature 생성 (여기만 나중에 수정하면 됨)
 */
function createSignature(loginTime: number) {
  // 👉 현재는 가장 기본 형태로 넣어둠 (추후 MISA 답변에 맞게 수정)
  const raw = `domain=${DOMAIN}&appid=${APP_ID}&logintime=${loginTime}`;

  return crypto
    .createHmac("sha256", SECRET_KEY)
    .update(raw, "utf8")
    .digest("hex");
}

/**
 * 📡 CUKCUK 로그인 요청
 */
async function requestLogin() {
  const loginTime = Date.now();
  const signature = createSignature(loginTime);

  const body = {
    Domain: DOMAIN,
    AppID: APP_ID,
    LoginTime: loginTime,
    SignatureInfo: signature,
  };

  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  let data: unknown = null;

  try {
    data = await res.json();
  } catch {
    data = await res.text();
  }

  return {
    status: res.status,
    data,
  };
}

/**
 * 🚀 API Route
 */
export async function GET() {
  if (!DOMAIN || !APP_ID || !SECRET_KEY) {
    return NextResponse.json(
      {
        ok: false,
        message: "Missing required env values",
      },
      { status: 500 }
    );
  }

  try {
    const result = await requestLogin();

    return NextResponse.json({
      ok: true,
      request: {
        domain: DOMAIN,
        appId: APP_ID,
      },
      result,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}