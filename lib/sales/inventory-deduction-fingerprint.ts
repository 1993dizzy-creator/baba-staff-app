import "server-only";

import { createHash } from "node:crypto";
import {
  getReceiptContentFingerprintCanonical,
  type ReceiptContentFingerprintInput,
} from "@/lib/sales/inventory-deduction-fingerprint-core";

export {
  buildReceiptContentFingerprintPayload,
  RECEIPT_CONTENT_FINGERPRINT_VERSION,
  type ReceiptContentFingerprintInput,
  type ReceiptContentFingerprintLineInput,
} from "@/lib/sales/inventory-deduction-fingerprint-core";

export function getReceiptContentFingerprint(
  input: ReceiptContentFingerprintInput
) {
  return createHash("sha256")
    .update(getReceiptContentFingerprintCanonical(input))
    .digest("hex");
}
