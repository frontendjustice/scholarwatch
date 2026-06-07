"""ScholarWatch — Backend Screening Engine & API Server"""

import asyncio
import hashlib
import json
import os
import re
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import xml.etree.ElementTree as ET

import httpx
import trafilatura
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

# ===== Configuration =====
DB_PATH = Path(__file__).parent / "scholarwatch.db"
STATIC_DIR = Path(__file__).parent
MAX_CONCURRENT_SCRAPES = 10
MAX_CONCURRENT_AI = 1  # Groq free tier: 1 concurrent to avoid 429 rate limits

# === AI Provider: Anthropic or OpenAI-compatible (e.g. Groq) ===
AI_PROVIDER = os.environ.get("AI_PROVIDER", "anthropic").lower()
AI_API_KEY = os.environ.get("AI_API_KEY", os.environ.get("ANTHROPIC_API_KEY", ""))
AI_TIMEOUT = int(os.environ.get("AI_TIMEOUT", "60"))
SCRAPE_TIMEOUT = 20
AI_CONTENT_CAP = 5000

# Multi-key rotation for Groq (comma-separated keys)
_GROQ_KEYS = [k.strip() for k in os.environ.get("GROQ_API_KEYS", "").split(",") if k.strip()]
_groq_key_index = 0
_groq_key_lock = asyncio.Lock()

def _next_groq_key() -> str:
    """Rotate to the next Groq key (not async — caller must hold lock)."""
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

# ===== Database =====
def get_db():
    conn = sqlite3.connect(str(DB_PATH), timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS feeds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            url TEXT NOT NULL UNIQUE,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            link TEXT NOT NULL,
            description TEXT,
            summary TEXT,
            score INTEGER DEFAULT 0,
            deadline TEXT,
            source_feed TEXT,
            criteria_json TEXT DEFAULT '{}',
            scraped_content TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(link, title)
        );
        CREATE TABLE IF NOT EXISTS scan_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT DEFAULT (datetime('now')),
            finished_at TEXT,
            feeds_checked INTEGER DEFAULT 0,
            entries_found INTEGER DEFAULT 0,
            entries_accepted INTEGER DEFAULT 0,
            status TEXT DEFAULT 'running'
        );
        CREATE INDEX IF NOT EXISTS idx_results_score ON results(score);
        CREATE INDEX IF NOT EXISTS idx_results_deadline ON results(deadline);
        CREATE TABLE IF NOT EXISTS bookmarks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            result_id INTEGER NOT NULL UNIQUE,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (result_id) REFERENCES results(id) ON DELETE CASCADE
        );
    """)
    conn.commit()
    conn.close()

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
    """Fetch a single RSS feed and return parsed entries."""
    try:
        resp = await client.get(feed["url"])
        resp.raise_for_status()
        text = resp.text
    except Exception as e:
        print(f"[RSS] Failed to fetch {feed['url']}: {e}")
        return []

    # Simple RSS/Atom parsing without feedparser dependency
    entries = []
    # Try RSS <item> blocks
    items = re.findall(r'<item[^>]*>(.*?)</item>', text, re.DOTALL)
    if not items:
        # Try Atom <entry> blocks
        items = re.findall(r'<entry[^>]*>(.*?)</entry>', text, re.DOTALL)

    for item in items:
        title = _extract_tag(item, 'title')
        link = _extract_link(item)
        desc = _extract_tag(item, 'description') or _extract_tag(item, 'summary') or _extract_tag(item, 'content')
        desc = _clean_html(desc)

        if title and link:
            entries.append({
                "title": title.strip(),
                "link": link.strip(),
                "description": (desc or "").strip()[:2000],
                "source_feed": feed.get("name", feed["url"]),
            })
    return entries

def _extract_tag(xml: str, tag: str) -> str:
    """Extract text from an XML tag, handling CDATA."""
    m = re.search(rf'<{tag}[^>]*>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*</{tag}>', xml, re.DOTALL)
    return m.group(1).strip() if m else ""

def _extract_link(xml: str) -> str:
    """Extract link from RSS <link> or Atom <link href=...>."""
    m = re.search(r'<link[^>]*href=["\']([^"\']+)["\']', xml)
    if m:
        return m.group(1)
    m = re.search(r'<link[^>]*>(.*?)</link>', xml, re.DOTALL)
    if m:
        return m.group(1).strip()
    m = re.search(r'<guid[^>]*>(https?://[^<]+)</guid>', xml)
    if m:
        return m.group(1)
    return ""

def _clean_html(text: str) -> str:
    """Strip HTML tags and decode entities."""
    if not text:
        return ""
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'&amp;', '&', text)
    text = re.sub(r'&lt;', '<', text)
    text = re.sub(r'&gt;', '>', text)
    text = re.sub(r'&quot;', '"', text)
    text = re.sub(r'&#?\w+;', ' ', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()

# ===== Deduplication =====
def deduplicate(entries: list[dict], existing_links: set[str]) -> list[dict]:
    """Step 2: Remove duplicates by link+title hash."""
    seen = set()
    unique = []
    for e in entries:
        key = hashlib.sha256(f"{e['link']}|{e['title']}".encode()).hexdigest()
        if key not in seen and e['link'] not in existing_links:
            seen.add(key)
            unique.append(e)
    return unique

# ===== Keyword Pre-Filter (cheap fast-reject gate) =====
NEGATIVE_KEYWORDS = [
    "expired", "closed", "deadline passed", "no longer accepting",
    "applications closed", "deadline was", "this opportunity has ended"
]

# Non-academic content types — reject immediately (score=0), no scraping, no AI.
# Only university scholarships, research fellowships, and academic funding should survive.
NON_ACADEMIC_KEYWORDS = [
    # Business / entrepreneurship / startup
    "business plan", "business competition", "business contest", "pitch competition",
    "startup competition", "startup challenge", "entrepreneurship award",
    "business idea", "venture competition", "enterprise challenge",
    # Hackathons / coding
    "hackathon", "coding competition", "coding challenge", "programming contest",
    "code challenge", "app challenge", "developer challenge",
    # Design / arts / architecture
    "design competition", "design contest", "design award", "architecture competition",
    "art competition", "art contest", "photography contest", "poster competition",
    "video competition", "film contest", "logo competition", "design challenge",
    # Essay-only / non-academic contests
    "essay contest", "essay competition", "writing contest", "poetry contest",
    "oratory contest", "debate competition",
    # Case competitions / corporate challenges
    "case competition", "case study competition", "case challenge",
    "innovation challenge", "innovation competition",
    # Corporate / commercial
    "marketing competition", "marketing contest", "sales competition",
    # Sports / non-academic
    "sports scholarship"
]

# Broad signal words — if NONE match, the entry is almost certainly not a scholarship
SIGNAL_KEYWORDS = [
    "scholarship", "fellowship", "grant", "award", "funding", "funded",
    "bursary", "stipend", "tuition", "programme", "program",
    "application", "apply", "applicant", "deadline", "eligibility",
    "opportunity", "position", "training", "master", "phd", "doctoral",
    "postdoc", "research", "degree", "study", "student", "scholar",
    "health", "medical", "clinical", "nursing", "pharmacy",
    "developing", "international", "global",
]

def keyword_prefilter(entry: dict) -> dict:
    """Cheap fast-reject gate. Only kills obvious non-scholarships.
    
    Returns entry with:
      - score=0, rejected_reason set  → hard reject, skip AI
      - score=1                       → survives to AI triage
    
    The keyword gate does NOT try to score criteria — that's the AI's job.
    It only asks: 'is this plausibly a scholarship/opportunity at all?'
    """
    text = f"{entry['title']} {entry['description']}".lower()

    # Hard reject: negative keywords (expired/closed)
    for neg in NEGATIVE_KEYWORDS:
        if neg in text:
            entry["score"] = 0
            entry["criteria"] = {}
            entry["rejected_reason"] = f"Negative keyword: {neg}"
            return entry

    # Hard reject: non-academic content type (business, design, hackathon, etc.)
    for kw in NON_ACADEMIC_KEYWORDS:
        if kw in text:
            entry["score"] = 0
            entry["criteria"] = {}
            entry["rejected_reason"] = f"Non-academic content: {kw}"
            return entry

    # Hard reject: no signal words at all → not scholarship-related
    if not any(kw in text for kw in SIGNAL_KEYWORDS):
        entry["score"] = 0
        entry["criteria"] = {}
        entry["rejected_reason"] = "No scholarship signal keywords found"
        return entry

    # Survived — pass to AI with score=1 (placeholder, AI will rescore)
    entry["score"] = 1
    entry["criteria"] = {}  # Will be filled by AI
    
    # Quick deadline hint extraction (free, helps AI)
    deadline_str = extract_deadline(text)
    entry["deadline_hint"] = deadline_str
    return entry

# ===== Deadline Extraction =====
DATE_PATTERNS = [
    # "31 January 2025", "January 31, 2025"
    r'(\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4})',
    r'((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2},?\s+\d{4})',
    # "2025-01-31"
    r'(\d{4}-\d{2}-\d{2})',
    # "31/01/2025" or "01/31/2025"
    r'(\d{1,2}/\d{1,2}/\d{4})',
    # "deadline: March 2025"
    r'deadline[:\s]+(\w+\s+\d{4})',
]

MONTH_MAP = {
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12
}

def extract_deadline(text: str) -> Optional[str]:
    """Step 6: Extract deadline date from text using regex patterns."""
    text_lower = text.lower()

    # Look near "deadline" context first
    deadline_context = ""
    for m in re.finditer(r'deadline.{0,80}', text_lower):
        deadline_context += m.group() + " "

    search_text = deadline_context if deadline_context else text_lower

    for pattern in DATE_PATTERNS:
        m = re.search(pattern, search_text, re.IGNORECASE)
        if m:
            raw = m.group(1)
            parsed = _parse_date(raw)
            if parsed:
                return parsed
    return None

def _parse_date(raw: str) -> Optional[str]:
    """Try to parse a date string into ISO format."""
    raw = raw.strip().rstrip(',')

    # ISO format
    if re.match(r'\d{4}-\d{2}-\d{2}', raw):
        return raw[:10]

    # "31 January 2025"
    m = re.match(r'(\d{1,2})\s+(\w+)\s+(\d{4})', raw)
    if m:
        day, month_str, year = m.groups()
        month = MONTH_MAP.get(month_str[:3].lower())
        if month:
            return f"{year}-{month:02d}-{int(day):02d}"

    # "January 31, 2025"
    m = re.match(r'(\w+)\s+(\d{1,2}),?\s+(\d{4})', raw)
    if m:
        month_str, day, year = m.groups()
        month = MONTH_MAP.get(month_str[:3].lower())
        if month:
            return f"{year}-{month:02d}-{int(day):02d}"

    # "March 2025" (end of month)
    m = re.match(r'(\w+)\s+(\d{4})', raw)
    if m:
        month_str, year = m.groups()
        month = MONTH_MAP.get(month_str[:3].lower())
        if month:
            import calendar
            last_day = calendar.monthrange(int(year), month)[1]
            return f"{year}-{month:02d}-{last_day:02d}"

    return None

# ===== Web Scraping =====
async def scrape_urls(entries: list[dict]) -> list[dict]:
    """Step 4: Concurrently scrape all accepted entry URLs."""
    sem = asyncio.Semaphore(MAX_CONCURRENT_SCRAPES)

    async def _scrape_one(entry: dict) -> dict:
        async with sem:
            try:
                async with httpx.AsyncClient(timeout=SCRAPE_TIMEOUT, follow_redirects=True) as client:
                    resp = await client.get(entry["link"], headers={
                        "User-Agent": "Mozilla/5.0 (compatible; ScholarWatch/1.0)"
                    })
                    resp.raise_for_status()
                    html = resp.text
                    # Extract readable text with trafilatura (handles JS-rendered content better)
                    text = trafilatura.extract(html, include_comments=False, include_tables=False)
                    if not text or len(text.strip()) < 50:
                        # Fallback to regex cleaner for short/non-article pages
                        text = _clean_html(html)
                    entry["scraped_content"] = (text or "")[:8000]  # Cap at 8k chars

                    # Re-extract deadline from full page
                    if not entry.get("deadline_hint"):
                        dl = extract_deadline(text or "")
                        if dl:
                            entry["deadline_hint"] = dl
                            entry["criteria"]["valid_deadline"] = True
                            entry["score"] = sum(1 for v in entry["criteria"].values() if v)
            except Exception as e:
                print(f"[Scrape] Failed {entry['link']}: {e}")
                entry["scraped_content"] = ""
        return entry

    results = await asyncio.gather(*[_scrape_one(e) for e in entries])
    return results

# ===== AI Contextual Triage & Summary =====

async def _ai_call(client: httpx.AsyncClient, system_prompt: str | None, user_prompt: str, max_tokens: int) -> str | None:
    """Call AI provider (Anthropic or OpenAI-compatible like Groq) and return response text."""
    retries = 3
    last_error = None
    for attempt in range(retries):
        try:
            if attempt > 0:
                await asyncio.sleep(1.5 ** attempt)  # backoff: 1.5, 2.25, 3.4s

            if AI_PROVIDER == "groq":
                messages = []
                if system_prompt:
                    messages.append({"role": "system", "content": system_prompt})
                messages.append({"role": "user", "content": user_prompt})

                # Use rotated key if available, else fall back to AI_API_KEY
                async with _groq_key_lock:
                    key = _next_groq_key() or AI_API_KEY

                resp = await client.post(
                    f"{AI_BASE_URL}/chat/completions",
                    json={"model": AI_MODEL, "max_tokens": max_tokens, "messages": messages},
                    headers={
                        "Authorization": f"Bearer {key}",
                        "content-type": "application/json",
                    },
                    timeout=AI_TIMEOUT,
                )
                if resp.status_code == 429:
                    print(f"[AI Call] HTTP 429 (rate limited) on key {key[:8]}..., attempt {attempt+1}/{retries}")
                    last_error = "rate_limited"
                    # Rotate key on 429 and retry immediately with next key
                    async with _groq_key_lock:
                        key = _next_groq_key()
                    if key:
                        continue
                    await asyncio.sleep(1.5 ** attempt)
                    continue
                if resp.status_code != 200:
                    print(f"[AI Call] HTTP {resp.status_code}: {resp.text[:200]}")
                    return None
                return resp.json()["choices"][0]["message"]["content"].strip()

            # Anthropic format
            body = {"model": AI_MODEL, "max_tokens": max_tokens, "messages": [{"role": "user", "content": user_prompt}]}
            if system_prompt:
                body["system"] = system_prompt

            resp = await client.post(
                f"{AI_BASE_URL}/v1/messages",
                json=body,
                headers={
                    "x-api-key": AI_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                timeout=AI_TIMEOUT,
            )
            if resp.status_code != 200:
                print(f"[AI Call] HTTP {resp.status_code}: {resp.text[:200]}")
                return None
            return resp.json()["content"][0]["text"].strip()
        except Exception as e:
            print(f"[AI Call] Error (attempt {attempt+1}/{retries}): {e}")
            last_error = str(e)
            if attempt < retries - 1:
                await asyncio.sleep(1)
    print(f"[AI Call] All {retries} attempts failed")
    return None


TRIAGE_SYSTEM = """You screen scholarship/fellowship opportunities for health professionals from low- and middle-income countries (LMICs). Evaluate based on the FULL content provided.

**IMPORTANT: IMMEDIATE REJECTION** — If the content is a business plan competition, startup pitch contest, hackathon, coding competition, design contest, art contest, essay contest, case competition, or any non-academic competition (NOT a university scholarship or research fellowship), return score 0 for ALL criteria and set is_opportunity to false. Only actual academic funding — university scholarships, research fellowships, academic grants, and health-related training programs — should pass.

Scoring criteria (each is TRUE or FALSE):
1. **fully_funded**: Covers BOTH tuition AND living expenses (stipend, accommodation, relocation grant, or monthly allowance). FALSE if tuition-only, partial, or unclear.
2. **open_eligibility**: Open to international applicants, especially from LMICs / developing countries. FALSE only if restricted to a single nationality or residents of one high-income country.
3. **health_related**: Applicable to health / medical / nursing / public health / biomedical fields. IMPORTANT: if the scholarship says "all courses", "all disciplines", "any field of study", or does NOT exclude health fields, mark TRUE — health professionals can apply.
4. **valid_deadline**: Has a specific future deadline date mentioned (day-month-year or month-year). FALSE if no date, deadline already passed, or only says "open" / "rolling" / "ongoing" with no specific date.

Return ONLY valid JSON — no markdown, no explanation."""


def _build_triage_prompt(entry: dict, include_summary: bool = False) -> str:
    """Build a compact triage prompt. Optionally includes summary request to save a second API call."""
    content = entry.get("scraped_content", entry.get("description", ""))
    content = (content or "")[:AI_CONTENT_CAP]
    dl_hint = entry.get("deadline_hint", "")

    summary_instruction = ""
    if include_summary:
        summary_instruction = ', "summary": "4-sentence summary: what it is, who it is for, what it covers, deadline/how to apply"'

    return f"""Title: {entry['title']}
{f'Deadline hint: {dl_hint}' if dl_hint else ''}
Content: {content}

Is this an actual scholarship/fellowship/grant ANNOUNCEMENT (not news about scholarships, not expired, not a blog post)?

JSON response:
{{"is_opportunity": true/false, "fully_funded": true/false, "open_eligibility": true/false, "health_related": true/false, "valid_deadline": true/false, "deadline_date": "YYYY-MM-DD or null"{summary_instruction}}}"""


async def ai_triage_entry(entry: dict, client: httpx.AsyncClient, sem: asyncio.Semaphore) -> dict:
    """Contextual AI triage on scraped content. Scores all 4 criteria in one call.
    For entries that look strong, also generates summary in same call."""
    async with sem:
        content_text = entry.get("scraped_content", entry.get("description", ""))
        if not content_text:
            entry["score"] = 0
            entry["criteria"] = {}
            entry["rejected_reason"] = "No content to evaluate"
            return entry

        title_lower = entry["title"].lower()
        looks_strong = any(w in title_lower for w in ["scholarship", "fellowship", "funded", "grant", "award", "bursary"])
        include_summary = looks_strong

        prompt = _build_triage_prompt(entry, include_summary=include_summary)
        max_tokens = 400 if include_summary else 150

        try:
            text = await _ai_call(client, TRIAGE_SYSTEM, prompt, max_tokens)
            if text:
                json_match = re.search(r'\{.*\}', text, re.DOTALL)
                if json_match:
                    result = json.loads(json_match.group())

                    if not result.get("is_opportunity", False):
                        entry["score"] = 0
                        entry["criteria"] = {}
                        entry["rejected_reason"] = "AI: not an actual opportunity"
                        return entry

                    entry["criteria"] = {
                        "fully_funded": result.get("fully_funded", False),
                        "open_eligibility": result.get("open_eligibility", False),
                        "health_related": result.get("health_related", False),
                        "valid_deadline": result.get("valid_deadline", False),
                    }
                    entry["score"] = sum(1 for v in entry["criteria"].values() if v)

                    if result.get("deadline_date") and result["deadline_date"] != "null":
                        entry["deadline_hint"] = result["deadline_date"]

                    if result.get("summary"):
                        entry["summary"] = result["summary"]
            else:
                print(f"[AI Triage] Failed for {entry['title']} (no response)")
        except Exception as e:
            print(f"[AI Triage] Failed for {entry['title']}: {e}")

        # Throttle: minimum 3s between Groq API calls (free tier RPM limit)
        if AI_PROVIDER == "groq":
            await asyncio.sleep(3)

    return entry


async def ai_generate_summary(entry: dict, client: httpx.AsyncClient, sem: asyncio.Semaphore) -> dict:
    """Generate summary for accepted entries that don't already have one from triage."""
    if entry.get("summary"):
        return entry

    async with sem:
        content = entry.get("scraped_content", entry.get("description", ""))
        if not content:
            entry["summary"] = entry.get("description", "No content available.")
            return entry

        prompt = f"""Summarize this scholarship for a health professional from a developing country in 4 sentences: what it is, who it's for, what it covers, deadline/how to apply.

Title: {entry['title']}
{f'Deadline: {entry.get("deadline_hint", "unknown")}' if entry.get('deadline_hint') else ''}
Content: {content[:AI_CONTENT_CAP]}

4 sentences, no bullets."""

        try:
            text = await _ai_call(client, None, prompt, 300)
            if text:
                entry["summary"] = text
            else:
                entry["summary"] = entry.get("description", "Summary generation failed.")
        except Exception as e:
            print(f"[AI Summary] Failed for {entry['title']}: {e}")
            entry["summary"] = entry.get("description", "Summary generation failed.")
    return entry

# ===== Full Pipeline =====
async def _emit(queue, event_type, **kwargs):
    """Push a progress event to the queue if available, and log to console."""
    payload = {"stage": event_type, **kwargs}
    if queue is not None:
        queue.put_nowait(payload)
    print(f"[Pipeline] {event_type}: {kwargs}")


async def run_pipeline(progress_queue: asyncio.Queue | None = None) -> dict:
    """Execute the contextual screening pipeline.
    
    Flow:
      1. RSS fetch
      2. Dedup against existing DB entries
      3. Keyword fast-reject (cheap gate — kills obvious non-scholarships)
      4. Scrape ALL survivors (get full page content before any AI call)
      5. AI contextual triage on full content (single Haiku call per entry)
      6. AI summary for accepted entries (score >= 3)
      7. Save to DB
    """
    conn = get_db()

    # Get active feeds
    feeds = [dict(r) for r in conn.execute("SELECT * FROM feeds WHERE active=1").fetchall()]
    if not feeds:
        conn.close()
        await _emit(progress_queue, "notice", message="No active feeds configured")
        return {"feeds_checked": 0, "entries_found": 0, "accepted": 0, "message": "No active feeds"}
    await _emit(progress_queue, "start", feeds_count=len(feeds), message=f"Starting scan across {len(feeds)} active feeds")

    # Log scan start
    conn.execute("INSERT INTO scan_log (feeds_checked) VALUES (?)", (len(feeds),))
    scan_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.commit()

    # Get existing result links for dedup
    existing = {r[0] for r in conn.execute("SELECT link FROM results").fetchall()}

    # Step 1: Fetch RSS
    entries = await fetch_rss_entries(feeds)
    total_found = len(entries)
    print(f"[Pipeline] Fetched {total_found} entries from {len(feeds)} feeds")
    await _emit(progress_queue, "fetch_rss", total=total_found, feeds=len(feeds), message=f"Fetched {total_found} entries from {len(feeds)} feeds")

    # Step 2: Dedup
    entries = deduplicate(entries, existing)
    dupes_removed = total_found - len(entries)
    print(f"[Pipeline] {len(entries)} new entries after dedup")
    await _emit(progress_queue, "dedup", new=len(entries), duplicates_removed=dupes_removed, message=f"De-duplicated: {len(entries)} new entries (removed {dupes_removed} duplicates)")

    # Step 3: Keyword fast-reject (only kills score=0)
    entries = [keyword_prefilter(e) for e in entries]
    survivors = [e for e in entries if e["score"] > 0]
    keyword_rejected = len(entries) - len(survivors)
    print(f"[Pipeline] Keyword gate: {keyword_rejected} rejected, {len(survivors)} survive to scraping")
    await _emit(progress_queue, "keyword_filter", rejected=keyword_rejected, survivors=len(survivors), message=f"Keyword gate: {keyword_rejected} rejected, {len(survivors)} pass to scraping")

    if not survivors:
        conn.execute("""
            UPDATE scan_log SET finished_at=datetime('now'), entries_found=?, entries_accepted=0, status='completed'
            WHERE id=?
        """, (total_found, scan_id))
        conn.commit()
        conn.close()
        result = {
            "feeds_checked": len(feeds), "entries_found": total_found,
            "after_dedup": len(entries), "keyword_rejected": keyword_rejected,
            "scraped": 0, "ai_triaged": 0, "accepted": 0, "rejected": keyword_rejected,
        }
        await _emit(progress_queue, "notice", message=f"All {keyword_rejected} entries rejected by keyword filter")
        return result

    # Step 4: Scrape ALL survivors before AI — contextual filtering needs full content
    survivors = await scrape_urls(survivors)
    scraped_count = sum(1 for e in survivors if e.get("scraped_content"))
    failed_scrapes = len(survivors) - scraped_count
    print(f"[Pipeline] Scraped {scraped_count}/{len(survivors)} pages")
    await _emit(progress_queue, "scrape", successful=scraped_count, total=len(survivors), failed=failed_scrapes, message=f"Scraped {scraped_count}/{len(survivors)} pages ({failed_scrapes} failed)")

    # Step 5: AI contextual triage — one Haiku call per survivor
    await _emit(progress_queue, "ai_triage_start", total=len(survivors), message=f"Starting AI triage on {len(survivors)} entries")
    ai_sem = asyncio.Semaphore(MAX_CONCURRENT_AI)
    async with httpx.AsyncClient() as client:
        # Wrap each triage call to emit per-entry progress
        triaged_count = [0]  # mutable container for nonlocal
        total = len(survivors)

        async def triage_with_progress(e):
            result = await ai_triage_entry(e, client, ai_sem)
            triaged_count[0] += 1
            await _emit(progress_queue, "ai_triage_progress",
                        completed=triaged_count[0], total=total,
                        message=f"AI triage: {triaged_count[0]}/{total} entries")
            return result

        triaged = await asyncio.gather(
            *[triage_with_progress(e) for e in survivors]
        )
    print(f"[Pipeline] AI triaged {len(triaged)} entries")

    # Split results
    ai_rejected = [e for e in triaged if e["score"] == 0]
    accepted = [e for e in triaged if e["score"] >= 3]
    marginal = [e for e in triaged if 0 < e["score"] < 3]

    # Also save marginal (score 1-2) so user can review borderline entries
    all_to_save = accepted + marginal

    print(f"[Pipeline] Results: {len(accepted)} accepted (score>=3), "
          f"{len(marginal)} marginal (score 1-2), {len(ai_rejected)} AI-rejected")
    await _emit(progress_queue, "ai_triage_done", accepted=len(accepted), marginal=len(marginal), rejected=len(ai_rejected), message=f"AI triage complete: {len(accepted)} accepted, {len(marginal)} marginal, {len(ai_rejected)} rejected")

    # Step 6: Generate summaries for accepted entries that don't have one yet
    needs_summary = [e for e in accepted if not e.get("summary")]
    if needs_summary:
        await _emit(progress_queue, "summaries", count=len(needs_summary), message=f"Generating AI summaries for {len(needs_summary)} accepted entries")
        async with httpx.AsyncClient() as client:
            await asyncio.gather(
                *[ai_generate_summary(e, client, ai_sem) for e in needs_summary]
            )
    # Marginal entries get RSS description as summary
    for e in marginal:
        if not e.get("summary"):
            e["summary"] = e.get("description", "")

    # Step 7: Final deadline + save to DB
    for e in all_to_save:
        e["deadline"] = e.get("deadline_hint")
        try:
            conn.execute("""
                INSERT OR IGNORE INTO results (title, link, description, summary, score, deadline, source_feed, criteria_json, scraped_content)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                e["title"], e["link"], e.get("description", ""),
                e.get("summary", ""), e["score"], e.get("deadline"),
                e.get("source_feed", ""), json.dumps(e.get("criteria", {})),
                e.get("scraped_content", "")[:2000]  # Store truncated
            ))
        except Exception as ex:
            print(f"[DB] Failed to insert {e['title']}: {ex}")

    # Update scan log
    conn.execute("""
        UPDATE scan_log SET finished_at=datetime('now'), entries_found=?, entries_accepted=?, status='completed'
        WHERE id=?
    """, (total_found, len(accepted), scan_id))
    conn.commit()
    conn.close()

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
        "total_saved": len(all_to_save),
    }
    return result

# ===== FastAPI App =====
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield

app = FastAPI(title="ScholarWatch", lifespan=lifespan)

# --- API Endpoints ---

class FeedCreate(BaseModel):
    name: str
    url: str

@app.get("/api/stats")
async def get_stats():
    conn = get_db()
    feeds = conn.execute("SELECT COUNT(*) FROM feeds WHERE active=1").fetchone()[0]
    screened = conn.execute("SELECT COUNT(*) FROM results").fetchone()[0]
    accepted = conn.execute("SELECT COUNT(*) FROM results WHERE score >= 3").fetchone()[0]
    last_scan = conn.execute("SELECT finished_at FROM scan_log ORDER BY id DESC LIMIT 1").fetchone()
    conn.close()
    return {
        "active_feeds": feeds,
        "total_screened": screened,
        "total_accepted": accepted,
        "last_run": last_scan[0] if last_scan else None,
    }

@app.post("/api/bookmarks/toggle")
async def toggle_bookmark(data: dict):
    """Toggle a bookmark on/off for a result."""
    result_id = data.get("result_id")
    if not result_id:
        raise HTTPException(400, "result_id required")
    conn = get_db()
    existing = conn.execute("SELECT id FROM bookmarks WHERE result_id = ?", (result_id,)).fetchone()
    if existing:
        conn.execute("DELETE FROM bookmarks WHERE result_id = ?", (result_id,))
        conn.commit()
        conn.close()
        return {"bookmarked": False, "result_id": result_id}
    else:
        conn.execute("INSERT INTO bookmarks (result_id) VALUES (?)", (result_id,))
        conn.commit()
        conn.close()
        return {"bookmarked": True, "result_id": result_id}


@app.get("/api/bookmarks")
async def get_bookmarks():
    """Get all bookmarked results."""
    conn = get_db()
    rows = conn.execute("""
        SELECT r.*, b.created_at as bookmarked_at
        FROM results r
        JOIN bookmarks b ON r.id = b.result_id
        ORDER BY b.created_at DESC
    """).fetchall()
    conn.close()
    results = []
    for r in rows:
        d = dict(r)
        d["criteria"] = json.loads(d.get("criteria_json", "{}"))
        del d["criteria_json"]
        if "scraped_content" in d:
            del d["scraped_content"]
        results.append(d)
    return {"results": results, "count": len(results)}


@app.get("/api/results")
async def get_results():
    conn = get_db()
    rows = conn.execute("SELECT * FROM results ORDER BY score DESC, created_at DESC").fetchall()
    conn.close()
    results = []
    for r in rows:
        d = dict(r)
        d["criteria"] = json.loads(d.get("criteria_json", "{}"))
        del d["criteria_json"]
        if "scraped_content" in d:
            del d["scraped_content"]
        results.append(d)
    return {"results": results}

@app.post("/api/scan")
async def trigger_scan():
    """Stream the scan pipeline progress via Server-Sent Events."""
    queue: asyncio.Queue = asyncio.Queue()

    async def event_stream():
        task = asyncio.create_task(run_pipeline(progress_queue=queue))

        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=0.3)
                yield f"data: {json.dumps(event)}\n\n"
            except asyncio.TimeoutError:
                if task.done():
                    try:
                        result = task.result()
                        yield f"data: {json.dumps({'stage': 'complete', 'results': result})}\n\n"
                    except Exception as e:
                        yield f"data: {json.dumps({'stage': 'error', 'message': str(e)})}\n\n"
                    break

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering on frontend
        },
    )

@app.get("/api/feeds")
async def get_feeds():
    conn = get_db()
    rows = conn.execute("SELECT * FROM feeds ORDER BY created_at DESC").fetchall()
    conn.close()
    return {"feeds": [dict(r) for r in rows]}

@app.post("/api/feeds")
async def add_feed(feed: FeedCreate):
    conn = get_db()
    try:
        conn.execute("INSERT INTO feeds (name, url) VALUES (?, ?)", (feed.name, feed.url))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(400, "Feed URL already exists")
    conn.close()
    return {"ok": True}

@app.post("/api/feeds/{feed_id}/toggle")
async def toggle_feed(feed_id: int):
    conn = get_db()
    conn.execute("UPDATE feeds SET active = CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id=?", (feed_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.delete("/api/feeds/{feed_id}")
async def delete_feed(feed_id: int):
    conn = get_db()
    conn.execute("DELETE FROM feeds WHERE id=?", (feed_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/results/{result_id}")
async def delete_result(result_id: int):
    """Delete a single screened result (cascades to bookmarks)."""
    conn = get_db()
    conn.execute("DELETE FROM results WHERE id=?", (result_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/clear-db")
async def clear_database():
    """Delete all screened results and scan logs. Bookmark entries cascade-delete."""
    conn = get_db()
    cur = conn.execute("SELECT COUNT(*) FROM results")
    n_results = cur.fetchone()[0]
    cur = conn.execute("SELECT COUNT(*) FROM scan_log")
    n_logs = cur.fetchone()[0]
    conn.execute("DELETE FROM results")
    conn.execute("DELETE FROM scan_log")
    conn.commit()
    conn.close()
    return {"ok": True, "deleted_results": n_results, "deleted_logs": n_logs}


@app.post("/api/feeds/opml")
async def upload_opml(file: UploadFile = File(...)):
    """Import RSS feeds from an OPML file.
    
    Parses standard OPML format, extracts <outline> elements with
    xmlUrl attributes, and bulk-inserts them as new feeds.
    Duplicates (by URL) are silently skipped.
    """
    if not file.filename:
        raise HTTPException(400, "No file provided")

    # Validate file extension
    fname = file.filename.lower()
    if not (fname.endswith(".opml") or fname.endswith(".xml")):
        raise HTTPException(400, "File must be .opml or .xml")

    # Read and parse
    try:
        content = await file.read()
        if len(content) > 5 * 1024 * 1024:  # 5MB limit
            raise HTTPException(400, "File too large (max 5MB)")
        root = ET.fromstring(content)
    except ET.ParseError as e:
        raise HTTPException(400, f"Invalid XML: {e}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Failed to read file: {e}")

    # Extract feeds from <outline> elements
    # OPML stores feeds as <outline type="rss" xmlUrl="..." text="..." />
    # They can be nested inside category <outline> elements
    extracted = []
    for outline in root.iter("outline"):
        xml_url = outline.get("xmlUrl") or outline.get("xmlurl") or outline.get("XMLURL")
        if not xml_url:
            continue
        # Get the best available name
        name = (
            outline.get("text")
            or outline.get("title")
            or outline.get("description")
            or xml_url
        )
        extracted.append({"name": name.strip(), "url": xml_url.strip()})

    if not extracted:
        raise HTTPException(400, "No RSS feeds found in OPML file. Expected <outline> elements with xmlUrl attributes.")

    # Bulk insert, skip duplicates
    conn = get_db()
    added = 0
    skipped = 0
    for feed in extracted:
        try:
            conn.execute("INSERT INTO feeds (name, url) VALUES (?, ?)", (feed["name"], feed["url"]))
            added += 1
        except sqlite3.IntegrityError:
            skipped += 1
    conn.commit()
    conn.close()

    return {
        "ok": True,
        "total_in_file": len(extracted),
        "added": added,
        "skipped_duplicates": skipped,
    }


# --- Static Files ---
@app.get("/")
async def serve_index():
    return FileResponse(STATIC_DIR / "index.html")

@app.get("/{path:path}")
async def serve_static(path: str):
    file_path = STATIC_DIR / path
    if file_path.exists() and file_path.is_file():
        # Determine content type
        ct = "application/octet-stream"
        if path.endswith(".css"): ct = "text/css"
        elif path.endswith(".js"): ct = "application/javascript"
        elif path.endswith(".html"): ct = "text/html"
        elif path.endswith(".json"): ct = "application/json"
        elif path.endswith(".png"): ct = "image/png"
        elif path.endswith(".svg"): ct = "image/svg+xml"
        return FileResponse(file_path, media_type=ct)
    return FileResponse(STATIC_DIR / "index.html")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
