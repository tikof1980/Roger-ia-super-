// ============================================================
// ROGER IA — Backend (Express + PostgreSQL/Supabase + Gemini)
// ============================================================

import express from "express";
import cors from "cors";
import { Pool } from "pg";
import fs from "fs";
import { randomUUID } from "crypto";
import config from "./agent_config.json" assert { type: "json" };

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SYSTEM_PROMPT = fs.readFileSync(
  new URL(config.agent.system_prompt_file, import.meta.url),
  "utf-8"
);

const GEMINI_MODEL = config.llm_providers.primary.model;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

// ------------------------------------------------------------
// Convertit les outils au format attendu par Gemini
// ------------------------------------------------------------
function toGeminiTools() {
  return [{
    functionDeclarations: config.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }))
  }];
}

async function callGemini(contents) {
  const resp = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      tools: toGeminiTools()
    })
  });
  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data;
}

// ------------------------------------------------------------
// Registre d'outils — chaque outil respecte son autonomy_level
// ------------------------------------------------------------
const toolHandlers = {
  async create_task(userId, args) {
    const { rows } = await pool.query(
      `INSERT INTO tasks (id, user_id, title, description, priority, due_date)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [randomUUID(), userId, args.title, args.description || null,
       args.priority || "moyenne", args.due_date || null]
    );
    return rows[0];
  },
  async update_task(userId, args) {
    const { rows } = await pool.query(
      `UPDATE tasks SET status = COALESCE($1,status), updated_at = now()
       WHERE id = $2 AND user_id = $3 RETURNING *`,
      [args.status || null, args.task_id, userId]
    );
    return rows[0];
  },
  async list_tasks(userId, args) {
    const { rows } = await pool.query(
      `SELECT * FROM tasks WHERE user_id = $1
       AND ($2::text IS NULL OR status = $2)
       ORDER BY due_date NULLS LAST LIMIT 50`,
      [userId, args.status || null]
    );
    return rows;
  },
  async create_reminder(userId, args) {
    const { rows } = await pool.query(
      `INSERT INTO reminders (id, user_id, message, remind_at)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [randomUUID(), userId, args.message, args.remind_at]
    );
    return rows[0];
  },
  async draft_message(userId, args) {
    const { rows } = await pool.query(
      `INSERT INTO message_drafts (id, user_id, channel, recipient, subject, body)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [randomUUID(), userId, args.channel, args.recipient || null,
       args.subject || null, args.body]
    );
    return rows[0];
  },
  async save_memory(userId, args) {
    const { rows } = await pool.query(
      `INSERT INTO memory (id, user_id, domain, fact) VALUES ($1,$2,$3,$4) RETURNING *`,
      [randomUUID(), userId, args.domain, args.fact]
    );
    return rows[0];
  },
  async get_memory(userId, args) {
    const { rows } = await pool.query(
      `SELECT * FROM memory WHERE user_id = $1 AND ($2::text IS NULL OR domain = $2)`,
      [userId, args.domain || null]
    );
    return rows;
  },
  async log_activity(userId, args) {
    await pool.query(
      `INSERT INTO activity_log (id, user_id, action, autonomy_level, details)
       VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), userId, args.action, args.autonomy_level || 0, args.details || {}]
    );
    return { logged: true };
  }
};

async function executeTool(userId, name, args) {
  const toolDef = config.tools.find((t) => t.name === name);
  if (!toolDef) throw new Error(`Outil inconnu: ${name}`);

  if (toolDef.autonomy_level > config.security_rules.require_confirmation_above_level) {
    return { requires_confirmation: true, tool: name, args };
  }

  const handler = toolHandlers[name];
  if (!handler) throw new Error(`Aucun handler pour: ${name}`);

  const result = await handler(userId, args);

  await pool.query(
    `INSERT INTO activity_log (id, user_id, action, autonomy_level, details)
     VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), userId, name, toolDef.autonomy_level, { args, result }]
  );

  return result;
}

// ------------------------------------------------------------
// Endpoint principal : boucle agentique (Gemini <-> outils)
// ------------------------------------------------------------
app.post("/api/chat", async (req, res) => {
  try {
    const { userId, conversationId, message } = req.body;
    if (!userId || !message) {
      return res.status(400).json({ error: "userId et message requis" });
    }

    await pool.query(
      `INSERT INTO messages (id, conversation_id, role, content)
       VALUES ($1,$2,'user',$3)`,
      [randomUUID(), conversationId, message]
    );

    let contents = [{ role: "user", parts: [{ text: message }] }];
    let round = 0;
    let finalText = "";

    while (round < config.security_rules.max_tool_rounds_per_turn) {
      const geminiResponse = await callGemini(contents);
      const candidate = geminiResponse?.candidates?.[0];
      const parts = candidate?.content?.parts || [];

      const functionCallPart = parts.find((p) => p.functionCall);
      const textPart = parts.find((p) => p.text);
      if (textPart) finalText = textPart.text;

      if (!functionCallPart) break;

      const { name, args } = functionCallPart.functionCall;
      const toolResult = await executeTool(userId, name, args);

      contents.push({ role: "model", parts: [{ functionCall: functionCallPart.functionCall }] });
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name, response: toolResult } }]
      });

      round++;
    }

    await pool.query(
      `INSERT INTO messages (id, conversation_id, role, content)
       VALUES ($1,$2,'assistant',$3)`,
      [randomUUID(), conversationId, finalText]
    );

    res.json({ reply: finalText });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur interne", details: err.message });
  }
});

app.get("/api/tasks/:userId", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM tasks WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.params.userId]
  );
  res.json(rows);
});

app.get("/api/health", (req, res) => res.json({ status: "ok", agent: config.agent.name }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Roger IA backend actif sur le port ${PORT}`));
