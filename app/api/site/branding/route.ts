import { NextResponse } from 'next/server';
import { getSiteBranding } from '../../../lib/site-branding';

export const dynamic = 'force-dynamic';

export async function GET() {
  const branding = await getSiteBranding();
  return NextResponse.json({ ok: true, data: branding });
}
