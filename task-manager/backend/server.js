// server.js — Enhanced with free AI, database persistence, and better email options
// Install deps:
//   npm i express cors uuid nodemailer web-push dotenv openai sqlite3 chrono-node date-fns-tz axios
// Optional (dev): npm i -D nodemon

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const webpush = require('web-push');
const OpenAI = require('openai');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const axios = require('axios');
const chrono = require('chrono-node');
const { zonedTimeToUtc } = require('date-fns-tz');

// ---- Config ----
const app = express();
const PORT = process.env.PORT || 3001;
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Karachi';
const DEFAULT_NOTIFY_EMAIL = process.env.DEFAULT_NOTIFY_EMAIL || null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'tasks.db');

// AI Provider options: 'openai', 'groq', 'local'
const PARSER_PROVIDER = process.env.PARSER_PROVIDER || 'groq';

// ---- Middleware ----
app.use(cors());
app.use(express.json());

// ---- Database Setup ----
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('🗄️  Connected to SQLite database');
    initDatabase();
  }
});

function initDatabase() {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      due_date TEXT,
      completed INTEGER DEFAULT 0,
      email TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;
  
  db.run(createTableSQL, (err) => {
    if (err) {
      console.error('❌ Failed to create tasks table:', err.message);
    } else {
      console.log('✅ Tasks table ready');
    }
  });
}

// Database helper functions
const dbOperations = {
  getAllTasks: () => {
    return new Promise((resolve, reject) => {
      db.all('SELECT * FROM tasks ORDER BY created_at DESC', (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map(row => ({
          id: row.id,
          title: row.title,
          dueDate: row.due_date,
          completed: Boolean(row.completed),
          email: row.email || undefined,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        })));
      });
    });
  },

  createTask: (task) => {
    return new Promise((resolve, reject) => {
      const sql = `INSERT INTO tasks (id, title, due_date, completed, email) VALUES (?, ?, ?, ?, ?)`;
      db.run(sql, [task.id, task.title, task.dueDate, task.completed ? 1 : 0, task.email], function(err) {
        if (err) reject(err);
        else resolve({ ...task, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      });
    });
  },

  updateTask: (id, updates) => {
    return new Promise((resolve, reject) => {
      const sql = `UPDATE tasks SET title = ?, due_date = ?, completed = ?, email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
      db.run(sql, [updates.title, updates.dueDate, updates.completed ? 1 : 0, updates.email, id], function(err) {
        if (err) reject(err);
        else if (this.changes === 0) reject(new Error('Task not found'));
        else resolve();
      });
    });
  },

  deleteTask: (id) => {
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM tasks WHERE id = ?', [id], function(err) {
        if (err) reject(err);
        else if (this.changes === 0) reject(new Error('Task not found'));
        else resolve();
      });
    });
  },

  getTask: (id) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM tasks WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else if (!row) resolve(null);
        else resolve({
          id: row.id,
          title: row.title,
          dueDate: row.due_date,
          completed: Boolean(row.completed),
          email: row.email || undefined
        });
      });
    });
  }
};

// ---- Storage for reminders and push subscriptions ----
/** Map<taskId, Timeout> */
let reminders = new Map();
/** @type {Array<any>} Web Push subscriptions */
let pushSubscriptions = [];

// ---- Email Configuration (Free Options) ----
let transporter = null;

// Free email service configurations
const emailConfigs = {
  // Gmail (free with app password)
  gmail: {
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_APP_PASSWORD // Use app password, not regular password
    }
  },
  
  
  // Custom SMTP (for services like ProtonMail Bridge, etc.)
  custom: {
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT ? Number(process.env.EMAIL_PORT) : 587,
    secure: process.env.EMAIL_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    }
  }
};

if (process.env.EMAIL_USER && (process.env.EMAIL_PASSWORD || process.env.EMAIL_APP_PASSWORD)) {
  const emailService = process.env.EMAIL_SERVICE || 'gmail';
  const config = emailConfigs[emailService];
  
  if (config) {
    try {
      transporter = nodemailer.createTransport(config);
      transporter.verify().then(() => {
        console.log(`📧 Email transporter ready (${emailService})`);
      }).catch(err => {
        console.warn('⚠️ Email transporter verify failed:', err?.message || err);
      });
    } catch (err) {
      console.warn('⚠️ Failed to create email transporter:', err?.message || err);
    }
  }
} else {
  console.log('ℹ️ Email not configured. Set EMAIL_USER and EMAIL_PASSWORD/EMAIL_APP_PASSWORD to enable');
  console.log('ℹ️ Supported services: gmail, outlook, yahoo, custom');
  console.log('ℹ️ For Gmail/Yahoo, use app passwords instead of regular passwords');
}

// ---- Web Push Setup ----
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:you@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  console.log('🔔 Web Push enabled');
} else {
  console.log('ℹ️ Web Push not configured (set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY to enable)');
}

// ---- AI Providers Setup ----
let openai = null;
if (process.env.OPENAI_API_KEY) {
  try {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log('🤖 OpenAI client initialized');
  } catch (e) {
    console.warn('⚠️ Failed to init OpenAI client:', e?.message || e);
  }
}

// Groq setup (free tier available)
let groqApiKey = process.env.GROQ_API_KEY;
if (groqApiKey) {
  console.log('🚀 Groq API key configured');
} else if (PARSER_PROVIDER === 'groq') {
  console.log('ℹ️ GROQ_API_KEY not set. Get free API key from: https://console.groq.com/');
}

// ---- AI Parsing Functions ----

// Enhanced local parser with better time handling
async function parseInputLocal(input) {
  const out = { title: String(input || '').trim(), dueDate: null };
  
  try {
    // Use chrono with better configuration
    const results = chrono.parse(out.title, new Date(), { 
      forwardDate: true,
      timezone: DEFAULT_TIMEZONE 
    });
    
    if (results.length > 0) {
      const first = results[0];
      const dt = first.start?.date?.();
      if (dt instanceof Date && !isNaN(dt.getTime())) {
        // Convert to UTC for storage
        const utc = zonedTimeToUtc(dt, DEFAULT_TIMEZONE);
        out.dueDate = utc.toISOString();
        
        // Remove the time part from title if it was parsed
        if (first.text) {
          out.title = out.title.replace(first.text, '').trim();
          // Clean up extra spaces
          out.title = out.title.replace(/\s+/g, ' ').trim();
        }
      }
    } else {
      // Enhanced heuristics for relative times
      const lower = out.title.toLowerCase();
      const now = new Date();
      
      // Handle "in X hours/minutes"
      const inTimeMatch = lower.match(/in (\d+) (hour|hours|minute|minutes|min)/);
      if (inTimeMatch) {
        const amount = parseInt(inTimeMatch[1]);
        const unit = inTimeMatch[2];
        const minutes = unit.startsWith('hour') ? amount * 60 : amount;
        const dueTime = new Date(now.getTime() + minutes * 60 * 1000);
        out.dueDate = dueTime.toISOString();
        out.title = out.title.replace(/in \d+ (hour|hours|minute|minutes|min)/i, '').trim();
      }
      // Handle other relative times
      else if (lower.includes('tomorrow')) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0);
        out.dueDate = d.toISOString();
      } else if (lower.includes('today')) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 0, 0);
        out.dueDate = d.toISOString();
      } else if (lower.includes('next week')) {
        const d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        d.setHours(9, 0, 0, 0);
        out.dueDate = d.toISOString();
      }
    }
  } catch (err) {
    console.warn('⚠️ Local parsing error:', err?.message);
  }
  
  return out;
}

// Groq API parser (free alternative to OpenAI)
async function parseInputGroq(input) {
  if (!groqApiKey) {
    console.log('ℹ️ Groq API key not configured, falling back to local parser');
    return parseInputLocal(input);
  }
  
  try {
    const systemPrompt = `You are a task parser. Extract task information from natural language input.
Current time: ${new Date().toISOString()}
Timezone: ${DEFAULT_TIMEZONE}

Return ONLY valid JSON with these keys:
- title: string (the cleaned task description)
- dueDate: string in ISO format or null

Examples:
"Call mom in 2 hours" → {"title": "Call mom", "dueDate": "2024-01-15T14:00:00.000Z"}
"Meeting tomorrow at 3pm" → {"title": "Meeting", "dueDate": "2024-01-16T15:00:00.000Z"}
"Buy groceries" → {"title": "Buy groceries", "dueDate": null}`;

    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'meta-llama/llama-4-maverick-17b-128e-instruct', // Free model
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: input }
      ],
    }, {
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      }
    });

    const content = response.data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('Empty response from Groq');

    // Extract JSON from response (in case there's extra text)
    const jsonMatch = content.match(/\{.*\}/s);
    const jsonStr = jsonMatch ? jsonMatch[0] : content;
    
    const parsed = JSON.parse(jsonStr);
    
    // Validate and normalize
    const title = (typeof parsed.title === 'string' && parsed.title.trim()) 
      ? parsed.title.trim() 
      : String(input || '').trim();
    
    let dueDate = null;
    if (parsed.dueDate) {
      const d = new Date(parsed.dueDate);
      if (!isNaN(d.getTime())) {
        dueDate = d.toISOString();
      }
    }
    
    return { title, dueDate };
    
  } catch (err) {
    console.warn('⚠️ Groq parsing failed, using local fallback:', err?.response?.status || err?.message || err);
    return parseInputLocal(input);
  }
}

// OpenAI parser (existing logic)
async function parseInputOpenAI(input) {
  if (!openai) {
    return parseInputGroq(input); // Fall back to Groq if available
  }
  
  try {
    const systemPrompt = `You are a task parser. Extract task information and due dates from natural language.
Current time: ${new Date().toISOString()}
Timezone: ${DEFAULT_TIMEZONE}

Return ONLY valid JSON: {"title": "...", "dueDate": "ISO string or null"}

Handle relative times like "in 1 hour", "tomorrow at 3pm", "next Friday", etc.`;

    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: input }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const content = resp.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('Empty completion');

    const parsed = JSON.parse(content);
    
    const title = (typeof parsed.title === 'string' && parsed.title.trim()) 
      ? parsed.title.trim() 
      : String(input || '').trim();
    
    let dueDate = null;
    if (parsed.dueDate) {
      const d = new Date(parsed.dueDate);
      if (!isNaN(d.getTime())) dueDate = d.toISOString();
    }
    
    return { title, dueDate };
  } catch (err) {
    console.warn('⚠️ OpenAI parse failed, using Groq fallback:', err?.status || err?.message || err);
    return parseInputGroq(input);
  }
}

// Main parsing function with provider selection
async function parseInput(input) {
  switch (PARSER_PROVIDER) {
    case 'openai':
      return parseInputOpenAI(input);
    case 'groq':
      return parseInputGroq(input);
    case 'local':
      return parseInputLocal(input);
    default:
      // Default cascade: try Groq first, then local
      if (groqApiKey) {
        return parseInputGroq(input);
      } else {
        return parseInputLocal(input);
      }
  }
}

// ---- Reminder Functions ----
function scheduleReminder(task, replace = false) {
  if (!task || !task.dueDate || task.completed) return;

  const now = new Date();
  const due = new Date(task.dueDate);
  if (isNaN(due.getTime())) {
    console.warn(`⚠️ Invalid dueDate for task ${task.id}:`, task.dueDate);
    return;
  }

  if (replace) cancelReminder(task.id);

  // Target time is 1 hour before due
  const target = new Date(due.getTime() - 60 * 60 * 1000);
  let delayMs = target.getTime() - now.getTime();

  // If within next hour, send shortly
  if (due > now && delayMs <= 0) {
    delayMs = 5 * 1000; // 5s
  }

  // Skip if overdue
  if (due <= now) {
    console.log(`⏰ Skipping reminder for overdue task "${task.title}" (${task.id})`);
    return;
  }

  // Clamp to max setTimeout
  const MAX_DELAY = 2 ** 31 - 1;
  delayMs = Math.min(delayMs, MAX_DELAY);

  const timeoutId = setTimeout(async () => {
    try {
      await sendReminder(task, due);
    } catch (err) {
      console.error('❌ sendReminder error:', err?.message || err);
    } finally {
      reminders.delete(task.id);
    }
  }, Math.max(0, delayMs));

  reminders.set(task.id, timeoutId);
  console.log(`⏰ Reminder scheduled for "${task.title}" in ${Math.round(delayMs / 1000)}s`);
}

function cancelReminder(taskId) {
  const existing = reminders.get(taskId);
  if (existing) {
    clearTimeout(existing);
    reminders.delete(taskId);
    console.log(`🗑️ Cancelled reminder for task ${taskId}`);
  }
}

async function sendReminder(task, due) {
  const humanDue = due.toLocaleString('en-US', { 
    hour: 'numeric', 
    minute: '2-digit', 
    day: '2-digit', 
    month: 'short', 
    year: 'numeric',
    timeZone: DEFAULT_TIMEZONE
  });
  
  console.log(`🔔 Reminder: "${task.title}" is due in 1 hour at ${humanDue}`);

  // Email notification
  const toEmail = task.email || DEFAULT_NOTIFY_EMAIL;
  if (transporter && toEmail) {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
        to: toEmail,
        subject: `📋 Task Reminder: ${task.title}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">⏰ Task Reminder</h2>
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin: 0; color: #555;">"${task.title}"</h3>
              <p style="margin: 10px 0 0 0; color: #666;">Due in 1 hour at ${humanDue}</p>
            </div>
            <p style="color: #888; font-size: 12px;">
              This reminder was sent from your task manager. 
            </p>
          </div>
        `,
        text: `Task Reminder: "${task.title}" is due in 1 hour at ${humanDue}.`
      });
      console.log(`📧 Email sent to ${toEmail}`);
    } catch (err) {
      console.warn('⚠️ Email send failed:', err?.message || err);
    }
  }

  // Web Push notification
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && pushSubscriptions.length) {
    const payload = JSON.stringify({
      title: '📋 Task Reminder',
      body: `"${task.title}" is due in 1 hour (${humanDue})`,
      data: { taskId: task.id },
      icon: '/icon-192x192.png',
      badge: '/badge-72x72.png'
    });
    
    for (const sub of [...pushSubscriptions]) {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        console.warn('⚠️ Push send failed; pruning subscription:', err?.statusCode || err?.message || err);
        pushSubscriptions = pushSubscriptions.filter(s => s !== sub);
      }
    }
  }
}

// ---- Routes ----

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const tasks = await dbOperations.getAllTasks();
    res.json({
      status: 'OK',
      tasks: tasks.length,
      reminders: reminders.size,
      uptime: process.uptime(),
      database: 'connected',
      aiProvider: PARSER_PROVIDER,
      emailConfigured: !!transporter,
      pushConfigured: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
    });
  } catch (err) {
    res.status(500).json({ 
      status: 'ERROR', 
      error: err.message,
      database: 'error' 
    });
  }
});

// Save push subscription
app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  
  const exists = pushSubscriptions.find(s => s.endpoint === sub.endpoint);
  if (!exists) {
    pushSubscriptions.push(sub);
    console.log('🔔 New push subscription added');
  }
  res.json({ ok: true });
});

// List all tasks
app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await dbOperations.getAllTasks();
    res.json(tasks);
  } catch (err) {
    console.error('GET /api/tasks error:', err);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// Create task
app.post('/api/tasks', async (req, res) => {
  try {
    let { title, dueDate, email, input } = req.body || {};
    
    // Parse natural language input if provided
    if (!title && input) {
      const parsed = await parseInput(input);
      title = parsed.title;
      dueDate = parsed.dueDate || null;
    }
    
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'title or input is required' });
    }

    const task = {
      id: uuidv4(),
      title: title.trim(),
      dueDate: dueDate || null,
      completed: false,
      email: email || undefined
    };

    const savedTask = await dbOperations.createTask(task);
    scheduleReminder(savedTask);
    
    res.json(savedTask);
  } catch (err) {
    console.error('POST /api/tasks error:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// Update task
app.put('/api/tasks/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const existingTask = await dbOperations.getTask(id);
    
    if (!existingTask) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const { title, dueDate, completed, email, input } = req.body || {};

    let nextTitle = title;
    let nextDue = dueDate;
    
    // Parse natural language input if provided
    if (input && !title && dueDate === undefined) {
      const parsed = await parseInput(input);
      nextTitle = parsed.title;
      nextDue = parsed.dueDate;
    }

    const updates = {
      title: nextTitle !== undefined ? nextTitle.trim() : existingTask.title,
      dueDate: nextDue !== undefined ? nextDue : existingTask.dueDate,
      completed: typeof completed === 'boolean' ? completed : existingTask.completed,
      email: email !== undefined ? email : existingTask.email
    };

    await dbOperations.updateTask(id, updates);
    const updatedTask = { ...existingTask, ...updates };
    
    // Re-schedule reminder
    scheduleReminder(updatedTask, true);
    
    res.json(updatedTask);
  } catch (err) {
    console.error('PUT /api/tasks/:id error:', err);
    if (err.message === 'Task not found') {
      res.status(404).json({ error: 'Task not found' });
    } else {
      res.status(500).json({ error: 'Failed to update task' });
    }
  }
});

// Delete task
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const existingTask = await dbOperations.getTask(id);
    
    if (!existingTask) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    await dbOperations.deleteTask(id);
    cancelReminder(id);
    
    res.json({ ok: true, deleted: existingTask });
  } catch (err) {
    console.error('DELETE /api/tasks/:id error:', err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// Parse input endpoint (for testing AI parsing)
app.post('/api/parse', async (req, res) => {
  try {
    const { input } = req.body || {};
    if (!input) {
      return res.status(400).json({ error: 'input is required' });
    }
    
    const result = await parseInput(input);
    res.json({ 
      input, 
      result, 
      provider: PARSER_PROVIDER,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('POST /api/parse error:', err);
    res.status(500).json({ error: 'Failed to parse input' });
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🔄 Shutting down gracefully...');
  
  // Clear all reminders
  for (const [taskId, timeoutId] of reminders) {
    clearTimeout(timeoutId);
  }
  reminders.clear();
  
  // Close database
  db.close((err) => {
    if (err) {
      console.error('❌ Error closing database:', err.message);
    } else {
      console.log('🗄️  Database connection closed');
    }
    process.exit(0);
  });
});

// ---- Server Start ----
async function startServer() {
  try {
    // Load existing tasks and schedule reminders
    const existingTasks = await dbOperations.getAllTasks();
    console.log(`📋 Loaded ${existingTasks.length} existing tasks`);
    
    let scheduledCount = 0;
    for (const task of existingTasks) {
      if (!task.completed && task.dueDate) {
        scheduleReminder(task, true);
        scheduledCount++;
      }
    }
    
    console.log(`⏰ Scheduled ${scheduledCount} reminders`);
    
    app.listen(PORT, () => {
      console.log(`🚀 Task Manager API running on http://localhost:${PORT}`);
      console.log(`🌍 Default timezone: ${DEFAULT_TIMEZONE}`);
      console.log(`🤖 AI Parser: ${PARSER_PROVIDER}`);
      console.log(`📧 Email: ${transporter ? 'configured' : 'not configured'}`);
      console.log(`🔔 Push notifications: ${(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) ? 'enabled' : 'disabled'}`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}

startServer();