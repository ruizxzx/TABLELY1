export function reportServerError(scope:string,error:unknown,meta:Record<string,unknown>={}){
  const safeError=error instanceof Error?{name:error.name,message:error.message,stack:error.stack}:String(error);
  console.error(JSON.stringify({level:'error',service:'tablely',scope,error:safeError,...meta,timestamp:new Date().toISOString()}));
}
