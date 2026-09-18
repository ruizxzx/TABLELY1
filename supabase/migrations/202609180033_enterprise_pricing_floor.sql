-- Enterprise pricing presentation: demand-based pricing from a visible minimum.

update public.saas_plans
set price_monthly = 10000,
    price_annual = 100000
where id = 'ENTERPRISE';

notify pgrst, 'reload schema';
