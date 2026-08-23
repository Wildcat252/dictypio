"""Show the most recent sentences that recorded a twice-hinted word."""
import sqlite3, json, glob, collections

db = glob.glob('.electron-dev-userdata/*.db')[0]
rows = sqlite3.connect(db).execute(
    "SELECT data, updated_at FROM learning_progress "
    "WHERE data IS NOT NULL ORDER BY updated_at DESC LIMIT 40").fetchall()

field_seen = repeat_total = 0
rep = collections.Counter()
print("most recent 40 sentence rows:\n")
for data, ts in rows:
    try: o = json.loads(data)
    except Exception: continue
    if "repeat_hint_words" not in o:
        continue
    field_seen += 1
    rhw = o.get("repeat_hint_words") or []
    hw = o.get("hint_words") or []
    for w in rhw:
        rep[w] += 1; repeat_total += 1
    if rhw or hw:
        print(f"  {ts}  hinted={hw}  TWICE-HINTED={rhw}")

print(f"\nrows carrying the new field : {field_seen}/40")
print(f"twice-hinted events         : {repeat_total}")
print(f"words qualifying as tricky  : {dict(rep) or 'none yet'}")
if field_seen == 0:
    print("\n!! Field absent -> the frontend is still the old build. Rebuild/reload the app.")
elif repeat_total == 0:
    print("\nField is flowing, but no word hit 2 reveals yet. See the recipe.")
