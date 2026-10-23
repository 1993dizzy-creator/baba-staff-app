// Diagnostics for GET /api/admin/ledger?scope=entries only. Records when each
// fixed base_reads query group settles and how many 1,000-row pages it read.
// Output is fixed names, durations and counts: no URLs, filters, ids, amounts,
// row data or user data. Query order and results are never changed.

export const ENTRIES_SLOW_LOG_MS = 3000;
const PAGE_SIZE = 1000;

export const ENTRIES_QUERY_GROUPS = ["mtx", "mcor", "pexp", "pcor", "prof", "card", "fund", "ref", "cand"] as const;
export type EntriesQueryGroup = typeof ENTRIES_QUERY_GROUPS[number];

type GroupTiming = { endMs: number; pages: number };
type EventLoopUtilization = { idle: number; active: number; utilization: number };
type PerformanceWithElu = Performance & { eventLoopUtilization?: (a?: EventLoopUtilization, b?: EventLoopUtilization) => EventLoopUtilization };

// Function-instance counters: the n-th request served and the idle gap before it.
let instanceRequests = 0;
let instanceLastRequestAt = 0;

const clock = () => performance.now();
const round = (value: number) => Math.round(value);

// Rows of a page loader that stops at the first short page => pages read.
function pagesFor(value: unknown) {
  const rows = Array.isArray(value) ? value : (value as { data?: unknown } | null)?.data;
  return Array.isArray(rows) ? Math.floor(rows.length / PAGE_SIZE) + 1 : 1;
}

export function createEntriesDiagnostics() {
  const now = Date.now();
  instanceRequests += 1;
  const instance = { request: instanceRequests, idleSeconds: instanceLastRequestAt ? round((now - instanceLastRequestAt) / 1000) : -1 };
  instanceLastRequestAt = now;
  const elu = (performance as PerformanceWithElu).eventLoopUtilization;
  const groups = new Map<EntriesQueryGroup, GroupTiming>();
  let baseStartedAt = 0;
  let eluStart: EventLoopUtilization | undefined;
  let eventLoop: number | null = null;

  const record = (group: EntriesQueryGroup, pages: number) => {
    const endMs = clock() - baseStartedAt;
    const current = groups.get(group);
    groups.set(group, { endMs: Math.max(current?.endMs ?? 0, endMs), pages: (current?.pages ?? 0) + pages });
  };

  return {
    startBaseReads() {
      baseStartedAt = clock();
      eluStart = elu?.call(performance);
    },
    endBaseReads() {
      eventLoop = eluStart && elu ? elu.call(performance, elu.call(performance), eluStart).utilization : null;
    },
    // Settles exactly like the original. Lazy on purpose: a Supabase query builder
    // only runs once subscribed, so subscribing here (instead of when Promise.all
    // does) would change the order in which queries are sent.
    group<P extends PromiseLike<unknown>>(group: EntriesQueryGroup, promise: P): PromiseLike<Awaited<P>> {
      return {
        then(onFulfilled, onRejected) {
          return (promise as PromiseLike<Awaited<P>>).then(
            (value) => { record(group, pagesFor(value)); return value; },
            (error: unknown) => { record(group, 0); throw error; },
          ).then(onFulfilled, onRejected);
        },
      };
    },
    // The month detail pages settle before its linked meal corrections, which
    // need the page ids; "p" for corrections is the number of requests.
    monthPagesLoaded(pages: number) {
      record("mtx", pages);
    },
    monthCorrectionsLoaded(requests: number) {
      record("mcor", requests);
    },
    serverTiming() {
      const tokens = ENTRIES_QUERY_GROUPS.flatMap((group) => {
        const timing = groups.get(group);
        return timing ? [`bq_${group};dur=${timing.endMs.toFixed(2)};desc="p${timing.pages}"`] : [];
      });
      if (eventLoop != null) tokens.push(`diag_elu;desc="${eventLoop.toFixed(2)}"`);
      tokens.push(`diag_inst;desc="r${instance.request} g${instance.idleSeconds}"`);
      return tokens;
    },
    // One line for slow requests only; stages are the existing Server-Timing values.
    logIfSlow(month: string, stages: ReadonlyArray<readonly [string, number]>, totalMs: number) {
      if (totalMs < ENTRIES_SLOW_LOG_MS) return false;
      console.warn("[ledger-entries-slow]", JSON.stringify({
        v: 1,
        at: new Date(now).toISOString(),
        month,
        totalMs: round(totalMs),
        stages: Object.fromEntries(stages.map(([name, ms]) => [name, round(ms)])),
        groups: Object.fromEntries([...groups].map(([group, timing]) => [group, [round(timing.endMs), timing.pages]])),
        elu: eventLoop == null ? null : Number(eventLoop.toFixed(2)),
        instance: [instance.request, instance.idleSeconds],
      }));
      return true;
    },
  };
}

export type EntriesDiagnostics = ReturnType<typeof createEntriesDiagnostics>;
