-- Optional Postgres Row-Level Security (defense-in-depth).
--
-- The repository layer already scopes every query by tenant_id; RLS is a second
-- wall so a missed WHERE can't leak across tenants. It is OFF by default because
-- it requires a two-role setup:
--
--   * The API connects as a NON-OWNER role (RLS applies; FORCE not needed for
--     non-owners) that has only DML grants. require_tenant sets
--     `app.current_tenant` per transaction (already wired behind ENABLE_RLS=1).
--   * The worker + carrier paths (which look up rows by job/token across
--     tenants, before a tenant is known) connect as a role with BYPASSRLS.
--
-- Apply this AFTER creating those roles and pointing DATABASE_URL at the
-- non-owner API role. Adjust the role names to your setup.
--
-- Example role setup (run as superuser):
--   CREATE ROLE voice_api LOGIN PASSWORD '...';
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voice_api;
--   ALTER ROLE voice_worker BYPASSRLS;   -- worker/carrier connection role

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'api_keys','tenant_keys','connections','agents','calls','call_jobs',
    'webhook_endpoints','webhook_deliveries','idempotency_keys',
    'rate_limit_counters','usage_records','phone_numbers'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.current_tenant'', true)::uuid);',
      t
    );
  END LOOP;
END $$;
