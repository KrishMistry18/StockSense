-- ===========================================================================
--  0005 — team administration
--
--  Adds a third membership state so self-registration is safe. Previously the only
--  states were manager and staff, and join_workspace handed out staff immediately:
--  anyone holding the invite code got straight into live inventory with no review.
--
--  New flow:
--    register  -> account exists, belongs to no workspace, sees nothing
--    join code -> 'pending', still sees nothing
--    manager   -> grants manager or staff from the Team screen
--
--  The gate is workspace membership rather than email verification, which is the
--  stronger check: an unverified address cannot read a single row of stock.
--
--  is_member() is the function every table's row-level security leans on, so
--  excluding 'pending' there closes access across the whole schema at once
--  instead of relying on each policy to remember.
--
--  Re-runnable.
-- ===========================================================================

-- --- Profile email, so the Team screen can identify people -------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email text NOT NULL DEFAULT '';
UPDATE public.profiles p SET email = u.email
  FROM auth.users u WHERE u.id = p.id AND p.email = '' AND u.email IS NOT NULL;

CREATE OR REPLACE FUNCTION public.create_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles(id, display_name, email)
  VALUES (NEW.id, coalesce(NEW.raw_user_meta_data->>'display_name',''), coalesce(NEW.email,''))
  ON CONFLICT (id) DO UPDATE
    SET display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE public.profiles.display_name END,
        email = CASE WHEN excluded.email <> '' THEN excluded.email ELSE public.profiles.email END;
  RETURN NEW;
END $$;

-- --- Pending membership ------------------------------------------------------
ALTER TABLE public.workspace_members DROP CONSTRAINT IF EXISTS workspace_members_role_check;
ALTER TABLE public.workspace_members ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN ('manager','staff','pending'));

-- Pending members are deliberately NOT members: this one function is what every
-- other policy in the schema tests.
CREATE OR REPLACE FUNCTION public.is_member(w uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.workspace_members
     WHERE workspace_id = w AND user_id = auth.uid() AND role IN ('manager','staff')
  )
$$;

-- ...but a pending member must still be able to see that they are pending,
-- otherwise the app cannot tell "awaiting approval" from "no workspace at all".
DROP POLICY IF EXISTS members_read_self ON public.workspace_members;
CREATE POLICY members_read_self ON public.workspace_members FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Joining with the invite code now requests access instead of granting it.
CREATE OR REPLACE FUNCTION public.join_workspace(code text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE w uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  SELECT id INTO w FROM public.workspaces WHERE join_code = upper(trim(code));
  IF w IS NULL THEN RAISE EXCEPTION 'Invalid invitation code'; END IF;
  INSERT INTO public.workspace_members VALUES (w, auth.uid(), 'pending') ON CONFLICT DO NOTHING;
  RETURN w;
END $$;

-- --- Role administration -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_member_role(workspace uuid, target_user uuid, new_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE managers int; current_role text;
BEGIN
  IF new_role NOT IN ('manager','staff','pending') THEN RAISE EXCEPTION 'Invalid role'; END IF;
  IF NOT public.is_manager(workspace) THEN RAISE EXCEPTION 'Only a manager can change roles'; END IF;

  SELECT role INTO current_role FROM public.workspace_members
   WHERE workspace_id = workspace AND user_id = target_user;
  IF current_role IS NULL THEN RAISE EXCEPTION 'That person is not in this workspace'; END IF;

  -- Locking yourself out, or emptying the workspace of managers, would leave nobody
  -- able to undo it.
  IF target_user = auth.uid() AND new_role <> 'manager' THEN
    RAISE EXCEPTION 'You cannot remove your own manager access';
  END IF;
  IF current_role = 'manager' AND new_role <> 'manager' THEN
    SELECT count(*) INTO managers FROM public.workspace_members
     WHERE workspace_id = workspace AND role = 'manager';
    IF managers <= 1 THEN RAISE EXCEPTION 'A workspace must keep at least one manager'; END IF;
  END IF;

  UPDATE public.workspace_members SET role = new_role
   WHERE workspace_id = workspace AND user_id = target_user;
END $$;

CREATE OR REPLACE FUNCTION public.remove_member(workspace uuid, target_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE managers int; current_role text;
BEGIN
  IF NOT public.is_manager(workspace) THEN RAISE EXCEPTION 'Only a manager can remove people'; END IF;
  IF target_user = auth.uid() THEN RAISE EXCEPTION 'You cannot remove yourself'; END IF;

  SELECT role INTO current_role FROM public.workspace_members
   WHERE workspace_id = workspace AND user_id = target_user;
  IF current_role IS NULL THEN RAISE EXCEPTION 'That person is not in this workspace'; END IF;

  IF current_role = 'manager' THEN
    SELECT count(*) INTO managers FROM public.workspace_members
     WHERE workspace_id = workspace AND role = 'manager';
    IF managers <= 1 THEN RAISE EXCEPTION 'A workspace must keep at least one manager'; END IF;
  END IF;

  -- Documents and ledger rows reference the user and are deliberately preserved:
  -- removing someone must not rewrite stock history they recorded.
  DELETE FROM public.workspace_members
   WHERE workspace_id = workspace AND user_id = target_user;
END $$;

GRANT EXECUTE ON FUNCTION public.set_member_role(uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_member(uuid,uuid) TO authenticated;

COMMENT ON FUNCTION public.set_member_role(uuid,uuid,text) IS
  'Manager-only. Grants manager, staff, or revokes to pending. Keeps at least one manager.';
