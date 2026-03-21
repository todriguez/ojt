# Backup & Recovery Runbook — Sprint 5A

## 1. Neon Postgres Point-in-Time Recovery

Neon provides built-in PITR on all paid plans.

**Verify PITR is enabled:**
1. Log in to Neon Console
2. Navigate to your project → Settings → Storage
3. Confirm "Point-in-time recovery" is enabled
4. Note the retention period (default: 7 days on Pro)

**To restore:**
1. Neon Console → Branches → Create branch from timestamp
2. Select the point in time before the incident
3. Update `DATABASE_URL` to point to the restored branch
4. Verify data integrity
5. If good, promote the restored branch or migrate data back

## 2. Drizzle Migration Rollback

Each migration in `drizzle/` is a forward-only SQL file. To roll back:

**Option A: Drizzle Kit (if supported)**
```bash
npx drizzle-kit down
```

**Option B: Manual rollback**
For each migration, create a corresponding `down` script:
- `0003_*.sql` adds `sessions` and `audit_log` tables
  - Rollback: `DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS audit_log; DROP TYPE IF EXISTS session_type; DROP TYPE IF EXISTS audit_actor_type;`

**Before running any migration in production:**
1. Test on a Neon branch first
2. Take a Neon snapshot/branch as a backup point
3. Apply migration
4. Verify with `npm run db:verify`
5. If verification fails, restore from the Neon branch

## 3. Staging Migration Failure Plan

If a migration fails on staging:

1. **Do not apply to production**
2. Check the error in Vercel function logs
3. Fix the migration SQL
4. Drop and recreate the staging Neon branch from production
5. Re-apply all migrations from scratch
6. Staging is disposable — production data is what matters

## 4. Data Export

Run the export script to dump data as JSONL:

```bash
npx tsx scripts/export-data.ts
```

This exports:
- `export-jobs.jsonl` — all jobs with scoring columns
- `export-messages.jsonl` — all conversation messages
- `export-customers.jsonl` — all customer records
- `export-outcomes.jsonl` — all job outcome records

**Schedule:** Run manually before major migrations or weekly via cron.

## 5. Environment-Specific Considerations

| Environment | Database | Backup Strategy |
|-------------|----------|-----------------|
| Local | PGlite (`./pglite-data-v2`) | Git-ignored, disposable |
| Staging | Neon branch | Disposable, recreate from prod |
| Production | Neon main branch | PITR + weekly JSONL export |
