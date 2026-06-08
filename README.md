# ScholarWatch — Scholarship Screening Pipeline

Automated pipeline that scans RSS feeds for fully-funded health-related scholarships and fellowships, using AI to screen and summarize opportunities.

## Architecture

```
GitHub Actions (daily cron)
      ↓ runs pipeline.py
RSS Feeds → Scrape → AI Triage → Supabase
                                    ↑ reads
                              Vercel (static frontend)
```

**No server required.** Three independent services, none tied to any single platform.

- **Pipeline:** Python script (`pipeline.py`) runs via GitHub Actions on a daily schedule
- **Database:** [Supabase](https://supabase.com) (PostgreSQL) — free tier (500MB)
- **Frontend:** Static HTML/JS deployed on [Vercel](https://vercel.com) — reads directly from Supabase via the JS client

## Setup

### 1. Create a Supabase project

Go to [supabase.com](https://supabase.com) → New project. Copy the **Project URL** and **anon key** from Settings → API.

### 2. Run the schema SQL

In the Supabase SQL Editor, paste and run the contents of `supabase_schema.sql`. This creates all tables and RLS policies.

### 3. Configure GitHub Secrets

Add these secrets in your repo Settings → Secrets and variables → Actions:

| Secret | Description |
|--------|-------------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Your Supabase anon key |
| `AI_PROVIDER` | `anthropic` or `groq` |
| `AI_API_KEY` | Your AI API key |
| `AI_BASE_URL` | (optional) Custom API base URL |
| `AI_MODEL` | (optional) Model name |

### 4. Deploy frontend to Vercel

1. Go to [vercel.com](https://vercel.com) → New Project → Import your GitHub repo
2. Set build command to blank (static site) and output directory to `.`
3. Before deploying, update `app.v3.js` — replace `%%SUPABASE_URL%%` and `%%SUPABASE_ANON_KEY%%` with your actual Supabase values
4. Deploy

### 5. Edit feeds

Edit `feeds.json` to add/remove RSS feed URLs. The pipeline reads from this file.

## Pipeline Flow

1. **RSS Fetch** — Reads feeds from `feeds.json`, parses entries
2. **Deduplication** — Removes entries already in the database
3. **Keyword Gate** — Fast-rejects obvious non-scholarships (casino, loans, etc.)
4. **Web Scraping** — Fetches full page content for survivors
5. **AI Triage** — Scores each entry 0–5 based on scholarship relevance
6. **AI Summary** — Generates 2–3 sentence summaries for accepted entries
7. **Save to Supabase** — Upserts results, updates scan log
