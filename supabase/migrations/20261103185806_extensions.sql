-- Extensions used by Headway.
-- pg_cron: 15 s schedule for the worker. pg_net: HTTP call from Cron to the Edge Function.
-- pg_trgm: typo-tolerant station search.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_trgm with schema extensions;
