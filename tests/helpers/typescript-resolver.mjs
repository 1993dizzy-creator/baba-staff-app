import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
registerHooks({resolve(specifier,context,nextResolve){if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:')){const base=new URL(specifier,context.parentURL);if(!existsSync(fileURLToPath(base))){for(const extension of ['.ts','.mjs','.js']){const path=fileURLToPath(base)+extension;if(existsSync(path))return nextResolve(pathToFileURL(path).href,context);}}}return nextResolve(specifier,context);}});
