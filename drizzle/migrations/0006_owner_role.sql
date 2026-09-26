-- ===========================================================================
--  0006 — separate the workspace owner from operational managers
--
--  Team administration was gated on is_manager, which made every manager an
--  account administrator: anyone who could edit the catalogue could also promote
--  themselves' colleagues, revoke access, or remove people. Granting roles is a
--  different kind of authority from running the warehouse, so it gets its own tier.
--
--    owner    runs the team: grants and revokes roles, plus everything a manager does
--    manager  runs operations: catalogue, warehouses, purchasing, reversals
--    staff    records and validates stock movements
--    pending  no access at all
--
--  is_manager() deliberately returns true for an owner, so every existing
--  manager-gated policy keeps working for owners without being rewritten.
--
--  Re-runnable.
-- ===========================================================================

ALTER TABLE public.workspace_members DROP CONSTRAINT IF EXISTS workspace_members_role_check;
ALTER TABLE public.workspace_members ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN ('owner','manager','staff','pending'));

-- An owner is a superset of a manager, so nothing already written needs to change.
CREATE OR REPLACE FUNCTION public.is_manager(w uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.workspace_members
     WHERE workspace_id = w AND user_id = auth.uid() AND role IN ('owner','manager')
  )
$$;

CREATE OR REPLACE FUNCTION public.is_owner(w uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.workspace_members
     WHERE workspace_id = w AND user_id = auth.uid() AND role = 'owner'
  )
$$;

CREATE OR REPLACE FUNCTION public.is_member(w uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.workspace_members
     WHERE workspace_id = w AND user_id = auth.uid() AND role IN ('owner','manager','staff')
  )
$$;

GRANT EXECUTE ON FUNCTION public.is_owner(uuid) TO authenticated;

-- Whoever creates a workspace owns it.
CREATE OR REPLACE FUNCTION public.create_workspace(workspace_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE w uuid;
BEGIN
  IF auth.uid() IS NULL OR length(trim(workspace_name)) NOT BETWEEN 2 AND 100 THEN
    RAISE EXCEPTION 'Invalid workspace name';
  END IF;
  INSERT INTO public.workspaces(name) VALUES (trim(workspace_name)) RETURNING id INTO w;
  INSERT INTO public.workspace_members VALUES (w, auth.uid(), 'owner');
  RETURN w;
END $$;

-- --- Role administration is now owner-only -----------------------------------
CREATE OR REPLACE FUNCTION public.set_member_role(workspace uuid, target_user uuid, new_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE owners int; current_role text;
BEGIN
  IF new_role NOT IN ('owner','manager','staff','pending') THEN RAISE EXCEPTION 'Invalid role'; END IF;
  IF NOT public.is_owner(workspace) THEN RAISE EXCEPTION 'Only the workspace owner can change roles'; END IF;

  SELECT role INTO current_role FROM public.workspace_members
   WHERE workspace_id = workspace AND user_id = target_user;
  IF current_role IS NULL THEN RAISE EXCEPTION 'That person is not in this workspace'; END IF;

  IF target_user = auth.uid() AND new_role <> 'owner' THEN
    RAISE EXCEPTION 'You cannot give away your own owner access';
  END IF;
  IF current_role = 'owner' AND new_role <> 'owner' THEN
    SELECT count(*) INTO owners FROM public.workspace_members
     WHERE workspace_id = workspace AND role = 'owner';
    IF owners <= 1 THEN RAISE EXCEPTION 'A workspace must keep at least one owner'; END IF;
  END IF;

  UPDATE public.workspace_members SET role = new_role
   WHERE workspace_id = workspace AND user_id = target_user;
END $$;

CREATE OR REPLACE FUNCTION public.remove_member(workspace uuid, target_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE owners int; current_role text;
BEGIN
  IF NOT public.is_owner(workspace) THEN RAISE EXCEPTION 'Only the workspace owner can remove people'; END IF;
  IF target_user = auth.uid() THEN RAISE EXCEPTION 'You cannot remove yourself'; END IF;

  SELECT role INTO current_role FROM public.workspace_members
   WHERE workspace_id = workspace AND user_id = target_user;
  IF current_role IS NULL THEN RAISE EXCEPTION 'That person is not in this workspace'; END IF;

  IF current_role = 'owner' THEN
    SELECT count(*) INTO owners FROM public.workspace_members
     WHERE workspace_id = workspace AND role = 'owner';
    IF owners <= 1 THEN RAISE EXCEPTION 'A workspace must keep at least one owner'; END IF;
  END IF;

  -- Stock history they recorded is deliberately left untouched.
  DELETE FROM public.workspace_members
   WHERE workspace_id = workspace AND user_id = target_user;
END $$;

-- --- Give every existing workspace exactly one owner -------------------------
-- Prefers the admin demo account, otherwise the earliest-joined manager, so no
-- workspace is left with nobody able to administer it.
DO $$
DECLARE w record; chosen uuid;
BEGIN
  FOR w IN SELECT id FROM public.workspaces LOOP
    IF EXISTS (SELECT 1 FROM public.workspace_members WHERE workspace_id = w.id AND role = 'owner') THEN
      CONTINUE;
    END IF;

    SELECT m.user_id INTO chosen
      FROM public.workspace_members m
      JOIN public.profiles p ON p.id = m.user_id
     WHERE m.workspace_id = w.id AND m.role = 'manager' AND p.email = 'admin@stocksense.local'
     LIMIT 1;

    IF chosen IS NULL THEN
      SELECT user_id INTO chosen FROM public.workspace_members
       WHERE workspace_id = w.id AND role = 'manager' LIMIT 1;
    END IF;

    IF chosen IS NOT NULL THEN
      UPDATE public.workspace_members SET role = 'owner'
       WHERE workspace_id = w.id AND user_id = chosen;
      RAISE NOTICE 'Workspace %: promoted % to owner', w.id, chosen;
    ELSE
      RAISE WARNING 'Workspace % has no manager to promote to owner', w.id;
    END IF;
  END LOOP;
END $$;

COMMENT ON FUNCTION public.is_owner(uuid) IS
  'True only for the workspace owner. Gates team administration, which is separate from operational management.';
