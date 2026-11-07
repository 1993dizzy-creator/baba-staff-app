// Reproduce repository-defined RPC bodies for local verification and fail-closed SQL guards.
// Reads SQL text only. Does not install a function or connect to a database.
import {readFileSync} from 'node:fs';
import {sha} from './july-restore-phase2.mjs';
const read=n=>readFileSync(new URL('../../supabase/migrations/'+n,import.meta.url),'utf8').replaceAll('\r\n','\n');
const unquote=s=>s.replaceAll("''","'");
function functionFrom(text,name){
 const start=text.search(new RegExp('create (?:or replace )?function '+name.replaceAll('.','\\.')+'\\('));
 if(start<0)throw Error('RPC_SOURCE_ABSENT:'+name);
 const rest=text.slice(start),m=rest.match(/as \$\$([\s\S]*?)\$\$;/);
 if(!m)throw Error('RPC_BODY_ABSENT:'+name);
 return {sql:rest.slice(0,m.index+m[0].length),body:m[1]};
}
function replaceKnown(body,a,b){if(!body.includes(a))throw Error('RPC_PATCH_ANCHOR');return body.replaceAll(a,()=>b);}
export function rpcContracts(){
 const projection=read('20260906114438_project_inventory_purchase_logs.sql');
 const original=functionFrom(read('202608210003_add_inventory_purchase_candidates.sql'),'public.ledger_resolve_inventory_candidate_v1');
 const lockSection=projection.split("v_oid := 'public.ledger_resolve_inventory_candidate_v1")[1].split("v_oid := 'public.ledger_sync")[0];
 let resolver=replaceKnown(original.body,unquote(lockSection.match(/v_anchor := '((?:[^']|'')*)';/)[1]),lockSection.match(/v_preamble := \$patch\$([\s\S]*?)\$patch\$;/)[1]+unquote(lockSection.match(/v_anchor := '((?:[^']|'')*)';/)[1]));
 const verification=read('20260921170100_add_inventory_payment_verification.sql');
 for(const m of verification.split('  -- The current reconciliation')[0].matchAll(/v_definition := replace\(v_definition,\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'\);/g))resolver=replaceKnown(resolver,unquote(m[1]),unquote(m[2]));
 if(sha(resolver)!=='edcfb9d5429307c6fa0690d8d89cfa005b02b8fd13749fab480793b32ed7c4d5')throw Error('OWNER_OBSERVED_RESOLVER_DIGEST');
 const syncOriginal=functionFrom(projection,'inventory_ledger_private.sync_candidate');let sync=syncOriginal.body;
 const syncPatch=verification.split("v_oid := 'inventory_ledger_private.sync_candidate")[1].split('  -- Rebooking')[0];
 sync=replaceKnown(sync,syncPatch.match(/v_guard := \$guard\$([\s\S]*?)\$guard\$;/)[1],'');
 for(const m of syncPatch.matchAll(/v_definition := replace\(v_definition,\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'\);/g))sync=replaceKnown(sync,unquote(m[1]),unquote(m[2]));
 const gas=read('20261010180457_scope_gas_inventory_purchase_category.sql'),anchor=gas.match(/anchor text := \$anchor\$([\s\S]*?)\$anchor\$/)[1];
 sync=replaceKnown(sync,anchor,anchor+gas.match(/addition text := \$addition\$([\s\S]*?)\$addition\$/)[1]);
 const display=read('20261019184037_sync_inventory_display_category_to_ledger.sql');
 const displayAnchor=display.match(/\$a1\$([\s\S]*?)\$a1\$/)[1];
 sync=replaceKnown(sync,displayAnchor,display.match(/\$b1\$([\s\S]*?)\$b1\$/)[1]+displayAnchor);
 const manual=functionFrom(read('20261031070537_meal_adjustment_original_business_date.sql'),'public.ledger_create_manual_transaction_v1');
 const lockOriginal=functionFrom(projection,'inventory_ledger_private.lock_sources');
 // The correction-origin patch normalizes child keys to the purchase root before
 // deduplication and source/month/ledger locking. Keep every other lock unchanged.
 const correction=read('20260914161954_link_inventory_purchase_corrections.sql');
 const lockPatch=correction.match(/v_definition := replace\(v_definition,\$anchor\$([\s\S]*?)\$anchor\$,\$replacement\$([\s\S]*?)\$replacement\$\);/);
 if(!lockPatch)throw Error('LOCK_CORRECTION_PATCH_ABSENT');
 const lockBody=replaceKnown(lockOriginal.body,lockPatch[1],lockPatch[2]);
 if(sha(lockBody)!=='df9b3ce8ceb8a3f754ca504aeaef6f3274c51ab997c899fe3fb9c76dc2556739')throw Error('OWNER_OBSERVED_LOCK_DIGEST');
 const lock={body:lockBody,sql:lockOriginal.sql.replace(lockOriginal.body,()=>lockBody)};
 const economics=functionFrom(read('20261030150000_inventory_purchase_billed_amount.sql'),'inventory_ledger_private.economics');
 return {
  resolver:{signature:'public.ledger_resolve_inventory_candidate_v1(bigint,text,bigint,bigint,bigint,date,text,text,bigint)',body:resolver,sql:original.sql.replace(original.body,()=>resolver),hash:sha(resolver)},
  manual:{...manual,signature:'public.ledger_create_manual_transaction_v1(text,timestamptz,date,numeric,bigint,bigint,bigint,bigint,text,text,bigint,text)',hash:sha(manual.body)},
  sync:{signature:'inventory_ledger_private.sync_candidate(jsonb,bigint)',body:sync,sql:syncOriginal.sql.replace(syncOriginal.body,()=>sync),hash:sha(sync)},
  lock:{...lock,signature:'inventory_ledger_private.lock_sources(text[],date[])',hash:sha(lock.body)},
  economics:{...economics,signature:'inventory_ledger_private.economics(jsonb)',hash:sha(economics.body)},
 };
}
