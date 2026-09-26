-- ===========================================================================
--  StockSense — complete database schema
--
--  Paste this whole file into the SQL Editor of a NEW Supabase project and run
--  it once. It is every migration in drizzle/migrations, concatenated in the
--  order recorded in meta/_journal.json, so the result is identical to a fully
--  migrated database.
--
--  Generated from the migration files — do not hand-edit. To change the schema,
--  add a migration and regenerate.
-- ===========================================================================


-- ===========================================================================
--  0000_inventory_core
-- ===========================================================================

CREATE TABLE public.profiles (id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, display_name text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT, UPDATE ON public.profiles TO authenticated; GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_read ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY profiles_update ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE FUNCTION public.create_profile() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$ BEGIN INSERT INTO public.profiles(id,display_name) VALUES (NEW.id, coalesce(NEW.raw_user_meta_data->>'display_name','')); RETURN NEW; END $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.create_profile();
CREATE TABLE public.workspaces (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK (length(name) BETWEEN 2 AND 100), join_code text NOT NULL UNIQUE DEFAULT upper(substr(encode(gen_random_bytes(8),'hex'),1,10)), created_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT ON public.workspaces TO authenticated; GRANT ALL ON public.workspaces TO service_role;
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.workspace_members (workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, role text NOT NULL CHECK(role IN ('manager','staff')), PRIMARY KEY(workspace_id,user_id));
GRANT SELECT ON public.workspace_members TO authenticated; GRANT ALL ON public.workspace_members TO service_role;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.is_member(w uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=w AND user_id=auth.uid()) $$;
CREATE FUNCTION public.is_manager(w uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=w AND user_id=auth.uid() AND role='manager') $$;
GRANT EXECUTE ON FUNCTION public.is_member(uuid), public.is_manager(uuid) TO authenticated;
CREATE POLICY workspaces_read ON public.workspaces FOR SELECT TO authenticated USING(public.is_member(id));
CREATE POLICY members_read ON public.workspace_members FOR SELECT TO authenticated USING(public.is_member(workspace_id));
CREATE FUNCTION public.create_workspace(workspace_name text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$ DECLARE w uuid; BEGIN IF auth.uid() IS NULL OR length(trim(workspace_name)) NOT BETWEEN 2 AND 100 THEN RAISE EXCEPTION 'Invalid workspace name'; END IF; INSERT INTO public.workspaces(name) VALUES(trim(workspace_name)) RETURNING id INTO w; INSERT INTO public.workspace_members VALUES(w,auth.uid(),'manager'); RETURN w; END $$;
CREATE FUNCTION public.join_workspace(code text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$ DECLARE w uuid; BEGIN IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF; SELECT id INTO w FROM public.workspaces WHERE join_code=upper(trim(code)); IF w IS NULL THEN RAISE EXCEPTION 'Invalid invitation code'; END IF; INSERT INTO public.workspace_members VALUES(w,auth.uid(),'staff') ON CONFLICT DO NOTHING; RETURN w; END $$;
GRANT EXECUTE ON FUNCTION public.create_workspace(text), public.join_workspace(text) TO authenticated;
CREATE TABLE public.warehouses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE, name text NOT NULL CHECK(length(name) BETWEEN 2 AND 100), code text NOT NULL CHECK(length(code) BETWEEN 2 AND 24), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,code));
GRANT SELECT, INSERT, UPDATE ON public.warehouses TO authenticated; GRANT ALL ON public.warehouses TO service_role;
ALTER TABLE public.warehouses ENABLE ROW LEVEL SECURITY;
CREATE POLICY warehouses_read ON public.warehouses FOR SELECT TO authenticated USING(public.is_member(workspace_id));
CREATE POLICY warehouses_insert ON public.warehouses FOR INSERT TO authenticated WITH CHECK(public.is_manager(workspace_id));
CREATE POLICY warehouses_update ON public.warehouses FOR UPDATE TO authenticated USING(public.is_manager(workspace_id)) WITH CHECK(public.is_manager(workspace_id));
CREATE TABLE public.locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE, warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE, name text NOT NULL CHECK(length(name) BETWEEN 2 AND 100), code text NOT NULL CHECK(length(code) BETWEEN 2 AND 24), UNIQUE(warehouse_id,code));
GRANT SELECT, INSERT, UPDATE ON public.locations TO authenticated; GRANT ALL ON public.locations TO service_role;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY locations_read ON public.locations FOR SELECT TO authenticated USING(public.is_member(workspace_id));
CREATE POLICY locations_insert ON public.locations FOR INSERT TO authenticated WITH CHECK(public.is_manager(workspace_id) AND EXISTS(SELECT 1 FROM public.warehouses w WHERE w.id=warehouse_id AND w.workspace_id=locations.workspace_id));
CREATE POLICY locations_update ON public.locations FOR UPDATE TO authenticated USING(public.is_manager(workspace_id)) WITH CHECK(public.is_manager(workspace_id) AND EXISTS(SELECT 1 FROM public.warehouses w WHERE w.id=warehouse_id AND w.workspace_id=locations.workspace_id));
CREATE TABLE public.products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE, name text NOT NULL CHECK(length(name) BETWEEN 2 AND 120), sku text NOT NULL CHECK(length(sku) BETWEEN 1 AND 50), category text NOT NULL DEFAULT 'General' CHECK(length(category) BETWEEN 1 AND 80), unit text NOT NULL DEFAULT 'Units' CHECK(length(unit) BETWEEN 1 AND 24), reorder_point numeric(14,2) NOT NULL DEFAULT 10 CHECK(reorder_point>=0), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,sku));
GRANT SELECT, INSERT, UPDATE ON public.products TO authenticated; GRANT ALL ON public.products TO service_role;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
CREATE POLICY products_read ON public.products FOR SELECT TO authenticated USING(public.is_member(workspace_id));
CREATE POLICY products_insert ON public.products FOR INSERT TO authenticated WITH CHECK(public.is_manager(workspace_id));
CREATE POLICY products_update ON public.products FOR UPDATE TO authenticated USING(public.is_manager(workspace_id)) WITH CHECK(public.is_manager(workspace_id));
CREATE TABLE public.stock_balances (workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE, product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE, location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE, quantity numeric(14,2) NOT NULL DEFAULT 0 CHECK(quantity>=0), PRIMARY KEY(product_id,location_id));
GRANT SELECT ON public.stock_balances TO authenticated; GRANT ALL ON public.stock_balances TO service_role;
ALTER TABLE public.stock_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY balances_read ON public.stock_balances FOR SELECT TO authenticated USING(public.is_member(workspace_id));
CREATE TABLE public.operations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE, reference text NOT NULL, kind text NOT NULL CHECK(kind IN ('receipt','delivery','transfer','adjustment')), status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','waiting','ready','done','canceled')), contact text NOT NULL DEFAULT '', source_location_id uuid REFERENCES public.locations(id), destination_location_id uuid REFERENCES public.locations(id), notes text NOT NULL DEFAULT '', created_by uuid NOT NULL REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, UNIQUE(workspace_id,reference));
GRANT SELECT, INSERT ON public.operations TO authenticated; GRANT UPDATE(contact,source_location_id,destination_location_id,notes) ON public.operations TO authenticated; GRANT ALL ON public.operations TO service_role;
ALTER TABLE public.operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY operations_read ON public.operations FOR SELECT TO authenticated USING(public.is_member(workspace_id));
CREATE POLICY operations_insert ON public.operations FOR INSERT TO authenticated WITH CHECK(public.is_member(workspace_id) AND created_by=auth.uid() AND status='draft');
CREATE POLICY operations_update ON public.operations FOR UPDATE TO authenticated USING(public.is_member(workspace_id) AND status='draft') WITH CHECK(public.is_member(workspace_id) AND status='draft');
CREATE TABLE public.operation_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE, operation_id uuid NOT NULL REFERENCES public.operations(id) ON DELETE CASCADE, product_id uuid NOT NULL REFERENCES public.products(id), quantity numeric(14,2) NOT NULL CHECK(quantity>=0 AND quantity<=100000000), counted_quantity numeric(14,2) CHECK(counted_quantity>=0 AND counted_quantity<=100000000));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.operation_items TO authenticated; GRANT ALL ON public.operation_items TO service_role;
ALTER TABLE public.operation_items ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.can_edit_operation(op uuid, w uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT public.is_member(w) AND EXISTS(SELECT 1 FROM public.operations WHERE id=op AND workspace_id=w AND status='draft') $$;
GRANT EXECUTE ON FUNCTION public.can_edit_operation(uuid,uuid) TO authenticated;
CREATE POLICY items_read ON public.operation_items FOR SELECT TO authenticated USING(public.is_member(workspace_id));
CREATE POLICY items_insert ON public.operation_items FOR INSERT TO authenticated WITH CHECK(public.can_edit_operation(operation_id,workspace_id) AND EXISTS(SELECT 1 FROM public.products WHERE id=product_id AND workspace_id=operation_items.workspace_id));
CREATE POLICY items_update ON public.operation_items FOR UPDATE TO authenticated USING(public.can_edit_operation(operation_id,workspace_id)) WITH CHECK(public.can_edit_operation(operation_id,workspace_id) AND EXISTS(SELECT 1 FROM public.products WHERE id=product_id AND workspace_id=operation_items.workspace_id));
CREATE POLICY items_delete ON public.operation_items FOR DELETE TO authenticated USING(public.can_edit_operation(operation_id,workspace_id));
CREATE TABLE public.stock_ledger (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE, operation_id uuid REFERENCES public.operations(id), product_id uuid NOT NULL REFERENCES public.products(id), location_id uuid NOT NULL REFERENCES public.locations(id), delta numeric(14,2) NOT NULL, balance_after numeric(14,2) NOT NULL, created_by uuid NOT NULL REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT ON public.stock_ledger TO authenticated; GRANT ALL ON public.stock_ledger TO service_role;
ALTER TABLE public.stock_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY ledger_read ON public.stock_ledger FOR SELECT TO authenticated USING(public.is_member(workspace_id));
CREATE FUNCTION public.apply_stock(w uuid, op uuid, p uuid, loc uuid, amount numeric) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE current_balance numeric; BEGIN IF loc IS NULL THEN RAISE EXCEPTION 'Select a location'; END IF; IF NOT EXISTS(SELECT 1 FROM public.products WHERE id=p AND workspace_id=w) OR NOT EXISTS(SELECT 1 FROM public.locations WHERE id=loc AND workspace_id=w) THEN RAISE EXCEPTION 'Product and location must belong to this workspace'; END IF; INSERT INTO public.stock_balances(workspace_id,product_id,location_id,quantity) VALUES(w,p,loc,0) ON CONFLICT(product_id,location_id) DO NOTHING; SELECT quantity INTO current_balance FROM public.stock_balances WHERE product_id=p AND location_id=loc FOR UPDATE; IF current_balance+amount<0 THEN RAISE EXCEPTION 'Not enough stock at the selected location'; END IF; UPDATE public.stock_balances SET quantity=current_balance+amount WHERE product_id=p AND location_id=loc; INSERT INTO public.stock_ledger(workspace_id,operation_id,product_id,location_id,delta,balance_after,created_by) VALUES(w,op,p,loc,amount,current_balance+amount,auth.uid()); END $$;
REVOKE ALL ON FUNCTION public.apply_stock(uuid,uuid,uuid,uuid,numeric) FROM PUBLIC;
CREATE FUNCTION public.advance_operation(op_id uuid, next_status text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE o public.operations%ROWTYPE; item public.operation_items%ROWTYPE; old_quantity numeric; count_items integer; BEGIN SELECT * INTO o FROM public.operations WHERE id=op_id FOR UPDATE; IF o.id IS NULL OR NOT public.is_member(o.workspace_id) THEN RAISE EXCEPTION 'Operation not found'; END IF; IF o.status IN ('done','canceled') THEN RAISE EXCEPTION 'This operation is closed'; END IF; IF next_status='canceled' THEN UPDATE public.operations SET status='canceled' WHERE id=op_id; RETURN; END IF; IF next_status IN ('waiting','ready') THEN IF o.status NOT IN ('draft','waiting') THEN RAISE EXCEPTION 'Invalid status change'; END IF; UPDATE public.operations SET status=next_status WHERE id=op_id; RETURN; END IF; IF next_status<>'done' THEN RAISE EXCEPTION 'Invalid status'; END IF; IF o.kind='receipt' AND o.destination_location_id IS NULL OR o.kind IN ('delivery','adjustment','transfer') AND o.source_location_id IS NULL OR o.kind='transfer' AND (o.destination_location_id IS NULL OR o.destination_location_id=o.source_location_id) THEN RAISE EXCEPTION 'Select valid stock locations'; END IF; SELECT count(*) INTO count_items FROM public.operation_items WHERE operation_id=op_id; IF count_items=0 THEN RAISE EXCEPTION 'Add at least one product'; END IF; FOR item IN SELECT * FROM public.operation_items WHERE operation_id=op_id ORDER BY product_id LOOP IF item.quantity<=0 AND o.kind<>'adjustment' THEN RAISE EXCEPTION 'Quantities must be greater than zero'; END IF; IF o.kind='receipt' THEN PERFORM public.apply_stock(o.workspace_id,o.id,item.product_id,o.destination_location_id,item.quantity); ELSIF o.kind='delivery' THEN PERFORM public.apply_stock(o.workspace_id,o.id,item.product_id,o.source_location_id,-item.quantity); ELSIF o.kind='transfer' THEN PERFORM public.apply_stock(o.workspace_id,o.id,item.product_id,o.source_location_id,-item.quantity); PERFORM public.apply_stock(o.workspace_id,o.id,item.product_id,o.destination_location_id,item.quantity); ELSE IF item.counted_quantity IS NULL THEN RAISE EXCEPTION 'Enter the counted quantity'; END IF; SELECT coalesce(quantity,0) INTO old_quantity FROM public.stock_balances WHERE product_id=item.product_id AND location_id=o.source_location_id; PERFORM public.apply_stock(o.workspace_id,o.id,item.product_id,o.source_location_id,item.counted_quantity-coalesce(old_quantity,0)); END IF; END LOOP; UPDATE public.operations SET status='done', completed_at=now() WHERE id=op_id; END $$;
GRANT EXECUTE ON FUNCTION public.advance_operation(uuid,text) TO authenticated;
CREATE INDEX ON public.operations(workspace_id,created_at DESC); CREATE INDEX ON public.stock_ledger(workspace_id,created_at DESC); CREATE INDEX ON public.products(workspace_id,name);

-- ===========================================================================
--  0001_delivery_confirmations_and_product_archiving
-- ===========================================================================

ALTER TABLE public.products ADD COLUMN archived boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.products.archived IS 'Archived products remain in historical documents and stock ledger.';
ALTER TABLE public.operations ADD COLUMN picked_at timestamptz;
ALTER TABLE public.operations ADD COLUMN packed_at timestamptz;
CREATE OR REPLACE FUNCTION public.advance_operation(op_id uuid, next_status text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE o public.operations%ROWTYPE; item public.operation_items%ROWTYPE; old_quantity numeric; count_items integer;
BEGIN
 SELECT * INTO o FROM public.operations WHERE id=op_id FOR UPDATE;
 IF o.id IS NULL OR NOT public.is_member(o.workspace_id) THEN RAISE EXCEPTION 'Operation not found'; END IF;
 IF o.status IN ('done','canceled') THEN RAISE EXCEPTION 'This operation is closed'; END IF;
 IF next_status='canceled' THEN UPDATE public.operations SET status='canceled' WHERE id=op_id; RETURN; END IF;
 IF o.kind='delivery' THEN
   IF next_status='waiting' THEN
     IF o.status<>'draft' THEN RAISE EXCEPTION 'Pick is only available for a draft delivery'; END IF;
     IF o.source_location_id IS NULL THEN RAISE EXCEPTION 'Select a stock location'; END IF;
     SELECT count(*) INTO count_items FROM public.operation_items WHERE operation_id=op_id;
     IF count_items=0 THEN RAISE EXCEPTION 'Add at least one product'; END IF;
     FOR item IN SELECT * FROM public.operation_items WHERE operation_id=op_id LOOP
       IF item.quantity<=0 OR item.quantity>coalesce((SELECT quantity FROM public.stock_balances WHERE product_id=item.product_id AND location_id=o.source_location_id),0) THEN RAISE EXCEPTION 'Not enough stock to pick this delivery'; END IF;
     END LOOP;
     UPDATE public.operations SET status='waiting',picked_at=now() WHERE id=op_id; RETURN;
   ELSIF next_status='ready' THEN
     IF o.status<>'waiting' THEN RAISE EXCEPTION 'Confirm picking before packing'; END IF;
     UPDATE public.operations SET status='ready',packed_at=now() WHERE id=op_id; RETURN;
   ELSIF next_status='done' AND o.status<>'ready' THEN RAISE EXCEPTION 'Confirm packing before dispatch'; END IF;
 ELSIF next_status IN ('waiting','ready') THEN
   IF o.status NOT IN ('draft','waiting') THEN RAISE EXCEPTION 'Invalid status change'; END IF;
   UPDATE public.operations SET status=next_status WHERE id=op_id; RETURN;
 END IF;
 IF next_status<>'done' THEN RAISE EXCEPTION 'Invalid status'; END IF;
 IF o.kind='receipt' AND o.destination_location_id IS NULL OR o.kind IN ('delivery','adjustment','transfer') AND o.source_location_id IS NULL OR o.kind='transfer' AND (o.destination_location_id IS NULL OR o.destination_location_id=o.source_location_id) THEN RAISE EXCEPTION 'Select valid stock locations'; END IF;
 SELECT count(*) INTO count_items FROM public.operation_items WHERE operation_id=op_id;
 IF count_items=0 THEN RAISE EXCEPTION 'Add at least one product'; END IF;
 FOR item IN SELECT * FROM public.operation_items WHERE operation_id=op_id ORDER BY product_id LOOP
   IF item.quantity<=0 AND o.kind<>'adjustment' THEN RAISE EXCEPTION 'Quantities must be greater than zero'; END IF;
   IF o.kind='receipt' THEN PERFORM public.apply_stock(o.workspace_id,o.id,item.product_id,o.destination_location_id,item.quantity);
   ELSIF o.kind='delivery' THEN PERFORM public.apply_stock(o.workspace_id,o.id,item.product_id,o.source_location_id,-item.quantity);
   ELSIF o.kind='transfer' THEN PERFORM public.apply_stock(o.workspace_id,o.id,item.product_id,o.source_location_id,-item.quantity); PERFORM public.apply_stock(o.workspace_id,o.id,item.product_id,o.destination_location_id,item.quantity);
   ELSE IF item.counted_quantity IS NULL THEN RAISE EXCEPTION 'Enter the counted quantity'; END IF;
     SELECT coalesce(quantity,0) INTO old_quantity FROM public.stock_balances WHERE product_id=item.product_id AND location_id=o.source_location_id;
     PERFORM public.apply_stock(o.workspace_id,o.id,item.product_id,o.source_location_id,item.counted_quantity-coalesce(old_quantity,0));
   END IF;
 END LOOP;
 UPDATE public.operations SET status='done',completed_at=now() WHERE id=op_id;
END $function$;
CREATE OR REPLACE FUNCTION public.discard_draft_operation(op_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE o public.operations%ROWTYPE;
BEGIN
 SELECT * INTO o FROM public.operations WHERE id=op_id FOR UPDATE;
 IF o.id IS NULL OR o.status<>'draft' OR NOT public.is_member(o.workspace_id) THEN RAISE EXCEPTION 'Only a workspace draft can be discarded'; END IF;
 DELETE FROM public.operation_items WHERE operation_id=op_id;
 DELETE FROM public.operations WHERE id=op_id;
END $function$;
GRANT EXECUTE ON FUNCTION public.discard_draft_operation(uuid) TO authenticated;

-- ===========================================================================
--  0002_ledger_actor_names
-- ===========================================================================

-- The stock ledger already records who made every movement, but a member could only ever read
-- their own profile, so the audit trail could not name anyone else. This lets members of the same
-- workspace resolve each other's display name and nothing more.
-- Written to be re-runnable: this backend's dashboard is not reachable, so a
-- half-applied state can only be repaired by the migration itself.
CREATE OR REPLACE FUNCTION public.shares_workspace(other uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT EXISTS(SELECT 1 FROM public.workspace_members me JOIN public.workspace_members them ON me.workspace_id=them.workspace_id WHERE me.user_id=auth.uid() AND them.user_id=other) $$;
GRANT EXECUTE ON FUNCTION public.shares_workspace(uuid) TO authenticated;
DROP POLICY IF EXISTS profiles_read_coworkers ON public.profiles;
CREATE POLICY profiles_read_coworkers ON public.profiles FOR SELECT TO authenticated USING(public.shares_workspace(id));
COMMENT ON POLICY profiles_read_coworkers ON public.profiles IS 'Workspace members can read each other''s display name so the stock ledger can attribute each movement to a person.';


-- ===========================================================================
--  0003_demo_accounts
-- ===========================================================================

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
--  SECURITY â€” READ BEFORE GOING LIVE
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

