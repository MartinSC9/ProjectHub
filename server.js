const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PROJECTS_FILE = path.join(__dirname, 'projects.json');
const activeProcesses = new Map(); // key: "projectId:serverType" -> process

function loadProjects() {
  return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
}

function saveProjects(data) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2));
}

// Broadcast to all connected clients
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

// API Routes
app.get('/api/projects', (req, res) => {
  res.json(loadProjects());
});

app.put('/api/projects/:id', (req, res) => {
  const data = loadProjects();
  const idx = data.projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.projects[idx] = { ...data.projects[idx], ...req.body };
  saveProjects(data);
  res.json(data.projects[idx]);
});

// Add task
app.post('/api/projects/:id/tasks', (req, res) => {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const newId = project.tasks.length ? Math.max(...project.tasks.map(t => t.id)) + 1 : 1;
  const task = { id: newId, text: req.body.text, status: 'pending' };
  project.tasks.push(task);
  saveProjects(data);
  res.json(task);
});

// Update task
app.put('/api/projects/:id/tasks/:taskId', (req, res) => {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const task = project.tasks.find(t => t.id === parseInt(req.params.taskId));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  Object.assign(task, req.body);
  saveProjects(data);
  res.json(task);
});

// Delete task
app.delete('/api/projects/:id/tasks/:taskId', (req, res) => {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  project.tasks = project.tasks.filter(t => t.id !== parseInt(req.params.taskId));
  saveProjects(data);
  res.json({ ok: true });
});

// Add bug
app.post('/api/projects/:id/bugs', (req, res) => {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const newId = project.bugs.length ? Math.max(...project.bugs.map(b => b.id)) + 1 : 1;
  const bug = { id: newId, text: req.body.text, severity: req.body.severity || 'medium' };
  project.bugs.push(bug);
  saveProjects(data);
  res.json(bug);
});

// Delete bug
app.delete('/api/projects/:id/bugs/:bugId', (req, res) => {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  project.bugs = project.bugs.filter(b => b.id !== parseInt(req.params.bugId));
  saveProjects(data);
  res.json({ ok: true });
});

// Start server process
app.post('/api/projects/:id/start/:serverType', (req, res) => {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const serverConfig = project.servers[req.params.serverType];
  if (!serverConfig) return res.status(404).json({ error: 'Server type not found' });

  const key = `${req.params.id}:${req.params.serverType}`;
  if (activeProcesses.has(key)) {
    return res.status(400).json({ error: 'Already running' });
  }

  const proc = spawn('bash', ['-c', serverConfig.command], {
    cwd: project.path,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  activeProcesses.set(key, proc);

  proc.stdout.on('data', (data) => {
    broadcast({ type: 'server-output', project: req.params.id, serverType: req.params.serverType, data: data.toString() });
  });

  proc.stderr.on('data', (data) => {
    broadcast({ type: 'server-output', project: req.params.id, serverType: req.params.serverType, data: data.toString() });
  });

  proc.on('close', (code) => {
    activeProcesses.delete(key);
    broadcast({ type: 'server-stopped', project: req.params.id, serverType: req.params.serverType, code });
  });

  broadcast({ type: 'server-started', project: req.params.id, serverType: req.params.serverType });
  res.json({ ok: true });
});

// Stop server process
app.post('/api/projects/:id/stop/:serverType', (req, res) => {
  const key = `${req.params.id}:${req.params.serverType}`;
  const proc = activeProcesses.get(key);
  if (!proc) return res.status(400).json({ error: 'Not running' });

  proc.kill('SIGTERM');
  setTimeout(() => {
    if (activeProcesses.has(key)) {
      proc.kill('SIGKILL');
      activeProcesses.delete(key);
    }
  }, 5000);

  res.json({ ok: true });
});

// Get active processes
app.get('/api/active-processes', (req, res) => {
  res.json([...activeProcesses.keys()]);
});

// Run Claude Code prompt on a project
app.post('/api/projects/:id/claude', (req, res) => {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  const sessionId = Date.now().toString();

  // Run claude CLI in non-interactive print mode
  const proc = spawn('claude', ['-p', prompt], {
    cwd: project.path,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true
  });

  broadcast({ type: 'claude-start', project: req.params.id, sessionId, prompt });

  let output = '';

  proc.stdout.on('data', (data) => {
    output += data.toString();
    broadcast({ type: 'claude-output', project: req.params.id, sessionId, data: data.toString() });
  });

  proc.stderr.on('data', (data) => {
    output += data.toString();
    broadcast({ type: 'claude-output', project: req.params.id, sessionId, data: data.toString() });
  });

  proc.on('close', (code) => {
    broadcast({ type: 'claude-done', project: req.params.id, sessionId, code });
  });

  res.json({ sessionId });
});

// Add server config to project
app.post('/api/projects/:id/servers', (req, res) => {
  const data = loadProjects();
  const project = data.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const { type, command, port } = req.body;
  if (!type || !command) return res.status(400).json({ error: 'type and command required' });
  project.servers[type] = { command, port: port || null };
  saveProjects(data);
  res.json(project.servers);
});

const PORT = 4000;
server.listen(PORT, () => {
  console.log(`\n  ProjectHub running at http://localhost:${PORT}\n`);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Puerto ${PORT} ya en uso, asumiendo que otra instancia corre.`);
  }
});
