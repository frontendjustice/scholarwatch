// ScholarWatch — Frontend Application
const API = window.location.origin;

// ===== Helpers =====
function htmlEsc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function formatDate(iso) {
  if (!iso) return '&mdash;';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '&mdash;';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getDeadlineClass(dl) {
  if (!dl) return 'deadline-unknown';
  const d = new Date(dl);
  const now = new Date();
  if (d < now) return 'deadline-expired';
  const diff = (d - now) / 86400000;
  if (diff <= 14) return 'deadline-soon';
  return 'deadline-upcoming';
}

// Score badge SVG (colored circle with number)
function scoreBadgeHTML(score) {
  return '<span class="score-badge score-' + score + '">' + score + '/4</span>';
}

function toast(msg, type) {
  type = type || 'success';
  var el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(function () { el.remove(); }, 3500);
}

// Re-run lucide icons on newly inserted DOM nodes
function refreshIcons() {
  if (window.lucide) lucide.createIcons();
}

// ===== State =====
var results = [];
var feeds = [];
var bookmarks = new Set();

// ===== API =====
async function api(path, opts) {
  opts = opts || {};
  try {
    var res = await fetch(API + path, {
      headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
      method: opts.method || 'GET',
      body: opts.body
    });
    if (!res.ok) {
      var err = await res.json().catch(function () { return { detail: res.statusText }; });
      throw new Error(err.detail || res.statusText);
    }
    return res.json();
  } catch (e) {
    console.error('API ' + path + ':', e);
    throw e;
  }
}

// ===== View Switching =====
document.querySelectorAll('.nav-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var view = btn.dataset.view;
    document.querySelectorAll('.nav-btn').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    document.getElementById('view-' + view).classList.add('active');
    if (view === 'dashboard') loadResults();
    if (view === 'bookmarked') loadBookmarks();
    if (view === 'feeds') loadFeeds();
    if (view === 'feedstats') loadFeedStats();
  });
});

// ===== Hamburger Menu =====
(function () {
  var hamburger = document.getElementById('nav-hamburger');
  var drawer = document.getElementById('nav-drawer');
  var overlay = document.getElementById('nav-overlay');

  function close() {
    hamburger.classList.remove('open');
    drawer.classList.remove('open');
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }
  function open() {
    hamburger.classList.add('open');
    drawer.classList.add('open');
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  hamburger.addEventListener('click', function () {
    if (drawer.classList.contains('open')) close(); else open();
  });
  overlay.addEventListener('click', close);
  drawer.querySelectorAll('.nav-btn').forEach(function (btn) {
    btn.addEventListener('click', close);
  });
})();

// ===== Stats =====
async function loadStats() {
  try {
    var data = await api('/api/stats');
    document.getElementById('stat-feeds').textContent = data.active_feeds || 0;
    document.getElementById('stat-screened').textContent = data.total_screened || 0;
    document.getElementById('stat-accepted').textContent = data.total_accepted || 0;
    document.getElementById('stat-lastrun').textContent = data.last_run || 'Never';
  } catch (e) { /* unavailable */ }
}

// ===== Results =====
async function loadResults() {
  try {
    var data = await api('/api/results');
    results = data.results || [];
    renderResults();
  } catch (e) {
    results = [];
    renderResults();
  }
  // Sync bookmarks
  try {
    var bm = await api('/api/bookmarks');
    bookmarks = new Set((bm.results || []).map(function (r) { return r.id; }));
    renderResults();
  } catch (e) { /* ignore */ }
}

// Build a single result row (table) or card (mobile)
function resultRowHTML(r) {
  var dlClass = getDeadlineClass(r.deadline);
  var dlText = r.deadline || 'Unknown';
  var isBookmarked = bookmarks.has(r.id);
  var starCls = isBookmarked ? 'bookmarked' : '';
  var starIcon = isBookmarked ? 'star' : 'star';
  return {
    table:
      '<tr>' +
        '<td>' + scoreBadgeHTML(r.score) + '</td>' +
        '<td>' +
          '<div class="result-title" onclick="showDetailById(' + r.id + ')">' + htmlEsc(r.title) + '</div>' +
          '<div class="result-source">' + htmlEsc(r.source_feed || '') + '</div>' +
        '</td>' +
        '<td><span class="deadline-badge ' + dlClass + '">' + htmlEsc(dlText) + '</span></td>' +
        '<td class="result-date">' + formatDate(r.created_at) + '</td>' +
        '<td class="result-date">' + htmlEsc(r.source_feed || '&mdash;') + '</td>' +
        '<td><div class="td-actions">' +
          '<a href="' + htmlEsc(r.link) + '" target="_blank" class="btn btn-xs btn-secondary"><i data-lucide="external-link" class="btn-icon"></i> Open</a>' +
          '<button class="btn-bookmark ' + starCls + '" onclick="toggleBookmark(' + r.id + ')" title="Bookmark"><i data-lucide="' + starIcon + '" class="btn-bookmark-icon"></i></button>' +
          '<button class="btn-delete" onclick="deleteResult(' + r.id + ')" title="Delete"><i data-lucide="trash-2" class="btn-bookmark-icon"></i></button>' +
        '</div></td>' +
      '</tr>',
    card:
      '<div class="result-card">' +
        '<div class="result-card-header">' +
          scoreBadgeHTML(r.score) +
          '<div class="result-card-body" style="flex:1">' +
            '<div class="result-title" onclick="showDetailById(' + r.id + ')">' + htmlEsc(r.title) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="result-card-meta">' +
          '<span class="deadline-badge ' + dlClass + '">' + htmlEsc(dlText) + '</span>' +
          '<span>' + formatDate(r.created_at) + '</span>' +
          '<span>' + htmlEsc(r.source_feed || '') + '</span>' +
        '</div>' +
        '<div class="result-card-footer">' +
          '<a href="' + htmlEsc(r.link) + '" target="_blank" class="btn btn-xs btn-secondary"><i data-lucide="external-link" class="btn-icon"></i> Open</a>' +
          '<button class="btn-bookmark ' + starCls + '" onclick="toggleBookmark(' + r.id + ')" title="Bookmark"><i data-lucide="' + starIcon + '" class="btn-bookmark-icon"></i></button>' +
          '<button class="btn-delete" onclick="deleteResult(' + r.id + ')" title="Delete"><i data-lucide="trash-2" class="btn-bookmark-icon"></i></button>' +
        '</div>' +
      '</div>'
  };
}

function renderResults() {
  var empty = document.getElementById('dash-empty');
  var wrap = document.getElementById('dash-results');
  var body = document.getElementById('results-body');
  var cards = document.getElementById('results-cards');
  var countEl = document.getElementById('result-count');

  // Filter
  var scoreFilter = document.getElementById('filter-score').value;
  var deadlineFilter = document.getElementById('filter-deadline').value;
  var search = (document.getElementById('filter-search').value || '').toLowerCase();

  var filtered = results.filter(function (r) {
    if (scoreFilter && String(r.score) !== scoreFilter) return false;
    if (search && !r.title.toLowerCase().includes(search)) return false;
    if (deadlineFilter) {
      var hasDL = !!r.deadline;
      if (deadlineFilter === 'confirmed' && !hasDL) return false;
      if (deadlineFilter === 'unknown' && hasDL) return false;
    }
    return true;
  });

  // Sort
  var sortBy = document.getElementById('sort-by').value;
  if (sortBy === 'recent') {
    filtered.sort(function (a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });
  } else {
    filtered.sort(function (a, b) { return b.score - a.score || (b.created_at || '').localeCompare(a.created_at || ''); });
  }

  if (filtered.length === 0) {
    empty.style.display = '';
    wrap.style.display = 'none';
    countEl.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  wrap.style.display = '';
  countEl.style.display = 'inline';
  countEl.textContent = filtered.length + ' result' + (filtered.length !== 1 ? 's' : '');

  body.innerHTML = filtered.map(function (r) { return resultRowHTML(r).table; }).join('');
  cards.innerHTML = filtered.map(function (r) { return resultRowHTML(r).card; }).join('');
  refreshIcons();
}

// ===== Bookmarks =====
async function loadBookmarks() {
  try {
    var data = await api('/api/bookmarks');
    var list = data.results || [];
    bookmarks = new Set(list.map(function (r) { return r.id; }));
    renderBookmarks(list);
  } catch (e) {
    bookmarks = new Set();
    renderBookmarks([]);
  }
}

function renderBookmarks(bookmarkedResults) {
  window._bookmarkedResults = bookmarkedResults;
  var empty = document.getElementById('bookmarked-empty');
  var wrap = document.getElementById('bookmarked-results');
  var body = document.getElementById('bookmarked-body');
  var cards = document.getElementById('bookmarked-cards');
  var count = document.getElementById('bookmarked-count');

  count.textContent = bookmarkedResults.length + ' saved';

  if (bookmarkedResults.length === 0) {
    empty.style.display = '';
    wrap.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  wrap.style.display = '';

  body.innerHTML = bookmarkedResults.map(function (r) { return resultRowHTML(r).table; }).join('');
  cards.innerHTML = bookmarkedResults.map(function (r) { return resultRowHTML(r).card; }).join('');
  refreshIcons();
}

// ===== Bookmark Toggle =====
async function toggleBookmark(resultId) {
  try {
    var data = await api('/api/bookmarks/toggle', {
      method: 'POST',
      body: JSON.stringify({ result_id: resultId })
    });
    if (data.bookmarked) {
      bookmarks.add(resultId);
      toast('Bookmarked');
    } else {
      bookmarks.delete(resultId);
      toast('Bookmark removed');
    }
    var activeView = document.querySelector('.nav-btn.active').dataset.view;
    if (activeView === 'dashboard') renderResults();
    if (activeView === 'bookmarked') loadBookmarks();
  } catch (e) {
    toast('Bookmark failed: ' + e.message, 'error');
  }
}

// ===== Delete =====
async function deleteResult(id) {
  if (!confirm('Delete this scholarship entry?')) return;
  try {
    await api('/api/results/' + id, { method: 'DELETE' });
    bookmarks.delete(id);
    results = results.filter(function (r) { return r.id !== id; });
    toast('Entry deleted');
    var activeView = document.querySelector('.nav-btn.active').dataset.view;
    if (activeView === 'dashboard') renderResults();
    if (activeView === 'bookmarked') loadBookmarks();
  } catch (e) {
    toast('Delete failed: ' + e.message, 'error');
  }
}

async function clearDatabase() {
  if (!confirm('Clear ALL results and scan logs? This cannot be undone.')) return;
  try {
    var data = await api('/api/clear-db', { method: 'POST' });
    results = [];
    bookmarks = new Set();
    var msg = data.deleted_results > 0
      ? 'Cleared ' + data.deleted_results + ' results and ' + data.deleted_logs + ' scan logs'
      : 'Database is already empty';
    toast(msg);
    var activeView = document.querySelector('.nav-btn.active').dataset.view;
    if (activeView === 'dashboard') renderResults();
    if (activeView === 'bookmarked') loadBookmarks();
    loadStats();
  } catch (e) {
    toast('Clear failed: ' + e.message, 'error');
  }
}

window.toggleBookmark = toggleBookmark;
window.deleteResult = deleteResult;
window.clearDatabase = clearDatabase;

// ===== Detail Modal =====
window.showDetail = function (idx) {
  var r = results[idx];
  if (!r) return;
  showDetailForResult(r);
};

window.showDetailById = function (id) {
  var r = results.find(function (x) { return x.id === id; });
  if (r) { showDetailForResult(r); return; }
  if (window._bookmarkedResults) {
    var bm = window._bookmarkedResults.find(function (x) { return x.id === id; });
    if (bm) { showDetailForResult(bm); return; }
  }
};

function showDetailForResult(r) {
  document.getElementById('modal-score').innerHTML = '<span class="score-badge score-' + r.score + '" style="width:48px;height:48px;font-size:20px">' + r.score + '/4</span>';
  document.getElementById('modal-title').textContent = r.title;
  document.getElementById('modal-deadline').innerHTML = '<i data-lucide="calendar" style="width:14px;height:14px;color:var(--text-muted)"></i> ' + (r.deadline ? 'Deadline: ' + r.deadline : 'Deadline: Unknown');
  document.getElementById('modal-source').innerHTML = '<i data-lucide="globe" style="width:14px;height:14px;color:var(--text-muted)"></i> ' + (r.source_feed || '&mdash;');
  document.getElementById('modal-link').href = r.link || '#';
  document.getElementById('modal-summary').textContent = r.summary || r.description || 'No summary available.';

  var criteria = [
    { label: 'Fully Funded', key: 'fully_funded' },
    { label: 'Open to LMIC / Everyone', key: 'open_eligibility' },
    { label: 'Health-Related / All Courses', key: 'health_related' },
    { label: 'Valid Deadline', key: 'valid_deadline' }
  ];
  document.getElementById('modal-criteria').innerHTML = criteria.map(function (c) {
    var pass = r.criteria && r.criteria[c.key];
    return '<div class="modal-criterion ' + (pass ? 'criterion-pass' : 'criterion-fail') + '"><i data-lucide="' + (pass ? 'check' : 'x') + '" style="width:16px;height:16px;flex-shrink:0"></i> ' + htmlEsc(c.label) + '</div>';
  }).join('');

  document.getElementById('modal-overlay').style.display = '';
  refreshIcons();
}

document.getElementById('modal-close').addEventListener('click', function () {
  document.getElementById('modal-overlay').style.display = 'none';
});
document.getElementById('modal-overlay').addEventListener('click', function (e) {
  if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
});

// ===== Filters =====
['filter-score', 'filter-deadline', 'filter-search', 'sort-by'].forEach(function (id) {
  document.getElementById(id).addEventListener('input', renderResults);
  document.getElementById(id).addEventListener('change', renderResults);
});

// ===== Run Scan (SSE streaming) =====
var STAGE_LABELS = {
  start:          'Starting scan',
  fetch_rss:      'Fetching RSS feeds',
  dedup:          'Deduplicating entries',
  keyword_filter: 'Running keyword filter',
  scrape:         'Scraping full pages',
  ai_triage_start:'Starting AI triage',
  ai_triage_done: 'AI triage complete',
  summaries:      'Generating summaries',
  notice:         'Notice',
  complete:       'Scan finished',
  error:          'Error'
};

function addLogEntry(container, entry) {
  var div = document.createElement('div');
  div.className = 'log-entry log-' + entry.stage;
  div.innerHTML = '<span class="log-label">' + htmlEsc(entry.label) + '</span><span class="log-detail">' + htmlEsc(entry.detail) + '</span>';
  container.appendChild(div);
  container.parentElement.scrollTop = container.parentElement.scrollHeight;
}

var btnRunScan = document.getElementById('btn-run-scan');
if (btnRunScan) {
  btnRunScan.addEventListener('click', async function () {
    var btn = btnRunScan;
    var loading = document.getElementById('dash-loading');
    var empty = document.getElementById('dash-empty');
    var wrap = document.getElementById('dash-results');
    var logBody = document.getElementById('scan-log-body');
    var statusEl = document.getElementById('scan-status');
    var progressEl = document.getElementById('scan-progress-bar');

    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader" class="btn-icon spinner-inline"></i> Scanning...';
    refreshIcons();
    empty.style.display = 'none';
    wrap.style.display = 'none';
    loading.style.display = '';
    logBody.innerHTML = '';
    statusEl.textContent = 'Starting...';
    progressEl.style.display = 'none';

    try {
      var response = await fetch(API + '/api/scan', { method: 'POST' });
      if (!response.ok) {
        var err = await response.json().catch(function () { return { detail: response.statusText }; });
        throw new Error(err.detail || response.statusText);
      }

      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop();

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (!line.startsWith('data: ')) continue;
          try {
            var event = JSON.parse(line.slice(6));
            var stage = event.stage;

            if (stage === 'ai_triage_start') progressEl.style.display = '';
            if (stage === 'ai_triage_done' || stage === 'complete' || stage === 'error') progressEl.style.display = 'none';

            if (stage === 'complete') {
              statusEl.textContent = 'Complete!';
              var r = event.results || event.result || {};
              addLogEntry(logBody, {
                stage: 'complete',
                label: STAGE_LABELS['complete'],
                detail: 'Feeds: ' + (r.feeds_checked || 0) + ' | Found: ' + (r.entries_found || 0) + ' | Accepted: ' + (r.accepted || 0) + ' | Marginal: ' + (r.marginal || 0) + ' | AI Rejected: ' + (r.ai_rejected || 0)
              });
              setTimeout(function () {
                loading.style.display = 'none';
                loadResults();
                loadStats();
                toast('Scan complete: ' + (r.accepted || 0) + ' scholarships found');
              }, 800);
              break;
            }

            if (stage === 'error') {
              statusEl.textContent = 'Error';
              addLogEntry(logBody, { stage: 'error', label: 'Error', detail: event.message });
              break;
            }

            if (stage === 'ai_triage_progress' && event.score === 0 && event.rejected_reason) {
              statusEl.textContent = event.message || stage;
              addLogEntry(logBody, {
                stage: 'ai_triage_progress',
                label: 'AI: ' + htmlEsc(event.title || 'Entry'),
                detail: 'Rejected — ' + htmlEsc(event.rejected_reason)
              });
            } else {
              statusEl.textContent = event.message || stage;
              addLogEntry(logBody, {
                stage: stage,
                label: STAGE_LABELS[stage] || stage,
                detail: event.message || ''
              });
            }
          } catch (e) { /* skip bad lines */ }
        }
      }
    } catch (e) {
      loading.style.display = 'none';
      empty.style.display = '';
      toast('Scan failed: ' + e.message, 'error');
    }

    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="play" class="btn-icon"></i> Run Scan Now';
    refreshIcons();
  });
}

// Also wire up the empty-state "Run First Scan" button
var btnEmptyScan = document.getElementById('btn-empty-scan');
if (btnEmptyScan) {
  btnEmptyScan.addEventListener('click', function () {
    // Switch to dashboard view and trigger scan
    document.querySelector('.nav-btn[data-view="dashboard"]').click();
    setTimeout(function () {
      var scanBtn = document.getElementById('btn-run-scan');
      if (scanBtn && !scanBtn.disabled) scanBtn.click();
    }, 200);
  });
}

document.getElementById('btn-refresh').addEventListener('click', function () {
  loadResults();
  loadStats();
});

// ===== Export =====
function exportCSV() {
  var a = document.createElement('a');
  a.href = '/api/export/csv';
  a.download = 'scholarwatch_export.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  toast('CSV download started');
}

function exportWord() {
  var a = document.createElement('a');
  a.href = '/api/export/docx';
  a.download = 'scholarwatch_export.docx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  toast('Word download started');
}

window.exportCSV = exportCSV;
window.exportWord = exportWord;

// ===== Feeds Management =====
async function loadFeeds() {
  try {
    var data = await api('/api/feeds');
    feeds = data.feeds || [];
    renderFeeds();
  } catch (e) {
    feeds = [];
    renderFeeds();
  }
}

function renderFeeds() {
  var list = document.getElementById('feeds-list');
  if (feeds.length === 0) {
    list.innerHTML =
      '<div class="empty-state">' +
        '<i data-lucide="rss" class="empty-icon"></i>' +
        '<p class="empty-title">No feeds configured</p>' +
        '<p class="empty-hint">Add your first RSS feed URL above to start monitoring.</p>' +
      '</div>';
    refreshIcons();
    return;
  }
  list.innerHTML = feeds.map(function (f) {
    return '<div class="feed-item">' +
      '<div class="feed-status ' + (f.active ? 'active' : 'inactive') + '"></div>' +
      '<div class="feed-info">' +
        '<div class="feed-name">' + htmlEsc(f.name) + '</div>' +
        '<div class="feed-url-text">' + htmlEsc(f.url) + '</div>' +
      '</div>' +
      '<div class="feed-actions">' +
        '<button class="btn btn-xs btn-secondary" onclick="toggleFeed(' + f.id + ')">' +
          '<i data-lucide="' + (f.active ? 'pause' : 'play') + '" class="btn-icon"></i> ' + (f.active ? 'Disable' : 'Enable') +
        '</button>' +
        '<button class="btn btn-xs btn-danger" onclick="deleteFeed(' + f.id + ')"><i data-lucide="trash-2" class="btn-icon"></i> Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');
  refreshIcons();
}

document.getElementById('btn-add-feed').addEventListener('click', async function () {
  var name = document.getElementById('feed-name').value.trim();
  var url = document.getElementById('feed-url').value.trim();
  if (!url) { toast('Please enter a feed URL', 'error'); return; }
  try {
    await api('/api/feeds', {
      method: 'POST',
      body: JSON.stringify({ name: name || url, url: url })
    });
    document.getElementById('feed-name').value = '';
    document.getElementById('feed-url').value = '';
    loadFeeds();
    loadStats();
    toast('Feed added');
  } catch (e) {
    toast('Failed to add feed: ' + e.message, 'error');
  }
});

window.toggleFeed = async function (id) {
  try {
    await api('/api/feeds/' + id + '/toggle', { method: 'POST' });
    loadFeeds();
    loadStats();
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
  }
};

window.deleteFeed = async function (id) {
  try {
    await api('/api/feeds/' + id, { method: 'DELETE' });
    loadFeeds();
    loadStats();
    toast('Feed removed');
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
  }
};

// ===== OPML Import =====
document.getElementById('btn-import-opml').addEventListener('click', function () {
  document.getElementById('opml-file-input').click();
});

document.getElementById('opml-file-input').addEventListener('change', async function (e) {
  var file = e.target.files[0];
  if (!file) return;
  var btn = document.getElementById('btn-import-opml');
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader" class="btn-icon spinner-inline"></i> Importing...';
  refreshIcons();

  try {
    var formData = new FormData();
    formData.append('file', file);
    var res = await fetch(API + '/api/feeds/opml', { method: 'POST', body: formData });
    if (!res.ok) {
      var err = await res.json().catch(function () { return { detail: res.statusText }; });
      throw new Error(err.detail || res.statusText);
    }
    var result = await res.json();
    loadFeeds();
    loadStats();
    toast('Imported ' + result.added + ' feed(s) (' + (result.skipped_duplicates || 0) + ' duplicates skipped)');
  } catch (e) {
    toast('OPML import failed: ' + e.message, 'error');
  }

  btn.disabled = false;
  btn.innerHTML = '<i data-lucide="upload" class="btn-icon"></i> Import OPML';
  refreshIcons();
  e.target.value = '';
});

// ===== Feed Stats =====
async function loadFeedStats() {
  try {
    var data = await api('/api/feed-stats');
    renderFeedStats(data);
  } catch (e) {
    document.getElementById('feedstats-body').innerHTML = '<tr><td colspan="6" class="empty-cell">Failed to load feed stats</td></tr>';
    document.getElementById('feedstats-overall').innerHTML = '';
  }
}

function getFeedTip(rate) {
  if (rate === 0) return 'No data yet';
  if (rate >= 60) return 'Great source';
  if (rate >= 30) return 'Decent — review';
  if (rate >= 10) return 'Low signal';
  return 'Mostly noise';
}

function renderFeedStats(data) {
  var feedsArr = data.feeds;
  var overall = data.overall;
  var overallEl = document.getElementById('feedstats-overall');

  if (overall.total_entries === 0) {
    overallEl.innerHTML = '<p style="color:var(--text-muted);padding:16px 0;">No results yet — run a scan to see per-feed statistics.</p>';
  } else {
    overallEl.innerHTML =
      '<div class="feedstats-summary">' +
        '<div class="feedstat"><span class="feedstat-num">' + overall.active_feeds + '</span><span class="feedstat-label">Active Feeds</span></div>' +
        '<div class="feedstat"><span class="feedstat-num">' + overall.total_entries + '</span><span class="feedstat-label">Total Entries</span></div>' +
        '<div class="feedstat accepted"><span class="feedstat-num">' + overall.total_accepted + '</span><span class="feedstat-label">Accepted (&ge;3)</span></div>' +
        '<div class="feedstat rejected"><span class="feedstat-num">' + overall.total_rejected + '</span><span class="feedstat-label">Rejected (&lt;3)</span></div>' +
        '<div class="feedstat"><span class="feedstat-num">' + overall.overall_acceptance_rate + '%</span><span class="feedstat-label">Acceptance Rate</span></div>' +
      '</div>';
  }

  var body = document.getElementById('feedstats-body');
  if (feedsArr.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty-cell">No feeds configured</td></tr>';
    return;
  }

  body.innerHTML = feedsArr.map(function (f) {
    var rateClass = f.acceptance_rate >= 50 ? 'rate-good' : f.acceptance_rate >= 20 ? 'rate-ok' : 'rate-poor';
    var badge = f.active
      ? '<span class="feed-badge active">Active</span>'
      : '<span class="feed-badge inactive">Paused</span>';
    return '<tr>' +
      '<td><strong>' + htmlEsc(f.name) + '</strong> ' + badge + '</td>' +
      '<td>' + f.total_entries + '</td>' +
      '<td>' + f.accepted + '</td>' +
      '<td>' + f.rejected + '</td>' +
      '<td><span class="rate-badge ' + rateClass + '">' + f.acceptance_rate + '%</span></td>' +
      '<td class="feedstats-tip">' + getFeedTip(f.acceptance_rate) + '</td>' +
    '</tr>';
  }).join('');
}

// ===== Spinner animation for inline buttons =====
var spinnerStyle = document.createElement('style');
spinnerStyle.textContent =
  '.spinner-inline { animation: spin 0.7s linear infinite; }' +
  '@keyframes spin { to { transform: rotate(360deg); } }';
document.head.appendChild(spinnerStyle);

// ===== Init =====
loadStats();
refreshIcons();
