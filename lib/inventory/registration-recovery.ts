// One registration form owns one attempt. Once a response is lost, subsequent
// submits only look up the original identity; they never silently POST again.
import type { LedgerSyncResult } from "./ledger-sync-contract";

export type RegistrationReply<T> = {
  ok?: boolean;
  data?: T;
  duplicateItem?: T;
  error?: string;
  message?: string;
  ledgerSync?: LedgerSyncResult;
};

export type RegistrationOutcome<T> =
  | { kind: "saved"; item: T; photoFailed: boolean; reply: RegistrationReply<T> }
  | { kind: "existing"; item: T; recovered: boolean }
  | { kind: "uncertain" }
  | { kind: "rejected"; response: Response; reply: RegistrationReply<T> }
  | { kind: "busy" };

export function createInventoryRegistration<T extends { id: number }>() {
  let busy = false;
  let recovery: (() => Promise<T | null>) | null = null;
  let settled: RegistrationOutcome<T> | null = null;
  const validItem = (item?: T): item is T => !!item && Number.isSafeInteger(item.id) && item.id > 0;

  return {
    async submit(options: {
      create: () => Promise<Response>;
      recover: () => Promise<T | null>;
      onConfirmed: (item: T, kind: "saved" | "existing") => void;
      refresh: (item: T) => Promise<unknown>;
      upload?: (itemId: number) => Promise<boolean>;
    }): Promise<RegistrationOutcome<T>> {
      if (busy) return { kind: "busy" };
      if (settled) return settled;
      busy = true;
      const refresh = async (item: T) => { try { await options.refresh(item); } catch { /* Registration already committed. */ } };
      const existing = async (item: T, recovered: boolean): Promise<RegistrationOutcome<T>> => {
        settled = { kind: "existing", item, recovered };
        options.onConfirmed(item, "existing");
        await refresh(item);
        return settled;
      };
      const recover = async (): Promise<RegistrationOutcome<T>> => {
        try {
          const item = await recovery?.();
          if (item && validItem(item)) return await existing(item, true);
        } catch { /* Keep the original attempt unresolved; do not POST again. */ }
        return { kind: "uncertain" };
      };
      try {
        if (recovery) return await recover();
        let response: Response;
        let reply: RegistrationReply<T>;
        try {
          response = await options.create();
          const decoded = await response.json();
          if (!decoded || typeof decoded !== "object") throw new Error("Invalid registration response");
          reply = decoded;
        } catch {
          recovery = options.recover;
          return await recover();
        }
        if (response.status === 409 &&
            ["inventory_item_duplicate_name_code", "inventory_item_duplicate_name_vi"].includes(reply.error ?? "") && validItem(reply.duplicateItem)) {
          return await existing(reply.duplicateItem, false);
        }
        if (response.status >= 500 || (response.ok && reply.ok && !validItem(reply.data))) {
          recovery = options.recover;
          return await recover();
        }
        if (!response.ok || !reply.ok || !validItem(reply.data)) return { kind: "rejected", response, reply };

        const item = reply.data;
        settled = { kind: "saved", item, photoFailed: false, reply };
        options.onConfirmed(item, "saved"); // Fix the ID before any photo/refresh await.
        const refreshed = refresh(item);
        let photoFailed = false;
        try {
          if (options.upload) photoFailed = !(await options.upload(item.id));
        } catch {
          photoFailed = true;
        }
        await refreshed;
        settled = { kind: "saved", item, photoFailed, reply };
        return settled;
      } finally {
        busy = false;
      }
    },
  };
}
