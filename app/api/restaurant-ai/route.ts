import { NextResponse } from 'next/server';
import { z } from 'zod';
import { executeRestaurantAssistant, type RestaurantAssistantMode } from '@/lib/ai-management';
import { restaurantAiAllowedRoutes, selectRestaurantHelp } from '@/lib/restaurant-ai-knowledge';
import { resolveServerRestaurantAccess } from '@/lib/server-restaurant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const requestSchema = z.object({
  branchId: z.string().uuid(),
  mode: z.enum(['support', 'analytics']),
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30),
  question: z.string().trim().min(1).max(600),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(240),
  })).max(4).optional().default([]),
});

function parseAssistantResult(value: unknown): Record<string, unknown> & { answer: string } {
  if (!value || typeof value !== 'object') throw new Error('The assistant returned an invalid response.');
  const result = value as Record<string, unknown>;
  if (typeof result.answer !== 'string' || !result.answer.trim()) throw new Error('The assistant returned an empty response.');
  return { ...result, answer: result.answer };
}

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Enter a question of up to 600 characters.' }, { status: 400 });

  const { branchId, mode, question, history, days } = parsed.data;
  const resolved = await resolveServerRestaurantAccess({
    branchId,
    ...(mode === 'analytics' ? { permission: 'ANALYTICS' } : {}),
  });
  if ('error' in resolved) return resolved.error;
  const { access } = resolved;

  let context: Record<string, unknown>;
  if (mode === 'support') {
    context = {
      restaurantName: access.context.organization.name,
      branchName: access.context.branch.name,
      approvedHelpNotes: selectRestaurantHelp(question),
      allowedRoutes: restaurantAiAllowedRoutes,
    };
  } else {
    const entitlements = await access.supabase.rpc('get_current_entitlements');
    if (entitlements.error) return NextResponse.json({ error: 'Analytics access could not be verified.' }, { status: 503 });
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    const advanced = Boolean(entitlements.data?.features?.ADVANCED_ANALYTICS);
    const result = advanced
      ? await access.supabase.rpc('get_build12_analytics', {
        p_branch_id: access.branchId, p_from: from.toISOString(), p_to: to.toISOString(),
      })
      : await access.supabase.rpc('get_branch_analytics', {
        p_branch_id: access.branchId, p_from: from.toISOString(), p_to: to.toISOString(),
      });
    if (result.error) {
      const forbidden = result.error.code === '42501';
      return NextResponse.json({ error: forbidden ? 'Analytics are not available for this account or branch.' : 'Branch analytics could not be loaded.' }, { status: forbidden ? 403 : 503 });
    }
    context = {
      branchName: access.context.branch.name,
      days,
      advancedAnalytics: advanced,
      branchAggregates: result.data ?? {},
    };
  }

  const assistantQuestion = JSON.stringify({
    recentConversation: history,
    currentQuestion: question,
  });
  try {
    const generated = await executeRestaurantAssistant({
      organizationId: access.context.organization.id,
      branchId: access.branchId,
      audience: 'staff',
      mode: mode as RestaurantAssistantMode,
      question: assistantQuestion,
      context,
    });
    const result = parseAssistantResult(generated.parsed);
    const answer = result.answer;
    const links = mode === 'support' && Array.isArray(result.links)
      ? result.links.flatMap((link) => {
        if (!link || typeof link !== 'object') return [];
        const candidate = link as Record<string, unknown>;
        if (typeof candidate.label !== 'string' || typeof candidate.href !== 'string'
          || !(restaurantAiAllowedRoutes as readonly string[]).includes(candidate.href)) return [];
        return [{ label: candidate.label.slice(0, 60), href: candidate.href }];
      }).slice(0, 3)
      : [];
    return NextResponse.json({
      answer: answer.slice(0, 1200),
      links,
      remainingRequests: generated.remainingRequests,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The assistant could not answer right now.';
    const limited = message.includes('daily AI assistant limit');
    return NextResponse.json({ error: message }, { status: limited ? 429 : 503 });
  }
}
