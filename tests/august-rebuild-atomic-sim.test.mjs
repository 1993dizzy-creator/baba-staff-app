// Disposable, SQLite-backed relational *simulation*, NOT PostgreSQL contract testing.
// The actual production-compatible PostgreSQL RPC remains blocked until local
// PostgreSQL (or PGlite) and matching fixture are available.
import assert from 'node:assert/strict';
import nodeTest from 'node:test';
let DatabaseSync;
try { ({DatabaseSync}=await import('node:sqlite')); } catch { /* optional Node 22+ test engine */ }
const test=(name,fn)=>nodeTest(name,{skip:!DatabaseSync},fn);

const BASELINE = {cash:51_502_786_000,cho:46_343_661_000,bank:222_917_683_000,vuong:6_774_110_000};
const accounts=[[1,'cash',BASELINE.cash],[2,'bank',BASELINE.bank],[3,'cho',BASELINE.cho],[5,'vuong',BASELINE.vuong]];
function database(){
  const db=new DatabaseSync(':memory:');
  db.exec(`pragma foreign_keys=on;
    create table funds(id integer primary key, name text unique not null, amount_milli integer not null);
    create table transactions(id integer primary key, source_key text unique not null, type text not null, amount_milli integer not null, status text not null);
    create table movements(id integer primary key, transaction_id integer not null references transactions(id) on delete restrict, fund_id integer not null references funds(id), amount_milli integer not null check(amount_milli<>0), unique(transaction_id,fund_id));
    create table payable(id integer primary key,source_transaction_id integer references transactions(id) on delete restrict,original_amount_milli integer,status text);
    create table payable_allocations(id integer primary key,payable_id integer references payable(id) on delete restrict,payment_transaction_id integer references transactions(id) on delete restrict,amount_milli integer not null);
    create table audit(id integer primary key,action text,transaction_id integer references transactions(id) on delete restrict);
    create table runs(id text primary key,manifest_digest text not null,status text not null);
  `);
  const insert=db.prepare('insert into funds(id,name,amount_milli) values(?,?,?)');
  for(const a of accounts)insert.run(...a);
  db.exec(`insert into transactions(id,source_key,type,amount_milli,status) values(20,'inventory:20','expense',11880000000,'confirmed'),(1090,'payable:1090','payable_payment',8487500000,'confirmed');
    insert into payable(id,source_transaction_id,original_amount_milli,status) values(15,20,126000000,'paid');
    insert into payable_allocations(id,payable_id,payment_transaction_id,amount_milli) values(6,15,1090,126000000);
    insert into audit(action,transaction_id) values('original',20);
  `);
  return db;
}
function q(db,s){return db.prepare(s).all()}
function snapshot(db){return {
  funds:q(db,'select * from funds order by id'),
  original:q(db,'select * from transactions where id in(20,1090) order by id'),
  payables:q(db,'select * from payable order by id'),
  allocations:q(db,'select * from payable_allocations order by id'),
  originalAudit:q(db,"select * from audit where action='original' order by id"),
};}
function event(id,source_key,flows,type='correction'){
  return {id,source_key,type,movements:flows.map(([fundId,milli])=>({fundId,milli}))};
}
function apply(db,runId,digest,events,{onAfterInsert=null,expectedCash=null}={}){
  db.exec('BEGIN IMMEDIATE');
  try{
    const existing=db.prepare('select manifest_digest,status from runs where id=?').get(runId);
    if(existing){
      if(existing.manifest_digest!==digest)throw new Error('IDEMPOTENCY_CONFLICT');
      if(existing.status!=='applied')throw new Error('RUN_ALREADY_REVERSED');
      db.exec('COMMIT');return 'already_applied';
    }
    db.prepare("insert into runs values(?,?,'applying')").run(runId,digest);
    let eventCount=0;
    for(const e of events){
      if(e.type==='correction')assert.equal(e.movements.length,1);
      if(e.type==='transfer'){
        assert.equal(e.movements.length,2);
        assert.equal(e.movements[0].milli+e.movements[1].milli,0);
        assert.notEqual(e.movements[0].fundId,e.movements[1].fundId);
      }
      const sum=e.movements.reduce((x,m)=>x+m.milli,0);
      db.prepare("insert into transactions(id,source_key,type,amount_milli,status) values(?,?,?,0,'confirmed')").run(e.id,e.source_key,e.type);
      for(const m of e.movements){
        assert.ok(Number.isSafeInteger(m.milli) && m.milli!==0);
        db.prepare('insert into movements(transaction_id,fund_id,amount_milli) values(?,?,?)').run(e.id,m.fundId,m.milli);
        db.prepare('update funds set amount_milli=amount_milli+? where id=?').run(m.milli,m.fundId);
      }
      db.prepare('insert into audit(action,transaction_id) values(?,?)').run('aug_rebuild_applied',e.id);
      eventCount++;
      if(onAfterInsert)onAfterInsert(eventCount);
    }
    if(expectedCash!==null&&db.prepare('select amount_milli a from funds where id=1').get().a!==expectedCash)throw new Error('CLOSING_FUNDS_MISMATCH');
    db.prepare("update runs set status='applied' where id=?").run(runId);
    db.exec('COMMIT');return 'applied';
  }catch(e){db.exec('ROLLBACK');throw e;}
}
function reverse(db,runId,events,reason){
  db.exec('BEGIN IMMEDIATE');
  try{
    const run=db.prepare('select status from runs where id=?').get(runId);
    if(run?.status==='reversed'){db.exec('COMMIT');return 'already_reversed';}
    if(run?.status!=='applied')throw new Error('RUN_NOT_APPLIED');
    for(const e of [...events].reverse()){
      // Retain each original transaction and cash record: reversal is append-only.
      const rId=e.id+100000;
      db.prepare("insert into transactions(id,source_key,type,amount_milli,status) values(?,?, 'correction',0,'confirmed')").run(rId,`reverse:${runId}:${e.id}`);
      for(const m of e.movements){
        db.prepare('insert into movements(transaction_id,fund_id,amount_milli) values(?,?,?)').run(rId,m.fundId,-m.milli);
        db.prepare('update funds set amount_milli=amount_milli-? where id=?').run(m.milli,m.fundId);
      }
      db.prepare('insert into audit(action,transaction_id) values(?,?)').run('aug_rebuild_reversed',rId);
    }
    db.prepare("update runs set status='reversed' where id=?").run(runId);
    db.exec('COMMIT');return 'reversed';
  }catch(e){db.exec('ROLLBACK');throw e;}
}
const SAMPLE=[event(1001,'aug-rebuild:run:transfer',[[1,-100000],[3,100000]],'transfer'),
  event(1002,'aug-rebuild:run:ship',[[1,-50000]])];

test('append-only correction and transfer preserve original ledger, allocations and audit',()=>{
 const db=database();const before=snapshot(db);
 assert.equal(apply(db,'run','hash',SAMPLE,{expectedCash:BASELINE.cash-150000}),'applied');
 const after=snapshot(db);
 assert.deepEqual(after.original,before.original);
 assert.deepEqual(after.payables,before.payables);
 assert.deepEqual(after.allocations,before.allocations);
 assert.deepEqual(after.originalAudit,before.originalAudit);
 assert.equal(db.prepare('select count(*) n from transactions').get().n,4);
 assert.equal(db.prepare('select count(*) n from movements').get().n,3);
 assert.equal(db.prepare('select amount_milli n from funds where id=3').get().n,BASELINE.cho+100000);
 assert.equal(db.prepare('select count(*) n from transactions where type=\'expense\'').get().n,1);
 db.close();
});

test('same-key retry is idempotent and conflicting payload is rejected',()=>{
 const db=database();apply(db,'run','hash',SAMPLE);
 const n=db.prepare('select count(*) n from movements').get().n;
 assert.equal(apply(db,'run','hash',SAMPLE),'already_applied');
 assert.equal(db.prepare('select count(*) n from movements').get().n,n);
 assert.throws(()=>apply(db,'run','DIFFERENT',SAMPLE),/IDEMPOTENCY_CONFLICT/);
 assert.equal(db.prepare('select count(*) n from movements').get().n,n);
 db.close();
});

test('foreign-key failure rolls back earlier inserted event AND audit',()=>{
 const db=database();const before=snapshot(db);
 const bad=[...SAMPLE,event(1003,'bad-unknown-account',[[9,1000]])];
 assert.throws(()=>apply(db,'run','h',bad),/FOREIGN KEY/);
 assert.deepEqual(snapshot(db),before);
 assert.equal(db.prepare('select count(*) n from movements').get().n,0);
 assert.equal(db.prepare('select count(*) n from runs').get().n,0);
 assert.equal(db.prepare('select count(*) n from audit').get().n,1);
 db.close();
});

test('failure injection rolls back ALL changes including generated keys',()=>{
 const db=database();const before=snapshot(db);
 assert.throws(()=>apply(db,'run','h',SAMPLE,{onAfterInsert:n=>{if(n===1)throw Error('synthetic-interruption')}}),/synthetic-interruption/);
 assert.deepEqual(snapshot(db),before);
 assert.equal(db.prepare('select count(*) n from runs').get().n,0);
 db.close();
});

test('wrong final balance rolls back full batch, not even one partial correction',()=>{
 const db=database();const before=snapshot(db);
 assert.throws(()=>apply(db,'run','h',SAMPLE,{expectedCash:BASELINE.cash}),/CLOSING_FUNDS_MISMATCH/);
 assert.deepEqual(snapshot(db),before);
 assert.equal(db.prepare('select count(*) n from movements').get().n,0);
 db.close();
});

test('one invalid transfer sign rolls back all rows',()=>{
 const db=database();
 const bad=[event(1000,'aug-rebuild:bad',[[1,-100],[3,50]],'transfer')];
 assert.throws(()=>apply(db,'run','hash',bad),/50 !== 0/);
 assert.equal(db.prepare('select count(*) n from runs').get().n,0);
 db.close();
});

test('append-only compensation returns balances exactly without deleting original data',()=>{
 const db=database();const before=snapshot(db);
 apply(db,'run','hash',SAMPLE);
 const n=db.prepare('select count(*) n from movements').get().n;
 assert.equal(reverse(db,'run',SAMPLE,'approved'),'reversed');
 assert.deepEqual(snapshot(db),before);
 assert.equal(db.prepare('select count(*) n from movements').get().n,2*n);
 assert.equal(reverse(db,'run',SAMPLE,'approved'),'already_reversed');
 assert.throws(()=>apply(db,'run','hash',SAMPLE),/RUN_ALREADY_REVERSED/);
 db.close();
});

test('reverse attempt against uncommitted/unknown run is blocked',()=>{
 const db=database();const before=snapshot(db);
 assert.throws(()=>reverse(db,'unknown',SAMPLE,'approved'),/RUN_NOT_APPLIED/);
 assert.deepEqual(snapshot(db),before);
 db.close();
});
