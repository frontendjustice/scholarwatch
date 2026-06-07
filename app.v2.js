// ScholarWatch — Frontend Application
const API = window.location.origin;

// ===== State =====
let results = [];
let feeds = [];
let bookmarks = new Set();

// ===== View Switching =====
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    if (view === 'dashboard') loadResults();
    if (view === 'bookmarked') loadBookmarks();
    if (view === 'feeds') loadFeeds();
  });
});

// ===== API Helpers =====
async function api(path, opts = {}) {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || res.statusText);
    }
    return res.json();
  } catch (e) {
    console.error(`API ${path}:`, e);
    throw e;
  }
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ===== Stats =====
async function loadStats() {
  try {
    const data = await api('/api/stats');
    document.getElementById('stat-feeds').textContent = data.active_feeds || 0;
    document.getElementById('stat-screened').textContent = data.total_screened || 0;
    document.getElementById('stat-accepted').textContent = data.total_accepted || 0;
    document.getElementById('stat-lastrun').textContent = data.last_run || 'Never';
  } catch {
    // Stats not available yet
  }
}

// ===== Results =====
async function loadResults() {
  try {
    const data = await api('/api/results');
    results = data.results || [];
    renderResults();
  } catch {
    results = [];
    renderResults();
  }
  // Also load bookmarks to sync star state
  try {
    const bmData = await api('/api/bookmarks');
    bookmarks = new Set((bmData.results || []).map(r => r.id));
    renderResults();
  } catch { /* ignore */ }
}

function renderResults() {
  const empty = document.getElementById('dash-empty');
  const wrap = document.getElementById('dash-results');
  const body = document.getElementById('results-body');

  // Filter
  const scoreFilter = document.getElementById('filter-score').value;
  const deadlineFilter = document.getElementById('filter-deadline').value;
  const search = document.getElementById('filter-search').value.toLowerCase();

  let filtered = results.filter(r => {
    if (scoreFilter && String(r.score) !== scoreFilter) return false;
    if (search && !r.title.toLowerCase().includes(search)) return false;
    if (deadlineFilter) {
      const dl = r.deadline ? new Date(r.deadline) : null;
      const now = new Date();
      const in30 = new Date(now.getTime() + 30 * 86400000);
      if (deadlineFilter === 'upcoming' && (!dl || dl < now || dl > in30)) return false;
      if (deadlineFilter === 'open' && (!dl || dl < now)) return false;
      if (deadlineFilter === 'expired' && (!dl || dl >= now)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    empty.style.display = '';
    wrap.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  wrap.style.display = '';

  body.innerHTML = filtered.map((r, i) => {
    const dlClass = getDeadlineClass(r.deadline);
    const dlText = r.deadline || 'Unknown';
    return `
      <tr>
        <td><div class="score-badge score-${r.score}">${r.score}/4</div></td>
        <td>
          <div class="result-title" onclick="showDetail(${i})">${esc(r.title)}</div>
          <div class="result-source">${esc(r.source_feed || '')}</div>
        </td>
        <td><span class="deadline-badge ${dlClass}">${esc(dlText)}</span></td>
        <td><span style="font-size:12px;color:var(--text-muted)">${esc(r.source_feed || '—')}</span></td>
        <td>
          <a href="${esc(r.link)}" target="_blank" class="btn btn-sm btn-secondary">Open</a>
          <button class="btn btn-sm btn-bookmark ${bookmarks.has(r.id) ? 'bookmarked' : ''}" onclick="toggleBookmark(${r.id})" title="Bookmark this scholarship">
            ${bookmarks.has(r.id) ? '★' : '☆'}
          </button>
          <button type="button" class="btn btn-sm btn-danger" style="margin-left:8px;" onclick="deleteResult(${r.id})" title="Delete this entry">🗑 Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

// ===== Bookmarks =====
async function loadBookmarks() {
  try {
    const data = await api('/api/bookmarks');
    const list = data.results || [];
    bookmarks = new Set(list.map(r => r.id));
    renderBookmarks(list);
  } catch {
    bookmarks = new Set();
    renderBookmarks([]);
  }
}

function renderBookmarks(bookmarkedResults) {
  window._bookmarkedResults = bookmarkedResults;
  const empty = document.getElementById('bookmarked-empty');
  const wrap = document.getElementById('bookmarked-results');
  const body = document.getElementById('bookmarked-body');
  const count = document.getElementById('bookmarked-count');

  count.textContent = `${bookmarkedResults.length} saved`;

  if (bookmarkedResults.length === 0) {
    empty.style.display = '';
    wrap.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  wrap.style.display = '';

  body.innerHTML = bookmarkedResults.map(r => {
    const dlClass = getDeadlineClass(r.deadline);
    const dlText = r.deadline || 'Unknown';
    return `
      <tr>
        <td><div class="score-badge score-${r.score}">${r.score}/4</div></td>
        <td>
          <div class="result-title" onclick="showDetailById(${r.id})">${esc(r.title)}</div>
          <div class="result-source">${esc(r.source_feed || '')}</div>
        </td>
        <td><span class="deadline-badge ${dlClass}">${esc(dlText)}</span></td>
        <td><span style="font-size:12px;color:var(--text-muted)">${esc(r.source_feed || '—')}</span></td>
        <td>
          <a href="${esc(r.link)}" target="_blank" class="btn btn-sm btn-secondary">Open</a>
          <button class="btn btn-sm btn-bookmark bookmarked" onclick="toggleBookmark(${r.id})" title="Remove bookmark">★</button>
          <button type="button" class="btn btn-sm btn-danger" style="margin-left:8px;" onclick="deleteResult(${r.id})" title="Delete this entry">🗑 Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

async function toggleBookmark(resultId) {
  try {
    const data = await api('/api/bookmarks/toggle', {
      method: 'POST',
      body: JSON.stringify({ result_id: resultId }),
    });
    if (data.bookmarked) {
      bookmarks.add(resultId);
      toast('Bookmarked');
    } else {
      bookmarks.delete(resultId);
      toast('Bookmark removed');
    }
    // Re-render current view
    const activeView = document.querySelector('.nav-btn.active').dataset.view;
    if (activeView === 'dashboard') renderResults();
    if (activeView === 'bookmarked') loadBookmarks();
  } catch (e) {
    toast(`Bookmark failed: ${e.message}`, 'error');
  }
}

// ===== Delete =====
async function deleteResult(id) {
  if (!confirm('Delete this scholarship entry?')) return;
  try {
    await api(`/api/results/${id}`, { method: 'DELETE' });
    bookmarks.delete(id);
    results = results.filter(r => r.id !== id);
    toast('Entry deleted');
    const activeView = document.querySelector('.nav-btn.active').dataset.view;
    if (activeView === 'dashboard') renderResults();
    if (activeView === 'bookmarked') loadBookmarks();
  } catch (e) {
    toast(`Delete failed: ${e.message}`, 'error');
  }
}

async function clearDatabase() {
  if (!confirm('Clear ALL results and scan logs? This cannot be undone.')) return;
  try {
    const data = await api('/api/clear-db', { method: 'POST' });
    results = [];
    bookmarks = new Set();
    const msg = data.deleted_results > 0
      ? `Cleared ${data.deleted_results} results and ${data.deleted_logs} scan logs`
      : 'Database is already empty — nothing to clear';
    toast(msg);
    const activeView = document.querySelector('.nav-btn.active').dataset.view;
    if (activeView === 'dashboard') renderResults();
    if (activeView === 'bookmarked') loadBookmarks();
    loadStats();
  } catch (e) {
    toast(`Clear failed: ${e.message}`, 'error');
  }
}

window.toggleBookmark = toggleBookmark;
window.deleteResult = deleteResult;
window.clearDatabase = clearDatabase;

// ===== Helpers =====
function getDeadlineClass(dl) {
  if (!dl) return 'deadline-unknown';
  const d = new Date(dl);
  const now = new Date();
  if (d < now) return 'deadline-expired';
  const diff = (d - now) / 86400000;
  if (diff <= 14) return 'deadline-soon';
  return 'deadline-upcoming';
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// ===== Detail Modal =====
window.showDetail = function(idx) {
  const r = results[idx];
  if (!r) return;
  showDetailForResult(r);
};

window.showDetailById = function(id) {
  const r = results.find(x => x.id === id);
  if (r) { showDetailForResult(r); return; }
  // Fallback: try bookmarked results
  if (window._bookmarkedResults) {
    const bm = window._bookmarkedResults.find(x => x.id === id);
    if (bm) { showDetailForResult(bm); return; }
  }
};

function showDetailForResult(r) {
  document.getElementById('modal-score').innerHTML = `<div class="score-badge score-${r.score}" style="width:56px;height:56px;font-size:20px">${r.score}/4</div>`;
  document.getElementById('modal-title').textContent = r.title;
  document.getElementById('modal-deadline').textContent = r.deadline ? `Deadline: ${r.deadline}` : 'Deadline: Unknown';
  document.getElementById('modal-source').textContent = `Source: ${r.source_feed || '—'}`;
  document.getElementById('modal-link').href = r.link || '#';
  document.getElementById('modal-summary').textContent = r.summary || r.description || 'No summary available.';

  const criteria = [
    { label: 'Fully Funded', key: 'fully_funded' },
    { label: 'Open to LMIC / Everyone', key: 'open_eligibility' },
    { label: 'Health-Related / All Courses', key: 'health_related' },
    { label: 'Valid Deadline', key: 'valid_deadline' },
  ];
  document.getElementById('modal-criteria').innerHTML = criteria.map(c => {
    const pass = r.criteria && r.criteria[c.key];
    return `<div class="modal-criterion ${pass ? 'criterion-pass' : 'criterion-fail'}">${pass ? '✓' : '✗'} ${c.label}</div>`;
  }).join('');

  document.getElementById('modal-overlay').style.display = '';
};

document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('modal-overlay').style.display = 'none';
});
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
});

// ===== Filters =====
['filter-score', 'filter-deadline', 'filter-search'].forEach(id => {
  document.getElementById(id).addEventListener('input', renderResults);
  document.getElementById(id).addEventListener('change', renderResults);
});

// ===== Run Scan (SSE streaming) =====
const STAGE_LABELS = {
  start:          '📡 Starting scan',
  fetch_rss:      '📥 Fetching RSS feeds',
  dedup:          '🔄 Deduplicating entries',
  keyword_filter: '🔍 Running keyword filter',
  scrape:         '🌐 Scraping full pages',
  ai_triage_start:'🤖 Starting AI triage',
  ai_triage_done: '✅ AI triage complete',
  summaries:      '📝 Generating summaries',
  notice:         'ℹ️ Notice',
  complete:       '🏁 Scan finished',
  error:          '❌ Error',
};

function addLogEntry(container, { stage, label, detail }) {
  const div = document.createElement('div');
  div.className = `log-entry log-${stage}`;
  div.innerHTML = `<span class="log-label">${label}</span><span class="log-detail">${detail}</span>`;
  container.appendChild(div);
  container.parentElement.scrollTop = container.parentElement.scrollHeight;
}

document.getElementById('btn-run-scan').addEventListener('click', async () => {
  const btn = document.getElementById('btn-run-scan');
  const loading = document.getElementById('dash-loading');
  const empty = document.getElementById('dash-empty');
  const wrap = document.getElementById('dash-results');
  const logBody = document.getElementById('scan-log-body');
  const statusEl = document.getElementById('scan-status');
  const progressEl = document.getElementById('scan-progress-bar');

  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">⏳</span> Scanning...';
  empty.style.display = 'none';
  wrap.style.display = 'none';
  loading.style.display = '';
  logBody.innerHTML = '';
  statusEl.textContent = 'Starting...';
  progressEl.style.display = 'none';

  try {
    const response = await fetch(`${API}/api/scan`, { method: 'POST' });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(err.detail || response.statusText);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          const stage = event.stage;

          if (stage === 'ai_triage_start') progressEl.style.display = '';
          if (stage === 'ai_triage_done' || stage === 'complete' || stage === 'error') progressEl.style.display = 'none';

          if (stage === 'complete') {
            statusEl.textContent = 'Complete!';
            const r = event.results || event.result || {};
            addLogEntry(logBody, {
              stage: 'complete',
              label: STAGE_LABELS['complete'],
              detail: `Feeds: ${r.feeds_checked} | Found: ${r.entries_found} | Accepted: ${r.accepted} | Marginal: ${r.marginal} | AI Rejected: ${r.ai_rejected}`,
            });
            setTimeout(() => {
              loading.style.display = 'none';
              loadResults();
              loadStats();
              toast(`Scan complete: ${r.accepted || 0} scholarships found`);
            }, 800);
            break;
          }

          if (stage === 'error') {
            statusEl.textContent = 'Error';
            addLogEntry(logBody, { stage: 'error', label: STAGE_LABELS['error'], detail: event.message });
            break;
          }

          statusEl.textContent = event.message || stage;
          addLogEntry(logBody, {
            stage,
            label: STAGE_LABELS[stage] || stage,
            detail: event.message || '',
          });
        } catch {}
      }
    }
  } catch (e) {
    loading.style.display = 'none';
    empty.style.display = '';
    toast(`Scan failed: ${e.message}`, 'error');
  }

  btn.disabled = false;
  btn.innerHTML = '<span class="btn-icon">▶</span> Run Scan Now';
});

document.getElementById('btn-refresh').addEventListener('click', () => {
  loadResults();
  loadStats();
});

document.getElementById('btn-clear-db').addEventListener('click', () => {
  clearDatabase();
});

document.getElementById('btn-clear-db-feeds').addEventListener('click', () => {
  clearDatabase();
});

// ===== Feeds Management =====
async function loadFeeds() {
  try {
    const data = await api('/api/feeds');
    feeds = data.feeds || [];
    renderFeeds();
  } catch {
    feeds = [];
    renderFeeds();
  }
}

function renderFeeds() {
  const list = document.getElementById('feeds-list');
  if (feeds.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📡</div>
        <h3>No feeds configured</h3>
        <p>Add your first RSS feed URL above to start monitoring.</p>
      </div>`;
    return;
  }
  list.innerHTML = feeds.map(f => `
    <div class="feed-item">
      <div class="feed-status ${f.active ? 'active' : 'inactive'}"></div>
      <div class="feed-info">
        <div class="feed-name">${esc(f.name)}</div>
        <div class="feed-url-text">${esc(f.url)}</div>
      </div>
      <div class="feed-actions">
        <button class="btn btn-sm btn-secondary" onclick="toggleFeed(${f.id})">${f.active ? 'Disable' : 'Enable'}</button>
        <button class="btn btn-sm btn-danger" onclick="deleteFeed(${f.id})">✕ Delete</button>
      </div>
    </div>
  `).join('');
}

document.getElementById('btn-add-feed').addEventListener('click', async () => {
  const name = document.getElementById('feed-name').value.trim();
  const url = document.getElementById('feed-url').value.trim();
  if (!url) { toast('Please enter a feed URL', 'error'); return; }
  try {
    await api('/api/feeds', {
      method: 'POST',
      body: JSON.stringify({ name: name || url, url }),
    });
    document.getElementById('feed-name').value = '';
    document.getElementById('feed-url').value = '';
    loadFeeds();
    loadStats();
    toast('Feed added successfully');
  } catch (e) {
    toast(`Failed to add feed: ${e.message}`, 'error');
  }
});

window.toggleFeed = async function(id) {
  try {
    await api(`/api/feeds/${id}/toggle`, { method: 'POST' });
    loadFeeds();
    loadStats();
  } catch (e) {
    toast(`Failed: ${e.message}`, 'error');
  }
};

window.deleteFeed = async function(id) {
  try {
    await api(`/api/feeds/${id}`, { method: 'DELETE' });
    loadFeeds();
    loadStats();
    toast('Feed removed');
  } catch (e) {
    toast(`Failed: ${e.message}`, 'error');
  }
};

// ===== OPML Import =====
document.getElementById('btn-import-opml').addEventListener('click', () => {
  document.getElementById('opml-file-input').click();
});

document.getElementById('opml-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const btn = document.getElementById('btn-import-opml');
  btn.disabled = true;
  btn.textContent = 'Importing...';

  try {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch(`${API}/api/feeds/opml`, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || res.statusText);
    }

    const result = await res.json();
    loadFeeds();
    loadStats();
    toast(`Imported ${result.added} feed(s) from OPML (${result.skipped_duplicates} duplicates skipped)`);
  } catch (e) {
    toast(`OPML import failed: ${e.message}`, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Import OPML';
  // Reset file input so the same file can be re-selected
  e.target.value = '';
});



// ===== Init =====
loadStats();
