const API = '';
let projects = [];
let activeFilter = 'all';
let selectedProject = null;
let activeProcesses = new Set();

// Sidebar resizer
document.addEventListener('DOMContentLoaded', () => {
  const sidebar = document.getElementById('sidebar');
  const resizer = document.getElementById('sidebar-resizer');
  if (!resizer || !sidebar) return;

  let isResizing = false;

  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    resizer.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const newWidth = Math.min(600, Math.max(200, e.clientX));
    sidebar.style.width = newWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    resizer.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
});
let ws;
const claudeHistory = new Map(); // projectId -> [{type, text}]
const terminalLogs = new Map(); // "projectId:serverType" -> string
const analyzeResults = new Map(); // projectId -> {text, running}
const featureResults = new Map(); // projectId -> [{feature, text, running}]
let favorites = new Set(JSON.parse(localStorage.getItem('favorites') || '[]'));

function findProjectById(id) {
  for (const p of projects) {
    if (p.id === id) return p;
    if (p.subprojects) {
      const sub = p.subprojects.find(s => s.id === id);
      if (sub) return sub;
    }
  }
  return null;
}

function initWebSocket() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleWsMessage(msg);
  };
  ws.onclose = () => setTimeout(initWebSocket, 2000);
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'server-started':
      activeProcesses.add(`${msg.project}:${msg.serverType}`);
      renderProjectDetail();
      break;
    case 'server-stopped':
      activeProcesses.delete(`${msg.project}:${msg.serverType}`);
      renderProjectDetail();
      break;
    case 'server-output': {
      const key = `${msg.project}:${msg.serverType}`;
      const prev = terminalLogs.get(key) || '';
      terminalLogs.set(key, prev + msg.data);
      if (document.getElementById('terminal-panel').dataset.key === key) {
        const el = document.getElementById('terminal-output');
        el.textContent = terminalLogs.get(key);
        el.scrollTop = el.scrollHeight;
      }
      break;
    }
    case 'claude-start': {
      const hist = claudeHistory.get(msg.project) || [];
      hist.push({ type: 'prompt', text: msg.prompt, sessionId: msg.sessionId });
      hist.push({ type: 'response', text: '', sessionId: msg.sessionId, running: true });
      claudeHistory.set(msg.project, hist);
      if (selectedProject?.id === msg.project) renderClaudeHistory();
      break;
    }
    case 'claude-output': {
      const hist = claudeHistory.get(msg.project) || [];
      const last = hist.findLast(h => h.sessionId === msg.sessionId && h.type === 'response');
      if (last) last.text += msg.data;
      if (selectedProject?.id === msg.project) renderClaudeHistory();
      break;
    }
    case 'claude-done': {
      const hist = claudeHistory.get(msg.project) || [];
      const last = hist.findLast(h => h.sessionId === msg.sessionId && h.type === 'response');
      if (last) last.running = false;
      if (selectedProject?.id === msg.project) renderClaudeHistory();
      break;
    }
    case 'analyze-start': {
      analyzeResults.set(msg.sessionId, { project: msg.project, text: '', running: true, categories: msg.categories });
      if (selectedProject?.id === msg.project) renderAnalyzeResults();
      break;
    }
    case 'analyze-output': {
      const r = analyzeResults.get(msg.sessionId);
      if (r) r.text += msg.data;
      if (selectedProject?.id === msg.project) renderAnalyzeResults();
      break;
    }
    case 'analyze-done': {
      const r = analyzeResults.get(msg.sessionId);
      if (r) r.running = false;
      if (selectedProject?.id === msg.project) renderAnalyzeResults();
      break;
    }
    case 'feature-start': {
      const list = featureResults.get(msg.project) || [];
      list.push({ sessionId: msg.sessionId, feature: msg.feature, text: '', running: true });
      featureResults.set(msg.project, list);
      if (selectedProject?.id === msg.project) renderFeatureResults();
      break;
    }
    case 'feature-output': {
      const list = featureResults.get(msg.project) || [];
      const item = list.findLast(f => f.sessionId === msg.sessionId);
      if (item) item.text += msg.data;
      if (selectedProject?.id === msg.project) renderFeatureResults();
      break;
    }
    case 'feature-done': {
      const list = featureResults.get(msg.project) || [];
      const item = list.findLast(f => f.sessionId === msg.sessionId);
      if (item) item.running = false;
      if (selectedProject?.id === msg.project) renderFeatureResults();
      break;
    }
    case 'deploy-start': {
      const el = document.getElementById(`deploy-status-${msg.project}`);
      if (el) { el.classList.remove('hidden'); el.innerHTML = '<span class="deploy-loading">Subiendo...</span>'; }
      const btn = document.getElementById(`deploy-btn-${msg.project}`);
      if (btn) { btn.disabled = true; btn.textContent = 'Subiendo...'; }
      break;
    }
    case 'deploy-output': {
      const el = document.getElementById(`deploy-status-${msg.project}`);
      if (el) el.innerHTML += `<pre class="deploy-log">${msg.data}</pre>`;
      break;
    }
    case 'deploy-done': {
      const el = document.getElementById(`deploy-status-${msg.project}`);
      if (el) {
        el.innerHTML += msg.success
          ? `<div class="deploy-success">Subido: "${msg.commitMsg}"</div>`
          : `<div class="deploy-error">Error al subir</div>`;
      }
      const btn = document.getElementById(`deploy-btn-${msg.project}`);
      if (btn) { btn.disabled = false; btn.textContent = 'Subir a prod'; }
      break;
    }
  }
}

async function loadProjects() {
  const res = await fetch(`${API}/api/projects`);
  const data = await res.json();
  projects = data.projects;
  const activeRes = await fetch(`${API}/api/active-processes`);
  const activeList = await activeRes.json();
  activeProcesses = new Set(activeList);

  // Refresh selectedProject with updated data
  if (selectedProject) {
    const updated = findProjectById(selectedProject.id);
    if (updated) {
      selectedProject = updated;
      renderProjectDetail();
    }
  }

  renderSidebar();
  renderStats();
}

function renderStats() {
  const total = projects.length;
  const totalTasks = projects.reduce((s, p) => s + p.tasks.length, 0);
  document.getElementById('stats').innerHTML = `
    <span>Proyectos:<span class="stat-value">${total}</span></span>
    <span>Tareas pendientes:<span class="stat-value">${totalTasks}</span></span>
  `;
}

function toggleFavorite(e, id) {
  e.stopPropagation();
  if (favorites.has(id)) favorites.delete(id);
  else favorites.add(id);
  localStorage.setItem('favorites', JSON.stringify([...favorites]));
  renderSidebar();
  if (selectedProject?.id === id) renderProjectDetail();
}

function showProjectContext(e, id) {
  e.preventDefault();
  e.stopPropagation();
  const old = document.getElementById('project-context-menu');
  if (old) old.remove();

  const isFav = favorites.has(id);
  const menu = document.createElement('div');
  menu.id = 'project-context-menu';
  menu.className = 'context-menu';
  menu.innerHTML = `
    <button onclick="contextToggleFav('${id}')">${isFav ? '\u2605 Quitar de favoritos' : '\u2606 Agregar a favoritos'}</button>
  `;
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  document.body.appendChild(menu);

  setTimeout(() => {
    document.addEventListener('click', removeContextMenu, { once: true });
  }, 0);
}

function removeContextMenu() {
  const m = document.getElementById('project-context-menu');
  if (m) m.remove();
}

function contextToggleFav(id) {
  removeContextMenu();
  if (favorites.has(id)) favorites.delete(id);
  else favorites.add(id);
  localStorage.setItem('favorites', JSON.stringify([...favorites]));
  renderSidebar();
  if (selectedProject?.id === id) renderProjectDetail();
}

async function deployProject(id) {
  // First check git info
  const btn = document.getElementById(`deploy-btn-${id}`);
  const statusEl = document.getElementById(`deploy-status-${id}`);

  try {
    const infoRes = await fetch(`${API}/api/projects/${id}/git-info`);
    const info = await infoRes.json();

    if (!info.isRepo) {
      if (statusEl) { statusEl.classList.remove('hidden'); statusEl.innerHTML = '<div class="deploy-error">No es un repositorio git</div>'; }
      return;
    }

    if (!info.remote) {
      if (statusEl) { statusEl.classList.remove('hidden'); statusEl.innerHTML = '<div class="deploy-error">No tiene remote configurado</div>'; }
      return;
    }

    if (!info.hasChanges) {
      if (statusEl) { statusEl.classList.remove('hidden'); statusEl.innerHTML = '<div class="deploy-info">Sin cambios para subir</div>'; }
      return;
    }

    // Show confirmation with info
    const confirmHtml = `
      <div class="deploy-confirm">
        <div class="deploy-info-row"><strong>Repo:</strong> ${info.remote}</div>
        <div class="deploy-info-row"><strong>Branch:</strong> ${info.branch}</div>
        <div class="deploy-info-row"><strong>Cambios:</strong> ${info.modifiedCount} modificados, ${info.untrackedCount} nuevos</div>
        <div class="deploy-files">${info.statusLines.map(l => `<div class="deploy-file-line">${l}</div>`).join('')}</div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-small btn-start" onclick="confirmDeploy('${id}')">Confirmar push</button>
          <button class="btn btn-small btn-ghost" onclick="cancelDeploy('${id}')">Cancelar</button>
        </div>
      </div>
    `;
    if (statusEl) { statusEl.classList.remove('hidden'); statusEl.innerHTML = confirmHtml; }
  } catch (e) {
    if (statusEl) { statusEl.classList.remove('hidden'); statusEl.innerHTML = `<div class="deploy-error">${e.message}</div>`; }
  }
}

async function confirmDeploy(id) {
  try {
    await fetch(`${API}/api/projects/${id}/deploy`, { method: 'POST' });
  } catch (e) {
    const statusEl = document.getElementById(`deploy-status-${id}`);
    if (statusEl) statusEl.innerHTML = `<div class="deploy-error">${e.message}</div>`;
  }
}

function cancelDeploy(id) {
  const statusEl = document.getElementById(`deploy-status-${id}`);
  if (statusEl) { statusEl.classList.add('hidden'); statusEl.innerHTML = ''; }
}

function renderSidebar() {
  const search = document.getElementById('search').value.toLowerCase();
  const list = document.getElementById('project-list');
  const filtered = projects.filter(p => {
    const matchSearch = p.name.toLowerCase().includes(search);
    const matchFilter = activeFilter === 'all' || p.status === activeFilter || (activeFilter === 'favorites' && favorites.has(p.id));
    return matchSearch && matchFilter;
  });

  // Favoritos primero
  filtered.sort((a, b) => {
    const aFav = favorites.has(a.id) ? 0 : 1;
    const bFav = favorites.has(b.id) ? 0 : 1;
    return aFav - bFav;
  });

  const expandedGroups = window._expandedGroups || (window._expandedGroups = new Set());

  list.innerHTML = filtered.map(p => {
    const hasSubs = p.subprojects && p.subprojects.length > 0;
    const isExpanded = expandedGroups.has(p.id);

    let html = `
    <li class="${selectedProject?.id === p.id ? 'active' : ''}" onclick="selectProject('${p.id}')" oncontextmenu="showProjectContext(event,'${p.id}')">
      <div style="display:flex;align-items:center;gap:8px">
        ${hasSubs ? `<button class="expand-btn ${isExpanded ? 'expanded' : ''}" onclick="toggleExpand(event,'${p.id}')">\u25B6</button>` : ''}
        <button class="fav-btn ${favorites.has(p.id) ? 'is-fav' : ''}" onclick="toggleFavorite(event,'${p.id}')" title="Favorito">${favorites.has(p.id) ? '\u2605' : '\u2606'}</button>
        <span class="project-name">${p.name}</span>
      </div>
    </li>`;

    if (hasSubs && isExpanded) {
      html += p.subprojects.map(sub => `
        <li class="subproject ${selectedProject?.id === sub.id ? 'active' : ''}" onclick="selectSubproject('${p.id}','${sub.id}')" oncontextmenu="showProjectContext(event,'${sub.id}')">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="project-name">${sub.name}</span>
          </div>
        </li>
      `).join('');
    }

    return html;
  }).join('');
}

function toggleExpand(e, id) {
  e.stopPropagation();
  const expanded = window._expandedGroups || (window._expandedGroups = new Set());
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  renderSidebar();
}

function selectProject(id) {
  selectedProject = projects.find(p => p.id === id);
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('project-detail').classList.remove('hidden');
  renderSidebar();
  renderProjectDetail();
}

function selectSubproject(parentId, subId) {
  const parent = projects.find(p => p.id === parentId);
  if (!parent || !parent.subprojects) return;
  selectedProject = parent.subprojects.find(s => s.id === subId);
  if (!selectedProject) return;
  selectedProject._parentId = parentId;
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('project-detail').classList.remove('hidden');
  renderSidebar();
  renderProjectDetail();
}

function renderProjectDetail() {
  if (!selectedProject) return;
  const p = selectedProject;
  const detail = document.getElementById('project-detail');

  const serverEntries = Object.entries(p.servers || {});

  detail.innerHTML = `
    <div class="project-header">
      <div>
        <h2><button class="fav-btn-lg ${favorites.has(p.id) ? 'is-fav' : ''}" onclick="toggleFavorite(event,'${p.id}')">${favorites.has(p.id) ? '\u2605' : '\u2606'}</button> ${p.name}</h2>
        <div class="project-path">${p.path}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-deploy" id="deploy-btn-${p.id}" onclick="deployProject('${p.id}')">Subir a prod</button>
      </div>
    </div>
    <div id="deploy-status-${p.id}" class="deploy-status hidden"></div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      ${serverEntries.length > 0
        ? serverEntries.map(([type, cfg]) => `
          <button class="btn-start-server" onclick="startServer('${p.id}','${type}')">
            <span class="start-icon">&#9654;</span>
            ${serverEntries.length > 1 ? `<span>${type}</span>` : '<span>Iniciar</span>'}
          </button>
        `).join('')
        : `<button class="btn btn-ghost btn-small" onclick="detectServer('${p.id}')">Detectar servidor</button>`
      }
    </div>

    <!-- Tasks -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">Tareas (${p.tasks.length})</span>
      </div>
      ${p.tasks.map(t => `
        <div class="item-row">
          <input type="checkbox" class="item-checkbox" ${t.status === 'done' ? 'checked' : ''} onchange="toggleTask('${p.id}', ${t.id})" />
          <span class="item-text ${t.status === 'done' ? 'done' : ''}">${t.text}</span>
          <div class="item-actions">
            ${t.status !== 'done' ? `<button class="btn-claude-small" onclick="openClaudeItem('${p.id}','task','${t.text.replace(/'/g, "\\'")}')">Claude</button>` : ''}
            <button class="btn-danger" onclick="deleteTask('${p.id}', ${t.id})">&#10005;</button>
          </div>
        </div>
      `).join('')}
      <div class="add-form">
        <input type="text" id="new-task-${p.id}" placeholder="Nueva tarea..." onkeydown="if(event.key==='Enter')addTask('${p.id}')" />
        <button class="btn btn-small btn-accent" onclick="addTask('${p.id}')">Agregar</button>
      </div>
    </div>

    <!-- Claude -->
    <div class="section claude-section">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-accent btn-small" onclick="openClaude('${p.id}')">Abrir Claude Code</button>
        <button class="btn btn-ghost btn-small" onclick="openClaude('${p.id}','analyze')">Analizar</button>
        <button class="btn btn-ghost btn-small" onclick="openClaude('${p.id}','custom')">Prompt custom...</button>
      </div>
    </div>
  `;

  checkServerStatus();
}

// Batch analyze modal
function openBatchAnalyze() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'batch-modal';

  const projectItems = projects.map(p =>
    '<label class="analyze-check batch-project-item">' +
    '<input type="checkbox" class="batch-project-cb" value="' + p.id + '" /> ' +
    p.name + '</label>'
  ).join('');

  overlay.innerHTML =
    '<div class="modal-content">' +
    '<div class="modal-header"><h3>Analizar m\u00FAltiples proyectos</h3>' +
    '<button class="btn-danger" onclick="closeBatchModal()">&times;</button></div>' +
    '<div class="analyze-warning" style="margin-bottom:12px">Cada proyecto seleccionado ejecutar\u00E1 un prompt de Claude Code. M\u00E1s proyectos = m\u00E1s tokens.</div>' +
    '<div class="modal-body">' +
    '<div style="margin-bottom:16px"><strong style="font-size:13px;color:var(--text-secondary)">CATEGOR\u00CDAS</strong>' +
    '<div class="analyze-categories" style="margin-top:8px">' +
    '<label class="analyze-check"><input type="checkbox" id="batch-cat-bugs" checked /> Bugs y errores</label>' +
    '<label class="analyze-check"><input type="checkbox" id="batch-cat-security" /> Seguridad</label>' +
    '<label class="analyze-check"><input type="checkbox" id="batch-cat-optimization" /> Optimizaci\u00F3n</label>' +
    '<label class="analyze-check"><input type="checkbox" id="batch-cat-tasks" /> Tareas pendientes</label>' +
    '</div></div>' +
    '<div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
    '<strong style="font-size:13px;color:var(--text-secondary)">PROYECTOS</strong>' +
    '<label class="analyze-check" style="font-size:12px"><input type="checkbox" id="batch-select-all" onchange="toggleBatchAll()" /> Seleccionar todos</label>' +
    '</div><div class="batch-project-list">' + projectItems + '</div></div></div>' +
    '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">' +
    '<button class="btn btn-small btn-ghost" onclick="closeBatchModal()">Cancelar</button>' +
    '<button class="btn btn-small btn-accent" onclick="runBatchAnalyze()">Analizar seleccionados</button>' +
    '</div></div>';

  document.body.appendChild(overlay);
}

function closeBatchModal() {
  const modal = document.getElementById('batch-modal');
  if (modal) modal.remove();
}

function toggleBatchAll() {
  const checked = document.getElementById('batch-select-all').checked;
  document.querySelectorAll('.batch-project-cb').forEach(cb => cb.checked = checked);
}

async function runBatchAnalyze() {
  const projectIds = [...document.querySelectorAll('.batch-project-cb:checked')].map(cb => cb.value);
  if (!projectIds.length) return;

  const categories = [];
  if (document.getElementById('batch-cat-bugs').checked) categories.push('bugs');
  if (document.getElementById('batch-cat-security').checked) categories.push('security');
  if (document.getElementById('batch-cat-optimization').checked) categories.push('optimization');
  if (document.getElementById('batch-cat-tasks').checked) categories.push('tasks');
  if (!categories.length) return;

  closeBatchModal();

  await fetch(API + '/api/analyze-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectIds, categories })
  });
}

function renderAnalyzeResults() {
  if (!selectedProject) return;
  const container = document.getElementById('analyze-results-' + selectedProject.id);
  if (!container) return;

  const results = [...analyzeResults.values()].filter(r => r.project === selectedProject.id);
  if (!results.length) { container.innerHTML = ''; return; }

  container.innerHTML = results.map(r =>
    '<div class="claude-msg response ' + (r.running ? 'running' : '') + '">' + escapeHtml(r.text) + (r.running ? '\n\u23F3 Analizando...' : '') + '</div>'
  ).join('');
  container.scrollTop = container.scrollHeight;
}

function renderFeatureResults() {
  if (!selectedProject) return;
  const container = document.getElementById('feature-results-' + selectedProject.id);
  if (!container) return;

  const list = featureResults.get(selectedProject.id) || [];
  if (!list.length) { container.innerHTML = ''; return; }

  container.innerHTML = list.map(f =>
    '<div class="claude-msg prompt">' + escapeHtml(f.feature) + '</div>' +
    '<div class="claude-msg response ' + (f.running ? 'running' : '') + '">' + escapeHtml(f.text) + (f.running ? '\n\u23F3 Implementando...' : '') + '</div>'
  ).join('');
  container.scrollTop = container.scrollHeight;
}

function renderClaudeHistory() {
  if (!selectedProject) return;
  const hist = claudeHistory.get(selectedProject.id) || [];
  const container = document.getElementById(`claude-history-${selectedProject.id}`);
  if (!container) return;

  container.innerHTML = hist.map(h => {
    if (h.type === 'prompt') {
      return `<div class="claude-msg prompt">&gt; ${escapeHtml(h.text)}</div>`;
    } else {
      return `<div class="claude-msg response ${h.running ? 'running' : ''}">${escapeHtml(h.text)}${h.running ? '\n⏳ Procesando...' : ''}</div>`;
    }
  }).join('');

  container.scrollTop = container.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function analyzeProject(projectId) {
  const categories = [];
  if (document.getElementById(`cat-bugs-${projectId}`)?.checked) categories.push('bugs');
  if (document.getElementById(`cat-security-${projectId}`)?.checked) categories.push('security');
  if (document.getElementById(`cat-optimization-${projectId}`)?.checked) categories.push('optimization');
  if (document.getElementById(`cat-tasks-${projectId}`)?.checked) categories.push('tasks');
  if (!categories.length) return;

  await fetch(`${API}/api/projects/${projectId}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ categories })
  });
}

async function addFeature(projectId) {
  const textarea = document.getElementById(`feature-prompt-${projectId}`);
  const feature = textarea.value.trim();
  if (!feature) return;
  textarea.value = '';

  await fetch(`${API}/api/projects/${projectId}/add-feature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feature })
  });
}

function statusLabel(s) {
  const labels = { 'in-progress': 'En progreso', 'unknown': 'Sin estado', 'done': 'Terminado', 'paused': 'Pausado' };
  return labels[s] || s;
}

const statusCycle = ['unknown', 'in-progress', 'paused', 'done'];

async function cycleStatus(id) {
  const p = projects.find(p => p.id === id);
  const idx = statusCycle.indexOf(p.status);
  const next = statusCycle[(idx + 1) % statusCycle.length];
  await fetch(`${API}/api/projects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: next })
  });
  p.status = next;
  selectedProject = p;
  renderProjectDetail();
  renderSidebar();
  renderStats();
}

async function addTask(projectId) {
  const input = document.getElementById(`new-task-${projectId}`);
  if (!input.value.trim()) return;
  const res = await fetch(`${API}/api/projects/${projectId}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: input.value.trim() })
  });
  const task = await res.json();
  const p = projects.find(p => p.id === projectId);
  p.tasks.push(task);
  input.value = '';
  renderProjectDetail();
  renderStats();
}

async function toggleTask(projectId, taskId) {
  const p = projects.find(p => p.id === projectId);
  const task = p.tasks.find(t => t.id === taskId);
  const newStatus = task.status === 'done' ? 'pending' : 'done';
  await fetch(`${API}/api/projects/${projectId}/tasks/${taskId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: newStatus })
  });
  task.status = newStatus;
  renderProjectDetail();
}

async function deleteTask(projectId, taskId) {
  await fetch(`${API}/api/projects/${projectId}/tasks/${taskId}`, { method: 'DELETE' });
  const p = projects.find(p => p.id === projectId);
  p.tasks = p.tasks.filter(t => t.id !== taskId);
  renderProjectDetail();
  renderStats();
}

async function addBug(projectId) {
  const input = document.getElementById(`new-bug-${projectId}`);
  const severity = document.getElementById(`new-bug-severity-${projectId}`).value;
  if (!input.value.trim()) return;
  const res = await fetch(`${API}/api/projects/${projectId}/bugs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: input.value.trim(), severity })
  });
  const bug = await res.json();
  const p = projects.find(p => p.id === projectId);
  p.bugs.push(bug);
  input.value = '';
  renderProjectDetail();
  renderStats();
}

async function deleteBug(projectId, bugId) {
  await fetch(`${API}/api/projects/${projectId}/bugs/${bugId}`, { method: 'DELETE' });
  const p = projects.find(p => p.id === projectId);
  p.bugs = p.bugs.filter(b => b.id !== bugId);
  renderProjectDetail();
  renderStats();
}

async function startServer(projectId, serverType) {
  await fetch(`${API}/api/projects/${projectId}/start/${serverType}`, { method: 'POST' });
}

function toggleAddServer() {
  document.getElementById('add-server-form').classList.toggle('hidden');
}

async function addServer(projectId) {
  const type = document.getElementById('new-server-type').value.trim();
  const command = document.getElementById('new-server-cmd').value.trim();
  const port = parseInt(document.getElementById('new-server-port').value) || null;
  if (!type || !command) return;
  await fetch(`${API}/api/projects/${projectId}/servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, command, port })
  });
  const p = projects.find(p => p.id === projectId);
  p.servers[type] = { command, port };
  renderProjectDetail();
}

async function openClaude(projectId, mode) {
  let customPrompt = '';
  if (mode === 'custom') {
    customPrompt = prompt('Prompt para Claude:');
    if (!customPrompt) return;
  }
  await fetch(`${API}/api/projects/${projectId}/open-claude`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: mode || 'free', customPrompt })
  });
}

async function openClaudeItem(projectId, type, text) {
  const label = type === 'task' ? 'Resolvé esta tarea' : 'Corregí este bug';
  await fetch(`${API}/api/projects/${projectId}/open-claude`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'custom', customPrompt: `${label}: ${text}` })
  });
}

async function detectServer(projectId) {
  await fetch(`${API}/api/projects/${projectId}/detect-server`, { method: 'POST' });
  await loadProjects();
}

async function checkServerStatus() {
  if (!selectedProject) return;
  const entries = Object.entries(selectedProject.servers || {});
  if (!entries.length) return;

  const ports = entries.map(([type, cfg]) => ({ id: selectedProject.id, type, port: cfg.port }));
  try {
    const res = await fetch(`${API}/api/check-ports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ports })
    });
    const results = await res.json();
    for (const r of results) {
      const btn = document.getElementById(`srv-${r.id}-${r.type}`);
      if (!btn) continue;
      if (r.active) {
        btn.classList.remove('off');
        btn.classList.add('on');
        btn.querySelector('.power-status').textContent = 'Encendido';
      } else {
        btn.classList.remove('on');
        btn.classList.add('off');
        btn.querySelector('.power-status').textContent = 'Apagado';
      }
    }
  } catch {}
}

// Check server status periodically
setInterval(checkServerStatus, 5000);

// Event listeners
document.getElementById('search').addEventListener('input', renderSidebar);

document.querySelectorAll('.filter').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    renderSidebar();
  });
});

// Theme toggle
function initTheme() {
  const saved = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon(saved);
}

function updateThemeIcon(theme) {
  const btn = document.getElementById('theme-toggle');
  btn.textContent = theme === 'dark' ? '\u2600' : '\u263E';
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcon(next);
});

// Scan projects
async function scanProjects() {
  const btn = document.getElementById('scan-btn');
  const feedback = document.getElementById('scan-feedback');
  btn.disabled = true;
  btn.textContent = 'Escaneando...';
  if (feedback) feedback.textContent = '';

  try {
    const res = await fetch(`${API}/api/scan`, { method: 'POST' });
    const data = await res.json();

    if (data.ok) {
      if (feedback) feedback.textContent = data.message;
      await loadProjects();
      btn.textContent = 'Escanear proyectos';
      btn.disabled = false;
    } else {
      if (feedback) feedback.textContent = 'Error al escanear';
      btn.textContent = 'Escanear proyectos';
      btn.disabled = false;
    }
  } catch (e) {
    if (feedback) feedback.textContent = 'Error al escanear';
    btn.textContent = 'Escanear proyectos';
    btn.disabled = false;
  }
}

// Init
initTheme();
initWebSocket();
loadProjects();
