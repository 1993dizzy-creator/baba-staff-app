import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
const nativeRequire=createRequire(import.meta.url);
function compile(path,mocks) {
  const mod={exports:{}};
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  new Function('require','module','exports',code)(name=>name in mocks?mocks[name]:nativeRequire(name),mod,mod.exports);
  return mod.exports;
}
const {calculatePartTimeExtraWork}=compile('lib/payroll/part-time-extra-work.ts',{});
const candidate=calculatePartTimeExtraWork({payType:'hourly',attendanceRecordId:101,userId:7,businessDate:'2026-10-01',
  checkInAt:'2026-10-01T17:45:00+07:00',checkOutAt:'2026-10-01T23:15:00+07:00',
  contractId:11,contractRevision:3,minuteRateAmount:35000/60,hourlyRateAmount:35000,
  scheduleId:21,scheduleRevision:4,scheduleStartTime:'18:00',scheduleEndTime:'23:00',storeSettingId:31,storeSettingRevision:5,storeOpenTime:'16:00',storeCloseTime:'01:00'});
function api(options={}) {
  const calls=[];
  const routes=compile('app/api/admin/payroll/part-time-extra-work/route.ts',{
    '@/lib/supabase/server':{supabaseServer:{rpc:async(name,args)=>{calls.push({name,args});return {data:options.result??{status:'created'},error:options.error??null};}}},
    '@/lib/payroll/monthly-run':{validPayrollMonth:v=>/^2026-\d\d$/.test(v)?v:null},
    '@/lib/payroll/overview-server':{loadPayrollOverview:async()=>({employees:[{partTimeExtraWork:options.noCandidate?[]:[candidate]}]})},
    '@/lib/payroll/server':{requirePayrollActor:async()=>options.forbidden?{response:Response.json({code:'FORBIDDEN'},{status:403})}:{actor:{id:1}},payrollJson:(body,status=200)=>Response.json(body,{status})},
    '@/lib/payroll/paid-extra-work':{},
  });
  return {routes,calls};
}
const request=body=>new Request('http://local/api/admin/payroll/part-time-extra-work',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({month:'2026-10',attendanceRecordId:101,decision:'approved',sourceHash:candidate.sourceHash,...body})});
test('approval API sends recalculated October sum and snapshot, ignoring client amounts',async()=>{
  const {routes,calls}=api();
  assert.equal((await routes.POST(request({candidateMinutes:999,candidateAmount:999}))).status,200);
  assert.equal(calls.length,1);
  assert.equal(calls[0].args.p_candidate_minutes,30);
  assert.equal(calls[0].args.p_before_schedule_minutes,15);
  assert.equal(calls[0].args.p_after_schedule_minutes,15);
  assert.equal(calls[0].args.p_candidate_amount,17500);
  assert.deepEqual(calls[0].args.p_source_snapshot,candidate.sourceSnapshot);
  assert.equal(calls[0].args.p_source_hash,candidate.sourceHash);
});
test('approval API blocks stale/missing candidates and non-admin callers before mutation',async()=>{
  for(const [options,body,status] of [[{}, {sourceHash:'b'.repeat(64)},409],[{noCandidate:true},{},404],[{forbidden:true},{},403]]) {
    const {routes,calls}=api(options);
    assert.equal((await routes.POST(request(body))).status,status);
    assert.equal(calls.length,0);
  }
});
test('approval API maps paid payroll lock and cancels through the audit RPC',async()=>{
  const locked=api({error:{message:'PAYROLL_EXTRA_WORK_LOCKED_FOR_PAID_EMPLOYEE'}});
  assert.equal((await locked.routes.POST(request({}))).status,409);
  const {routes,calls}=api();
  assert.equal((await routes.DELETE(request({cancellationReason:'manager review'}))).status,200);
  assert.equal(calls[0].name,'payroll_admin_cancel_part_time_extra_work_decision_v1');
  assert.equal(calls[0].args.p_attendance_record_id,101);
  assert.equal(calls[0].args.p_reason,'manager review');
});
test('rendered expanded UI distinguishes included early work from historical metadata and locks paid actions',()=>{
  const React=nativeRequire('react');
  const {renderToStaticMarkup}=nativeRequire('react-dom/server');
  const render=(row,paid=false,lang='ko')=>{
    let index=0;
    const values=[null,'',true,101];
    const Component=compile('components/payroll/PartTimeExtraWorkSection.tsx',{
      react:{...React,useState:()=>[values[index++],()=>{}],useLayoutEffect:()=>{},useRef:()=>({current:null})},
      '@/lib/payroll/payroll-page-money':{formatVnd:v=>`${v}₫`},
      './PartTimeExtraWorkSection.module.css':{default:{}},
    }).default;
    return renderToStaticMarkup(React.createElement(Component,{employee:{userId:7,partTimeExtraWork:[row],amounts:{partTimeExtraWorkAmount:0},payment:paid?{payment_status:'paid'}:null},month:'2026-10',lang,refresh:async()=>true}));
  };
  const html=render(candidate);
  assert.match(html,/조기근무 \(후보 포함\)/);
  assert.match(html,/30분/);
  assert.match(html,/승인 후에만 수당/);
  assert.match(render(candidate,false,'vi'),/Trước ca \(được tính\)/);
  const historical={...candidate,candidateMinutes:15,sourceSnapshot:{...candidate.sourceSnapshot,extraWorkPolicy:undefined}};
  assert.match(render(historical),/조기출근 \(후보 제외\)/);
  assert.match(render({...candidate,sourceSnapshot:{}},true),/조기근무 \(후보 포함\)/);
  assert.match(render(candidate,true),/disabled=""/);
  assert.match(render(candidate,true),/지급 완료 직원/);
});

test('approval API returns conflict when attendance becomes stale during the database lock wait',async()=>{
  const {routes,calls}=api({error:{message:'PAYROLL_EXTRA_WORK_STALE_SOURCE'}});
  const response=await routes.POST(request({}));
  assert.equal(response.status,409);
  assert.equal((await response.json()).code,'PAYROLL_EXTRA_WORK_STALE');
  assert.equal(calls.length,1);
});


test('cancellation API preserves Production cancelled/not_active payloads and paid conflict mapping',async()=>{
  for(const result of [{id:101,status:'cancelled'},{status:'not_active'}]) {
    const {routes,calls}=api({result});
    const response=await routes.DELETE(request({cancellationReason:'manager reason'}));
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{ok:true,decision:result});
    assert.equal(calls.length,1);
  }
  const locked=api({error:{message:'PAYROLL_EXTRA_WORK_LOCKED_FOR_PAID_EMPLOYEE'}});
  const paid=await locked.routes.DELETE(request({cancellationReason:'manager reason'}));
  assert.equal(paid.status,409);
  assert.equal((await paid.json()).code,'PAYROLL_EMPLOYEE_ALREADY_PAID');
  const missing=api();
  assert.equal((await missing.routes.DELETE(request({cancellationReason:' '}))).status,400);
  assert.equal(missing.calls.length,0);
});
