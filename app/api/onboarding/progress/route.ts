import { NextResponse } from 'next/server';
import { resolveServerRestaurantAccess } from '@/lib/server-restaurant';

export async function GET() {
  const resolved = await resolveServerRestaurantAccess({ ownerOnly: true });
  if ('error' in resolved) return resolved.error;
  const { access } = resolved;
  const { data, error } = await access.admin.from('organizations')
    .select('onboarding_progress,onboarding_completed_at')
    .eq('id', access.context.organization.id).single();
  if (error) return NextResponse.json({ error: 'Could not load onboarding progress. Apply the Build 28 migration first.' }, { status: 503 });
  return NextResponse.json({ progress: data.onboarding_progress ?? { step: 1, completedSteps: [] }, completedAt: data.onboarding_completed_at });
}

export async function POST(request: Request) {
  const resolved = await resolveServerRestaurantAccess({ ownerOnly: true });
  if ('error' in resolved) return resolved.error;
  const body = await request.json().catch(() => null) as { step?: number; completedStep?: number; complete?: boolean } | null;
  if (!body || (body.step !== undefined && (!Number.isInteger(body.step) || body.step < 1 || body.step > 7)) || (body.completedStep !== undefined && (!Number.isInteger(body.completedStep) || body.completedStep < 1 || body.completedStep > 7))) {
    return NextResponse.json({ error: 'Invalid onboarding progress.' }, { status: 400 });
  }
  const { access } = resolved;
  const { data: current, error: readError } = await access.admin.from('organizations')
    .select('onboarding_progress').eq('id', access.context.organization.id).single();
  if (readError) return NextResponse.json({ error: 'Could not load onboarding state. Apply the Build 28 migration first.' }, { status: 503 });
  const oldProgress = current.onboarding_progress && typeof current.onboarding_progress === 'object' ? current.onboarding_progress as Record<string, unknown> : {};
  const completed = Array.isArray(oldProgress.completedSteps) ? oldProgress.completedSteps.filter((x): x is number => Number.isInteger(x) && Number(x) >= 1 && Number(x) <= 7) : [];
  if (body.completedStep && !completed.includes(body.completedStep)) completed.push(body.completedStep);
  const progress = { ...oldProgress, step: body.step ?? Math.min(7, Number(oldProgress.step ?? 1)), completedSteps: completed, updatedAt: new Date().toISOString() };
  const payload: Record<string, unknown> = { onboarding_progress: progress };
  if (body.complete) {
    if (![1, 2, 3, 4, 5, 6].every((step) => completed.includes(step))) {
      return NextResponse.json({ error: 'Complete or explicitly skip each setup step before launching.' }, { status: 409 });
    }
    payload.onboarding_completed_at = new Date().toISOString();
    progress.completedSteps = [...new Set([...completed, 7])];
    progress.step = 7;
    payload.onboarding_progress = progress;
  }
  const { error } = await access.admin.from('organizations').update(payload).eq('id', access.context.organization.id);
  if (error) return NextResponse.json({ error: 'Could not save onboarding progress.' }, { status: 500 });
  return NextResponse.json({ ok: true, progress });
}
