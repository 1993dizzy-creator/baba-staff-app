import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { after, before } from "node:test";
import type {
  LegacySessionPayload,
  SessionPayloadV2,
} from "../lib/auth/session-token";

const sessionTokenModulePath = "../lib/auth/session-token.ts";
const {
  BABA_SESSION_ABSOLUTE_SECONDS,
  BABA_SESSION_IDLE_SECONDS,
  BABA_SESSION_REFRESH_MIN_INTERVAL_SECONDS,
  BABA_SESSION_REFRESH_WINDOW_SECONDS,
  createServerSessionPayload,
  createServerSessionToken,
  createServerSessionTokenFromPayload,
  refreshServerSessionPayload,
  verifyServerSessionToken,
} = await import(sessionTokenModulePath);

const originalSecret = process.env.BABA_SESSION_SECRET;
const TEST_SECRET = "test-session-secret-that-is-at-least-32-bytes-long";
const BASE_NOW = 1_800_000_000;

before(() => {
  process.env.BABA_SESSION_SECRET = TEST_SECRET;
});

after(() => {
  if (originalSecret === undefined) delete process.env.BABA_SESSION_SECRET;
  else process.env.BABA_SESSION_SECRET = originalSecret;
});

function signLegacy(payload: LegacySessionPayload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", TEST_SECRET)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

test("v2 issuance uses 30-day idle and 180-day absolute expirations", () => {
  const token = createServerSessionToken(42, BASE_NOW);
  assert.ok(Buffer.byteLength(token, "utf8") < 4096);
  const payload = verifyServerSessionToken(token, BASE_NOW);
  assert.deepEqual(payload, {
    v: 2,
    uid: "42",
    iat: BASE_NOW,
    refreshedAt: BASE_NOW,
    exp: BASE_NOW + BABA_SESSION_IDLE_SECONDS,
    absoluteExp: BASE_NOW + BABA_SESSION_ABSOLUTE_SECONDS,
  });
});

test("v2 verification rejects payload, signature, expiry, uid, and clock anomalies", () => {
  const validPayload = createServerSessionPayload(42, BASE_NOW);
  const validToken = createServerSessionTokenFromPayload(validPayload);
  const [encoded, signature] = validToken.split(".");

  assert.equal(verifyServerSessionToken(`${encoded}x.${signature}`, BASE_NOW), null);
  assert.equal(verifyServerSessionToken(`${encoded}.${signature.slice(0, -1)}x`, BASE_NOW), null);
  assert.equal(verifyServerSessionToken(validToken, validPayload.exp), null);

  const invalidUid = { ...validPayload, uid: "0" };
  assert.equal(
    verifyServerSessionToken(createServerSessionTokenFromPayload(invalidUid), BASE_NOW),
    null
  );

  const futureIat = {
    ...validPayload,
    iat: BASE_NOW + 301,
    refreshedAt: BASE_NOW + 301,
  };
  assert.equal(
    verifyServerSessionToken(createServerSessionTokenFromPayload(futureIat), BASE_NOW),
    null
  );

  const futureRefresh = {
    ...validPayload,
    refreshedAt: BASE_NOW + 301,
  };
  assert.equal(
    verifyServerSessionToken(
      createServerSessionTokenFromPayload(futureRefresh),
      BASE_NOW
    ),
    null
  );

  const absoluteExpired: SessionPayloadV2 = {
    ...validPayload,
    exp: BASE_NOW + 1,
    absoluteExp: BASE_NOW,
  };
  assert.equal(
    verifyServerSessionToken(
      createServerSessionTokenFromPayload(absoluteExpired),
      BASE_NOW
    ),
    null
  );
});

test("all positive user ids use the same v2 session format", () => {
  for (const userId of [1, 2, 3, 4, 5]) {
    const payload = verifyServerSessionToken(
      createServerSessionToken(userId, BASE_NOW),
      BASE_NOW
    );
    assert.equal(payload?.v, 2);
    assert.equal(payload?.uid, String(userId));
  }
});

test("secret is required and must be at least 32 bytes", () => {
  delete process.env.BABA_SESSION_SECRET;
  assert.throws(() => createServerSessionToken(42, BASE_NOW), /at least 32 bytes/);
  process.env.BABA_SESSION_SECRET = "too-short";
  assert.throws(() => createServerSessionToken(42, BASE_NOW), /at least 32 bytes/);
  process.env.BABA_SESSION_SECRET = TEST_SECRET;
});

test("sliding refresh starts at seven days and is limited to once per day", () => {
  const original = createServerSessionPayload(42, BASE_NOW);
  const eightDaysRemaining = original.exp - 8 * 24 * 60 * 60;
  assert.equal(refreshServerSessionPayload(original, eightDaysRemaining), null);

  const sevenDaysRemaining = original.exp - BABA_SESSION_REFRESH_WINDOW_SECONDS;
  const refreshed = refreshServerSessionPayload(original, sevenDaysRemaining);
  assert.ok(refreshed);
  assert.equal(refreshed.iat, original.iat);
  assert.equal(refreshed.absoluteExp, original.absoluteExp);
  assert.equal(refreshed.refreshedAt, sevenDaysRemaining);
  assert.equal(refreshed.exp, sevenDaysRemaining + BABA_SESSION_IDLE_SECONDS);

  const withinOneDay: SessionPayloadV2 = {
    ...refreshed,
    exp: refreshed.refreshedAt + BABA_SESSION_REFRESH_WINDOW_SECONDS,
  };
  assert.equal(
    refreshServerSessionPayload(
      withinOneDay,
      refreshed.refreshedAt + BABA_SESSION_REFRESH_MIN_INTERVAL_SECONDS - 1
    ),
    null
  );
});

test("sliding refresh never extends absolute expiration", () => {
  const payload: SessionPayloadV2 = {
    v: 2,
    uid: "42",
    iat: BASE_NOW,
    refreshedAt: BASE_NOW + 150 * 24 * 60 * 60,
    exp: BASE_NOW + 179 * 24 * 60 * 60,
    absoluteExp: BASE_NOW + BABA_SESSION_ABSOLUTE_SECONDS,
  };
  const now = BASE_NOW + 178 * 24 * 60 * 60;
  const refreshed = refreshServerSessionPayload(payload, now);
  assert.ok(refreshed);
  assert.equal(refreshed.absoluteExp, payload.absoluteExp);
  assert.equal(refreshed.exp, payload.absoluteExp);
  assert.equal(
    refreshServerSessionPayload(payload, payload.absoluteExp),
    null
  );
});

test("only a valid unexpired v1 token can migrate to v2", () => {
  const legacy: LegacySessionPayload = {
    v: 1,
    uid: "42",
    exp: BASE_NOW + 60,
  };
  const token = signLegacy(legacy);
  const verified = verifyServerSessionToken(token, BASE_NOW);
  assert.deepEqual(verified, legacy);

  const migrated = refreshServerSessionPayload(verified!, BASE_NOW);
  assert.deepEqual(migrated, createServerSessionPayload(42, BASE_NOW));
  assert.equal(verifyServerSessionToken(token, legacy.exp), null);
  assert.equal(
    verifyServerSessionToken(`${token.slice(0, -1)}x`, BASE_NOW),
    null
  );
});
