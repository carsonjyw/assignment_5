import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
const db = new PGlite();
const v = await db.query("select version()");
console.log(v.rows[0].version);
const sql = fs.readFileSync(process.argv[2], "utf8");
const t0 = performance.now();
try { await db.exec(sql); console.log("no exception?"); }
catch (e) { console.log(e.message); }
console.log(`total script ${(performance.now() - t0).toFixed(0)} ms`);
