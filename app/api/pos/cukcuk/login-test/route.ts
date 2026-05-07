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

function maskSensitiveValue(value: unknown) {
  if (typeof value !== "string") return value;
  if (value.length <= 10) return "***";

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function maskSensitiveData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => maskSensitiveData(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => {
        const normalizedKey = key.toLowerCase();
        const isSensitive =
          normalizedKey.includes("accesstoken") ||
          normalizedKey.includes("access_token") ||
          normalizedKey.includes("token") ||
          normalizedKey.includes("authorization");

        return [
          key,
          isSensitive
            ? maskSensitiveValue(entryValue)
            : maskSensitiveData(entryValue),
        ];
      })
    );
  }

  return value;
}

function createSignature(message: string) {
  return crypto
    .createHmac("sha256", SECRET_KEY)
    .update(message, "utf8")
    .digest("hex");
}

async function requestLogin() {
  const loginTime = new Date().toISOString();
  const signaturePayload = {
    AppID: APP_ID,
    Domain: DOMAIN,
    LoginTime: loginTime,
  };
  const signatureMessage = JSON.stringify(signaturePayload);
  const signature = createSignature(signatureMessage);

  const body = {
    ...signaturePayload,
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
    data: maskSensitiveData(data),
  };
}

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
