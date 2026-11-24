"""Local bakery order tracker. Run with python3 app.py."""
import csv
import re
import sqlite3
from contextlib import closing
from datetime import date, timedelta
from html import escape, unescape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

ROOT = Path(__file__).resolve().parent
DATABASE = ROOT / "bakery.db"
START = date(2026, 11, 23)
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
PRODUCTS = {"cupcakes": (40, 30), "cake": (120, 120)}


def pickup_date(value):
    parts = value.split()[1:]
    if parts[0].isdigit():
        parts.reverse()
    month = ("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split().index(parts[0]) + 1)
    return date(2026, month, int(parts[1])).isoformat()


def product(value):
    quantity, item = re.fullmatch(r"(\d+) (dozen cupcakes|cakes?)", value.lower()).groups()
    return ("cupcakes" if item == "dozen cupcakes" else "cake"), int(quantity)


def connect():
    db = sqlite3.connect(DATABASE)
    db.row_factory = sqlite3.Row
    return db


def initialize():
    with closing(connect()) as db, db:
        db.execute("BEGIN IMMEDIATE")
        version = db.execute("PRAGMA user_version").fetchone()[0]
        if version == 1:
            upgrade(db)
        if version:
            return
        db.execute("""CREATE TABLE orders (
            id INTEGER PRIMARY KEY, customer TEXT NOT NULL, item TEXT NOT NULL,
            quantity INTEGER NOT NULL, pickup TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0
        )""")
        db.execute("""CREATE TABLE requests (
            id INTEGER PRIMARY KEY, received TEXT NOT NULL, customer TEXT NOT NULL,
            action TEXT NOT NULL, item TEXT, quantity INTEGER, pickup TEXT NOT NULL,
            message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pending'
        )""")
        db.execute("CREATE TABLE helpers (pickup TEXT PRIMARY KEY, booked TEXT NOT NULL)")
        with (ROOT / "existing_orders.csv").open(newline="", encoding="utf-8") as source:
            for row in csv.DictReader(source):
                db.execute("INSERT INTO orders VALUES (?, ?, ?, ?, ?, 0)", (
                    int(row["order"].lstrip("#")), row["customer"], *product(row["item"]),
                    pickup_date(row["pickup_day"]),
                ))
        for offset, weekday in enumerate(WEEKDAYS):
            received = (START + timedelta(days=offset)).isoformat()
            source = (ROOT / f"InstagramOrders_{weekday}.html").read_text(encoding="utf-8")
            for message in re.findall(r'<p class="message">(.*?)</p>', source, re.S):
                message = unescape(message)
                fields = dict(line.split(": ", 1) for line in message.splitlines())
                request = fields["Order"]
                if request == "Cancel":
                    action, item, quantity = "Cancel", None, None
                elif request.startswith("Change to "):
                    action = "Change"
                    item, quantity = product(request.removeprefix("Change to "))
                else:
                    action = "New"
                    item, quantity = product(request)
                db.execute("""INSERT INTO requests
                    (received, customer, action, item, quantity, pickup, message)
                    VALUES (?, ?, ?, ?, ?, ?, ?)""", (
                    received, fields["Name"], action, item, quantity,
                    pickup_date(fields["Pickup Date"]), message,
                ))
        upgrade(db)


def upgrade(db):
    db.execute("ALTER TABLE orders ADD COLUMN picked_up INTEGER NOT NULL DEFAULT 0")
    db.execute("ALTER TABLE requests ADD COLUMN reason TEXT NOT NULL DEFAULT ''")
    db.execute("CREATE TABLE workday (day TEXT NOT NULL)")
    db.execute("INSERT INTO workday VALUES (?)", (START.isoformat(),))
    db.execute("PRAGMA user_version = 2")


def current_day(db):
    return db.execute("SELECT day FROM workday").fetchone()[0]


def notice(received, pickup):
    return (date.fromisoformat(pickup) - date.fromisoformat(received)).days >= 2


def minutes(order):
    return PRODUCTS[order["item"]][1] * order["quantity"]


def day_details(db, pickup):
    orders = db.execute(
        "SELECT * FROM orders WHERE pickup = ? AND cancelled = 0 ORDER BY id", (pickup,)
    ).fetchall()
    helper = db.execute("SELECT 1 FROM helpers WHERE pickup = ?", (pickup,)).fetchone()
    return orders, sum(map(minutes, orders)), 720 if helper else 480, bool(helper)


def eligibility(db, request):
    if not notice(request["received"], request["pickup"]):
        return "Less than two days’ notice.", None
    orders, used, capacity, _ = day_details(db, request["pickup"])
    target = None
    if request["action"] != "New":
        matches = [order for order in orders if not order["picked_up"]
                   and order["customer"].casefold() == request["customer"].casefold()]
        if len(matches) != 1:
            return "Could not identify one accepted order for this customer and pickup date.", None
        target = matches[0]
        used -= minutes(target)
    reserved = db.execute(
        "SELECT * FROM requests WHERE pickup = ? AND status = 'Requested'",
        (request["pickup"],),
    )
    used += sum(map(minutes, reserved))
    if request["action"] != "Cancel" and used + minutes(request) > capacity:
        return "There isn’t enough baking time on the pickup date.", target
    return "", target


def fetch(db, day):
    messages = db.execute(
        "SELECT * FROM requests WHERE received = ? AND status = 'Pending' ORDER BY id",
        (day,),
    ).fetchall()
    for request in messages:
        reason, target = eligibility(db, request)
        status = "Rejected"
        if not reason:
            status = "Requested"
            if request["action"] == "Change":
                db.execute("UPDATE orders SET item = ?, quantity = ? WHERE id = ?",
                           (request["item"], request["quantity"], target["id"]))
                status = "Applied"
            elif request["action"] == "Cancel":
                db.execute("UPDATE orders SET cancelled = 1 WHERE id = ?", (target["id"],))
                status = "Cancelled"
        db.execute("UPDATE requests SET status = ?, reason = ? WHERE id = ?",
                   (status, reason, request["id"]))
    return f"Fetched {len(messages)} messages." if messages else "No new messages."


def advance(db, day):
    if db.execute("SELECT 1 FROM requests WHERE received = ? AND status = 'Pending'",
                  (day,)).fetchone():
        raise ValueError("Fetch today’s Instagram messages before continuing.")
    if day >= (START + timedelta(days=9)).isoformat():
        raise ValueError("All scheduled pickup days are complete.")
    db.execute("""INSERT INTO orders (customer, item, quantity, pickup)
                  SELECT customer, item, quantity, pickup FROM requests
                  WHERE status = 'Requested' ORDER BY id""")
    db.execute("UPDATE requests SET status = 'Accepted' WHERE status = 'Requested'")
    db.execute("UPDATE orders SET picked_up = 1 WHERE pickup <= ? AND cancelled = 0", (day,))
    next_day = (date.fromisoformat(day) + timedelta(days=1)).isoformat()
    db.execute("UPDATE workday SET day = ?", (next_day,))
    return "Advanced to the next day. The previous day’s pickups were closed at 5 PM."


def apply(db, form, working_day):
    if form.get("day") != [working_day]:
        raise ValueError("The workday has changed. Use the current day’s controls.")
    action = form["action"][0]
    if action == "fetch":
        return fetch(db, working_day)
    if action == "advance":
        return advance(db, working_day)
    if action == "helper":
        pickup = date.fromisoformat(form["pickup"][0]).isoformat()
        if not notice(working_day, pickup):
            raise ValueError("Book helpers at least two days before pickup.")
        if db.execute("SELECT 1 FROM helpers WHERE pickup = ?", (pickup,)).fetchone():
            raise ValueError("A helper is already booked for that day.")
        db.execute("INSERT INTO helpers VALUES (?, ?)", (pickup, working_day))
        return "Helper booked."
    if action != "reject":
        raise ValueError("Choose an available action.")
    result = db.execute("""UPDATE requests SET status = 'Rejected', reason = 'Rejected by the baker.'
                           WHERE id = ? AND received = ? AND status = 'Requested'""",
                        (form["id"][0], working_day))
    if not result.rowcount:
        raise ValueError("That request is no longer available for a decision.")
    return "Request rejected."


def day_label(value):
    day = date.fromisoformat(value)
    return f"{day:%a, %b} {day.day}"


def duration(value):
    hours, remainder = divmod(value, 60)
    return f"{hours}h {remainder}m" if remainder else f"{hours}h"


def order_label(order):
    quantity = order["quantity"]
    item = "dozen cupcakes" if order["item"] == "cupcakes" else "cake" if quantity == 1 else "cakes"
    return f"{quantity} {item}"


def render(db, working_day, feedback="", error=False):
    messages = db.execute(
        "SELECT * FROM requests WHERE received <= ? AND status != 'Pending' ORDER BY received DESC, id", (working_day,)
    ).fetchall()
    inbox = []
    for req in messages:
        controls = ""
        status = req["status"]
        if status == "Requested":
            controls = f"""<form method="post" action="/">
              <input type="hidden" name="day" value="{working_day}">
              <input type="hidden" name="id" value="{req['id']}">
              <button class="secondary" name="action" value="reject">Reject</button>
              </form>"""
        if req["reason"]:
            controls += f'<p class="reason">{escape(req["reason"])}</p>'
        inbox.append(f"""<article class="message" data-status="{status}">
          <div class="spread"><strong>{escape(req['customer'])}</strong><span>{status}</span></div>
          <small>{day_label(req['received'])} · {req['action']} request</small>
          <p>{'Cancel order' if req['action'] == 'Cancel' else order_label(req)}
          <br>Pickup {day_label(req['pickup'])}</p>{controls}</article>""")

    pickups = db.execute("""SELECT pickup FROM orders
        UNION SELECT pickup FROM requests WHERE received <= ? AND status != 'Pending'
        UNION SELECT pickup FROM helpers ORDER BY pickup DESC""", (working_day,))
    schedule = []
    for (pickup,) in pickups:
        orders, used, capacity, helper = day_details(db, pickup)
        revenue = sum(PRODUCTS[order["item"]][0] * order["quantity"] for order in orders)
        all_orders = db.execute(
            "SELECT * FROM orders WHERE pickup = ? ORDER BY id", (pickup,)
        ).fetchall()
        requested = db.execute(
            "SELECT * FROM requests WHERE pickup = ? AND status = 'Requested' ORDER BY id",
            (pickup,),
        ).fetchall()
        reserved = sum(map(minutes, requested))
        rows = ""
        for order in all_orders + requested:
            if "cancelled" not in order.keys():
                status, number = "Requested", ""
            else:
                status = ("Cancelled" if order["cancelled"] else "Picked up" if order["picked_up"]
                          else "Accepted, pending delivery")
                number = f"#{order['id']} "
            rows += (f"<li><span>{number}{escape(order['customer'])}<br><small>{status}</small>"
                     f"</span><span>{order_label(order)}</span></li>")
        can_book = not helper and notice(working_day, pickup)
        helper_label = "Helper booked · $100" if helper else "Request helper · $100"
        helper_note = ("Adds 4 hours" if helper or can_book else "Requires 2 days’ notice")
        schedule.append(f"""<article class="pickup{' latest' if not schedule else ''}">
          <div class="spread"><h3>{day_label(pickup)}</h3><strong>${revenue} in orders</strong></div>
          <p>{duration(used)} booked · {duration(reserved)} requested · {duration(capacity-used-reserved)} of {duration(capacity)} available</p>
          <progress aria-label="Baking time booked on {day_label(pickup)}" value="{used+reserved}" max="{capacity}"></progress>
          {f'<ul>{rows}</ul>' if rows else '<p class="muted">No orders</p>'}
          <form method="post" action="/" class="helper">
            <input type="hidden" name="day" value="{working_day}">
            <input type="hidden" name="pickup" value="{pickup}">
            <button class="secondary" name="action" value="helper"{'' if can_book else ' disabled'}>
              {helper_label}
            </button>
            <small>{helper_note}</small>
          </form></article>""")
    unfetched = db.execute(
        "SELECT 1 FROM requests WHERE received = ? AND status = 'Pending'", (working_day,)
    ).fetchone()
    complete = working_day >= (START + timedelta(days=9)).isoformat()
    controls = f"""<form method="post" class="workday">
      <input type="hidden" name="day" value="{working_day}">
      <strong>{day_label(working_day)} · 2026</strong>
      <button name="action" value="fetch">Fetch Instagram messages</button>
      {('<p>All scheduled pickup days are complete.</p>' if complete else
        '<button name="action" value="advance"' + (' disabled' if unfetched else '') +
        '>Accept all and go to next day</button>')}
      {('<small>Going to the next day closes today’s pickups at 5 PM.</small>'
        if not complete else '')}
    </form>"""
    inbox_html = "".join(inbox) or '<p class="muted">No messages fetched yet.</p>'
    banner = (f'<p class="feedback{" reason" if error else ""}" role="status">{escape(feedback)}</p>'
              if feedback else "")
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bakery order tracker</title><style>
:root {{color-scheme:light;--ink:#30211d;--muted:#6e534b;--paper:#fffaf3;--line:#e9d8cb;--accent:#8b3e2c}}
* {{box-sizing:border-box}}
body {{margin:0;background:#f6eee4;color:var(--ink);font:1rem/1.5 system-ui,sans-serif}}
header {{background:#47291f;color:var(--paper);padding:2rem max(1rem,calc((100vw - 1120px)/2))}}
h1,h2,h3 {{font-family:Georgia,serif;margin:0;line-height:1.15}}
h1 {{font-size:clamp(2rem,5vw,3.5rem)}}
h2 {{font-size:1.8rem;margin-bottom:1rem}}
h3 {{font-size:1.35rem}}
main {{max-width:1152px;margin:auto;padding:1.5rem 1rem 3rem}}
.workday {{display:flex;align-items:center;flex-wrap:wrap;gap:.75rem;margin:0 0 1.5rem}}
button {{border:1px solid var(--line);border-radius:.5rem;padding:.55rem .8rem;
background:var(--paper);color:var(--ink);font:inherit;text-decoration:none}}
button {{background:var(--accent);color:white;border-color:var(--accent)}}
button {{cursor:pointer}}
button.secondary {{background:var(--paper);color:var(--accent)}}
button:disabled {{opacity:.55;cursor:default}}
:focus-visible {{outline:3px solid #34715d;outline-offset:3px}}
.columns {{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.35fr);gap:1.5rem}}
article,.feedback {{background:var(--paper);border:1px solid var(--line);border-radius:.75rem;
padding:1rem;margin-bottom:.75rem}}
.schedule {{display:grid;gap:.75rem;grid-template-columns:repeat(2,minmax(0,1fr))}}
.pickup {{margin:0;min-width:0}}
.pickup.latest {{grid-column:1 / -1;padding:clamp(1.25rem,3vw,2rem);border-color:var(--accent);
background:#fff5e8}}
.pickup.latest h3 {{font-size:clamp(1.8rem,4vw,2.5rem)}}
.helper {{display:flex;flex-wrap:wrap;gap:.4rem .65rem;align-items:center;margin-top:.75rem}}
.spread,li {{display:flex;justify-content:space-between;align-items:baseline;gap:.75rem}}
small,.muted {{color:var(--muted)}}
.reason {{color:#8b241a}}
article p {{margin:.55rem 0}}
progress {{width:100%;accent-color:#34715d}}
ul {{list-style:none;padding:0;margin:.5rem 0 .85rem}}
li {{border-bottom:1px solid var(--line);padding:.25rem 0}}
@media(max-width:740px) {{.columns {{grid-template-columns:1fr}}}}
@media(max-width:520px) {{.schedule {{grid-template-columns:1fr}}}}
</style></head><body>
<header><h1>Bakery order tracker</h1></header>
<main>{controls}{banner}
<div class="columns"><section><h2>Instagram inbox</h2>
<label id="filter" hidden><input id="pending" type="checkbox"> Show only requested orders</label>
<div id="messages">{inbox_html}</div></section>
<section><h2>Pickup schedule</h2><div class="schedule">{''.join(schedule)}</div></section></div></main>
<script>
const filter = document.querySelector('#filter');
const pending = document.querySelector('#pending');
filter.hidden = false;
pending.addEventListener('change', () => {{
  for (const message of document.querySelectorAll('#messages article')) {{
    message.hidden = pending.checked && message.dataset.status !== 'Requested';
  }}
}});
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def send_page(self, content, status=200):
        data = content.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path != "/":
            self.send_error(404)
            return
        query = parse_qs(url.query)
        with closing(connect()) as db, db:
            db.execute("BEGIN")
            self.send_page(render(db, current_day(db), query.get("message", [""])[0]))

    def do_POST(self):
        if self.path != "/":
            self.send_error(404)
            return
        # A browser on another website cannot submit changes to the local app.
        if (self.headers.get("Host") != "127.0.0.1:8000" or
                self.headers.get("Origin") != "http://127.0.0.1:8000"):
            self.send_error(403)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 4096:
            self.send_error(400)
            return
        form = parse_qs(self.rfile.read(length).decode("utf-8"))
        with closing(connect()) as db:
            try:
                with db:
                    db.execute("BEGIN IMMEDIATE")
                    message = apply(db, form, current_day(db))
            except (ValueError, KeyError) as exc:
                message = str(exc) if isinstance(exc, ValueError) else "A required field is missing."
                self.send_page(render(db, current_day(db), message, error=True), 400)
                return
        self.send_response(303)
        self.send_header("Location", "/?" + urlencode({"message": message}))
        self.end_headers()


if __name__ == "__main__":
    initialize()
    print("Open http://127.0.0.1:8000/ in your browser. Press Control+C to stop.", flush=True)
    with ThreadingHTTPServer(("127.0.0.1", 8000), Handler) as server:
        server.serve_forever()
