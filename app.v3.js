// ScholarWatch — Supabase Frontend
// ===== Supabase Client =====
const SUPABASE_URL = 'https://zytookvpynknavpohobl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp5dG9va3ZweW5rbmF2cG9ob2JsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NjMzODYsImV4cCI6MjA5NjQzOTM4Nn0.2frRHPMUN4pTXm0-Aol-ZgVw6CRcvej_X6YUuEKMPnc';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
    const { count: feedCount } = await supabase
      .from('feeds').select('*', { count: 'exact', head: true }).eq('active', true);
    const { count: screened } = await supabase
      .from('results').select('*', { count: 'exact', head: true });
    const { count: accepted } = await supabase
      .from('results').select('*', { count: 'exact', head: true }).gte('score', 3);
    const { data: lastScan } = await supabase
      .from('scan_log').select('finished_at').order('id', { ascending: false }).limit(1);

    document.getElementById('stat-feeds').textContent = feedCount || 0;
    document.getElementById('stat-screened').textContent = screened || 0;
    document.getElementById('stat-accepted').textContent = accepted || 0;
    document.getElementById('stat-lastrun').textContent = lastScan?.[0]?.finished_at || 'Never';
  } catch (e) {
    console.error('Stats:', e);
  }
}

// ===== Results =====
async function loadResults() {
  try {
    const { data } = await supabase
      .from('results')
      .select('*')
      .order('score', { ascending: false })
      .order('created_at', { ascending: false });
    results = data || [];
  } catch {
    results = [];
  }
  renderResults();
  // Sync bookmarks
  try {
    const { data: bmData } = await supabase.from('bookmarks').select('result_id');
    bookmarks = new Set((bmData || []).map(r => r.result_id));
    renderResults();
  } catch { /* ignore */ }
}

function renderResults() {
  const empty = document.getElementById('dash-empty');
  const wrap = document.getElementById('dash-results');
  const body = document.getElementById('results-body');

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
        <td><div class="score-badge score-${r.score}">${r.score}/5</div></td>
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
    const { data } = await supabase
      .from('bookmarks')
      .select('result_id, results(*)')
      .order('created_at', { ascending: false });
    const list = (data || []).map(b => b.results).filter(Boolean);
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
        <td><div class="score-badge score-${r.score}">${r.score}/5</div></td>
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
    const { data: existing } = await supabase
      .from('bookmarks').select('id').eq('result_id', resultId).single();

    if (existing) {
      await supabase.from('bookmarks').delete().eq('result_id', resultId);
      bookmarks.delete(resultId);
      toast('Bookmark removed');
    } else {
      await supabase.from('bookmarks').insert({ result_id: resultId });
      bookmarks.add(resultId);
      toast('Bookmarked');
    }

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
    await supabase.from('results').delete().eq('id', id);
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
    const { data: r } = await supabase.from('results').select('id');
    const deletedResults = r ? r.length : 0;
    await supabase.from('results').delete().neq('id', 0);
    const { data: s } = await supabase.from('scan_log').select('id');
    const deletedLogs = s ? s.length : 0;
    await supabase.from('scan_log').delete().neq('id', 0);

    results = [];
    bookmarks = new Set();
    const msg = deletedResults > 0
      ? `Cleared ${deletedResults} results and ${deletedLogs} scan logs`
      : 'Database is already empty';
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
  if (window._bookmarkedResults) {
    const bm = window._bookmarkedResults.find(x => x.id === id);
    if (bm) { showDetailForResult(bm); return; }
  }
};

function showDetailForResult(r) {
  document.getElementById('modal-score').innerHTML = `<div class="score-badge score-${r.score}" style="width:56px;height:56px;font-size:20px">${r.score}/5</div>`;
  document.getElementById('modal-title').textContent = r.title;
  document.getElementById('modal-deadline').textContent = r.deadline ? `Deadline: ${r.deadline}` : 'Deadline: Unknown';
  document.getElementById('modal-source').textContent = `Source: ${r.source_feed || '—'}`;
  document.getElementById('modal-link').href = r.link || '#';
  document.getElementById('modal-summary').textContent = r.summary || r.description || 'No summary available.';

  // Parse criteria JSON
  let criteria = {};
  try {
    criteria = typeof r.criteria_json === 'string' ? JSON.parse(r.criteria_json) : (r.criteria_json || {});
  } catch { criteria = {}; }

  const criteriaItems = [
    { label: 'Funding', key: 'funding_type', value: criteria.funding_type },
    { label: 'Country Eligibility', key: 'country_eligibility', value: criteria.country_eligibility },
    { label: 'Reason', key: 'reason', value: criteria.reason },
  ];
  document.getElementById('modal-criteria').innerHTML = criteriaItems.map(c =>
    `<div class="modal-criterion ${c.value ? 'criterion-pass' : 'criterion-fail'}">${c.value ? '✓' : '—'} ${c.label}: ${c.value || 'Not specified'}</div>`
  ).join('');

  document.getElementById('modal-overlay').style.display = '';
}

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

// ===== Scan Button (GitHub Actions info) =====
document.getElementById('btn-run-scan').addEventListener('click', () => {
  const logBody = document.getElementById('scan-log-body');
  const statusEl = document.getElementById('scan-status');
  const loading = document.getElementById('dash-loading');
  const empty = document.getElementById('dash-empty');
  const wrap = document.getElementById('dash-results');

  empty.style.display = 'none';
  wrap.style.display = 'none';
  loading.style.display = '';
  logBody.innerHTML = '';
  statusEl.textContent = '';

  addLogEntry(logBody, { stage: 'notice', label: '⚡ GitHub Actions', detail: 'Scans run daily at 6pm WAT via GitHub Actions' });
  addLogEntry(logBody, { stage: 'notice', label: '🔗 Manual trigger', detail: 'Visit GitHub Actions → "ScholarWatch Daily Scan" → Run workflow' });
  addLogEntry(logBody, { stage: 'notice', label: '⚙️ Configure feeds', detail: 'Edit feeds.json in the GitHub repo to add/remove RSS feeds' });

  setTimeout(() => { loading.style.display = 'none'; empty.style.display = ''; loadStats(); }, 1200);
});

const STAGE_LABELS = {
  start:          '📡 Starting scan',
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

// ===== Feeds Management (read-only from Supabase) =====
async function loadFeeds() {
  try {
    const { data } = await supabase
      .from('feeds')
      .select('*')
      .order('created_at');
    feeds = data || [];
  } catch {
    feeds = [];
  }
  renderFeeds();
}

function renderFeeds() {
  const list = document.getElementById('feeds-list');
  if (feeds.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📡</div>
        <h3>No feeds configured</h3>
        <p>Add feeds by editing <code>feeds.json</code> in the GitHub repo, or insert directly into the feeds table via the Supabase SQL Editor.</p>
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
    </div>
  `).join('');
}

// Hide feed add form (feeds managed via GitHub repo)
document.getElementById('btn-add-feed').addEventListener('click', () => {
  toast('Feeds are managed via feeds.json in the GitHub repo. Edit the file and push.', 'success');
});

// Init
loadResults();
loadStats();
