// Build-time module initialization only. No Supabase service or credentials exist here.
import {createHmac, randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {sanitizedEnv} from './common.mjs';

export function createBuildEnvironment() {
  // Preserve the regular credential-removal policy; add only fixed local fixture values.
  const {env} = sanitizedEnv();
  const guard = `--import=${pathToFileURL(join(import.meta.dirname, 'offline-guard.mjs')).href}`;
  env.NODE_OPTIONS = `${guard}${env.NODE_OPTIONS ? ` ${env.NODE_OPTIONS}` : ''}`;
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({alg: 'HS256', typ: 'JWT'});
  const payload = encode({iss: 'baba-offline-build-fixture', role: 'anon', iat: 0, exp: 4102444800});
  // This ephemeral signing key belongs to no project and is never persisted or returned.
  const signature = createHmac('sha256', randomBytes(32)).update(`${header}.${payload}`).digest('base64url');
  const publicToken = `${header}.${payload}.${signature}`;
  env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:9';
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY = publicToken;
  // Existing server modules require this variable's presence. Its value is the SAME anon
  // fixture token, never a service_role credential. No database/mock server is started.
  env.SUPABASE_SERVICE_ROLE_KEY = publicToken;
  return {env, description: {
    mode: 'offline-local-fixture', supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    injectedVariables: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
    tokenRole: 'anon', tokenSource: 'ephemeral-local-signature-not-a-project-key',
    offlineGuard: 'scripts/agent/lib/offline-guard.mjs', productionEnvironmentValidated: false,
    deployableArtifact: false,
  }};
}
