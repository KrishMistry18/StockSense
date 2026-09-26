-- ===========================================================================
--  Demo sign-in accounts, applied through the migration pipeline.
--
--  WHY THIS IS A MIGRATION
--    This backend is provisioned by Lovable Cloud, so its Supabase dashboard is
--    not reachable by the project owner: the auth settings cannot be changed and
--    the SQL editor cannot be opened. Migrations are the only channel that
--    reaches this database, so the identical script in scripts/seed-demo-users.sql
--    is mirrored here to make the demo sign-in cards usable.
--
--  SECURITY — READ BEFORE GOING LIVE
--    The password below is committed to the repository, so these three accounts
--    are public knowledge. Delete this migration and drop the accounts before the
--    app faces real users, or rotate the passwords.
--
--  Email confirmation stays ON for everyone else: this only pre-confirms these
--  three accounts by writing email_confirmed_at directly. Normal sign-ups still
--  have to verify their address.
--
--  Every failure is swallowed into a warning on purpose. Writing to auth.users is
--  an unofficial pattern and the schema varies between GoTrue releases; a mismatch
--  must not abort the deployment and take the rest of the migrations with it.
-- ===========================================================================

-- pgcrypto lives in "extensions" on Supabase but "public" elsewhere.
SET search_path = public, extensions;

DO $$
DECLARE
  demo_password text := 'StockSense#2026';
  target_workspace uuid;
  seed record;
  -- Not named user_id: PL/pgSQL could not tell the variable apart from
  -- auth.identities.user_id and would abort on an ambiguous column reference.
  seed_user uuid;
BEGIN
  -- Attach to the existing workspace so the demo accounts land on the sample
  -- warehouses, products, and movement history instead of the setup wizard.
  SELECT id INTO target_workspace FROM public.workspaces ORDER BY created_at LIMIT 1;
  IF target_workspace IS NULL THEN
    INSERT INTO public.workspaces(name) VALUES ('StockSense Demo') RETURNING id INTO target_workspace;
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
        now(),                                   -- pre-confirmed, so no inbox is needed
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('display_name', seed.display_name),
        now(), now()
      );

      -- GoTrue refuses a password login without a matching identity row.
      INSERT INTO auth.identities (
        provider_id, user_id, identity_data, provider,
        last_sign_in_at, created_at, updated_at
      ) VALUES (
        seed_user::text, seed_user,
        jsonb_build_object('sub', seed_user::text, 'email', seed.email, 'email_verified', true),
        'email', now(), now(), now()
      );
    ELSE
      -- Repairs an account signed up through the app that never got confirmed.
      UPDATE auth.users
         SET encrypted_password = crypt(demo_password, gen_salt('bf')),
             email_confirmed_at = coalesce(email_confirmed_at, now()),
             raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
                                  || jsonb_build_object('display_name', seed.display_name),
             updated_at = now()
       WHERE id = seed_user;

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
    END IF;

    -- on_auth_user_created normally fills this in; upsert keeps the name right
    -- for accounts that already existed.
    INSERT INTO public.profiles(id, display_name)
    VALUES (seed_user, seed.display_name)
    ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name;

    INSERT INTO public.workspace_members(workspace_id, user_id, role)
    VALUES (target_workspace, seed_user, seed.member_role)
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role;
  END LOOP;

  RAISE NOTICE 'Demo accounts ready in workspace %', target_workspace;
EXCEPTION WHEN OTHERS THEN
  -- Never block a deployment over demo data.
  RAISE WARNING 'Demo account seeding skipped: % (%)', SQLERRM, SQLSTATE;
END $$;

RESET search_path;
