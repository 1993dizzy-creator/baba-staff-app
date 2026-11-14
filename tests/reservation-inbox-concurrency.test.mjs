// Real PostgreSQL, independent connections and observed lock waits. No env DB URL is read.
// Local binary setup (ignored): npm.cmd --cache .local/npm-cache install --prefix .local/pg-tools --no-audit --no-fund embedded-postgres@18.6.0-beta.19
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import pg from 'pg';
import { BABA_TABLES } from '../lib/sales/baba-table-catalog.ts';
import { users, original, hardening, input } from './helpers/reservation-hardening-fixture.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const rawRpc=async (client,name,args) => (await client.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;
const make=async (client,extra={}) => (await rawRpc(client,'reservation_create_v1',[4,JSON.stringify(input(extra))])).reservation;

test('real PostgreSQL concurrency: confirm, edit, table exclusion/rollback, Inbox create and request-key idempotency', {timeout:60000}, async t => {
  const platform=process.platform==='win32'?'windows':process.platform;
  const bin=path.resolve(process.env.BABA_RESERVATION_PG_BIN || `.local/pg-tools/node_modules/@embedded-postgres/${platform}-${process.arch}/native/bin`);
  const exe=name=>path.join(bin,name+(process.platform==='win32'?'.exe':''));
  assert.ok(existsSync(exe('initdb')), 'Install the pinned local-only test binaries using the command at the top of this file');
  const root=path.resolve('.local/reservation-phase1');mkdirSync(root,{recursive:true});
  const dir=mkdtempSync(path.join(root,'pg-'));const logs=[];
  const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  Object.assign(env,{TEMP:dir,TMP:dir,HOME:dir,USERPROFILE:dir});
  const init=execFileSync(exe('initdb'),['-D',dir,'--auth=trust','--username=baba_test','--locale=C','--encoding=UTF8'],{env,windowsHide:true,encoding:'utf8'});
  logs.push(init);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const child=spawn(exe('postgres'),['-D',dir,'-h','127.0.0.1','-p',String(port)],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>logs.push(b.toString()));child.stderr.on('data',b=>logs.push(b.toString()));
  const config={host:'127.0.0.1',port,user:'baba_test',database:'postgres',connectionTimeoutMillis:500,statement_timeout:8000};
  const clients=[];let admin;
  try {
    for(let i=0;i<100;i++) {
      const candidate=new pg.Client(config);
      try { await candidate.connect();admin=candidate;break; }
      catch { await candidate.end().catch(()=>{});await delay(30); }
    }
    assert.ok(admin,logs.join('\n'));
    clients.push(admin);
    await admin.query(users);await admin.query(original);await admin.query(hardening);
    t.diagnostic((await admin.query('select version() v')).rows[0].v);
    const a=new pg.Client(config), b=new pg.Client(config);
    await a.connect();clients.push(a);await b.connect();clients.push(b);
    const bpid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
    async function race(first,second) {
      await a.query('begin');await a.query('set local role service_role');
      await b.query('begin');await b.query('set local role service_role');
      let waiting;
      try {
        const winner=await first(a);
        waiting=second(b);waiting.catch(()=>{});
        let blocked=false;
        for(let n=0;n<150;n++) {
          const row=(await admin.query('select wait_event_type from pg_stat_activity where pid=$1',[bpid])).rows[0];
          if(row?.wait_event_type==='Lock') { blocked=true;break; }
          await delay(10);
        }
        assert.ok(blocked,'second connection must actually wait on an uncommitted first transaction');
        await a.query('commit');
        const loser=await waiting;await b.query('commit');
        return [winner,loser];
      } finally {
        await a.query('rollback');await b.query('rollback');
        if(waiting) await waiting.catch(()=>{});
      }
    }
    await t.test('same version confirmation commits once with one historical confirmation',async()=>{
      const r=await make(admin);
      const [x,y]=await race(c=>rawRpc(c,'reservation_transition_v1',[5,r.id,1,'confirmed',null]),c=>rawRpc(c,'reservation_transition_v1',[4,r.id,1,'confirmed',null]));
      assert.equal(x.status,'ok');assert.equal(y.status,'version_conflict');
      const history=(await admin.query("select * from reservation_private.reservation_events where reservation_id=$1 and event_type='status_changed'",[r.id])).rows;
      assert.equal(history.length,1);assert.equal(Number(history[0].actor_user_id),5);
    });
    await t.test('same version edit commits once; loser cannot overwrite',async()=>{
      const r=await make(admin);
      const [x,y]=await race(c=>rawRpc(c,'reservation_update_v1',[4,r.id,1,JSON.stringify({partySize:6})]),c=>rawRpc(c,'reservation_update_v1',[4,r.id,1,JSON.stringify({partySize:9})]));
      assert.equal(x.status,'ok');assert.equal(y.status,'version_conflict');
      assert.deepEqual((await admin.query('select party_size,version from reservation_private.reservations where id=$1',[r.id])).rows,[{party_size:6,version:2}]);
    });
    await t.test('same reservation/version assignment commits once, and stale second assignment creates no link',async()=>{
      const r=await make(admin,{reservedAt:'2026-11-17T19:00:00+07:00'});
      const [x,y]=await race(c=>rawRpc(c,'reservation_link_table_v1',[4,r.id,1,BABA_TABLES[2].MapObjectID]),
        c=>rawRpc(c,'reservation_link_table_v1',[4,r.id,1,BABA_TABLES[3].MapObjectID]));
      assert.equal(x.status,'ok');assert.equal(y.status,'version_conflict');
      assert.equal((await admin.query('select count(*)::int n from reservation_private.reservation_table_links where reservation_id=$1',[r.id])).rows[0].n,1);
    });
    await t.test('same version release commits once with one release event',async()=>{
      const r=await make(admin,{reservedAt:'2026-11-18T19:00:00+07:00'});
      const linked=await rawRpc(admin,'reservation_link_table_v1',[4,r.id,1,BABA_TABLES[2].MapObjectID]);
      const linkId=linked.reservation.tables[0].linkId;
      const [x,y]=await race(c=>rawRpc(c,'reservation_release_table_v1',[4,r.id,2,linkId,'synthetic']),
        c=>rawRpc(c,'reservation_release_table_v1',[4,r.id,2,linkId,'synthetic second']));
      assert.equal(x.status,'ok');assert.equal(y.status,'version_conflict');
      assert.equal((await admin.query("select count(*)::int n from reservation_private.reservation_events where reservation_id=$1 and event_type='table_released'",[r.id])).rows[0].n,1);
    });
    await t.test('different reservations, same table/time: exclusion waits then one conflict, no partial link/version/event',async()=>{
      const r1=await make(admin),r2=await make(admin);const table=BABA_TABLES[0].MapObjectID;
      const [x,y]=await race(c=>rawRpc(c,'reservation_link_table_v1',[4,r1.id,1,table]),c=>rawRpc(c,'reservation_link_table_v1',[4,r2.id,1,table]));
      assert.equal(x.status,'ok');assert.equal(y.status,'table_conflict');assert.equal(y.conflictReservationId,r1.id);
      assert.equal((await admin.query('select version from reservation_private.reservations where id=$1',[r2.id])).rows[0].version,1);
      assert.equal((await admin.query("select count(*)::int n from reservation_private.reservation_events where reservation_id=$1 and event_type='table_linked'",[r2.id])).rows[0].n,0);
      assert.equal((await admin.query('select count(*)::int n from reservation_private.reservation_table_links where reservation_id=$1',[r2.id])).rows[0].n,0);
    });
    await t.test('concurrent table assignment versus time edit: both reservation and all link ranges rollback on exclusion',async()=>{
      const r1=await make(admin,{reservedAt:'2026-11-16T19:00:00+07:00'}),r2=await make(admin,{reservedAt:'2026-11-16T22:00:00+07:00'});
      const table=BABA_TABLES[1].MapObjectID;
      await rawRpc(admin,'reservation_link_table_v1',[4,r2.id,1,table]);
      const [x,y]=await race(c=>rawRpc(c,'reservation_link_table_v1',[4,r1.id,1,table]),c=>rawRpc(c,'reservation_update_v1',[4,r2.id,2,JSON.stringify({reservedAt:'2026-11-16T20:00:00+07:00'})]));
      assert.equal(x.status,'ok');assert.equal(y.status,'table_conflict');
      const row=(await admin.query('select version,reserved_at from reservation_private.reservations where id=$1',[r2.id])).rows[0];
      assert.equal(row.version,2);assert.equal(row.reserved_at.toISOString(),'2026-11-16T15:00:00.000Z');
      assert.equal((await admin.query('select lower(planned_range) at from reservation_private.reservation_table_links where reservation_id=$1',[r2.id])).rows[0].at.toISOString(),row.reserved_at.toISOString());
    });
    await t.test('same Inbox with different request keys waits then source_conflict; only one reservation',async()=>{
      const entry={status:'received',event_name:'message.text.received',chat_type:'GROUP',chat_id:'synthetic-group',message_id:'synthetic-message',message_text:'synthetic',payload_sha256:'a'.repeat(64),raw_payload:{}};
      const inbox=await rawRpc(admin,'reservation_inbox_ingest_v1',[JSON.stringify(entry)]);
      const [x,y]=await race(c=>rawRpc(c,'reservation_create_v1',[4,JSON.stringify(input({sourceInboxId:inbox.inboxId,requestKey:'11111111-1111-4111-8111-111111111111'}))]),
        c=>rawRpc(c,'reservation_create_v1',[4,JSON.stringify(input({sourceInboxId:inbox.inboxId,requestKey:'22222222-2222-4222-8222-222222222222'}))]));
      assert.equal(x.status,'ok');assert.equal(y.status,'source_conflict');assert.equal(y.reservationId,x.reservation.id);
      assert.equal((await admin.query('select count(*)::int n from reservation_private.reservations where source_inbox_id=$1',[inbox.inboxId])).rows[0].n,1);
    });
    await t.test('same create request key without Inbox waits then returns the original reservation',async()=>{
      const data=JSON.stringify(input({requestKey:'33333333-3333-4333-8333-333333333333'}));
      const [x,y]=await race(c=>rawRpc(c,'reservation_create_v1',[4,data]),c=>rawRpc(c,'reservation_create_v1',[4,data]));
      assert.equal(x.status,'ok');assert.equal(y.status,'ok');assert.equal(y.duplicateRequest,true);assert.equal(x.reservation.id,y.reservation.id);
    });
  } finally {
    for(const client of clients.reverse()) await client.end().catch(()=>{});
    if(child.exitCode===null) {
      execFileSync(exe('pg_ctl'),['-D',dir,'stop','-m','fast','-w'],{env,windowsHide:true,encoding:'utf8',timeout:10000});
    }
    writeFileSync(path.join(dir,'test-server.log'),logs.join('\n'));
  }
});
