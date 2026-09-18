-- Run once in Supabase SQL Editor.
-- Equivalent to migration 202609180033_enterprise_pricing_floor.sql.

update public.saas_plans
set price_monthly = 10000,
    price_annual = 100000
where id = 'ENTERPRISE';

notify pgrst, 'reload schema';
