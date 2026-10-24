import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    { error: 'Translations are prepared from Dashboard → Menu and loaded from the saved menu data.' },
    { status: 410 },
  );
}
