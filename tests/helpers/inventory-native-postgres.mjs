import {spawn} from 'node:child_process';
import {appendFileSync,mkdtempSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import pg from 'pg';
const {Client}=pg;
// Starts an owned loopback-only PostgreSQL cluster. No existing DB URL or credentials are read.
export async function nativeInventoryPostgres(){
 const bin=path.resolve(process.env.QA_POSTGRES_BIN);
 const root=path.resolve('.qa-review');mkdirSync(root,{recursive:true});
 const dir=mkdtempSync(path.join(root,'pg-native-test-'));
 const exe=name=>path.join(bin,name+(process.platform==='win32'?'.exe':''));
 const run=(name,args)=>new Promise((resolve,reject)=>{const child=spawn(exe(name),args,{windowsHide:true});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);child.on('error',reject);child.on('exit',code=>code?reject(Error(output)):resolve(output));});
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 await run('initdb',['-D',dir,'-U','postgres','--auth=trust','--locale=C','--encoding=UTF8']);
 const server=spawn(exe('postgres'),['-D',dir,'-h','127.0.0.1','-p',String(port),'-c','log_lock_waits=on','-c','deadlock_timeout=100ms'],{windowsHide:true});
 const stop=async()=>{if(server.exitCode===null)try{await run('pg_ctl',['-D',dir,'-m','fast','-w','stop']);}catch(error){server.kill();throw error;}};
 try{
  await new Promise((resolve,reject)=>{let logs='';const timer=setTimeout(()=>reject(Error('PostgreSQL startup timeout: '+logs)),8000);
   server.stderr.on('data',x=>{appendFileSync(path.join(dir,'server.log'),x);logs+=x;if(logs.includes('ready to accept connections')){clearTimeout(timer);resolve();}});
   server.stdout.on('data',x=>appendFileSync(path.join(dir,'server.log'),x));
   server.on('error',e=>{clearTimeout(timer);reject(e);});server.on('exit',code=>{clearTimeout(timer);reject(Error(logs+' exit '+code));});
  });
  const config={host:'127.0.0.1',port,user:'postgres',database:'postgres'};
  const admin=new Client(config);await admin.connect();
  const actualDir=(await admin.query('show data_directory')).rows[0].data_directory;
  if(path.resolve(actualDir)!==dir)throw Error('Unexpected test cluster');
  const version=(await admin.query('select version() as version')).rows[0].version;
  let counter=0;const clients=new Set([admin]);
  const connect=async(database)=>{const c=new Client({...config,database});await c.connect();clients.add(c);return c;};
  class Database{
   constructor(){this.name='qa_case_'+(++counter);this.ready=(async()=>{await admin.query('create database '+this.name);this.client=await connect(this.name);})();}
   async exec(sql){await this.ready;const roles="create role anon; create role authenticated; create role service_role;";
    // Roles are shared across databases within this isolated cluster.
    if(counter>1)sql=sql.replace(roles,'');return this.client.query(sql);}
   async query(sql,args=[]){await this.ready;return this.client.query(sql,args);}
   async close(){if(this.client){clients.delete(this.client);await this.client.end();}}
  }
  return {Database,connect,version,dir,stop:async()=>{await Promise.allSettled([...clients].map(c=>c.end()));await stop();}};
 }catch(error){await stop();throw error;}
}
