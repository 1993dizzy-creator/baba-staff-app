export function posCloseApiError(error:unknown){
  const message=error instanceof Error?error.message:String((error as {message?:unknown})?.message??'');
  const allowed=['INVALID_POS_BUSINESS_DATE','POS_CLOSE_FORBIDDEN','RELOGIN_REQUIRED','SESSION_CONFIG_ERROR',
    'POS_CLOSE_BEFORE_CONFIGURED_CLOSE_TIME','POS_CLOSE_SOURCE_CHANGED_SINCE_REVIEW','POS_CLOSE_SYNC_FAILED','POS_CLOSE_SOURCE_INVALID'];
  const code=allowed.includes(message)?message:'POS_CLOSE_FAILED';
  return Response.json({ok:false,code},{status:code==='RELOGIN_REQUIRED'?401:code==='POS_CLOSE_FORBIDDEN'?403:code.startsWith('INVALID_')?400:409});
}
export function parsePosCloseBody(body:unknown){
  if(!body||typeof body!=='object'||Array.isArray(body))throw Error('INVALID_POS_BUSINESS_DATE');
  const b=body as Record<string,unknown>;
  if(Object.keys(b).some(k=>!['businessDate','reclose','expectedSourceFingerprint'].includes(k))
    || typeof b.businessDate!=='string' || (b.reclose!==undefined&&typeof b.reclose!=='boolean')
    || (b.expectedSourceFingerprint!==undefined&&(typeof b.expectedSourceFingerprint!=='string'||!/^[0-9a-f]{64}$/.test(b.expectedSourceFingerprint))))throw Error('INVALID_POS_BUSINESS_DATE');
  return {date:b.businessDate,reclose:b.reclose===true,expectedSourceFingerprint:b.expectedSourceFingerprint as string|undefined};
}
