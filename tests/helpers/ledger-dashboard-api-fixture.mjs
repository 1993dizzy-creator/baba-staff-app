import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const compile = path => ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const cardCode = compile('lib/ledger/card-settlement-data.ts');


function queryKind(table, columns, filters) {
  const is = (key, value) => filters.some(([op, name, expected]) => op === 'eq' && name === key && expected === value);
  if (table === 'ledger_transactions') {
    if (columns === 'type,amount,economic_effect_sign,category_id') return is('type', 'expense_recognition') ? 'recognition' : 'profit';
    if (columns.startsWith('id,amount,economic_effect_sign')) return 'paidRoots';
    if (columns.startsWith('correction_of_id,amount')) return 'paidCorrections';
  }
  if (table === 'ledger_card_reconciliation_lines' && columns.includes('sale:')) return 'priorCardDeposits';
  if (table === 'ledger_movements') return is('transaction.type', 'opening') ? 'opening' : 'movements';
  if (table === 'ledger_reserve_plans') return 'reservePlans';
  if (table === 'ledger_reserve_entries') return 'reserveEntries';
  return table;
}

// Read-only Supabase double. The default cap, inclusive ranges, filters and
// multi-column ordering are enforced; shuffled input cannot accidentally pass.
export function dashboardApi(tables, { failKind, source = readFileSync('app/api/admin/ledger/route.ts','utf8'), denied = false } = {}) {
  const routeCode = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const spies = { inventoryDisplay:0, inventoryIssues:0, entries:0, reserveEntries:0 };
  const entriesModule = require('../../lib/ledger/entries.ts');
  const calls = [];
  const db = {
    from(table) {
      const filters = [], orders = [];
      let columns = '', from = 0, to = 999;
      const value = (row, key) => key.split('.').reduce((item, part) => item?.[part], row);
      const matches = row => filters.every(([op, key, expected]) => {
        const actual = value(row, key);
        switch (op) {
          case 'eq': return actual === expected;
          case 'neq': return actual !== expected;
          case 'gte': return actual >= expected;
          case 'lt': return actual < expected;
          case 'lte': return actual <= expected;
          case 'in': return expected.includes(actual);
          case 'not': return actual != null;
          case 'like': return new RegExp('^' + expected.split('%').join('.*') + '$').test(actual ?? '');
          default: throw Error('Unexpected filter ' + op);
        }
      });
      function execute(single = false) {
        const kind = queryKind(table, columns, filters);
        const call = { table, columns, kind, filters: [...filters], orders: [...orders], from, to };
        calls.push(call);
        if (kind === failKind && from >= 1000) return { data: null, error: { code: 'PAGE_FAILED', kind } };
        const rows = (tables[table] ?? []).filter(matches).sort((a, b) => {
          for (const [key, ascending] of orders) {
            const left = value(a, key), right = value(b, key);
            if (left !== right) return (left < right ? -1 : 1) * (ascending ? 1 : -1);
          }
          return 0;
        }).slice(from, Math.min(to + 1, from + 1000));
        call.ids = rows.map(row => row.id);
        const selected=rows.map(row=>project(row,columns));call.bytes=Buffer.byteLength(JSON.stringify(selected));
        return { data: single ? selected[0] ?? null : selected, error: null };
      }
      const query = {
        select(selection) { columns = selection; return query; },
        order(key, options = {}) { orders.push([key, options.ascending !== false]); return query; },
        range(start, end) { from = start; to = end; return query; },
        maybeSingle: async () => execute(true),
        then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
      };
      for (const op of ['eq', 'neq', 'gte', 'lt', 'lte', 'in', 'not', 'like']) {
        query[op] = (key, expected) => { filters.push([op, key, expected]); return query; };
      }
      return query;
    },
    rpc() { throw Error('RPC forbidden in this read-only test'); },
  };
  const cardModule = { exports: {} };
  const cardFunctions = require('../../lib/ledger/card-settlements.ts');
  new Function('require', 'module', 'exports', cardCode)(name => {
    if (name === '@/lib/supabase/server') return { supabaseServer: db };
    if (name === '@/lib/ledger/card-settlements') return cardFunctions;
    throw Error('Unexpected card dependency ' + name);
  }, cardModule, cardModule.exports);
  const dependencies = {
    '@/lib/supabase/server': { supabaseServer: db },
    '@/lib/ledger/server': { requireLedgerActor: async () => (denied ? { response:Response.json({ok:false},{status:403}) } : { actor: { id: 7, role: 'owner' } }), ledgerJson: (body, status = 200) => Response.json(body, { status }) },
    '@/lib/ledger/payroll-payment-groups': require('../../lib/ledger/payroll-payment-groups.ts'),
    '@/lib/ledger/entries-diagnostics': require('../../lib/ledger/entries-diagnostics.ts'),
    '@/lib/ledger/inventory-display': { withInventoryDisplay: async rows => {spies.inventoryDisplay++;return rows;}, loadInventoryProjectionIssues: async () => {spies.inventoryIssues++;return [];} },
    '@/lib/ledger/entries': { buildLedgerEntries: (...args) => {spies.entries++;return entriesModule.buildLedgerEntries(...args);}, buildReserveLedgerEntries: (...args) => {spies.reserveEntries++;return entriesModule.buildReserveLedgerEntries(...args);} },
    '@/lib/ledger/card-settlement-data': cardModule.exports,
    '@/lib/ledger/card-settlements': cardFunctions,
    '@/lib/common/business-time': {
      getBusinessDate: () => '2026-10-19',
      getBusinessMonthEndBoundary(month) {
        const date = new Date(month + '-01T00:00:00Z'); date.setUTCMonth(date.getUTCMonth() + 1);
        const businessDateExclusive = date.toISOString().slice(0, 10);
        return { businessDateExclusive, cutoffAt: businessDateExclusive + 'T03:00:00+07:00' };
      },
    },
  };
  for (const name of ['reserve-balances', 'fund-account-view', 'dashboard-cash-report', 'accrual-report', 'manual-entry-policy', 'payables', 'summary', 'cash-outflow']) {
    dependencies['@/lib/ledger/' + name] = require('../../lib/ledger/' + name + '.ts');
  }
  dependencies['@/lib/partners/emoji'] = require('../../lib/partners/emoji.ts');
  const routeModule = { exports: {} };
  new Function('require', 'module', 'exports', 'console', 'Date', routeCode)(name => {
    assert.ok(name in dependencies, 'Unexpected dependency ' + name);
    return dependencies[name];
  }, routeModule, routeModule.exports, { error() {} }, class extends Date { constructor(...args){super(...(args.length?args:['2026-10-19T06:00:00Z']));} });
  return {
    calls, spies,
    get: (month = '2026-09', scope = '') => routeModule.exports.GET(new Request('http://local/api/admin/ledger?month=' + month + scope)),
  };
}


function splitColumns(columns) {
  const parts=[];let depth=0,start=0;
  for(let i=0;i<columns.length;i++){if(columns[i]==='(')depth++;if(columns[i]===')')depth--;if(columns[i]===','&&depth===0){parts.push(columns.slice(start,i));start=i+1;}}
  parts.push(columns.slice(start));return parts;
}
function project(row,columns) {
  if(row==null)return row;if(Array.isArray(row))return row.map(r=>project(r,columns));
  const output={};for(const column of splitColumns(columns)){if(column==='*')return structuredClone(row);const open=column.indexOf('('),head=open<0?column:column.slice(0,open),key=head.split(':')[0].split('!')[0];if(Object.hasOwn(row,key))output[key]=open<0?row[key]:project(row[key],column.slice(open+1,-1));}return output;
}
