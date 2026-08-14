export type InventoryBootstrapStreamTiming = Record<string, number>;

export type InventoryBootstrapStreamEvent<TItem, TStatus, TKeg> =
  | { type: "items"; items: TItem[] }
  | {
      type: "enrichment";
      statusMap: Record<string, TStatus>;
      kegProgressMap: Record<string, TKeg>;
      activeKegTrackingItemIds: number[];
    }
  | { type: "complete"; timing: InventoryBootstrapStreamTiming }
  | {
      type: "error";
      stage: "enrichment";
      code: "inventory_bootstrap_enrichment_failed";
      timing: InventoryBootstrapStreamTiming;
    };

export type InventoryBootstrapStreamResult<TItem, TStatus, TKeg> = {
  items: TItem[];
  statusMap: Record<string, TStatus>;
  kegProgressMap: Record<string, TKeg>;
  activeKegTrackingItemIds: number[];
  timing: InventoryBootstrapStreamTiming | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseInventoryBootstrapStreamEvent<TItem, TStatus, TKeg>(
  line: string
) {
  const value = JSON.parse(line) as unknown;
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Invalid inventory bootstrap stream event");
  }
  if (value.type === "items" && Array.isArray(value.items)) {
    return value as InventoryBootstrapStreamEvent<TItem, TStatus, TKeg>;
  }
  if (
    value.type === "enrichment" &&
    isRecord(value.statusMap) &&
    isRecord(value.kegProgressMap) &&
    Array.isArray(value.activeKegTrackingItemIds)
  ) {
    return value as InventoryBootstrapStreamEvent<TItem, TStatus, TKeg>;
  }
  if (value.type === "complete" && isRecord(value.timing)) {
    return value as InventoryBootstrapStreamEvent<TItem, TStatus, TKeg>;
  }
  if (
    value.type === "error" &&
    value.stage === "enrichment" &&
    value.code === "inventory_bootstrap_enrichment_failed" &&
    isRecord(value.timing)
  ) {
    return value as InventoryBootstrapStreamEvent<TItem, TStatus, TKeg>;
  }
  throw new Error("Invalid inventory bootstrap stream event");
}

export async function readInventoryBootstrapStream<TItem, TStatus, TKeg>(
  response: Response,
  handlers: {
    onItems: (items: TItem[]) => void;
    onEnrichment: (event: {
      statusMap: Record<string, TStatus>;
      kegProgressMap: Record<string, TKeg>;
      activeKegTrackingItemIds: number[];
    }) => void;
  },
  signal?: AbortSignal
) {
  if (!response.body) {
    throw new Error("Inventory bootstrap stream body is unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawItems = false;
  let sawEnrichment = false;
  let sawComplete = false;
  let result: InventoryBootstrapStreamResult<TItem, TStatus, TKeg> = {
    items: [],
    statusMap: {},
    kegProgressMap: {},
    activeKegTrackingItemIds: [],
    timing: null,
  };

  const abort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", abort, { once: true });

  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const event = parseInventoryBootstrapStreamEvent<TItem, TStatus, TKeg>(line);
    if (event.type === "items") {
      if (sawItems) throw new Error("Duplicate inventory items stream event");
      sawItems = true;
      result = { ...result, items: event.items };
      handlers.onItems(event.items);
      return;
    }
    if (event.type === "enrichment") {
      if (!sawItems || sawEnrichment) {
        throw new Error("Out-of-order inventory enrichment stream event");
      }
      sawEnrichment = true;
      result = {
        ...result,
        statusMap: event.statusMap,
        kegProgressMap: event.kegProgressMap,
        activeKegTrackingItemIds: event.activeKegTrackingItemIds,
      };
      handlers.onEnrichment(event);
      return;
    }
    if (event.type === "error") {
      const error = new Error(event.code);
      Object.assign(error, { stage: event.stage, timing: event.timing });
      throw error;
    }
    if (!sawItems || !sawEnrichment || sawComplete) {
      throw new Error("Out-of-order inventory complete stream event");
    }
    sawComplete = true;
    result = { ...result, timing: event.timing };
  };

  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(consumeLine);
      if (done) break;
    }
    if (buffer.trim()) consumeLine(buffer);
    if (!sawItems || !sawEnrichment || !sawComplete) {
      throw new Error("Incomplete inventory bootstrap stream");
    }
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
