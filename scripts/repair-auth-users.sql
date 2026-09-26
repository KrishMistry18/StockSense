-- ===========================================================================
--  REPAIR: heal auth.users rows that were inserted by raw SQL
--
--  RUN THIS ONCE, in Supabase dashboard -> SQL Editor -> New query.
--
--  THE PROBLEM
--    GoTrue (Supabase Auth) scans several varchar columns on auth.users into
--    plain Go strings, which cannot hold NULL. Some of those columns have no
--    database default, so a hand-written INSERT that omits them leaves NULLs
--    behind. Every query that touches such a row then fails, which surfaces as:
--
--      500 "Database error finding users"     (listing users)
--      500 "Database error querying schema"   (signing in)
--      500 "Database error loading user"      (admin read or delete)
--
--    The whole auth API degrades, not just the affected accounts, because these
--    queries scan across rows.
--
--  THE FIX
--    Set those columns to the empty string they were always meant to hold. This
--    is safe for every account, touches nothing else, and is idempotent.
--
--  Column names are checked against information_schema first, because the exact
--  set varies between GoTrue releases.
-- ===========================================================================

DO $$
DECLARE
  col text;
  patched int;
  total int := 0;
BEGIN
  FOR col IN
    SELECT unnest(ARRAY[
      'confirmation_token',
      'recovery_token',
      'email_change',
      'email_change_token_new',
      'email_change_token_current',
      'phone_change',
      'phone_change_token',
      'reauthentication_token'
    ])
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = col
    ) THEN
      EXECUTE format('UPDATE auth.users SET %I = %L WHERE %I IS NULL', col, '', col);
      GET DIAGNOSTICS patched = ROW_COUNT;
      total := total + patched;
      IF patched > 0 THEN
        RAISE NOTICE 'auth.users.% : repaired % row(s)', col, patched;
      END IF;
    END IF;
  END LOOP;

  RAISE NOTICE 'Done. % column value(s) repaired across auth.users.', total;
END $$;

-- Should list the three demo accounts, all confirmed, with no NULLs left.
SELECT u.email,
       (u.email_confirmed_at IS NOT NULL) AS confirmed,
       u.confirmation_token = '' AS token_ok,
       p.display_name,
       m.role
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
  LEFT JOIN public.workspace_members m ON m.user_id = u.id
 ORDER BY u.email;
