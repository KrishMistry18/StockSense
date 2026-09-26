-- ===========================================================================
--  StockSense — demo sign-in accounts
--  DEV / DEMO ONLY. These passwords are committed to the repository.
--
--  Deliberately NOT placed in drizzle/migrations: everything in that folder runs
--  on every deploy, and seeding publicly-known passwords into a real environment
--  would be a straightforward account takeover. Run this by hand instead.
--
--  HOW TO RUN
--    Supabase dashboard -> SQL Editor -> New query -> paste this file -> Run.
--
--  WHY THIS EXISTS
--    The project has "Confirm email" switched on, so a normal sign-up cannot
--    complete without a reachable inbox. This writes email_confirmed_at directly,
--    so the accounts are usable immediately without changing that setting.
--
--  Safe to run more than once. Re-running resets these passwords and repairs an
--  account that was signed up earlier but never confirmed.
-- ===========================================================================

-- pgcrypto lives in "extensions" on Supabase but in "public" elsewhere; this
-- resolves crypt()/gen_salt() either way.
SET search_path = public, extensions;

DO $$
DECLARE
  demo_password text := 'StockSense#2026';
  target_workspace uuid;
  seed record;
  -- Not named user_id: PL/pgSQL would not be able to tell the variable apart from
  -- auth.identities.user_id and would abort with an ambiguous column reference.
  seed_user uuid;
BEGIN
  -- Attach the demo accounts to the existing workspace so they see the sample
  -- warehouses, products, and movement history that is already there.
  SELECT id INTO target_workspace FROM public.workspaces ORDER BY created_at LIMIT 1;
  IF target_workspace IS NULL THEN
    INSERT INTO public.workspaces(name) VALUES ('StockSense Demo') RETURNING id INTO target_workspace;
    RAISE NOTICE 'No workspace existed, created a fresh one.';
  END IF;

  FOR seed IN
    SELECT * FROM (VALUES
      ('admin@stocksense.local',   'Admin User',    'manager'),
      ('manager@stocksense.local', 'Maya Manager',  'manager'),
      ('staff@stocksense.local',   'Sam Stockroom', 'staff')
    ) AS t(email, display_name, member_role)
  LOOP
    SELECT id INTO seed_user FROM auth.users WHERE email = seed.email;

    IF seed_user IS NULL THEN
      seed_user := gen_random_uuid();

      INSERT INTO auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at
      ) VALUES (
        '00000000-0000-0000-0000-000000000000', seed_user, 'authenticated', 'authenticated',
        seed.email, crypt(demo_password, gen_salt('bf')),
        now(),                                    -- pre-confirmed, so no inbox is needed
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('display_name', seed.display_name),
        now(), now()
      );

      -- GoTrue will not accept a password login without a matching identity row.
      INSERT INTO auth.identities (
        provider_id, user_id, identity_data, provider,
        last_sign_in_at, created_at, updated_at
      ) VALUES (
        seed_user::text, seed_user,
        jsonb_build_object('sub', seed_user::text, 'email', seed.email, 'email_verified', true),
        'email', now(), now(), now()
      );

      RAISE NOTICE 'Created %', seed.email;
    ELSE
      UPDATE auth.users
         SET encrypted_password = crypt(demo_password, gen_salt('bf')),
             email_confirmed_at = coalesce(email_confirmed_at, now()),
             raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
                                  || jsonb_build_object('display_name', seed.display_name),
             updated_at = now()
       WHERE id = seed_user;

      -- Repairs a sign-up that predates this script and has no identity row.
      INSERT INTO auth.identities (
        provider_id, user_id, identity_data, provider,
        last_sign_in_at, created_at, updated_at
      )
      SELECT seed_user::text, seed_user,
             jsonb_build_object('sub', seed_user::text, 'email', seed.email, 'email_verified', true),
             'email', now(), now(), now()
      WHERE NOT EXISTS (
        SELECT 1 FROM auth.identities i WHERE i.user_id = seed_user AND i.provider = 'email'
      );

      RAISE NOTICE 'Reset password and confirmed %', seed.email;
    END IF;

    -- The on_auth_user_created trigger normally fills this in; upsert keeps the
    -- display name correct for accounts that already existed.
    INSERT INTO public.profiles(id, display_name)
    VALUES (seed_user, seed.display_name)
    ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name;

    INSERT INTO public.workspace_members(workspace_id, user_id, role)
    VALUES (target_workspace, seed_user, seed.member_role)
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role;
  END LOOP;

  RAISE NOTICE 'Demo accounts ready. Workspace: %', target_workspace;
END $$;

-- Confirm the result.
SELECT u.email,
       p.display_name,
       m.role,
       w.name AS workspace,
       (u.email_confirmed_at IS NOT NULL) AS confirmed
  FROM auth.users u
  JOIN public.profiles p ON p.id = u.id
  LEFT JOIN public.workspace_members m ON m.user_id = u.id
  LEFT JOIN public.workspaces w ON w.id = m.workspace_id
 WHERE u.email LIKE '%@stocksense.local'
 ORDER BY u.email;
