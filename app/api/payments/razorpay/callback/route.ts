import { NextResponse } from 'next/server';
import { getAppBaseUrl } from '../../../../lib/site';

export const dynamic='force-dynamic';

function redirect(status:string){
  const base = getAppBaseUrl();
  return NextResponse.redirect(`${base}/studio/payments?razorpay=${encodeURIComponent(status)}`,303);
}

export async function GET(){
  // Build 3 intentionally supports creator-supplied Razorpay API credentials only.
  // OAuth remains reserved for a later build and must not create/replace payment accounts.
  return redirect('oauth_unsupported');
}
