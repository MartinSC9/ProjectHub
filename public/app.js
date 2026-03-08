const API = '';
let projects = [];
let activeFilter = 'all';
let selectedProject = null;
let activeProcesses = new Set();
let ws;
const claudeHistory = new Map(); // projectId -> [{type, text}]
const terminalLogs = new Map(); // "projectId:serverType" -> string
let favorites = new Set(JSON.parse(localStorage.getItem('favorites') || '[]'));

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
  }
}

async function loadProjects() {
  const res = await fetch(`${API}/api/projects`);
  const data = await res.json();
  projects = data.projects;
  const activeRes = await fetch(`${API}/api/active-processes`);
  const activeList = await activeRes.json();
  activeProcesses = new Set(activeList);
  renderSidebar();
  renderStats();
}

function renderStats() {
  const total = projects.length;
  const inProgress = projects.filter(p => p.status === 'in-progress').length;
  const totalTasks = projects.reduce((s, p) => s + p.tasks.length, 0);
  const totalBugs = projects.reduce((s, p) => s + p.bugs.length, 0);
  document.getElementById('stats').innerHTML = `
    <span>Proyectos:<span class="stat-value">${total}</span></span>
    <span>Activos:<span class="stat-value">${inProgress}</span></span>
    <span>Tareas:<span class="stat-value">${totalTasks}</span></span>
    <span>Bugs:<span class="stat-value">${totalBugs}</span></span>
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

  list.innerHTML = filtered.map(p => `
    <li class="${selectedProject?.id === p.id ? 'active' : ''}" onclick="selectProject('${p.id}')">
      <div style="display:flex;align-items:center;gap:8px">
        <button class="fav-btn ${favorites.has(p.id) ? 'is-fav' : ''}" onclick="toggleFavorite(event,'${p.id}')" title="Favorito">${favorites.has(p.id) ? '\u2605' : '\u2606'}</button>
        <span class="project-name">${p.name}</span>
      </div>
      <span class="status-dot ${p.status}"></span>
    </li>
  `).join('');
}

function selectProject(id) {
  selectedProject = projects.find(p => p.id === id);
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
        <div class="tags">${p.tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>
      </div>
      <div class="status-badge ${p.status}" onclick="cycleStatus('${p.id}')">${statusLabel(p.status)}</div>
    </div>

    <!-- Servers -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">Servidores</span>
        <button class="btn btn-ghost btn-small" onclick="toggleAddServer()">+ Agregar</button>
      </div>
      ${serverEntries.length === 0 ? '<div class="no-items">Sin servidores configurados</div>' : ''}
      ${serverEntries.map(([type, cfg]) => {
        const key = `${p.id}:${type}`;
        const running = activeProcesses.has(key);
        return `
          <div class="server-row">
            <div class="server-info">
              <span class="server-type">${type}</span>
              <span class="server-cmd">${cfg.command}</span>
              ${cfg.port ? `<span class="server-port">:${cfg.port}</span>` : ''}
            </div>
            <div style="display:flex;gap:6px;align-items:center">
              ${running ? `
                <button class="btn btn-small btn-ghost" onclick="showTerminal('${p.id}','${type}')">Ver Log</button>
                <button class="btn btn-small btn-stop" onclick="stopServer('${p.id}','${type}')">Parar</button>
              ` : `
                <button class="btn btn-small btn-start" onclick="startServer('${p.id}','${type}')">Iniciar</button>
              `}
            </div>
          </div>
        `;
      }).join('')}
      <div id="add-server-form" class="hidden">
        <div class="add-server-form">
          <input type="text" id="new-server-type" placeholder="Tipo (frontend, backend, mobile)" style="width:160px" />
          <input type="text" id="new-server-cmd" placeholder="Comando (npm run dev)" style="flex:1" />
          <input type="number" id="new-server-port" placeholder="Puerto" style="width:80px" />
          <button class="btn btn-small btn-accent" onclick="addServer('${p.id}')">Agregar</button>
        </div>
      </div>
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
          <button class="btn-danger" onclick="deleteTask('${p.id}', ${t.id})">&#10005;</button>
        </div>
      `).join('')}
      <div class="add-form">
        <input type="text" id="new-task-${p.id}" placeholder="Nueva tarea..." onkeydown="if(event.key==='Enter')addTask('${p.id}')" />
        <button class="btn btn-small btn-accent" onclick="addTask('${p.id}')">Agregar</button>
      </div>
    </div>

    <!-- Bugs -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">Bugs (${p.bugs.length})</span>
      </div>
      ${p.bugs.map(b => `
        <div class="item-row">
          <span class="severity ${b.severity}">${b.severity}</span>
          <span class="item-text">${b.text}</span>
          <button class="btn-danger" onclick="deleteBug('${p.id}', ${b.id})">&#10005;</button>
        </div>
      `).join('')}
      <div class="add-form">
        <input type="text" id="new-bug-${p.id}" placeholder="Nuevo bug..." onkeydown="if(event.key==='Enter')addBug('${p.id}')" />
        <select id="new-bug-severity-${p.id}" style="padding:8px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:13px;">
          <option value="low">Low</option>
          <option value="medium" selected>Medium</option>
          <option value="high">High</option>
        </select>
        <button class="btn btn-small btn-accent" onclick="addBug('${p.id}')">Agregar</button>
      </div>
    </div>

    <!-- Claude -->
    <div class="section claude-section">
      <div class="section-header">
        <span class="section-title">Claude Code</span>
      </div>
      <div class="claude-input-area">
        <textarea id="claude-prompt-${p.id}" placeholder="Escribí un prompt para Claude... (se ejecuta en la carpeta del proyecto)" rows="3"></textarea>
        <button class="btn btn-accent" onclick="sendClaude('${p.id}')" style="align-self:flex-end">Enviar</button>
      </div>
      <div class="claude-history" id="claude-history-${p.id}"></div>
    </div>
  `;

  renderClaudeHistory();
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
  showTerminal(projectId, serverType);
}

async function stopServer(projectId, serverType) {
  await fetch(`${API}/api/projects/${projectId}/stop/${serverType}`, { method: 'POST' });
}

function showTerminal(projectId, serverType) {
  const panel = document.getElementById('terminal-panel');
  const key = `${projectId}:${serverType}`;
  panel.classList.remove('hidden');
  panel.dataset.key = key;
  document.getElementById('terminal-title').textContent = `${projectId} / ${serverType}`;
  document.getElementById('terminal-output').textContent = terminalLogs.get(key) || '(esperando output...)';
  const el = document.getElementById('terminal-output');
  el.scrollTop = el.scrollHeight;
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

async function sendClaude(projectId) {
  const textarea = document.getElementById(`claude-prompt-${projectId}`);
  const prompt = textarea.value.trim();
  if (!prompt) return;
  textarea.value = '';
  await fetch(`${API}/api/projects/${projectId}/claude`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt })
  });
}

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

document.getElementById('terminal-close').addEventListener('click', () => {
  document.getElementById('terminal-panel').classList.add('hidden');
});

document.getElementById('terminal-clear').addEventListener('click', () => {
  const key = document.getElementById('terminal-panel').dataset.key;
  if (key) terminalLogs.set(key, '');
  document.getElementById('terminal-output').textContent = '';
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

// Init
initTheme();
initWebSocket();
loadProjects();
