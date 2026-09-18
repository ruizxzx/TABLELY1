BEGIN;
REVOKE EXECUTE ON FUNCTION public.admin_begin_plan_reprovision(text,text,numeric,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_begin_plan_reprovision(text,text,numeric,text,text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_finalize_plan_reprovision(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_finalize_plan_reprovision(uuid,text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_fail_plan_reprovision(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_fail_plan_reprovision(uuid,text) TO authenticated;
COMMIT;
