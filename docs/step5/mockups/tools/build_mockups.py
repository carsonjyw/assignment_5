"""Builds docs/step5/mockups/index.html: three visual directions for HEADWAY, drawn from real data
(MTA shapes.txt geometry, HEADWAY stations, a live board snapshot, a computed trip)."""
import html, json, sys, time

D = sys.argv[1]
OUT = sys.argv[2]
geo = json.load(open(f"{D}/geo.json"))
boards = {b["stop_id"]: [{"r": t["route_id"], "h": t.get("headsign"), "eta": t["eta"], "live": t["live"]} for t in b["trains"]]
          for b in json.load(open(f"{D}/boards.json"))}
status = json.load(open(f"{D}/status.json"))[0]
NOW = int(open(f"{D}/now.txt").read())
R = geo["routes"]
esc = html.escape

def mins(eta):
    s = eta - NOW
    return "Now" if s < 60 else f"{s // 60}"

def tok(route_id, style, size=22):
    r = R.get(route_id, {"color": "808183", "text_color": "FFFFFF", "short_name": route_id})
    bg, fg, label = "#" + r["color"], "#" + r["text_color"], r["short_name"]
    if route_id in ("6X", "7X", "FX"):
        label = label[0]
    fs = round(size * 0.58)
    shape = {"d1": f"border-radius:{round(size*0.28)}px", "d2": "border-radius:50%", "d3": "border-radius:0"}[style]
    extra = "box-shadow:inset 0 0 0 2px rgba(255,255,255,.9);" if route_id.endswith("X") and len(route_id) == 2 else ""
    return (f'<span class="tok" style="width:{size}px;height:{size}px;font-size:{fs}px;background:{bg};color:{fg};{shape};{extra}"'
            f' aria-label="{esc(label)} train">{esc(label)}</span>')

def upcoming(stop, n=4):
    return [t for t in sorted(boards.get(stop, []), key=lambda t: t["eta"]) if t["eta"] >= NOW - 30][:n]

def svg_map(theme, focus_route=None, focus_station=None, crop=None, trip=None, labels=(), label_size=9):
    bg, base_w, dim, st_fill, st_stroke, label = theme
    x0, y0, w, h = crop or (0, 0, geo["w"], geo["h"])
    out = [f'<svg viewBox="{x0} {y0} {w} {h}" class="map" role="img" aria-label="NYC subway network drawn from MTA shapes"><rect x="{x0}" y="{y0}" width="{w}" height="{h}" fill="{bg}"/>']
    order = sorted(geo["lines"], key=lambda l: (l["route"] == focus_route, l["route"] in (trip or [])))
    for l in order:
        c = "#" + R.get(l["route"], {"color": "808183"})["color"]
        on = (focus_route is None and not trip) or l["route"] == focus_route or (trip and l["route"] in trip)
        out.append(f'<path d="{l["d"]}" fill="none" stroke="{c}" stroke-width="{base_w * (1.9 if on and (focus_route or trip) else 1)}"'
                   f' stroke-linecap="round" stroke-linejoin="round" opacity="{1 if on else dim}"/>')
    for s in geo["stations"]:
        if not (x0 - 5 <= s["x"] <= x0 + w + 5 and y0 - 5 <= s["y"] <= y0 + h + 5):
            continue
        r = base_w * (1.25 if s["xfer"] else 0.7)
        out.append(f'<circle cx="{s["x"]}" cy="{s["y"]}" r="{r}" fill="{st_fill}" stroke="{st_stroke}" stroke-width="{base_w*0.45}"/>')
    for sid in ([focus_station] if focus_station else []) + list((trip or {}).get("_stations", [])):
        s = next(s for s in geo["stations"] if s["id"] == sid)
        out.append(f'<circle cx="{s["x"]}" cy="{s["y"]}" r="{base_w*3.2}" fill="none" stroke="{label}" stroke-width="{base_w*0.9}" class="ping"/>'
                   f'<circle cx="{s["x"]}" cy="{s["y"]}" r="{base_w*1.6}" fill="{label}"/>')
    for sid in labels:
        s = next(s for s in geo["stations"] if s["id"] == sid)
        out.append(f'<text x="{s["x"]+base_w*2.6}" y="{s["y"]+label_size*0.35}" font-size="{label_size}" font-weight="700" fill="{label}"'
                   f' stroke="{bg}" stroke-width="{label_size*0.32}" paint-order="stroke" font-family="Inter Tight, Archivo, sans-serif">{esc(s["name"])}</text>')
    out.append("</svg>")
    return "".join(out)

def station_xy(sid):
    s = next(s for s in geo["stations"] if s["id"] == sid); return s["x"], s["y"]

tsx, tsy = station_xy(611)
MANHATTAN = (tsx - 110, tsy - 150, 300, 250)
updated = int(NOW - time.mktime(time.strptime(status["last_success_at"][:19], "%Y-%m-%dT%H:%M:%S")) + time.timezone)
upd = f"{max(updated, 0)} s ago" if updated < 120 else "recently"

# --------------------------------------------------------------------------------------- direction 1
def d1():
    rows = lambda stop: "".join(
        f'<li class="d1row{" sched" if not t["live"] else ""}">{tok(t["r"],"d1",34)}<span class="d1dest">{esc(t["h"] or "")}'
        f'<em>{"Live" if t["live"] else "Scheduled"}</em></span><span class="d1min">{mins(t["eta"])}<small>{"" if mins(t["eta"])=="Now" else "min"}</small></span></li>'
        for t in upcoming(stop, 4))
    lines_bar = "".join(tok(r, "d1", 26) for r in ["A", "C", "E", "B", "D", "F", "M", "G", "J", "Z", "L", "N", "Q", "R", "W", "1", "2", "3", "4", "5", "6", "7", "GS", "SI"])
    explore = f'''
<div class="frame desk d1">
  <div class="d1top"><b class="d1logo">HEADWAY</b><nav><a class="on">Explore</a><a>Plan</a><a>Saved</a></nav><span class="d1live"><i></i>Live · {upd}</span></div>
  <div class="d1body">
    <div class="d1map">{svg_map(("#0d0e10", 2.0, 0.28, "#0d0e10", "#f4f4f2", "#ffffff"), focus_route="A", focus_station=153, crop=(tsx-150, tsy-240, 300, 330), labels=(153, 611, 602, 617, 628, 164), label_size=8.5)}</div>
    <aside class="d1side">
      <div class="d1search">⌕ Search a station or line</div>
      <div class="d1lines">{lines_bar}</div>
      <div class="d1card">
        <div class="d1sign"><span>125 St</span>{"".join(tok(r,"d1",24) for r in ["A","C","B","D"])}</div>
        <p class="d1dir">↓ Downtown &amp; Brooklyn</p><ul>{rows("A15S")}</ul>
        <button class="d1follow">☆ Save station</button>
      </div>
    </aside>
  </div>
</div>'''
    station = f'''
<div class="frame phone d1">
  <div class="d1sign big"><span>Times Sq–42 St</span><small>13 lines · 5 line groups · 10 platforms</small></div>
  <div class="d1chips"><b>All</b>{"".join(tok(r,"d1",28) for r in ["1","2","3","A","C","E","N","Q","R","W","7","GS"])}</div>
  <p class="d1fresh"><i></i>Live · updated {upd}</p>
  <section><h4>{"".join(tok(r,"d1",22) for r in ["1","2","3"])} ↑ Uptown &amp; The Bronx</h4><ul>{rows("127N")}</ul></section>
  <section><h4>{"".join(tok(r,"d1",22) for r in ["N","Q","R","W"])} ↓ Downtown &amp; Brooklyn</h4><ul>{rows("R16S")}</ul></section>
  <div class="d1tabs"><a>Explore</a><a>Plan</a><a>Saved</a></div>
</div>'''
    plan = f'''
<div class="frame phone d1">
  <div class="d1plan"><p>From</p><b>125 St</b><p>To</p><b>14 St–Union Sq</b></div>
  <div class="d1map small">{svg_map(("#0d0e10", 2.2, 0.12, "#0d0e10", "#f4f4f2", "#ffffff"), crop=(tsx-150, tsy-330, 300, 470), trip={"A":1, "L":1, "_stations":[153, 618, 602]})}</div>
  <ol class="d1legs">
    <li>{tok("A","d1",30)}<div><b>A toward Far Rockaway / Lefferts</b><p>125 St → 14 St · 4 stops</p><em>Next A at 125 St: {mins(min(t["eta"] for t in boards.get("A15S",[]) if t["r"]=="A"))} min · Live</em></div></li>
    <li class="xfer">⇄<div><b>Transfer at 14 St / 8 Av</b><p>Walk to the L platform · allow 3 min (MTA transfer time)</p></div></li>
    <li>{tok("L","d1",30)}<div><b>L toward Canarsie</b><p>8 Av → 14 St–Union Sq · 2 stops</p></div></li>
  </ol>
  <p class="d1note">About 25 min by schedule (weekday midday, incl. expected wait). Live times shown where available.</p>
  <div class="d1tabs"><a>Explore</a><a class="on">Plan</a><a>Saved</a></div>
</div>'''
    return explore, station, plan

# --------------------------------------------------------------------------------------- direction 2
def d2():
    rows = lambda stop: "".join(
        f'<tr><td>{tok(t["r"],"d2",22)}</td><td class="d2dest">{esc(t["h"] or "")}</td><td class="d2kind">{"Live" if t["live"] else "Sched."}</td>'
        f'<td class="d2min">{mins(t["eta"])}</td></tr>' for t in upcoming(stop, 4))
    explore = f'''
<div class="frame desk d2">
  <div class="d2mast"><span>Vol. 1 · New York · {time.strftime("%A, %B %-d", time.gmtime(NOW - 5*3600))}</span><h2>The Headway</h2><span>Live from all 8 MTA feeds · {upd}</span></div>
  <div class="d2grid">
    <div class="d2lead"><p class="d2kick">Arrivals</p><h3>Uptown A, B, C &amp; D trains are running every few minutes at 125 St</h3>
      <table>{rows("A15N")}</table><p class="d2by">Times count down live. "Sched." means no train has been dispatched yet.</p></div>
    <figure class="d2plate">{svg_map(("#ffffff", 1.1, 0.25, "#ffffff", "#111111", "#d0021b"), crop=(tsx-260, tsy-330, 520, 560), focus_station=153)}<figcaption>Fig. 1 — The network, drawn from MTA route geometry. Tap any station.</figcaption></figure>
    <div class="d2col"><p class="d2kick">Find</p><div class="d2search">Search a station…</div><p class="d2kick">Saved</p><p class="d2saved">Times Sq–42 St · 14 St–Union Sq</p></div>
  </div>
</div>'''
    station = f'''
<div class="frame phone d2">
  <p class="d2kick">Station · Manhattan</p><h2 class="d2h">125 St</h2>
  <p class="d2deck">{"".join(tok(r,"d2",20) for r in ["A","C","B","D"])} <span>Live · {upd}</span></p>
  <h4>Downtown &amp; Brooklyn</h4><table>{rows("A15S")}</table>
  <h4>Uptown &amp; The Bronx</h4><table>{rows("A15N")}</table>
  <div class="d2tabs"><a>Map</a><a>Plan</a><a>Saved</a></div>
</div>'''
    return explore, station

# --------------------------------------------------------------------------------------- direction 3
def d3():
    def band(stop, heading):
        ts = upcoming(stop, 3)
        if not ts: return ""
        f = ts[0]; r = R[f["r"]]
        rest = " · ".join(f'{R[t["r"]]["short_name"]} {mins(t["eta"])}' for t in ts[1:])
        return (f'<div class="d3band" style="background:#{r["color"]};color:#{r["text_color"]}"><p>{esc(heading)}</p>'
                f'<div class="d3big"><b>{mins(f["eta"])}</b><span>{"" if mins(f["eta"])=="Now" else "min"}</span></div>'
                f'<p class="d3to">{esc(r["short_name"])} to {esc(f["h"] or "")} · {"Live" if f["live"] else "Scheduled"}</p><p class="d3then">then {esc(rest)}</p></div>')
    explore = f'''
<div class="frame desk d3">
  <div class="d3top"><b>HEADWAY</b><span>Explore</span><span>Plan</span><span>Saved</span><span class="d3live">● Live {upd}</span></div>
  <div class="d3body">
    <div class="d3rail">{"".join(f'<div class="d3line">{tok(r,"d3",40)}<span>{esc(R[r]["long_name"])}</span></div>' for r in ["N","Q","R","W","L","7"])}</div>
    <div class="d3map">{svg_map(("#e8e8e4", 2.6, 0.22, "#ffffff", "#111", "#111111"), focus_route="N", crop=MANHATTAN, focus_station=611, labels=(611, 602, 607, 461), label_size=8)}</div>
  </div>
</div>'''
    station = f'''
<div class="frame phone d3">
  <div class="d3head"><h2>14 St–Union Sq</h2><p>{"".join(tok(r,"d3",22) for r in ["L","N","Q","R","W","4","5","6"])}</p></div>
  {band("L03S", "L · Brooklyn")}{band("R20N", "N Q R W · Uptown & Queens")}{band("635S", "4 5 6 · Downtown & Brooklyn")}
  <div class="d3tabs"><a>Explore</a><a>Plan</a><a>Saved</a></div>
</div>'''
    return explore, station

e1, s1, p1 = d1(); e2, s2 = d2(); e3, s3 = d3()

CSS = """
*{box-sizing:border-box}body{margin:0;background:#f3f3f1;color:#111;font:16px/1.5 'Inter Tight',system-ui,sans-serif}
.wrap{max-width:1240px;margin:0 auto;padding:40px 24px 80px}.intro h1{font:800 44px/1 'Inter Tight';letter-spacing:-.02em;margin:0}
.intro p{max-width:760px;color:#444}.dir{margin-top:64px}.dir>header{display:flex;gap:16px;align-items:baseline;border-top:3px solid #111;padding-top:14px}
.dir>header h2{font:800 28px/1.1 'Inter Tight';margin:0}.dir>header p{margin:0;color:#444}.row{display:flex;gap:24px;flex-wrap:wrap;margin-top:20px;align-items:flex-start}
.frame{overflow:hidden;position:relative;flex:none}.desk{width:780px;height:520px;border-radius:14px}.phone{width:340px;height:720px;border-radius:30px;border:8px solid #111}
.tok{display:inline-flex;align-items:center;justify-content:center;font-weight:800;flex:none;line-height:1;font-family:'Inter Tight',sans-serif}
.map{width:100%;height:100%;display:block}.ping{animation:ping 1.8s ease-out infinite;transform-box:fill-box;transform-origin:center}
@keyframes ping{from{opacity:.9;transform:scale(.4)}to{opacity:0;transform:scale(1.4)}}
@keyframes breathe{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.ping,.d1live i,.d1fresh i{animation:none}}
/* d1 wayfinding */
.d1{background:#0d0e10;color:#f4f4f2}.d1top{display:flex;align-items:center;gap:22px;height:52px;padding:0 18px;border-bottom:1px solid #26282c}
.d1logo{font:900 18px 'Inter Tight';letter-spacing:.08em}.d1top nav{display:flex;gap:4px}.d1top nav a{padding:6px 12px;border-radius:999px;color:#c9cbce;font-weight:600}
.d1top nav a.on{background:#f4f4f2;color:#0d0e10}.d1live{margin-left:auto;font-size:13px;color:#c9cbce;display:flex;gap:7px;align-items:center}
.d1live i,.d1fresh i{width:8px;height:8px;border-radius:50%;background:#3ddc84;display:inline-block;animation:breathe 2.4s infinite}
.d1body{display:flex;height:468px}.d1map{flex:1}.d1side{width:330px;border-left:1px solid #26282c;padding:14px;display:flex;flex-direction:column;gap:12px}
.d1search{background:#1b1d21;border-radius:10px;padding:10px 12px;color:#9ea1a6}.d1lines{display:flex;flex-wrap:wrap;gap:5px}
.d1card{background:#f4f4f2;color:#0d0e10;border-radius:12px;overflow:hidden;flex:1;display:flex;flex-direction:column}
.d1sign{background:#0d0e10;color:#fff;display:flex;gap:5px;align-items:center;padding:10px 12px;border:2px solid #f4f4f2;border-radius:12px 12px 0 0}
.d1sign span{font:800 22px 'Inter Tight';margin-right:auto;letter-spacing:-.01em}.d1sign.big{flex-direction:column;align-items:flex-start;border:0;border-radius:0;padding:26px 18px 14px}
.d1sign.big span{font-size:34px;line-height:1}.d1sign.big small{color:#c9cbce}
.d1dir{margin:8px 12px 0;font:700 13px 'Inter Tight';text-transform:uppercase;letter-spacing:.06em}
.d1card ul,.phone.d1 ul{list-style:none;margin:0;padding:0 12px}.d1row{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid #d9d9d6}
.d1dest{flex:1;font-weight:600;font-size:14px;line-height:1.2;min-width:0}.d1dest em{display:block;font-style:normal;font-size:11px;font-weight:700;color:#0b7a43;text-transform:uppercase;letter-spacing:.05em}
.sched .d1dest em{color:#5b5d61}.d1min{font:800 30px/1 'Inter Tight';font-variant-numeric:tabular-nums;text-align:right;min-width:62px}.d1min small{font-size:13px;margin-left:2px}
.sched .d1min{font-weight:500;color:#45474b}.d1follow{margin:auto 12px 12px;border:2px solid #0d0e10;background:#fff;border-radius:999px;padding:9px;font:700 14px 'Inter Tight'}
.phone.d1{background:#0d0e10}.d1chips{display:flex;gap:5px;overflow:hidden;padding:0 18px 8px}.d1chips b{background:#f4f4f2;color:#0d0e10;border-radius:999px;padding:4px 10px;font-size:13px}
.d1fresh{margin:2px 18px 8px;font-size:13px;color:#c9cbce;display:flex;gap:7px;align-items:center}
.phone.d1 section{background:#f4f4f2;color:#0d0e10;margin:0 10px 10px;border-radius:12px;padding-bottom:4px}
.phone.d1 h4{margin:0;padding:10px 12px 6px;font:700 13px 'Inter Tight';display:flex;gap:4px;align-items:center;text-transform:uppercase;letter-spacing:.04em}
.d1tabs{position:absolute;bottom:0;left:0;right:0;display:flex;background:#0d0e10;border-top:1px solid #26282c}.d1tabs a{flex:1;text-align:center;padding:14px 0 18px;font-weight:700;color:#c9cbce}
.d1tabs a.on{color:#fff;box-shadow:inset 0 3px 0 #fff}.d1plan{padding:22px 18px 10px;display:grid;grid-template-columns:50px 1fr;gap:4px 8px;align-items:baseline}
.d1plan p{margin:0;color:#9ea1a6;font-size:13px}.d1plan b{font:800 22px 'Inter Tight'}.d1map.small{height:250px}
.d1legs{list-style:none;margin:0;padding:6px 12px}.d1legs li{display:flex;gap:10px;background:#f4f4f2;color:#0d0e10;border-radius:10px;padding:9px 10px;margin-bottom:6px}
.d1legs b{font-size:14px}.d1legs p{margin:0;font-size:12px;color:#45474b}.d1legs em{font-style:normal;font-size:12px;font-weight:700;color:#0b7a43}
.d1legs .xfer{background:#1b1d21;color:#f4f4f2;font-size:20px;align-items:center}.d1legs .xfer p{color:#c9cbce}.d1note{margin:0 16px;font-size:11px;color:#9ea1a6}
/* d2 editorial */
.d2{background:#fff;color:#111;font-family:'IBM Plex Sans Condensed',sans-serif}.d2mast{text-align:center;border-bottom:3px double #111;padding:10px 20px 6px;display:grid;grid-template-columns:1fr auto 1fr;align-items:end;font-size:12px}
.d2mast h2{font:400 46px/1 'DM Serif Display',serif;margin:0 18px}.d2mast span:last-child{text-align:right}
.d2grid{display:grid;grid-template-columns:270px 1fr 170px;gap:0;height:440px}.d2grid>*{padding:14px 16px;border-right:1px solid #111}.d2grid>*:last-child{border:0}
.d2kick{font:700 11px 'IBM Plex Sans Condensed';text-transform:uppercase;letter-spacing:.14em;color:#d0021b;margin:0 0 4px}
.d2lead h3{font:400 25px/1.1 'DM Serif Display',serif;margin:0 0 10px}.d2 table{width:100%;border-collapse:collapse}.d2 td{border-top:1px solid #ccc;padding:5px 3px;font-size:14px}
.d2dest{font-weight:500}.d2kind{font-size:11px;text-transform:uppercase;color:#555}.d2min{font:400 24px 'DM Serif Display',serif;text-align:right}
.d2by{font-size:12px;color:#555;font-style:italic}.d2plate{margin:0;padding:8px!important}.d2plate .map{height:390px}.d2plate figcaption{font-size:11px;font-style:italic}
.d2search{border-bottom:2px solid #111;padding:6px 0;margin-bottom:16px;color:#555}.d2saved{font:400 18px/1.3 'DM Serif Display',serif}
.phone.d2{padding:22px 18px}.d2h{font:400 64px/.9 'DM Serif Display',serif;margin:0}.d2deck{display:flex;gap:4px;align-items:center;border-bottom:3px double #111;padding-bottom:10px}
.d2deck span{margin-left:auto;font-size:12px;color:#0b7a43;font-weight:700}.phone.d2 h4{font:700 12px 'IBM Plex Sans Condensed';text-transform:uppercase;letter-spacing:.12em;margin:16px 0 4px}
.d2tabs{position:absolute;bottom:0;left:0;right:0;display:flex;border-top:3px double #111;background:#fff}.d2tabs a{flex:1;text-align:center;padding:12px 0 16px;font:400 18px 'DM Serif Display',serif}
/* d3 grid & signal */
.d3{background:#e8e8e4;color:#111;font-family:'Archivo',sans-serif}.d3top{display:flex;gap:26px;align-items:center;height:56px;padding:0 20px;background:#111;color:#fff;font-weight:700}
.d3top b{font:900 20px 'Archivo';font-stretch:125%;letter-spacing:.02em}.d3live{margin-left:auto;font-weight:500;color:#cfd0cc}.d3body{display:flex;height:464px}
.d3rail{width:300px;display:flex;flex-direction:column}.d3line{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:2px solid #111;font-weight:700;font-stretch:110%}
.d3map{flex:1;border-left:2px solid #111}.phone.d3{background:#111}.d3head{background:#e8e8e4;padding:20px 16px 12px}.d3head h2{font:900 30px/1 'Archivo';font-stretch:115%;margin:0 0 8px}
.d3head p{display:flex;gap:3px;margin:0}.d3band{padding:12px 16px 14px;border-top:3px solid #111}.d3band p{margin:0;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.05em}
.d3big{display:flex;align-items:baseline;gap:6px}.d3big b{font:900 76px/1 'Archivo';font-stretch:112%;font-variant-numeric:tabular-nums}.d3big span{font-weight:800;font-size:20px}
.d3to{font-size:15px!important;text-transform:none!important;letter-spacing:0!important}.d3then{font-weight:600!important;text-transform:none!important;opacity:1}
.d3tabs{position:absolute;bottom:0;left:0;right:0;display:flex;background:#111;color:#fff}.d3tabs a{flex:1;text-align:center;padding:14px 0 18px;font-weight:800;font-stretch:115%}
.note{font-size:13px;color:#555;max-width:900px}
body:has(.dir:target) .dir:not(:target),body:has(.dir:target) .intro{display:none}
body:has(.dir:target) .dir{margin-top:0}
"""

page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Headway design directions</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;600;700;800;900&family=DM+Serif+Display&family=IBM+Plex+Sans+Condensed:wght@400;500;700&family=Archivo:wdth,wght@100..125,500..900&display=swap" rel="stylesheet">
<style>{CSS}</style></head><body><div class="wrap">
<div class="intro"><h1>Headway: New York in Motion</h1>
<p>Three directions, all drawn from real data. The map is MTA's own route geometry (shapes.txt, {len(geo['lines'])} line patterns) and HEADWAY's 445 station locations. Arrival times are a live snapshot from the HEADWAY database taken {time.strftime('%H:%M UTC', time.gmtime(NOW))}. The trip in Direction 1 was computed from MTA's weekday schedule and transfers.txt. Route marks are HEADWAY's own shapes in each line's colour, not MTA artwork.</p></div>
<section class="dir" id="d1"><header><h2>1 · Wayfinding</h2><p>Subway signage as interface: black sign bands, white type, a luminous map. Map-first.</p></header>
<div class="row">{e1}{s1}{p1}</div></section>
<section class="dir" id="d2"><header><h2>2 · Front Page</h2><p>New York editorial: a broadsheet of live arrivals, the map as a figure plate.</p></header>
<div class="row">{e2}{s2}</div></section>
<section class="dir" id="d3"><header><h2>3 · Signal Blocks</h2><p>Urban modernism: each line's colour becomes a full-bleed field with giant numerals.</p></header>
<div class="row">{e3}{s3}</div></section>
<p class="note">Data: MTA GTFS and GTFS-Realtime, retrieved by HEADWAY and served from its own database. Not affiliated with or endorsed by the MTA.</p>
</div></body></html>"""
open(OUT, "w").write(page)
print("wrote", OUT, len(page), "bytes")
