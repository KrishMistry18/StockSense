-- The stock ledger already records who made every movement, but a member could only ever read
-- their own profile, so the audit trail could not name anyone else. This lets members of the same
-- workspace resolve each other's display name and nothing more.
CREATE FUNCTION public.shares_workspace(other uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT EXISTS(SELECT 1 FROM public.workspace_members me JOIN public.workspace_members them ON me.workspace_id=them.workspace_id WHERE me.user_id=auth.uid() AND them.user_id=other) $$;
GRANT EXECUTE ON FUNCTION public.shares_workspace(uuid) TO authenticated;
CREATE POLICY profiles_read_coworkers ON public.profiles FOR SELECT TO authenticated USING(public.shares_workspace(id));
COMMENT ON POLICY profiles_read_coworkers ON public.profiles IS 'Workspace members can read each other''s display name so the stock ledger can attribute each movement to a person.';
