const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');

// Ensure claude CLI is in PATH (Windows: ~/.local/bin may not be in Electron's PATH)
const localBin = path.join(os.homedir(), '.local', 'bin');
if (!process.env.PATH.includes(localBin)) {
  process.env.PATH = localBin + (process.platform === 'win32' ? ';' : ':') + process.env.PATH;
}

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

function findProject(data, id) {
  for (const p of data.projects) {
    if (p.id === id) return p;
    if (p.subprojects) {
      const sub = p.subprojects.find(s => s.id === id);
      if (sub) return sub;
    }
  }
  return null;
}

// Broadcast to all connected clients
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

// ============ AUTO-SCAN ============

const SCAN_ROOT = 'D:/Files/Projects';
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.expo', '.cache', 'project-hub']);

function scanDirectory(dirPath) {
  try {
    const pkg = readPkg(dirPath);
    const gitInfo = detectGit(dirPath);
    const type = detectProjectType(pkg, dirPath);
    const servers = detectServers(pkg, type);
    const tags = detectTags(pkg, type);
    const description = detectDescription(pkg, type, dirPath);
    const subprojects = detectSubprojects(dirPath);

    return {
      path: dirPath.replace(/\\/g, '/'),
      name: pkg?.name || path.basename(dirPath),
      description,
      tags,
      type,
      servers,
      git: gitInfo,
      subprojects,
      hasPackageJson: !!pkg
    };
  } catch { return null; }
}

function readPkg(dirPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf-8'));
  } catch { return null; }
}

function detectGit(dirPath) {
  try {
    const { execSync } = require('child_process');
    execSync('git rev-parse --is-inside-work-tree', { cwd: dirPath, stdio: 'pipe' });
    let remote = '';
    try { remote = execSync('git remote get-url origin', { cwd: dirPath, stdio: 'pipe' }).toString().trim(); } catch {}
    let branch = '';
    try { branch = execSync('git branch --show-current', { cwd: dirPath, stdio: 'pipe' }).toString().trim(); } catch {}
    return { isRepo: true, remote, branch };
  } catch { return { isRepo: false }; }
}

function detectProjectType(pkg, dirPath) {
  if (!pkg) {
    // Check for static HTML
    try {
      const files = fs.readdirSync(dirPath);
      if (files.includes('index.html')) return 'html-static';
    } catch {}
    return 'unknown';
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps['next']) return 'nextjs';
  if (deps['expo'] || deps['expo-router']) return 'expo';
  if (deps['react-native']) return 'react-native';
  if (deps['vite'] && deps['react']) return 'vite-react';
  if (deps['vite']) return 'vite';
  if (deps['react']) return 'react';
  if (deps['express'] || deps['fastify'] || deps['hapi']) return 'api';
  if (deps['electron']) return 'electron';
  if (pkg.scripts?.start || pkg.scripts?.dev) return 'node';
  return 'unknown';
}

function detectServers(pkg, type) {
  if (type === 'html-static') {
    return { dev: { command: 'npx serve -l 8080', port: 8080 } };
  }
  if (!pkg?.scripts) return {};
  const servers = {};
  const s = pkg.scripts;

  // Detect dev server
  if (s.dev) {
    const port = guessPort(type, s.dev);
    servers.dev = { command: 'npm run dev', port };
  } else if (s.start && type !== 'api') {
    const port = guessPort(type, s.start);
    servers.dev = { command: 'npm run start', port };
  }

  // Detect API server
  if (type === 'api') {
    if (s.dev) {
      servers.api = { command: 'npm run dev', port: guessPort(type, s.dev) };
    } else if (s.start) {
      servers.api = { command: 'npm run start', port: guessPort(type, s.start) };
    }
  }

  // Expo special case
  if (type === 'expo' || type === 'react-native') {
    if (s.start) servers.mobile = { command: 'npx expo start', port: 19000 };
    else if (s.android || s.ios) servers.mobile = { command: 'npx expo start', port: 19000 };
  }

  // Monorepo scripts (e.g., "server:dev", "web:dev")
  for (const [key, val] of Object.entries(s)) {
    if (key.includes(':dev') || key.includes(':start')) {
      const name = key.split(':')[0];
      if (!servers[name]) {
        servers[name] = { command: `npm run ${key}`, port: null };
      }
    }
  }

  return servers;
}

function guessPort(type, cmd) {
  // Try to extract port from command
  const portMatch = cmd?.match(/--port\s+(\d+)|PORT=(\d+)|-p\s+(\d+)|:(\d{4})/);
  if (portMatch) return parseInt(portMatch[1] || portMatch[2] || portMatch[3] || portMatch[4]);
  // Default ports by type
  switch (type) {
    case 'nextjs': return 3000;
    case 'vite-react': case 'vite': return 5173;
    case 'expo': case 'react-native': return 19000;
    case 'react': return 3000;
    case 'api': case 'node': return 3000;
    default: return null;
  }
}

function detectTags(pkg, type) {
  if (!pkg) return type === 'html-static' ? ['html', 'css'] : [];
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const tags = [];

  const tagMap = {
    'next': 'next.js', 'react': 'react', 'react-native': 'react-native',
    'expo': 'expo', 'vue': 'vue', 'svelte': 'svelte', 'vite': 'vite',
    'express': 'express', 'typescript': 'typescript', 'tailwindcss': 'tailwind',
    '@tailwindcss/vite': 'tailwind', 'supabase': 'supabase', '@supabase/supabase-js': 'supabase',
    'prisma': 'prisma', '@prisma/client': 'prisma', 'mongoose': 'mongodb',
    'mysql2': 'mysql', 'pg': 'postgresql', 'socket.io': 'socket.io',
    'zustand': 'zustand', '@tanstack/react-query': 'react-query',
    'framer-motion': 'framer-motion', 'three': 'three.js',
    '@shadcn/ui': 'shadcn', 'electron': 'electron',
    '@mercadopago/sdk-js': 'mercadopago', 'mercadopago': 'mercadopago',
    'jsonwebtoken': 'jwt', 'stripe': 'stripe',
  };

  for (const [dep, tag] of Object.entries(tagMap)) {
    if (deps[dep]) tags.push(tag);
  }

  if (deps['typescript'] || deps['ts-node'] || deps['tsx'] || pkg.devDependencies?.['typescript']) {
    if (!tags.includes('typescript')) tags.push('typescript');
  }

  return [...new Set(tags)];
}

function detectDescription(pkg, type, dirPath) {
  if (pkg?.description && pkg.description !== '') return pkg.description;
  const name = path.basename(dirPath);
  const typeLabels = {
    'nextjs': 'Proyecto Next.js',
    'vite-react': 'Proyecto React + Vite',
    'vite': 'Proyecto Vite',
    'react': 'Proyecto React',
    'expo': 'App React Native + Expo',
    'react-native': 'App React Native',
    'api': 'API/Backend Node.js',
    'electron': 'App de escritorio Electron',
    'html-static': 'Página HTML estática',
    'node': 'Proyecto Node.js',
    'unknown': 'Proyecto'
  };
  return `${typeLabels[type] || 'Proyecto'} - ${name}`;
}

function detectSubprojects(dirPath, depth = 0) {
  if (depth > 3) return [];
  const subs = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name)) continue;
      const subPath = path.join(dirPath, entry.name);
      const subPkg = readPkg(subPath);

      if (subPkg) {
        const subType = detectProjectType(subPkg, subPath);
        subs.push({
          path: subPath.replace(/\\/g, '/'),
          name: subPkg.name || entry.name,
          type: subType,
          tags: detectTags(subPkg, subType),
          servers: detectServers(subPkg, subType)
        });
      } else {
        // Check for index.html (static site) or requirements.txt (Python)
        const files = fs.readdirSync(subPath);
        const hasHtml = files.includes('index.html');
        const hasPython = files.includes('requirements.txt') || files.includes('main.py');

        if (hasHtml && !hasPython) {
          subs.push({
            path: subPath.replace(/\\/g, '/'),
            name: entry.name,
            type: 'html-static',
            tags: ['html', 'css'],
            servers: { dev: { command: 'npx serve -l 8080', port: 8080 } }
          });
        } else if (hasPython) {
          subs.push({
            path: subPath.replace(/\\/g, '/'),
            name: entry.name,
            type: 'python',
            tags: ['python'],
            servers: {}
          });
        }

        // Recurse deeper
        const deeper = detectSubprojects(subPath, depth + 1);
        subs.push(...deeper);
      }
    }
  } catch {}
  return subs;
}

function makeId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Scan endpoint
app.post('/api/scan', (req, res) => {
  const data = loadProjects();
  const existingMap = new Map();
  // Index existing projects by path for merging
  for (const p of data.projects) {
    existingMap.set(p.path, p);
  }

  const scanned = [];
  let entries;
  try {
    entries = fs.readdirSync(SCAN_ROOT, { withFileTypes: true });
  } catch (e) {
    return res.status(500).json({ error: `No se pudo leer ${SCAN_ROOT}: ${e.message}` });
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name)) continue;
    const fullPath = path.join(SCAN_ROOT, entry.name).replace(/\\/g, '/');

    const info = scanDirectory(fullPath);
    if (!info) continue;

    // Check if project already exists
    const existing = existingMap.get(fullPath);

    if (existing) {
      // Merge: update auto-detected fields, preserve user data
      existing.tags = info.tags.length ? info.tags : existing.tags;
      existing.description = existing.description && existing.description !== `Proyecto - ${entry.name}` ? existing.description : info.description;

      // Always update servers and tags from scan
      if (Object.keys(info.servers).length > 0) {
        existing.servers = info.servers;
      }
      if (info.tags.length > 0) {
        existing.tags = info.tags;
      }

      // Update/add subprojects
      if (info.subprojects.length > 0) {
        const existingSubs = existing.subprojects || [];
        const existingSubPaths = new Set(existingSubs.map(s => s.path));

        for (const sub of info.subprojects) {
          if (!existingSubPaths.has(sub.path)) {
            existingSubs.push({
              id: makeId(existing.id + '-' + path.basename(sub.path)),
              name: sub.name,
              path: sub.path,
              tags: sub.tags,
              status: 'unknown',
              servers: sub.servers,
              tasks: [],
              bugs: []
            });
          } else {
            // Always update existing sub's servers and tags
            const existingSub = existingSubs.find(s => s.path === sub.path);
            if (existingSub) {
              if (Object.keys(sub.servers).length > 0) existingSub.servers = sub.servers;
              if (sub.tags.length > 0) existingSub.tags = sub.tags;
            }
          }
        }
        existing.subprojects = existingSubs;
      }

      scanned.push(existing);
    } else {
      // New project
      const newProject = {
        id: makeId(entry.name),
        name: entry.name,
        path: fullPath,
        description: info.description,
        tags: info.tags,
        status: 'unknown',
        servers: info.servers,
        tasks: [],
        bugs: []
      };

      if (info.subprojects.length > 0) {
        newProject.subprojects = info.subprojects.map(sub => ({
          id: makeId(entry.name + '-' + path.basename(sub.path)),
          name: sub.name,
          path: sub.path,
          tags: sub.tags,
          status: 'unknown',
          servers: sub.servers,
          tasks: [],
          bugs: []
        }));
      }

      scanned.push(newProject);
    }

    existingMap.delete(fullPath);
  }

  // Keep projects that weren't in the scan (maybe external paths)
  for (const [, p] of existingMap) {
    scanned.push(p);
  }

  data.projects = scanned;
  saveProjects(data);

  const newCount = scanned.length - (data.projects?.length || 0);
  res.json({
    ok: true,
    total: scanned.length,
    message: `Escaneo completo: ${scanned.length} proyectos detectados`
  });
});

// API Routes
app.get('/api/projects', (req, res) => {
  res.json(loadProjects());
});

app.put('/api/projects/:id', (req, res) => {
  const data = loadProjects();
  const project = findProject(data, req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  Object.assign(project, req.body);
  saveProjects(data);
  res.json(project);
});

// Add task
app.post('/api/projects/:id/tasks', (req, res) => {
  const data = loadProjects();
  const project = findProject(data, req.params.id);
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
  const project = findProject(data, req.params.id);
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
  const project = findProject(data, req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  project.tasks = project.tasks.filter(t => t.id !== parseInt(req.params.taskId));
  saveProjects(data);
  res.json({ ok: true });
});

// Add bug
app.post('/api/projects/:id/bugs', (req, res) => {
  const data = loadProjects();
  const project = findProject(data, req.params.id);
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
  const project = findProject(data, req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  project.bugs = project.bugs.filter(b => b.id !== parseInt(req.params.bugId));
  saveProjects(data);
  res.json({ ok: true });
});

// Start server process - opens in a new terminal + browser tab
app.post('/api/projects/:id/start/:serverType', (req, res) => {
  const data = loadProjects();
  const project = findProject(data, req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const serverConfig = project.servers[req.params.serverType];
  if (!serverConfig) return res.status(404).json({ error: 'Server type not found' });

  const projectPath = project.path.replace(/\//g, '\\');
  const title = `${project.name} - ${req.params.serverType}`;

  // Write temp .bat that runs the server
  const tmpDir = os.tmpdir();
  const batFile = path.join(tmpDir, `server-${req.params.id}-${req.params.serverType}-${Date.now()}.bat`);
  const batContent = `@echo off\nchcp 65001 >nul\ntitle ${title}\ncd /d "${projectPath}"\necho Iniciando ${title}...\necho.\n${serverConfig.command}\npause\ndel "%~f0"\n`;
  fs.writeFileSync(batFile, batContent, 'utf-8');

  spawn('cmd', ['/c', 'start', '', batFile], { stdio: 'ignore', detached: true });

  // Open browser after a short delay if port is configured
  if (serverConfig.port) {
    setTimeout(() => {
      spawn('cmd', ['/c', 'start', `http://localhost:${serverConfig.port}`], { stdio: 'ignore', detached: true });
    }, 3000);
  }

  res.json({ ok: true });
});

// Stop server process
app.post('/api/projects/:id/stop/:serverType', (req, res) => {
  const key = `${req.params.id}:${req.params.serverType}`;
  const proc = activeProcesses.get(key);
  if (!proc) return res.status(400).json({ error: 'Not running' });

  // On Windows, kill the entire process tree
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t'], { stdio: 'ignore' });
  } else {
    proc.kill('SIGTERM');
  }
  setTimeout(() => {
    if (activeProcesses.has(key)) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t'], { stdio: 'ignore' });
      } else {
        proc.kill('SIGKILL');
      }
      activeProcesses.delete(key);
      broadcast({ type: 'server-stopped', project: req.params.id, serverType: req.params.serverType, code: -1 });
    }
  }, 3000);

  res.json({ ok: true });
});

// Get active processes
app.get('/api/active-processes', (req, res) => {
  res.json([...activeProcesses.keys()]);
});

// Open Claude Code in a new terminal
app.post('/api/projects/:id/open-claude', (req, res) => {
  const data = loadProjects();
  const project = findProject(data, req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const { mode, customPrompt } = req.body;

  // Build prompt based on mode and project data
  let prompt = '';
  if (mode === 'custom' && customPrompt) {
    prompt = customPrompt;
  } else if (mode === 'tasks' && project.tasks?.length) {
    const pending = project.tasks.filter(t => t.status === 'pending').map(t => `- ${t.text}`).join('\n');
    if (pending) prompt = `Tengo estas tareas pendientes para resolver:\n${pending}\n\nAnaliza el proyecto y resolve estas tareas.`;
  } else if (mode === 'bugs' && project.bugs?.length) {
    const bugList = project.bugs.map(b => `- [${b.severity}] ${b.text}`).join('\n');
    if (bugList) prompt = `Tengo estos bugs para corregir:\n${bugList}\n\nAnaliza el proyecto y corregi estos bugs.`;
  } else if (mode === 'analyze') {
    prompt = 'Analiza este proyecto en profundidad. Reporta bugs, problemas de seguridad, optimizaciones posibles y tareas pendientes (TODOs). Responde en espanol, se conciso y accionable.';
  }

  // Write a temp .bat file and run it in a new terminal
  const tmpDir = require('os').tmpdir();
  const batFile = path.join(tmpDir, `claude-${req.params.id}-${Date.now()}.bat`);
  const projectPath = project.path.replace(/\//g, '\\');

  let batContent = `@echo off\nchcp 65001 >nul\ncd /d "${projectPath}"\ntitle Claude - ${project.name}\n`;
  if (prompt) {
    // Write prompt to a temp file, pass as initial message via --prompt-file is not available
    // So we use the trick: pipe as first argument to claude
    const safeLine = prompt.replace(/\r?\n/g, ' ').replace(/"/g, "'");
    batContent += `claude "${safeLine}"\ndel "%~f0"\n`;
  } else {
    batContent += `claude\ndel "%~f0"\n`;
  }

  fs.writeFileSync(batFile, batContent, 'utf-8');
  spawn('cmd', ['/c', 'start', '', batFile], { stdio: 'ignore', detached: true });

  res.json({ ok: true });
});

// Analyze project with AI
app.post('/api/projects/:id/analyze', (req, res) => {
  const data = loadProjects();
  const project = findProject(data, req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const { categories } = req.body; // ['bugs', 'security', 'optimization', 'tasks']
  if (!categories || !categories.length) return res.status(400).json({ error: 'Categories required' });

  const categoryPrompts = {
    bugs: 'Find bugs, errors, and issues in the codebase. Check for TypeScript errors, runtime errors, broken imports, and logic issues.',
    security: 'Analyze the codebase for security vulnerabilities: exposed secrets, SQL injection, XSS, insecure dependencies, missing auth checks, OWASP top 10.',
    optimization: 'Find performance issues and optimization opportunities: large bundles, unnecessary re-renders, missing indexes, N+1 queries, unoptimized images, memory leaks.',
    tasks: 'Identify pending work: TODOs in code, incomplete features, missing tests, placeholder data, hardcoded values that should be configurable, missing error handling.'
  };

  const selectedPrompts = categories.map(c => categoryPrompts[c]).filter(Boolean);
  const prompt = `Analyze this project and give me a concise report in Spanish. For each issue found, give a severity (HIGH/MEDIUM/LOW) and a one-line description. Group by category.\n\nAnalyze the following:\n${selectedPrompts.join('\n')}\n\nKeep the response concise and actionable. No code blocks, just the findings list.`;

  const sessionId = `analyze-${Date.now()}`;

  const proc = spawn('claude', ['-p', prompt], {
    cwd: project.path,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true
  });

  broadcast({ type: 'analyze-start', project: req.params.id, sessionId, categories });

  proc.on('error', (err) => {
    broadcast({ type: 'analyze-output', project: req.params.id, sessionId, data: `Error: ${err.message}\n` });
    broadcast({ type: 'analyze-done', project: req.params.id, sessionId, code: -1 });
  });

  proc.stdout.on('data', (d) => {
    broadcast({ type: 'analyze-output', project: req.params.id, sessionId, data: d.toString() });
  });

  proc.stderr.on('data', (d) => {
    broadcast({ type: 'analyze-output', project: req.params.id, sessionId, data: d.toString() });
  });

  proc.on('close', (code) => {
    broadcast({ type: 'analyze-done', project: req.params.id, sessionId, code });
  });

  res.json({ sessionId });
});

// Analyze multiple projects
app.post('/api/analyze-batch', (req, res) => {
  const data = loadProjects();
  const { projectIds, categories } = req.body;
  if (!projectIds || !projectIds.length || !categories || !categories.length) {
    return res.status(400).json({ error: 'projectIds and categories required' });
  }

  const sessionIds = [];
  for (const id of projectIds) {
    const project = findProject(data, id);
    if (!project) continue;

    const categoryPrompts = {
      bugs: 'Find bugs, errors, and issues.',
      security: 'Find security vulnerabilities.',
      optimization: 'Find performance issues.',
      tasks: 'Identify pending work and TODOs.'
    };

    const selectedPrompts = categories.map(c => categoryPrompts[c]).filter(Boolean);
    const prompt = `Analyze this project briefly in Spanish. For each issue: severity (HIGH/MEDIUM/LOW) + one-line description. Group by category.\n\nAnalyze:\n${selectedPrompts.join('\n')}\n\nBe concise.`;

    const sessionId = `analyze-${id}-${Date.now()}`;
    sessionIds.push({ projectId: id, sessionId });

    const proc = spawn('claude', ['-p', prompt], {
      cwd: project.path,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    });

    broadcast({ type: 'analyze-start', project: id, sessionId, categories });

    proc.stdout.on('data', (d) => {
      broadcast({ type: 'analyze-output', project: id, sessionId, data: d.toString() });
    });

    proc.stderr.on('data', (d) => {
      broadcast({ type: 'analyze-output', project: id, sessionId, data: d.toString() });
    });

    proc.on('close', (code) => {
      broadcast({ type: 'analyze-done', project: id, sessionId, code });
    });
  }

  res.json({ sessionIds });
});

// Add server config to project
app.post('/api/projects/:id/servers', (req, res) => {
  const data = loadProjects();
  const project = findProject(data, req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const { type, command, port } = req.body;
  if (!type || !command) return res.status(400).json({ error: 'type and command required' });
  project.servers[type] = { command, port: port || null };
  saveProjects(data);
  res.json(project.servers);
});

// Auto-detect server for a single project
app.post('/api/projects/:id/detect-server', (req, res) => {
  const data = loadProjects();
  const project = findProject(data, req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const pkg = readPkg(project.path);
  const type = detectProjectType(pkg, project.path);
  const servers = detectServers(pkg, type);
  const tags = detectTags(pkg, type);

  if (Object.keys(servers).length > 0) project.servers = servers;
  if (tags.length > 0) project.tags = tags;

  saveProjects(data);
  res.json({ ok: true, servers: project.servers });
});

// Check if ports are in use
app.post('/api/check-ports', (req, res) => {
  const { ports } = req.body; // [{ id, type, port }]
  if (!ports || !ports.length) return res.json([]);

  const net = require('net');
  let pending = ports.length;
  const results = [];

  ports.forEach(({ id, type, port }) => {
    if (!port) {
      results.push({ id, type, port, active: false });
      if (--pending === 0) res.json(results);
      return;
    }
    const sock = new net.Socket();
    sock.setTimeout(500);
    sock.on('connect', () => {
      results.push({ id, type, port, active: true });
      sock.destroy();
      if (--pending === 0) res.json(results);
    });
    sock.on('timeout', () => {
      results.push({ id, type, port, active: false });
      sock.destroy();
      if (--pending === 0) res.json(results);
    });
    sock.on('error', () => {
      results.push({ id, type, port, active: false });
      if (--pending === 0) res.json(results);
    });
    sock.connect(port, '127.0.0.1');
  });
});

// Git info for a project
app.get('/api/projects/:id/git-info', (req, res) => {
  const data = loadProjects();
  const project = findProject(data, req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const { execSync } = require('child_process');
  const cwd = project.path;

  try {
    // Check if it's a git repo
    execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'pipe' });
  } catch {
    return res.json({ isRepo: false });
  }

  try {
    let remote = '';
    try { remote = execSync('git remote get-url origin', { cwd, stdio: 'pipe' }).toString().trim(); } catch {}

    let branch = '';
    try { branch = execSync('git branch --show-current', { cwd, stdio: 'pipe' }).toString().trim(); } catch {}

    let status = '';
    try { status = execSync('git status --porcelain', { cwd, stdio: 'pipe' }).toString().trim(); } catch {}

    let diff = '';
    try { diff = execSync('git diff --stat', { cwd, stdio: 'pipe' }).toString().trim(); } catch {}

    let untrackedCount = 0;
    let modifiedCount = 0;
    if (status) {
      const lines = status.split('\n').filter(Boolean);
      untrackedCount = lines.filter(l => l.startsWith('??')).length;
      modifiedCount = lines.filter(l => !l.startsWith('??')).length;
    }

    res.json({
      isRepo: true,
      remote,
      branch,
      hasChanges: status.length > 0,
      untrackedCount,
      modifiedCount,
      diff,
      statusLines: status ? status.split('\n').filter(Boolean) : []
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Deploy: add all, commit with AI message, push
app.post('/api/projects/:id/deploy', (req, res) => {
  const data = loadProjects();
  const project = findProject(data, req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const { execSync } = require('child_process');
  const cwd = project.path;
  const sessionId = `deploy-${Date.now()}`;

  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'pipe' });
  } catch {
    return res.status(400).json({ error: 'No es un repositorio git' });
  }

  // Get status to build commit message
  let status = '';
  try { status = execSync('git status --porcelain', { cwd, stdio: 'pipe' }).toString().trim(); } catch {}

  if (!status) {
    return res.status(400).json({ error: 'No hay cambios para subir' });
  }

  // Build a smart commit message from the changes
  const lines = status.split('\n').filter(Boolean);
  const added = lines.filter(l => l.startsWith('??') || l.startsWith('A ')).map(l => l.slice(3).trim());
  const modified = lines.filter(l => l.startsWith(' M') || l.startsWith('M ')).map(l => l.slice(3).trim());
  const deleted = lines.filter(l => l.startsWith(' D') || l.startsWith('D ')).map(l => l.slice(3).trim());
  const renamed = lines.filter(l => l.startsWith('R ')).map(l => l.slice(3).trim());

  let msgParts = [];
  if (added.length) msgParts.push(`add ${summarizeFiles(added)}`);
  if (modified.length) msgParts.push(`update ${summarizeFiles(modified)}`);
  if (deleted.length) msgParts.push(`remove ${summarizeFiles(deleted)}`);
  if (renamed.length) msgParts.push(`rename ${summarizeFiles(renamed)}`);

  const commitMsg = msgParts.length ? msgParts.join(', ') : 'update project files';

  broadcast({ type: 'deploy-start', project: req.params.id, sessionId });

  try {
    execSync('git add -A', { cwd, stdio: 'pipe' });
    broadcast({ type: 'deploy-output', project: req.params.id, sessionId, data: '> git add -A\n' });

    execSync(`git commit -m "${commitMsg}"`, { cwd, stdio: 'pipe' });
    broadcast({ type: 'deploy-output', project: req.params.id, sessionId, data: `> git commit -m "${commitMsg}"\n` });

    const pushOutput = execSync('git push 2>&1', { cwd, stdio: 'pipe' }).toString();
    broadcast({ type: 'deploy-output', project: req.params.id, sessionId, data: `> git push\n${pushOutput}\n` });

    broadcast({ type: 'deploy-done', project: req.params.id, sessionId, success: true, commitMsg });
    res.json({ ok: true, commitMsg, sessionId });
  } catch (e) {
    const errMsg = e.stderr ? e.stderr.toString() : e.message;
    broadcast({ type: 'deploy-output', project: req.params.id, sessionId, data: `Error: ${errMsg}\n` });
    broadcast({ type: 'deploy-done', project: req.params.id, sessionId, success: false });
    res.status(500).json({ error: errMsg });
  }
});

function summarizeFiles(files) {
  if (files.length <= 2) return files.join(', ');
  // Group by directory or extension
  const exts = {};
  files.forEach(f => {
    const ext = f.includes('.') ? f.split('.').pop() : 'files';
    exts[ext] = (exts[ext] || 0) + 1;
  });
  return Object.entries(exts).map(([ext, count]) => `${count} .${ext}`).join(', ');
}

const PORT = 4000;
server.listen(PORT, () => {
  console.log(`\n  ProjectHub running at http://localhost:${PORT}\n`);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Puerto ${PORT} ya en uso, asumiendo que otra instancia corre.`);
  }
});
