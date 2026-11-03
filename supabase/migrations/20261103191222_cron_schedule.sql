-- Supabase Cron: call the worker every 15 s (docs/step3/DATA_FLOW.md §3.1).
-- The worker secret is read from Vault at call time; it never appears in SQL, logs, or the repo.
select cron.schedule(
  'poll-subway',
  '15 seconds',
  $$
  select net.http_post(
    url := 'https://fddulhtbsrrzepgehdhi.supabase.co/functions/v1/poll-subway',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'worker_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000)
  $$
);

-- Daily housekeeping, SQL only (no Edge Function call): keep 3 days of worker_runs, 1 day of Cron history.
select cron.schedule(
  'headway-prune',
  '17 4 * * *',
  $$
  select public.prune_worker_history();
  delete from cron.job_run_details where end_time < now() - interval '1 day';
  $$
);
