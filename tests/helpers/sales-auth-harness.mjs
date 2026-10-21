import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
export function loadTs(path,mocks={}) {
 const out=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const exports={};new Function('require','exports',out)(name=>Object.hasOwn(mocks,name)?mocks[name]:name.startsWith('node:')?require(name):{},exports);return exports;
}
export function authHarness() {
 const tokens=loadTs('lib/auth/session-token.ts');
 let token;let actor={id:3,username:'manager',role:'manager',name:'Manager',is_active:true,app_login_enabled:true};
 const touched=[];
 const db={from(table){touched.push(table);if(table!=='users')throw new Error('Unexpected database access: '+table);const q={select(){return q},eq(){return q},async maybeSingle(){return {data:actor,error:null}}};return q;}};
 const auth=loadTs('lib/auth/server-auth.ts',{'server-only':{},'@/lib/auth/server-session':{readServerSession:async()=>tokens.verifyServerSessionToken(token)},'@/lib/supabase/server':{supabaseServer:db}});
 return {auth,tokens,touched,setToken(v){token=v},setActor(v){actor={...actor,...v}},sign(id=3){token=tokens.createServerSessionToken(id);return token;}};
}
export const nextMock={NextResponse:{json:(body,init)=>Response.json(body,init)}};
