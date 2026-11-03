# Step 6: System Understanding Quiz

A record of the five-question quiz on how HEADWAY works, completed one question at a time as Step 6 requires. Each answer below reflects the quiz discussion, including the details clarified afterwards.

## 1. Comparing boards, not feed bytes

**Question.** Why can't the worker tell whether arrivals changed by checking whether a feed's bytes or timestamp changed? What does HEADWAY compare instead?

**Answer.** A feed's bytes and `header.timestamp` change every few seconds, even when nothing riders care about has changed. So HEADWAY builds candidate boards, with the next 3 trains per route at each platform. `commit_worker_run()` compares them with the stored boards using the rule in `board_changed()`. A board is written when its trains, their order or their status change, or when an ETA moves at least 30 seconds from the stored value. Measuring against the stored value means slow drift still adds up and eventually triggers a write.

**Key concept.** Detect changes in decoded, meaningful data, not in the transport. This avoids unnecessary database writes and Realtime messages.

## 2. Atomic leases and fencing tokens

**Question.** Cron fires every 15 seconds, and a run might take longer than expected. What stops two overlapping runs from both writing, and what stops a slow older run from overwriting newer data?

**Answer.** Before doing any work, a run must claim a lease through `claim_worker_run()`, which uses an advisory lock, a partial unique index on `status = 'running'`, and `insert … on conflict do nothing`. A second claim gets `null` and the run is skipped. The lease lasts 30 seconds, so a crashed worker can't block later runs forever. Each run also gets a rising ID that acts as a fencing token: `commit_worker_run()` rejects a run that has been superseded, and the board upsert only applies when the stored `run_id` is older.

**Key concept.** Mutual exclusion and fencing are enforced inside PostgreSQL transactions, so correctness doesn't depend on worker timing.

## 3. Why change detection runs in PostgreSQL

**Question.** Why does the comparison run in PostgreSQL rather than in the Edge Function? What limit would the other design have hit?

**Answer.** Comparing in the Edge Function would mean downloading all the stored boards every run: about 837 KB, or about 148 GB a month, far above Supabase's 5 GB monthly free egress limit. Instead, the worker sends its candidate boards to `commit_worker_run()` and gets back only a small summary, about 45 MB of egress a month. Data sent into the database doesn't count as egress. The savings in writes and Realtime messages come from the change rule itself; running it in PostgreSQL is what saves the egress, and it keeps the comparison and the writes in one transaction.

**Key concept.** Move the computation to the data when moving the data is the expensive part.

## 4. Filtered Realtime and local countdowns

**Question.** What does the browser subscribe to, and why not the whole `platform_boards` table? How does the countdown keep changing between messages?

**Answer.** The browser subscribes to Postgres Changes on `platform_boards`, filtered to the `station_id` values it is showing, plus the `worker_status` heartbeat. With nearly 1,000 boards, most changes are irrelevant to any one rider, so filtering cuts messages, bandwidth and cost. Boards store an absolute arrival time (`eta`), and a one-second timer in the browser computes the time remaining. It uses a clock offset from the `server_now` RPC, so a wrong device clock doesn't skew the countdown. When a channel reports `SUBSCRIBED`, the page refetches the boards so nothing missed while connecting is lost.

**Key concept.** Realtime delivers changes in the data; passing time is handled locally.

## 5. Clerk JWTs and row-level security

**Question.** When a signed-in rider taps Save, how does Supabase know who they are, and what stops them from reading another rider's saved stations or saving under someone else's account?

**Answer.** Clerk issues a signed JWT with the user's ID in `sub` and `role: authenticated`. The Supabase client sends it through its `accessToken` callback, and Supabase verifies it through the Clerk third-party auth integration. The `follows` table has row-level security: its `select`, `insert` and `delete` policies all compare `user_id` with `auth.jwt()->>'sub'`. These checks run inside PostgreSQL, so editing a browser request to use another person's ID is rejected. This was verified with two real Clerk test users, and all 15 RLS checks passed.

**Key concept.** Authorization belongs in the database, tied to a verified identity, not in the frontend.
