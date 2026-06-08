"""Migrate existing feeds from the current SQLite database into Supabase.

Usage:
    python migrate_feeds.py

Requires SUPABASE_URL and SUPABASE_ANON_KEY env vars.
Also reads the SQLite db from DB_PATH (default: provided via CLI or env).
"""

import json
import os
import sqlite3
import sys

from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_ANON_KEY = os.environ["SUPABASE_ANON_KEY"]
DB_PATH = os.environ.get("DB_PATH", "scholarwatch.db")

def main():
    supabase = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Migrate feeds
    feeds = conn.execute("SELECT name, url, active FROM feeds").fetchall()
    print(f"Found {len(feeds)} feeds in SQLite")

    for feed in feeds:
        try:
            supabase.table("feeds").upsert({
                "name": feed["name"],
                "url": feed["url"],
                "active": bool(feed["active"]),
            }, on_conflict="url").execute()
            print(f"  OK: {feed['name']}")
        except Exception as e:
            print(f"  FAIL: {feed['name']} — {e}")

    # Migrate existing results (if any)
    results = conn.execute("SELECT * FROM results ORDER BY created_at").fetchall()
    print(f"\nFound {len(results)} results in SQLite")

    for r in results:
        try:
            supabase.table("results").upsert({
                "title": r["title"],
                "link": r["link"],
                "description": r["description"],
                "summary": r["summary"],
                "score": r["score"],
                "deadline": r["deadline"],
                "source_feed": r["source_feed"],
                "criteria_json": r["criteria_json"] or "{}",
                "scraped_content": r["scraped_content"],
            }, on_conflict="link,title").execute()
            print(f"  OK: {r['title'][:60]}")
        except Exception as e:
            print(f"  FAIL: {r['title'][:60]} — {e}")

    conn.close()
    print("\nMigration complete!")

if __name__ == "__main__":
    main()
