// Worker tests on saved MTA responses (docs/step1/evidence/raw). No network, no live database:
// the real migrations run in an in-memory PostgreSQL (PGlite), and the real worker code talks to it.
// Run: deno test --allow-read supabase/functions/tests/
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { PGlite } from "npm:@electric-sql/pglite@0.5.11";
import { decodeFeed } from "../poll-subway/gtfs.ts";
import { buildCandidates } from "../poll-subway/boards.ts";
import { FEEDS, type FetchFeed, type Rpc, runOnce } from "../poll-subway/worker.ts";

const ROOT = new URL("../../../", import.meta.url);
const RAW = new URL("docs/step1/evidence/raw/", ROOT);
const MIGRATIONS = [
  "20261103185826_schema.sql",
  "20261103185908_worker_functions.sql",
  "20261103190404_seed_routes_stations_a.sql",
  "20261103190531_seed_stations_b.sql",
  "20261103190640_seed_platforms.sql",
  "20261103190702_seed_route_stops.sql",
  "20261103191915_follows_rls_perf.sql",
].map((f) => new URL(`supabase/migrations/${f}`, ROOT));

const fixture = (snap: string, feed: string) => Deno.readFileSync(new URL(`${snap}_${feed}.pb`, RAW));

async function snapshotJson(snap: string) {
  const gz = await Deno.readFile(new URL(`docs/step1/evidence/snap_${snap}.json.gz`, ROOT));
  const text = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  return JSON.parse(text);
}

// "now" for a snapshot: just after the newest feed header, like the real run
const snapNowS = (snap: string) => Math.max(...FEEDS.map((f) => decodeFeed(fixture(snap, f)).timestamp)) + 3;

// Supabase-specific objects that PGlite doesn't have
const PREAMBLE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.jwt() to anon, authenticated;
  create schema extensions;
  create publication supabase_realtime;
`;

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(PREAMBLE);
  for (const m of MIGRATIONS) await db.exec(await Deno.readTextFile(m));
  return db;
}

// RPC against PGlite with a test clock (production uses the database's now())
function pgRpc(db: PGlite, nowS: () => number): Rpc {
  const types: Record<string, string> = {
    p_run_id: "bigint", p_feeds: "jsonb", p_boards: "jsonb", p_meta: "jsonb", p_error: "text", p_now: "timestamptz",
  };
  return async (fn, args) => {
    const all: Record<string, unknown> = { ...args, p_now: new Date(nowS() * 1000).toISOString() };
    const names = Object.keys(all);
    const params = names.map((n) => (types[n] === "jsonb" ? JSON.stringify(all[n]) : all[n]));
    const sql = `select to_jsonb(public.${fn}(${names.map((n, i) => `${n} => $${i + 1}::${types[n]}`).join(", ")})) as r`;
    const res = await db.query<{ r: unknown }>(sql, params);
    return res.rows[0].r;
  };
}

const fixtureFetch = (snap: string, failing: string[] = []): FetchFeed => async (feed) => {
  if (failing.includes(feed)) throw new Error("timeout");
  return fixture(snap, feed);
};

async function run(db: PGlite, snap: string, opts: { dt?: number; failing?: string[] } = {}) {
  const nowS = snapNowS(snap) + (opts.dt ?? 0);
  return runOnce({ fetchFeed: fixtureFetch(snap, opts.failing), rpc: pgRpc(db, () => nowS), nowMs: () => nowS * 1000 });
}

const count = async (db: PGlite, sql: string) => Number((await db.query<{ n: number }>(sql)).rows[0].n);

// ------------------------------------------------------------------------------------- decoder
Deno.test("decoder matches the independently decoded Step 1 snapshot for all 8 feeds", async () => {
  const snap = await snapshotJson("A");
  for (const feed of FEEDS) {
    const msg = decodeFeed(fixture("A", feed));
    const ref = snap.feeds[feed];
    assertEquals(msg.timestamp, ref.feed_timestamp, `${feed} timestamp`);
    assertEquals(msg.trips.length, ref.trip_updates, `${feed} trips`);
    assertEquals(
      msg.trips.reduce((n, t) => n + t.stops.length, 0),
      ref.trips.reduce((n: number, t: { stops: unknown[] }) => n + t.stops.length, 0),
      `${feed} stop updates`,
    );
    assertEquals(msg.trips.filter((t) => t.assigned).length, ref.trips.filter((t: { is_assigned: boolean }) => t.is_assigned).length, `${feed} assigned`);
  }
});

Deno.test("decoder rejects a corrupted feed", () => {
  const bytes = fixture("A", "gtfs-l").slice(0, 5000);
  let threw = false;
  try { decodeFeed(bytes); } catch { threw = true; }
  assert(threw);
});

// ------------------------------------------------------------------------------------- candidates
Deno.test("candidate boards keep the next 3 trains of every route (125 St southbound has A, B, C, D)", () => {
  const nowS = snapNowS("A");
  const boards = buildCandidates(FEEDS.map((feed) => ({ feed, msg: decodeFeed(fixture("A", feed)) })), nowS);
  const a15s = boards.find((b) => b.stop_id === "A15S")!;
  const routes = new Set(a15s.trains.map((t) => t.route_id));
  for (const r of ["A", "B", "C", "D"]) assert(routes.has(r), `A15S missing ${r}`);
  for (const b of boards) {
    const per = new Map<string, number>();
    for (const t of b.trains) {
      per.set(t.route_id, (per.get(t.route_id) ?? 0) + 1);
      assert(t.eta >= nowS - 30 && t.eta <= nowS + 5400);
    }
    for (const n of per.values()) assert(n <= 3);
  }
});

// ------------------------------------------------------------------------------------- change rule
Deno.test("board_changed: every immediate rule triggers, jitter does not", async () => {
  const db = await freshDb();
  const now = 1_000_000;
  const tr = (o: Record<string, unknown> = {}) => ({
    trip_id: "t1", route_id: "A", eta: now + 300, kind: "arr", headsign: "Far Rockaway", live: true, feed: "gtfs-ace", carried: false, ...o,
  });
  const two = [tr(), tr({ trip_id: "t2", eta: now + 600 })];
  const cases: [string, unknown[], boolean][] = [
    ["identical", two, false],
    ["jitter 29 s", [tr({ eta: now + 329 }), tr({ trip_id: "t2", eta: now + 571 })], false],
    ["eta moved 30 s", [tr({ eta: now + 330 }), two[1]], true],
    ["new train (identity)", [tr({ trip_id: "t9" }), two[1]], true],
    ["order swap", [two[1], two[0]], true],
    ["departure (train disappears)", [two[1]], true],
    ["prediction disappears (board empties)", [], true],
    ["live flips", [tr({ live: false }), two[1]], true],
    ["destination changes", [tr({ headsign: "Lefferts Blvd" }), two[1]], true],
    ["route changes", [tr({ route_id: "C" }), two[1]], true],
    ["arrival vs departure", [tr({ kind: "dep" }), two[1]], true],
    ["carried flips", [tr({ carried: true }), two[1]], true],
    ["enters arriving window", [tr({ eta: now + 50 }), two[1]], true],
  ];
  // stored first train at now+300 → 50 s needs a separate stored board near the window edge
  const edge = [tr({ eta: now + 70 })];
  for (const [label, next, expected] of cases) {
    const stored = label === "enters arriving window" ? edge : two;
    const got = (await db.query<{ c: boolean }>("select public.board_changed($1::jsonb, $2::jsonb, $3) as c",
      [JSON.stringify(stored), JSON.stringify(next), now])).rows[0].c;
    assertEquals(got, expected, label);
  }
  await db.close();
});

// ------------------------------------------------------------------------------------- worker + SQL
Deno.test("worker on fixtures: fill, identical replay writes 0, real changes written, jitter skipped", async () => {
  const db = await freshDb();
  const a = await run(db, "A");
  assertEquals(a.status, "ok");
  assert(a.boards_changed! > 900, `initial fill wrote ${a.boards_changed}`);
  // Step 1 found ~0.8% of stop updates at non-public stop ids (R60, X22, H19, ...): SQL drops and counts them
  assertEquals(a.trains_rejected, 49);
  assertEquals(a.feeds_rejected, {});

  const replay = await run(db, "A");
  assertEquals(replay.boards_changed, 0, "identical replay must write nothing");

  const b = await run(db, "B");
  assertEquals(b.status, "ok");
  assert(b.boards_changed! > 0 && b.boards_changed! < 975);

  // Step 1's real change: L 072350_L..N at 14 St-Union Sq moved +486 s between A and B
  const l03n = (await db.query<{ trains: { trip_id: string; eta: number }[]; run_id: number }>(
    "select trains, run_id from public.platform_boards where stop_id = 'L03N'")).rows[0];
  const lTrain = l03n.trains.find((t) => t.trip_id === "072350_L..N");
  assert(lTrain, "L train present");
  assertEquals(lTrain!.eta, Date.UTC(2026, 10, 3, 17, 46, 21) / 1000);
  assertEquals(Number(l03n.run_id), b.run_id);

  // Some boards differed only by small jitter and were NOT rewritten
  const untouched = await count(db, `select count(*) n from public.platform_boards where run_id = ${a.run_id}`);
  assert(untouched > 0, "jitter-only boards keep the older run_id");

  // headsigns resolved from dest stop ids in SQL
  assert(lTrain && (l03n.trains[0] as unknown as { headsign: string }).headsign, "headsign resolved");
  await db.close();
});

Deno.test("feed failure: one-run blip keeps trains, second failure marks carried, recovery clears, nothing blanked", async () => {
  const db = await freshDb();
  await run(db, "C");
  const nonEmpty = await count(db, "select count(*) n from public.platform_boards where trains <> '[]'");
  const carried = () => count(db, "select count(*) n from public.platform_boards pb, jsonb_array_elements(pb.trains) t where (t->>'carried')::boolean");

  const r1 = await run(db, "C", { dt: 15, failing: ["gtfs"] });
  assertEquals(r1.status, "partial");
  assertEquals(r1.feeds_rejected, { gtfs: "timeout" });
  assertEquals(await carried(), 0, "first failure does not mark carried");

  const r2 = await run(db, "C", { dt: 30, failing: ["gtfs"] });
  assertEquals(r2.status, "partial");
  assert(await carried() > 0, "second consecutive failure marks carried");
  const status = (await db.query<{ feeds: Record<string, { fail_streak: number; ok: boolean }> }>(
    "select feeds from public.worker_status")).rows[0].feeds;
  assertEquals(status.gtfs.fail_streak, 2);
  assertEquals(status.gtfs.ok, false);

  const r3 = await run(db, "C", { dt: 45 });
  assertEquals(r3.status, "ok");
  assertEquals(await carried(), 0, "recovery clears carried");
  const emptied = nonEmpty - await count(db, "select count(*) n from public.platform_boards where trains <> '[]'");
  assert(emptied < 50, `only boards whose trains really departed may empty (${emptied})`);
  await db.close();
});

Deno.test("format change: renamed stop ids reject only that feed; corrupt feed reported as decode", async () => {
  const db = await freshDb();
  await run(db, "A");
  const nowS = snapNowS("B");
  const renameL: Rpc = async (fn, args) => {
    if (fn === "commit_worker_run") {
      (args.p_boards as { stop_id: string; trains: { feed: string }[] }[]).forEach((b) => {
        if (b.trains.some((t) => t.feed === "gtfs-l")) b.stop_id = "X" + b.stop_id;
      });
    }
    return pgRpc(db, () => nowS)(fn, args);
  };
  const res = await runOnce({ fetchFeed: fixtureFetch("B"), rpc: renameL, nowMs: () => nowS * 1000 });
  assertEquals(res.status, "partial");
  assertEquals(res.feeds_rejected, { "gtfs-l": "unmapped_spike" });

  const corrupt: FetchFeed = async (f) => (f === "gtfs-g" ? new Uint8Array([1, 2, 3]) : fixture("B", f));
  const res2 = await runOnce({ fetchFeed: corrupt, rpc: pgRpc(db, () => nowS + 15), nowMs: () => (nowS + 15) * 1000 });
  assertEquals(res2.feeds_rejected?.["gtfs-g"], "decode");
  await db.close();
});

// ------------------------------------------------------------------------------------- concurrency + validation
Deno.test("concurrency: one live lease, stale runs rejected, newer run always wins", async () => {
  const db = await freshDb();
  const nowS = snapNowS("A");
  const rpc = pgRpc(db, () => nowS);
  const r1 = await rpc("claim_worker_run", {}) as number;
  assert(r1 > 0);
  assertEquals(await rpc("claim_worker_run", {}), null, "overlapping claim refused");

  // raw second 'running' row is impossible at the constraint level
  await assertRejects(() => db.query("insert into public.worker_runs (lease_expires_at, status) values (now(), 'running')"));

  // lease expires → next claim supersedes r1; r1's late commit is rejected
  const later = pgRpc(db, () => nowS + 31);
  const r2 = await later("claim_worker_run", {}) as number;
  assert(r2 > r1);
  const feeds = Object.fromEntries(FEEDS.map((f) => [f, { ok: true, feed_ts: nowS, reason: null }]));
  await assertRejects(() => later("commit_worker_run", { p_run_id: r1, p_feeds: feeds, p_boards: [] }), Error, "superseded");
  assertEquals(await count(db, `select count(*) n from public.worker_runs where id = ${r1} and status = 'superseded'`), 1);

  // fencing at row level: a board owned by a newer run is never overwritten by an older run id
  await db.query("insert into public.platform_boards (stop_id, station_id, trains, run_id) values ('127S', 611, '[]', 999999)");
  const res = await later("commit_worker_run", { p_run_id: r2, p_feeds: feeds, p_boards: [{ stop_id: "127S", trains: [{ trip_id: "x", route_id: "1", eta: nowS + 300, kind: "arr", dest: "142S", live: true, feed: "gtfs" }] }] }) as { boards_changed: number };
  assertEquals(res.boards_changed, 0);
  assertEquals(await count(db, "select run_id n from public.platform_boards where stop_id = '127S'"), 999999);
  await db.close();
});

Deno.test("validation: malformed input rejected, bad trains dropped and counted", async () => {
  const db = await freshDb();
  const nowS = snapNowS("A");
  const rpc = pgRpc(db, () => nowS);
  const id = await rpc("claim_worker_run", {}) as number;
  await assertRejects(() => rpc("commit_worker_run", { p_run_id: id, p_feeds: { gtfs: {} }, p_boards: [] }), Error, "invalid_input");
  const feeds = Object.fromEntries(FEEDS.map((f) => [f, { ok: true, feed_ts: nowS, reason: null }]));
  const good = { trip_id: "ok1", route_id: "1", eta: nowS + 120, kind: "arr", dest: "142S", live: true, feed: "gtfs" };
  const res = await rpc("commit_worker_run", {
    p_run_id: id, p_feeds: feeds, p_boards: [
      { stop_id: "127S", trains: [good,
        { ...good, trip_id: "bad-route-feed", route_id: "A" },        // A is not in the gtfs feed
        { ...good, trip_id: "bad-eta", eta: "soon" },
        { ...good, trip_id: "bad-kind", kind: "maybe" },
        { ...good, trip_id: "too-far", eta: nowS + 99999 }] },
      { stop_id: "NOPE", trains: [good] },                               // unknown platform
    ],
  }) as { trains_in: number; trains_rejected: number; status: string };
  assertEquals(res.trains_in, 6);
  assertEquals(res.trains_rejected, 5);
  // all other feeds sent nothing → they are 'empty', so only gtfs is healthy
  assertEquals(res.status, "partial");
  await db.close();
});

// ------------------------------------------------------------------------------------- privileges + RLS
Deno.test("privileges: browsers can read public data but cannot run worker functions or write", async () => {
  const db = await freshDb();
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    assert(await count(db, "select count(*) n from public.stations") === 445);
    await assertRejects(() => db.query("select public.claim_worker_run()"), Error, "permission denied");
    await assertRejects(() => db.query("update public.platform_boards set trains = '[]'"), Error, "permission denied");
    await assertRejects(() => db.query("select * from public.worker_runs"), Error, "permission denied");
    await db.exec("reset role");
  }
  await db.close();
});

Deno.test("follows RLS: users see and change only their own follows; limit 12", async () => {
  const db = await freshDb();
  const as = async (sub: string | null) => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claims', $1, false)", [sub ? JSON.stringify({ sub, role: "authenticated" }) : ""]);
    await db.exec(sub ? "set role authenticated" : "set role anon");
  };
  await as("user_a");
  await db.query("insert into public.follows (station_id) values (611)");
  assertEquals(await count(db, "select count(*) n from public.follows"), 1);
  await as("user_b");
  assertEquals(await count(db, "select count(*) n from public.follows"), 0, "user_b cannot see user_a's follows");
  await assertRejects(() => db.query("insert into public.follows (user_id, station_id) values ('user_a', 610)"), Error, "row-level security");
  await as(null);
  await assertRejects(() => db.query("select * from public.follows"), Error, "permission denied");
  await as("user_c");
  const ids = (await db.query<{ station_id: number }>("select station_id from public.stations order by station_id limit 13")).rows;
  for (const { station_id } of ids.slice(0, 12)) await db.query("insert into public.follows (station_id) values ($1)", [station_id]);
  await assertRejects(() => db.query("insert into public.follows (station_id) values ($1)", [ids[12].station_id]), Error, "follow_limit");
  await db.exec("reset role");
  await db.close();
});
