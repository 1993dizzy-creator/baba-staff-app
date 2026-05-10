import "server-only";
import crypto from "crypto";

const DEFAULT_BASE_URL = "https://graphapi.cukcuk.vn";

export type CukcukSignaturePayload = {
  AppID: string;
  Domain: string;
  LoginTime: string;
};

export type CukcukLoginRawResponse = {
  Code?: number;
  Data?: {
    Domain?: string;
    AppID?: string;
    AccessToken?: string;
    CompanyCode?: string;
    [key: string]: unknown;
  };
  Total?: number;
  Success?: boolean;
  ErrorType?: number;
  Message?: string;
  [key: string]: unknown;
};

export type CukcukLoginResult = {
  status: number;
  accessToken: string;
  companyCode: string;
  domain: string;
  appId: string;
  loginTime: string;
  raw: CukcukLoginRawResponse;
  request: {
    baseUrl: string;
    endpoint: string;
    domain: string;
    appId: string;
    loginTime: string;
  };
};

export class CukcukAuthError extends Error {
  status?: number;
  raw?: CukcukLoginRawResponse;

  constructor(
    message: string,
    options?: {
      status?: number;
      raw?: CukcukLoginRawResponse;
    }
  ) {
    super(message);
    this.name = "CukcukAuthError";
    this.status = options?.status;
    this.raw = options?.raw;
  }
}

function getRequiredEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new CukcukAuthError(`Missing environment variable: ${name}`);
  }

  return value;
}

function getBaseUrl() {
  return (process.env.CUKCUK_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
    /\/$/,
    ""
  );
}

export function createCukcukSignature(params: {
  appId: string;
  domain: string;
  loginTime: string;
  secretKey: string;
}) {
  const payload: CukcukSignaturePayload = {
    AppID: params.appId,
    Domain: params.domain,
    LoginTime: params.loginTime,
  };

  const message = JSON.stringify(payload);

  const signature = crypto
    .createHmac("sha256", params.secretKey)
    .update(message, "utf8")
    .digest("hex");

  return {
    payload,
    message,
    signature,
  };
}

export async function loginCukcuk(): Promise<CukcukLoginResult> {
  const baseUrl = getBaseUrl();
  const domain = getRequiredEnv("CUKCUK_DOMAIN");
  const appId = getRequiredEnv("CUKCUK_APP_ID");
  const secretKey = getRequiredEnv("CUKCUK_SECRET_KEY");

  const endpoint = "/api/Account/Login";
  const loginTime = new Date().toISOString();

  const { payload, signature } = createCukcukSignature({
    appId,
    domain,
    loginTime,
    secretKey,
  });

  const body = {
    ...payload,
    SignatureInfo: signature,
  };

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const raw = (await response.json()) as CukcukLoginRawResponse;

  if (!response.ok) {
    throw new CukcukAuthError(`CUKCUK login HTTP error: ${response.status}`, {
      status: response.status,
      raw,
    });
  }

  if (raw.Success !== true || raw.Code !== 200) {
    throw new CukcukAuthError("CUKCUK login failed", {
      status: response.status,
      raw,
    });
  }

  const accessToken = raw.Data?.AccessToken;
  const companyCode = raw.Data?.CompanyCode;

  if (!accessToken || !companyCode) {
    throw new CukcukAuthError("CUKCUK login response missing token data", {
      status: response.status,
      raw,
    });
  }

  return {
    status: response.status,
    accessToken,
    companyCode,
    domain,
    appId,
    loginTime,
    raw,
    request: {
      baseUrl,
      endpoint,
      domain,
      appId,
      loginTime,
    },
  };
}