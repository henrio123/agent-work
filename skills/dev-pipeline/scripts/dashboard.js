#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] || '18790', 10);
const WORKSPACE_ROOT = path.resolve(os.homedir(), 'dev', 'agent-work');

function safePath(p) {
  const resolved = path.resolve(WORKSPACE_ROOT, p);
  if (!resolved.startsWith(WORKSPACE_ROOT + path.sep) && resolved !== WORKSPACE_ROOT) {
    throw new Error(`Path outside workspace: ${resolved}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------
function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeStatus(s) {
  if (s.project_name && !s.project) { s.project = s.project_name; delete s.project_name; }
  if (s.status && !s.current_stage) { s.current_stage = s.status; delete s.status; }
  if (!s.updated_at) s.updated_at = s.created_at || new Date().toISOString();
  if (Array.isArray(s.required_user_input)) {
    s.required_user_input = s.required_user_input.map((item) =>
      typeof item === 'string'
        ? { id: '', prompt: item, options: null, default: null, status: 'pending', answer: null }
        : item
    );
  } else { s.required_user_input = []; }
  if (!Array.isArray(s.stage_history)) s.stage_history = [];
  if (!Array.isArray(s.next_actions)) s.next_actions = [];
  if (typeof s.blocked !== 'boolean') s.blocked = false;
  if (s.blocked_reason === undefined) s.blocked_reason = null;
  return s;
}

function getAllRuns() {
  const runsDir = safePath('runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name))
    .map((entry) => {
      const statusPath = path.join(runsDir, entry.name, 'status.json');
      if (!fs.existsSync(statusPath)) return null;
      try {
        const s = normalizeStatus(readJSON(statusPath));
        return { folder: entry.name, ...s };
      } catch { return null; }
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------
function renderHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DevPipeline Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e1e4e8; padding: 24px; }
  h1 { font-size: 1.5rem; margin-bottom: 16px; color: #fff; }
  .meta { color: #8b949e; font-size: 0.85rem; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 10px 12px; background: #161b22; border-bottom: 1px solid #30363d; font-size: 0.8rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 10px 12px; border-bottom: 1px solid #21262d; font-size: 0.9rem; vertical-align: top; }
  tr:hover td { background: #161b22; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
  .badge-intake { background: #1f6feb33; color: #58a6ff; }
  .badge-task-pack-generated { background: #8b5cf633; color: #a78bfa; }
  .badge-in-progress { background: #f0883e33; color: #f0883e; }
  .badge-blocked { background: #f8514933; color: #f85149; }
  .badge-review { background: #d29a2833; color: #d29a28; }
  .badge-done { background: #3fb95033; color: #3fb950; }
  .blocked-icon { color: #f85149; margin-left: 4px; }
  details { margin-top: 6px; }
  details summary { cursor: pointer; color: #58a6ff; font-size: 0.8rem; }
  details summary:hover { text-decoration: underline; }
  .detail-section { padding: 8px; background: #0d1117; border: 1px solid #21262d; border-radius: 6px; margin-top: 4px; font-size: 0.8rem; }
  .input-item { margin: 4px 0; padding: 4px 8px; background: #161b22; border-radius: 4px; }
  .input-pending { border-left: 3px solid #f0883e; }
  .input-answered { border-left: 3px solid #3fb950; }
  .history-item { margin: 2px 0; }
  .ts { color: #8b949e; font-size: 0.75rem; }
  .empty { text-align: center; padding: 40px; color: #484f58; }
</style>
</head>
<body>
<h1>DevPipeline Dashboard</h1>
<p class="meta">Auto-refreshes every 5s &middot; <span id="updated"></span></p>
<div id="app"><p class="empty">Loading&hellip;</p></div>
<script>
async function load() {
  try {
    const res = await fetch('/api/runs');
    const runs = await res.json();
    document.getElementById('updated').textContent = 'Updated: ' + new Date().toLocaleTimeString();
    if (!runs.length) {
      document.getElementById('app').innerHTML = '<p class="empty">No runs yet.</p>';
      return;
    }
    let html = '<table><thead><tr><th>Folder</th><th>Ticket</th><th>Title</th><th>Project</th><th>Stage</th><th>Updated</th><th>Details</th></tr></thead><tbody>';
    for (const r of runs) {
      const stage = r.current_stage || 'unknown';
      const cls = 'badge badge-' + stage;
      const blockedMark = r.blocked ? ' <span class="blocked-icon">&#9679; blocked</span>' : '';
      let detailsHtml = '';
      if (r.required_user_input && r.required_user_input.length) {
        detailsHtml += '<details><summary>Inputs (' + r.required_user_input.length + ')</summary><div class="detail-section">';
        for (const inp of r.required_user_input) {
          const cls2 = inp.status === 'answered' ? 'input-answered' : 'input-pending';
          detailsHtml += '<div class="input-item ' + cls2 + '"><strong>' + esc(inp.prompt) + '</strong>';
          if (inp.status === 'answered') detailsHtml += ' &rarr; ' + esc(inp.answer || '');
          else detailsHtml += ' <em>(pending)</em>';
          detailsHtml += '</div>';
        }
        detailsHtml += '</div></details>';
      }
      if (r.stage_history && r.stage_history.length) {
        detailsHtml += '<details><summary>History (' + r.stage_history.length + ')</summary><div class="detail-section">';
        for (const h of r.stage_history) {
          detailsHtml += '<div class="history-item"><span class="badge badge-' + h.stage + '">' + esc(h.stage) + '</span> <span class="ts">' + esc(h.started_at || '') + (h.finished_at ? ' &rarr; ' + esc(h.finished_at) : ' (active)') + '</span></div>';
        }
        detailsHtml += '</div></details>';
      }
      html += '<tr><td><code>' + esc(r.folder) + '</code></td><td>' + esc(r.ticket_id) + '</td><td>' + esc(r.title) + '</td><td>' + esc(r.project) + '</td><td><span class="' + cls + '">' + esc(stage) + '</span>' + blockedMark + '</td><td class="ts">' + esc(r.updated_at || '') + '</td><td>' + detailsHtml + '</td></tr>';
    }
    html += '</tbody></table>';
    document.getElementById('app').innerHTML = html;
  } catch (e) {
    document.getElementById('app').innerHTML = '<p class="empty">Error: ' + e.message + '</p>';
  }
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
load();
setInterval(load, 5000);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHTML());
    return;
  }

  if (url.pathname === '/api/runs') {
    const runs = getAllRuns();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(runs, null, 2));
    return;
  }

  const match = url.pathname.match(/^\/api\/runs\/(.+)$/);
  if (match) {
    const folder = decodeURIComponent(match[1]);
    try {
      const runsDir = safePath('runs');
      const statusPath = path.join(runsDir, folder, 'status.json');
      if (!fs.existsSync(statusPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Run not found' }));
        return;
      }
      const s = normalizeStatus(readJSON(statusPath));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(s, null, 2));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`DevPipeline dashboard: http://localhost:${PORT}`);
});
