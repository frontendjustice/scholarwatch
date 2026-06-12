# ScholarWatch

Automated health scholarship screening pipeline — scans RSS feeds, filters for fully-funded LMIC opportunities, and delivers AI-powered summaries.

## Architecture

- **Backend**: Python/FastAPI + SQLite
- **Frontend**: Vanilla HTML/CSS/JS (single-page app)
- **Dependencies**: httpx, feedparser, beautifulsoup4, fastapi, uvicorn

## Quick Start

```bash
pip install -r requirements.txt
python server.py
```

Then open `http://localhost:8080`.

## Features

- Add/remove RSS feed URLs (manual or OPML import)
- Multi-stage screening pipeline (fetch → deduplicate → filter → score → summarize → persist)
- AI-powered 6-sentence summaries for qualifying opportunities
- Dashboard with search, filter, bookmark, and export
- Newsletter generation (DOCX)
- Deadline extraction and scoring

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/feeds` | List all feeds |
| POST | `/api/feeds` | Add a feed |
| DELETE | `/api/feeds/{id}` | Delete a feed |
| POST | `/api/feeds/{id}/toggle` | Toggle feed active state |
| POST | `/api/feeds/opml` | Import OPML file |
| POST | `/api/scan` | Run full scan pipeline |
| GET | `/api/results` | Get screened results |
| DELETE | `/api/results/{id}` | Delete a result |
| POST | `/api/clear-db` | Clear database |
| GET | `/api/newsletter` | Get newsletter data |
| POST | `/api/newsletter` | Generate newsletter |
| DELETE | `/api/newsletter` | Delete newsletter |
| POST | `/api/bookmarks/toggle` | Toggle bookmark |
| GET | `/api/bookmarks` | Get bookmarked results |

## Project Structure

```
.
├── server.py           # FastAPI backend
├── index.html          # SPA template
├── app.v2.js           # Frontend logic
├── style.css           # Styles
├── start.sh            # Production start script
├── run.sh              # Development run script
├── package.json        # Node deps (for dev tooling)
├── requirements.txt    # Python deps
└── .gitignore
```
