"""ScholarWatch Pipeline — standalone script for GitHub Actions.

Reads RSS feeds from feeds.json, runs the full screening pipeline
(fetch → dedup → keyword filter → scrape → AI triage → summary),
and writes results + scan_log to Supabase.

No FastAPI, no uvicorn, no HTTP server — just the pipeline.
"""

import asyncio
import hashlib
import json
import os
import re
import sys
import time
from typing import Optional

import httpx
import trafilatura

# Supabase client (auto-reads env vars)
from supabase import create_client, Client

# ===== Configuration =====
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_ANON_KEY = os.environ["SUPABASE_ANON_KEY"]
FEEDS_FILE = os.environ.get("FEEDS_FILE", "feeds.json")

MAX_CONCURRENT_SCRAPES = 10
MAX_CONCURRENT_AI = 1   # Groq free tier limit
SCRAPE_TIMEOUT = 20
AI_CONTENT_CAP = 5000

# AI Provider config
AI_PROVIDER = os.environ.get("AI_PROVIDER", "anthropic").lower()
AI_API_KEY = os.environ.get("AI_API_KEY", os.environ.get("ANTHROPIC_API_KEY", ""))
AI_TIMEOUT = int(os.environ.get("AI_TIMEOUT", "60"))

# Multi-key rotation for Groq
_GROQ_KEYS = [k.strip() for k in os.environ.get("GROQ_API_KEYS", "").split(",") if k.strip()]
_groq_key_index = 0
_groq_key_lock = asyncio.Lock()

def _next_groq_key() -> str:
    global _groq_key_index
    if not _GROQ_KEYS:
        return ""
    key = _GROQ_KEYS[_groq_key_index]
    _groq_key_index = (_groq_key_index + 1) % len(_GROQ_KEYS)
    return key

if AI_PROVIDER == "groq":
    AI_BASE_URL = os.environ.get("AI_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")
    AI_MODEL = os.environ.get("AI_MODEL", "llama-3.3-70b-versatile")
else:
    AI_BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")
    AI_MODEL = os.environ.get("AI_MODEL", "claude-3-5-haiku-20241022")

# ===== Non-Academic Keywords ====
NON_ACADEMIC_KEYWORDS = [
    "mortgage", "car insurance", "credit card", "debt consolidation",
    "payday loan", "refinance", "casino", "sports betting", "online gambling",
    "hair transplant", "weight loss pills", "diet supplement", "male enhancement",
    "CBD gummies", "erectile dysfunction", "penny stock", "crypto trading",
    "forex signal", "make money online", "work from home earn", "get rich quick",
    "bitcoin investment", "timeshare", "rent to own", "buy now pay later",
    "personal injury lawyer", "mesothelioma", "class action lawsuit",
    "viagra", "cialis", "onlyfans", "adult content", "dating site",
    "sweepstakes", "lottery", "raffle", "free iphone", "free gift card",
    "miraculous cure", "homeopathic remedy", "essential oils cure",
    "psychic reading", "tarot card", "astrology prediction",
    "multilevel marketing", "MLM opportunity", "network marketing",
    "pay for delete", "credit repair", "tax relief",
    "extended car warranty", "final expense insurance",
    "reverse mortgage", "home warranty", "solar panel scam",
]

# ===== Supabase helpers =====
def _supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_ANON_KEY)

# ===== RSS Parsing =====
async def fetch_rss_entries(feeds: list[dict]) -> list[dict]:
    """Step 1: Fetch and parse RSS feeds."""
    entries = []
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        tasks = [_fetch_single_feed(client, f) for f in feeds]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for feed_entries in results:
            if isinstance(feed_entries, list):
                entries.extend(feed_entries)
    return entries

async def _fetch_single_feed(client: httpx.AsyncClient, feed: dict) -> list[dict]:
    try:
        resp = await client.get(feed["url"])
        resp.raise_for_status()
        text = resp.text
    except Exception as e:
        print(f"[RSS] Failed to fetch {feed['url']}: {e}")
        return []

    entries = []
    items = re.findall(r'<item>(.*?)</item>', text, re.DOTALL)
    if not items:
        items = re.findall(r'<entry>(.*?)</entry>', text, re.DOTALL)

    for item_xml in items:
        title = _extract_tag(item_xml, "title") or "Untitled"
        link = _extract_link(item_xml)
        if not link:
            continue
        description = _extract_tag(item_xml, "description") or _extract_tag(item_xml, "summary") or ""
        description = _clean_html(description)
        pub_date = _extract_tag(item_xml, "pubDate") or _extract_tag(item_xml, "published") or _extract_tag(item_xml, "updated") or ""
        entries.append({
            "title": title,
            "link": link,
            "description": description,
            "pub_date": pub_date,
            "source_feed": feed["name"],
            "feed_url": feed["url"],
        })
    return entries

def _extract_tag(xml: str, tag: str) -> str:
    m = re.search(rf'<{tag}[^>]*>(.*?)</{tag}>', xml, re.DOTALL)
    return _clean_html(m.group(1).strip()) if m else ""

def _extract_link(xml: str) -> str:
    for tag in ("link",):
        m = re.search(rf'<{tag}[^>]*href="([^"]+)"', xml, re.IGNORECASE)
        if m:
            return m.group(1)
    m = re.search(r'<link[^>]*>(https?://[^<]+)</link>', xml)
    if m:
        return m.group(1)
    m = re.search(r'<id>(https?://[^<]+)</id>', xml)
    return m.group(1) if m else ""

def _clean_html(text: str) -> str:
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'&[a-z]+;', ' ', text)
    text = re.sub(r'&#?\w+;', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()

# ===== Deduplication =====
def _link_hash(link: str) -> str:
    return hashlib.sha256(link.strip().lower().rstrip("/").encode()).hexdigest()

def deduplicate(entries: list[dict], existing_links: set[str]) -> list[dict]:
    seen = set(existing_links)
    result = []
    for e in entries:
        h = _link_hash(e["link"])
        if h not in seen:
            seen.add(h)
            result.append(e)
    return result

# ===== Keyword Fast-Reject =====
def keyword_prefilter(entry: dict) -> dict:
    text = (entry.get("title", "") + " " + entry.get("description", "")).lower()
    for kw in NON_ACADEMIC_KEYWORDS:
        if kw in text:
            entry["score"] = 0
            entry["reject_reason"] = f"keyword: {kw}"
            return entry
    entry["score"] = 1  # survive to AI triage
    return entry

# ===== Deadline Extraction =====
def extract_deadline(text: str) -> Optional[str]:
    patterns = [
        r'(?:deadline|apply before|applications? (?:close|end|due)|submitted? by|closing date)[:\s]+(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})',
        r'(?:deadline|apply before|applications? (?:close|end|due)|submitted? by|closing date)[:\s]+(\d{4}-\d{2}-\d{2})',
        r'(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})',
    ]
    for p in patterns:
        m = re.search(p, text, re.IGNORECASE)
        if m:
            return m.group(1)
    return None

# ===== Web Scraping =====
async def scrape_urls(entries: list[dict]) -> list[dict]:
    sem = asyncio.Semaphore(MAX_CONCURRENT_SCRAPES)
    async def _scrape_one(entry: dict) -> dict:
        async with sem:
            try:
                async with httpx.AsyncClient(timeout=SCRAPE_TIMEOUT, follow_redirects=True) as client:
                    resp = await client.get(entry["link"], headers={"User-Agent": "ScholarWatch/1.0"})
                    resp.raise_for_status()
                    content = trafilatura.extract(resp.text, include_comments=False, include_tables=False)
                    if content:
                        entry["scraped_content"] = content[:AI_CONTENT_CAP]
                        entry["deadline_hint"] = extract_deadline(content)
            except Exception as e:
                print(f"[Scrape] Failed {entry['link']}: {e}")
        return entry

    tasks = [_scrape_one(e) for e in entries]
    return await asyncio.gather(*tasks)

# ===== AI Calls =====
async def _ai_call(client: httpx.AsyncClient, system_prompt: str | None, user_prompt: str, max_tokens: int) -> str | None:
    if not AI_API_KEY:
        print("[AI] No API key configured, skipping")
        return None

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {AI_API_KEY}",
    }

    if AI_PROVIDER == "anthropic":
        messages = []
        if system_prompt:
            messages.append({"role": "user", "content": system_prompt})
        messages.append({"role": "user", "content": user_prompt})
        payload = {
            "model": AI_MODEL,
            "max_tokens": max_tokens,
            "messages": messages,
        }
    else:
        msgs = []
        if system_prompt:
            msgs.append({"role": "system", "content": system_prompt})
        msgs.append({"role": "user", "content": user_prompt})
        payload = {
            "model": AI_MODEL,
            "max_tokens": max_tokens,
            "messages": msgs,
        }

    for attempt in range(3):
        try:
            url = f"{AI_BASE_URL}/v1/messages" if AI_PROVIDER == "anthropic" else f"{AI_BASE_URL}/chat/completions"
            resp = await client.post(url, json=payload, headers=headers, timeout=AI_TIMEOUT)
            if resp.status_code == 429:
                wait = 3 * (attempt + 1)
                print(f"[AI] Rate limited, waiting {wait}s...")
                await asyncio.sleep(wait)
                continue
            resp.raise_for_status()
            data = resp.json()
            if AI_PROVIDER == "anthropic":
                return data["content"][0]["text"]
            else:
                return data["choices"][0]["message"]["content"]
        except Exception as e:
            print(f"[AI] Call failed (attempt {attempt+1}): {e}")
            if attempt < 2:
                await asyncio.sleep(2)
    return None

def _build_triage_prompt(entry: dict, include_summary: bool = False) -> str:
    content = entry.get("scraped_content", entry.get("description", ""))
    title = entry.get("title", "")
    source = entry.get("source_feed", "")

    return f"""You are a scholarship screening assistant. Evaluate this opportunity:

Title: {title}
Source: {source}
Content:
{content[:3000]}

Score 0-5:
5 = Fully funded, LMIC-eligible, clear academic scholarship/fellowship with deadline
4 = Strong scholarship, likely LMIC-eligible, some funding details provided
3 = Plausible scholarship, need to check eligibility details
2 = Training/workshop with some funding, or unclear if fully academic
1 = Conference travel grant, short course, competition, or minimal funding
0 = Not a scholarship/fellowship (job posting, news article, commercial ad, contest, non-academic event)

Return ONLY a JSON object with: score (int), reason (str), country_eligibility (str), funding_type (str), deadline (str if found else null). No other text."""

async def ai_triage_entry(entry: dict, client: httpx.AsyncClient, sem: asyncio.Semaphore) -> dict:
    async with sem:
        prompt = _build_triage_prompt(entry)
        raw = await _ai_call(client, None, prompt, 300)
        if not raw:
            entry["score"] = 0
            entry["reject_reason"] = "AI call failed"
            return entry

        # Extract JSON from response
        m = re.search(r'\{[^{}]*"score"[^{}]*\}', raw, re.DOTALL)
        if not m:
            entry["score"] = 0
            entry["reject_reason"] = "AI returned no valid JSON"
            return entry

        try:
            data = json.loads(m.group(0))
            entry["score"] = max(0, min(5, int(data.get("score", 0))))
            entry["criteria"] = data
            entry["deadline_hint"] = data.get("deadline") or entry.get("deadline_hint")
        except (json.JSONDecodeError, ValueError):
            entry["score"] = 0
            entry["reject_reason"] = "AI JSON parse failed"
        return entry

async def ai_generate_summary(entry: dict, client: httpx.AsyncClient, sem: asyncio.Semaphore) -> dict:
    async with sem:
        content = entry.get("scraped_content", entry.get("description", ""))
        prompt = f"""Summarise this scholarship opportunity in 2-3 concise sentences. Include: what it covers, who is eligible, and the deadline if mentioned.

Title: {entry.get('title', '')}
Content: {content[:2000]}

Return ONLY the summary text, no JSON, no prefixes."""
        summary = await _ai_call(client, None, prompt, 200)
        if summary:
            entry["summary"] = summary.strip()
        return entry


# ===== Main Pipeline =====
async def run_pipeline() -> dict:
    """Execute the screening pipeline, reading feeds from feeds.json and writing to Supabase."""
    supabase = _supabase()

    # Load feeds from JSON
    try:
        with open(FEEDS_FILE) as f:
            all_feeds = json.load(f)
    except Exception as e:
        print(f"Failed to load {FEEDS_FILE}: {e}")
        return {"feeds_checked": 0, "entries_found": 0, "accepted": 0, "error": str(e)}

    feeds = [f for f in all_feeds if f.get("active", True)]
    if not feeds:
        print("[Pipeline] No active feeds configured")
        return {"feeds_checked": 0, "entries_found": 0, "accepted": 0, "message": "No active feeds"}

    print(f"[Pipeline] Starting scan across {len(feeds)} feeds")

    # Insert scan log row
    scan = supabase.table("scan_log").insert({
        "feeds_checked": len(feeds),
        "status": "running"
    }).execute()
    scan_id = scan.data[0]["id"] if scan.data else None

    # Get existing links for dedup
    existing = set()
    try:
        resp = supabase.table("results").select("link").execute()
        for r in resp.data:
            existing.add(_link_hash(r["link"]))
    except Exception as e:
        print(f"[Pipeline] Failed to load existing links: {e}")
    print(f"[Pipeline] {len(existing)} existing links loaded for dedup")

    # Step 1: RSS Fetch
    entries = await fetch_rss_entries(feeds)
    total_found = len(entries)
    print(f"[Pipeline] Fetched {total_found} entries from {len(feeds)} feeds")
    if not entries:
        if scan_id:
            supabase.table("scan_log").update({
                "finished_at": "now()",
                "entries_found": 0,
                "entries_accepted": 0,
                "status": "completed"
            }).eq("id", scan_id).execute()
        return {"feeds_checked": len(feeds), "entries_found": 0, "accepted": 0}

    # Step 2: Dedup
    entries = deduplicate(entries, existing)
    dupes_removed = total_found - len(entries)
    print(f"[Pipeline] {len(entries)} new entries after dedup (removed {dupes_removed})")

    # Step 3: Keyword fast-reject
    entries = [keyword_prefilter(e) for e in entries]
    survivors = [e for e in entries if e["score"] > 0]
    keyword_rejected = len(entries) - len(survivors)
    print(f"[Pipeline] Keyword gate: {keyword_rejected} rejected, {len(survivors)} survive")

    if not survivors:
        if scan_id:
            supabase.table("scan_log").update({
                "finished_at": "now()",
                "entries_found": total_found,
                "entries_accepted": 0,
                "status": "completed"
            }).eq("id", scan_id).execute()
        return {"feeds_checked": len(feeds), "entries_found": total_found, "accepted": 0,
                 "after_dedup": len(entries), "keyword_rejected": keyword_rejected}

    # Step 4: Scrape
    survivors = await scrape_urls(survivors)
    scraped_count = sum(1 for e in survivors if e.get("scraped_content"))
    failed_scrapes = len(survivors) - scraped_count
    print(f"[Pipeline] Scraped {scraped_count}/{len(survivors)} pages ({failed_scrapes} failed)")

    # Step 5: AI triage
    print(f"[Pipeline] Starting AI triage on {len(survivors)} entries...")
    ai_sem = asyncio.Semaphore(MAX_CONCURRENT_AI)
    async with httpx.AsyncClient() as client:
        triaged = await asyncio.gather(
            *[ai_triage_entry(e, client, ai_sem) for e in survivors]
        )
    print(f"[Pipeline] AI triage complete: {len(triaged)} entries")

    ai_rejected = [e for e in triaged if e["score"] == 0]
    accepted = [e for e in triaged if e["score"] >= 3]
    marginal = [e for e in triaged if 0 < e["score"] < 3]
    all_to_save = accepted + marginal
    print(f"[Pipeline] Results: {len(accepted)} accepted, {len(marginal)} marginal, {len(ai_rejected)} AI-rejected")

    # Step 6: Summaries for accepted
    needs_summary = [e for e in accepted if not e.get("summary")]
    if needs_summary:
        print(f"[Pipeline] Generating summaries for {len(needs_summary)} entries...")
        async with httpx.AsyncClient() as client:
            await asyncio.gather(
                *[ai_generate_summary(e, client, ai_sem) for e in needs_summary]
            )

    for e in marginal:
        if not e.get("summary"):
            e["summary"] = e.get("description", "")

    # Step 7: Save to Supabase
    saved = 0
    for e in all_to_save:
        e["deadline"] = e.get("deadline_hint")
        try:
            supabase.table("results").upsert({
                "title": e["title"],
                "link": e["link"],
                "description": e.get("description", ""),
                "summary": e.get("summary", ""),
                "score": e["score"],
                "deadline": e.get("deadline"),
                "source_feed": e.get("source_feed", ""),
                "criteria_json": json.dumps(e.get("criteria", {})),
                "scraped_content": (e.get("scraped_content", "") or "")[:2000],
            }, on_conflict="link,title").execute()
            saved += 1
            if saved % 10 == 0:
                print(f"[Pipeline] Saved {saved}/{len(all_to_save)} results")
        except Exception as ex:
            print(f"[DB] Failed to insert {e['title']}: {ex}")

    # Update scan log
    if scan_id:
        supabase.table("scan_log").update({
            "finished_at": "now()",
            "entries_found": total_found,
            "entries_accepted": len(accepted),
            "status": "completed"
        }).eq("id", scan_id).execute()

    result = {
        "feeds_checked": len(feeds),
        "entries_found": total_found,
        "after_dedup": len(entries),
        "keyword_rejected": keyword_rejected,
        "scraped": scraped_count,
        "ai_triaged": len(triaged),
        "accepted": len(accepted),
        "marginal": len(marginal),
        "ai_rejected": len(ai_rejected),
        "total_saved": saved,
    }
    print(f"\n[Pipeline] COMPLETE: {json.dumps(result, indent=2)}")
    return result


if __name__ == "__main__":
    start = time.time()
    result = asyncio.run(run_pipeline())
    elapsed = time.time() - start
    print(f"\nPipeline finished in {elapsed:.1f}s")
    sys.exit(0 if result.get("error") is None else 1)
