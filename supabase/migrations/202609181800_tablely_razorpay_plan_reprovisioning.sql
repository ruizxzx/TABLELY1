BEGIN;

-- TABLELY SaaS Razorpay plan versions.
-- This is deliberately separate from restaurant/customer Razorpay payment data.
CREATE TABLE IF NOT EXISTS public.saas_plan_provider_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id text NOT NULL REFERENCES public.saas_plans(id) ON DELETE CASCADE,
  billing_interval text NOT NULL CHECK (billing_interval IN ('month','year')),
  price numeric(12,2) NOT NULL CHECK (price >= 1),
  previous_price numeric(12,2),
  previous_provider_plan_id text,
  currency text NOT NULL DEFAULT 'INR',
  provider_plan_id text,
  provider_environment text NOT NULL DEFAULT 'unknown',
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','HISTORICAL','FAILED')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  failed_at timestamptz,
  failure_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS saas_plan_provider_versions_provider_uidx
  ON public.saas_plan_provider_versions(provider_plan_id)
  WHERE provider_plan_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS saas_plan_provider_versions_pending_uidx
  ON public.saas_plan_provider_versions(plan_id, billing_interval)
  WHERE status = 'PENDING';
CREATE UNIQUE INDEX IF NOT EXISTS saas_plan_provider_versions_active_uidx
  ON public.saas_plan_provider_versions(plan_id, billing_interval)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS saas_plan_provider_versions_plan_created_idx
  ON public.saas_plan_provider_versions(plan_id, billing_interval, created_at DESC);

ALTER TABLE public.saas_plan_provider_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.saas_plan_provider_versions FROM anon, authenticated, public;
DROP POLICY IF EXISTS saas_plan_provider_versions_admin_select ON public.saas_plan_provider_versions;
CREATE POLICY saas_plan_provider_versions_admin_select
  ON public.saas_plan_provider_versions
  FOR SELECT TO authenticated
  USING (public.is_platform_admin());
GRANT SELECT ON public.saas_plan_provider_versions TO authenticated;

-- Preserve all provider plan IDs that were already in the catalog before this
-- migration. Their original provider account/environment cannot be inferred from
-- the old schema, so they are intentionally marked unknown rather than pretending
-- they belong to the currently configured Razorpay account.
INSERT INTO public.saas_plan_provider_versions(
  plan_id,billing_interval,price,currency,provider_plan_id,provider_environment,status,created_at,activated_at
)
SELECT p.id,'month',p.price_monthly,coalesce(p.currency,'INR'),p.provider_plan_id,'unknown','ACTIVE',coalesce(p.created_at,now()),coalesce(p.created_at,now())
FROM public.saas_plans p
WHERE p.provider_plan_id IS NOT NULL
ON CONFLICT (provider_plan_id) WHERE provider_plan_id IS NOT NULL DO NOTHING;

INSERT INTO public.saas_plan_provider_versions(
  plan_id,billing_interval,price,currency,provider_plan_id,provider_environment,status,created_at,activated_at
)
SELECT p.id,'year',p.price_annual,coalesce(p.currency,'INR'),p.provider_plan_id_annual,'unknown','ACTIVE',coalesce(p.created_at,now()),coalesce(p.created_at,now())
FROM public.saas_plans p
WHERE p.provider_plan_id_annual IS NOT NULL
ON CONFLICT (provider_plan_id) WHERE provider_plan_id IS NOT NULL DO NOTHING;

-- Start/reuse one server-side provisioning record per plan + interval. Returning
-- an existing fresh PENDING row makes duplicate clicks/retries deterministic.
CREATE OR REPLACE FUNCTION public.admin_begin_plan_reprovision(
  p_plan_id text,
  p_billing_interval text,
  p_price numeric,
  p_currency text DEFAULT 'INR',
  p_environment text DEFAULT 'unknown'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan public.saas_plans;
  v_pending public.saas_plan_provider_versions;
  v_interval text := lower(trim(coalesce(p_billing_interval,'month')));
  v_currency text := upper(trim(coalesce(p_currency,'INR')));
  v_environment text := lower(trim(coalesce(p_environment,'unknown')));
  v_old_provider_plan_id text;
  v_old_price numeric;
  v_id uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin access required' USING errcode='42501';
  END IF;
  IF p_plan_id = 'ENTERPRISE' THEN
    RAISE EXCEPTION 'Enterprise plans use contact sales and do not provision a self-serve payment plan';
  END IF;
  IF v_interval NOT IN ('month','year') THEN
    RAISE EXCEPTION 'Invalid billing interval';
  END IF;
  IF p_price IS NULL OR p_price < 1 THEN
    RAISE EXCEPTION 'Plan price must be at least ₹1';
  END IF;
  IF v_currency = '' THEN
    RAISE EXCEPTION 'Currency is required';
  END IF;
  SELECT * INTO v_plan FROM public.saas_plans WHERE id=p_plan_id FOR UPDATE;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'Plan not found';
  END IF;

  v_old_provider_plan_id := CASE WHEN v_interval='year' THEN v_plan.provider_plan_id_annual ELSE v_plan.provider_plan_id END;
  v_old_price := CASE WHEN v_interval='year' THEN v_plan.price_annual ELSE v_plan.price_monthly END;

  SELECT * INTO v_pending
  FROM public.saas_plan_provider_versions
  WHERE plan_id=p_plan_id AND billing_interval=v_interval AND status='PENDING'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_pending.id IS NOT NULL THEN
    IF v_pending.created_at < now() - interval '15 minutes' THEN
      UPDATE public.saas_plan_provider_versions
      SET status='FAILED', failed_at=now(), failure_reason='Stale provisioning request automatically released.'
      WHERE id=v_pending.id;
    ELSE
      RETURN jsonb_build_object(
        'provisioning_id',v_pending.id,
        'reused',true,
        'created_at',v_pending.created_at,
        'plan_id',p_plan_id,
        'billing_interval',v_interval,
        'price',v_pending.price,
        'previous_price',v_pending.previous_price,
        'previous_provider_plan_id',v_pending.previous_provider_plan_id,
        'currency',v_pending.currency,
        'environment',v_pending.provider_environment,
        'old_provider_plan_id',v_old_provider_plan_id,
        'old_price',v_old_price
      );
    END IF;
  END IF;

  INSERT INTO public.saas_plan_provider_versions(
    plan_id,billing_interval,price,previous_price,previous_provider_plan_id,currency,provider_environment,status,created_by
  ) VALUES (
    p_plan_id,v_interval,p_price,v_old_price,v_old_provider_plan_id,v_currency,v_environment,'PENDING',auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'provisioning_id',v_id,
    'reused',false,
    'created_at',now(),
    'plan_id',p_plan_id,
    'billing_interval',v_interval,
    'price',p_price,
    'currency',v_currency,
    'environment',v_environment,
    'old_provider_plan_id',v_old_provider_plan_id,
    'old_price',v_old_price
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_begin_plan_reprovision(text,text,numeric,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_finalize_plan_reprovision(
  p_provisioning_id uuid,
  p_provider_plan_id text
)
RETURNS public.saas_plans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_version public.saas_plan_provider_versions;
  v_plan public.saas_plans;
  v_old_provider_plan_id text;
  v_old_price numeric;
  v_user uuid := auth.uid();
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin access required' USING errcode='42501';
  END IF;
  IF p_provider_plan_id IS NULL OR trim(p_provider_plan_id)='' THEN
    RAISE EXCEPTION 'Provider plan ID is required';
  END IF;

  SELECT * INTO v_version
  FROM public.saas_plan_provider_versions
  WHERE id=p_provisioning_id
  FOR UPDATE;
  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'Provisioning record not found';
  END IF;
  IF v_version.status = 'ACTIVE' AND v_version.provider_plan_id = p_provider_plan_id THEN
    SELECT * INTO v_plan FROM public.saas_plans WHERE id=v_version.plan_id;
    RETURN v_plan;
  END IF;
  IF v_version.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Provisioning record is not pending';
  END IF;

  SELECT * INTO v_plan FROM public.saas_plans WHERE id=v_version.plan_id FOR UPDATE;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'Plan not found';
  END IF;

  v_old_provider_plan_id := CASE WHEN v_version.billing_interval='year' THEN v_plan.provider_plan_id_annual ELSE v_plan.provider_plan_id END;
  v_old_price := CASE WHEN v_version.billing_interval='year' THEN v_plan.price_annual ELSE v_plan.price_monthly END;

  IF v_old_provider_plan_id IS DISTINCT FROM p_provider_plan_id OR v_old_provider_plan_id IS NULL THEN
    UPDATE public.saas_plan_provider_versions
    SET status='HISTORICAL'
    WHERE plan_id=v_version.plan_id
      AND billing_interval=v_version.billing_interval
      AND status='ACTIVE';
  END IF;

  UPDATE public.saas_plan_provider_versions
  SET provider_plan_id=p_provider_plan_id,
      status='ACTIVE',
      activated_at=now(),
      failure_reason=null,
      failed_at=null
  WHERE id=v_version.id;

  UPDATE public.saas_plans
  SET price_monthly=case when v_version.billing_interval='month' then v_version.price else price_monthly end,
      price_annual=case when v_version.billing_interval='year' then v_version.price else price_annual end,
      provider_plan_id=case when v_version.billing_interval='month' then p_provider_plan_id else provider_plan_id end,
      provider_plan_id_annual=case when v_version.billing_interval='year' then p_provider_plan_id else provider_plan_id_annual end,
      currency=coalesce(v_version.currency,currency),
      updated_at=now()
  WHERE id=v_plan.id
  RETURNING * INTO v_plan;

  INSERT INTO public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
  VALUES (
    v_user,
    'SAAS_PLAN_PROVIDER_REPROVISIONED',
    'SAAS_PLAN',
    null,
    jsonb_build_object(
      'plan_id',v_version.plan_id,
      'billing_interval',v_version.billing_interval,
      'previous_provider_plan_id',v_old_provider_plan_id,
      'new_provider_plan_id',p_provider_plan_id,
      'old_price',v_old_price,
      'new_price',v_version.price,
      'provider_environment',v_version.provider_environment,
      'success',true,
      'reason','provider_plan_reprovision'
    )
  );

  RETURN v_plan;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_finalize_plan_reprovision(uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_fail_plan_reprovision(
  p_provisioning_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_version public.saas_plan_provider_versions;
  v_user uuid := auth.uid();
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin access required' USING errcode='42501';
  END IF;
  SELECT * INTO v_version FROM public.saas_plan_provider_versions WHERE id=p_provisioning_id FOR UPDATE;
  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'Provisioning record not found';
  END IF;
  IF v_version.status='ACTIVE' THEN
    RETURN;
  END IF;
  UPDATE public.saas_plan_provider_versions
  SET status='FAILED', failed_at=now(), failure_reason=left(coalesce(p_reason,'Provider plan creation failed.'),1000)
  WHERE id=v_version.id AND status='PENDING';

  INSERT INTO public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
  VALUES (
    v_user,
    'SAAS_PLAN_PROVIDER_REPROVISION_FAILED',
    'SAAS_PLAN',
    null,
    jsonb_build_object(
      'plan_id',v_version.plan_id,
      'billing_interval',v_version.billing_interval,
      'old_price',v_version.previous_price,
      'new_price',v_version.price,
      'previous_provider_plan_id',v_version.previous_provider_plan_id,
      'failure_reason',left(coalesce(p_reason,'Provider plan creation failed.'),1000),
      'success',false,
      'reason','provider_plan_reprovision'
    )
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_fail_plan_reprovision(uuid,text) TO authenticated;

-- Webhooks may carry an annual provider plan ID or a historical provider plan ID.
-- Resolve both current and historical mappings without treating old versions as invalid.
CREATE OR REPLACE FUNCTION public.apply_provider_subscription_event(
  p_provider_subscription_id text,
  p_event_type text,
  p_status text,
  p_provider_plan_id text,
  p_payment_id text,
  p_payload jsonb
)
RETURNS public.organization_subscriptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub public.organization_subscriptions;
  v_plan public.saas_plans;
  v_status text := lower(coalesce(p_status, ''));
BEGIN
  SELECT * INTO v_sub
  FROM public.organization_subscriptions
  WHERE provider_subscription_id = p_provider_subscription_id
  FOR UPDATE;
  IF v_sub.id IS NULL THEN
    RAISE EXCEPTION 'Subscription not found';
  END IF;

  IF v_status IN ('active','authenticated') THEN v_status := 'ACTIVE';
  ELSIF v_status IN ('cancelled','halted') THEN v_status := 'CANCELLED';
  ELSIF v_status IN ('completed') THEN v_status := 'EXPIRED';
  ELSIF v_status IN ('expired') THEN v_status := 'EXPIRED';
  ELSIF v_status IN ('past_due','paused') THEN v_status := 'PAST_DUE';
  ELSE v_status := v_sub.status;
  END IF;

  IF p_provider_plan_id IS NOT NULL AND trim(p_provider_plan_id)<>'' THEN
    SELECT * INTO v_plan
    FROM public.saas_plans
    WHERE provider_plan_id = p_provider_plan_id
       OR provider_plan_id_annual = p_provider_plan_id
    LIMIT 1;
    IF v_plan.id IS NULL THEN
      SELECT p.* INTO v_plan
      FROM public.saas_plan_provider_versions v
      JOIN public.saas_plans p ON p.id=v.plan_id
      WHERE v.provider_plan_id = p_provider_plan_id
      ORDER BY v.created_at DESC
      LIMIT 1;
    END IF;
  END IF;

  UPDATE public.organization_subscriptions
  SET status=v_status,
      plan_id=coalesce(v_plan.id,plan_id),
      pending_plan_id=case when v_plan.id is not null and pending_plan_id=v_plan.id then null else pending_plan_id end,
      pending_provider_plan_id=case when v_plan.id is not null and pending_plan_id=v_plan.id then null else pending_provider_plan_id end,
      updated_at=now()
  WHERE id=v_sub.id
  RETURNING * INTO v_sub;

  UPDATE public.subscription_billing_events
  SET organization_id=v_sub.organization_id,
      subscription_id=v_sub.id,
      provider_payment_id=coalesce(p_payment_id,provider_payment_id),
      status=v_status,
      occurred_at=now()
  WHERE provider_subscription_id=p_provider_subscription_id
    AND event_type=p_event_type
    AND organization_id IS NULL;

  RETURN v_sub;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.apply_provider_subscription_event(text,text,text,text,text,jsonb) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_provider_subscription_event(text,text,text,text,text,jsonb) TO service_role;

COMMIT;
