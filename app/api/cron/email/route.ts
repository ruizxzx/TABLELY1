import {NextResponse} from 'next/server';
import {retryFailedEmailEvents} from '../../../lib/server-email';
export const dynamic='force-dynamic';
async function run(request:Request){const secret=(process.env.SELLORA_CRON_SECRET||process.env.CRON_SECRET||'').trim();const auth=request.headers.get('authorization')||'';if(!secret||auth!==`Bearer ${secret}`)return NextResponse.json({ok:false,error:'Unauthorized'},{status:401});try{return NextResponse.json({ok:true,...await retryFailedEmailEvents(20)});}catch(e){console.error('[cron/email]',e);return NextResponse.json({ok:false,error:e instanceof Error?e.message:'Email retry failed.'},{status:500});}}
export async function GET(request:Request){return run(request)}
export async function POST(request:Request){return run(request)}
