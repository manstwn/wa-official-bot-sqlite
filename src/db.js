import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.resolve('data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'database.sqlite');
const db = new Database(DB_PATH);

// Enable WAL (Write-Ahead Logging) mode for performance
db.pragma('journal_mode = WAL');

// ============================================================
// Database Table Initializations
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    [from] TEXT NOT NULL,
    [to] TEXT,
    type TEXT,
    body TEXT,
    timestamp INTEGER,
    direction TEXT NOT NULL,
    tempMediaUrl TEXT,
    metaResponse TEXT, -- JSON string
    rawData TEXT,      -- JSON string
    ingestedAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_ingested ON messages(ingestedAt DESC);

  CREATE TABLE IF NOT EXISTS ai_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider TEXT DEFAULT 'gemini',
    model TEXT DEFAULT 'gemini-2.0-flash-lite',
    geminiKey TEXT DEFAULT '',
    openrouterKey TEXT DEFAULT '',
    systemPrompt TEXT DEFAULT '',
    autoAiEnabled INTEGER DEFAULT 0, -- 0 = false, 1 = true
    imageOnly INTEGER DEFAULT 0 -- 0 = false, 1 = true
  );

  CREATE TABLE IF NOT EXISTS ai_history (
    time TEXT PRIMARY KEY,
    entry TEXT NOT NULL -- JSON string
  );
`);

// Add new columns to existing schema if necessary
try {
  db.exec(`ALTER TABLE ai_config ADD COLUMN imageOnly INTEGER DEFAULT 0`);
} catch (e) {
  // Ignored if column already exists
}

// ============================================================
// Automatic Startup Migration from legacy JSON files
// ============================================================
function runLegacyMigrations() {
  const LEGACY_DB_FILE = path.join(DATA_DIR, 'db.json');
  const LEGACY_CONFIG_FILE = path.join(DATA_DIR, 'ai-config.json');
  const LEGACY_HISTORY_FILE = path.join(DATA_DIR, 'ai-history.json');

  const isTableEmpty = (tableName) => {
    const row = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get();
    return row.count === 0;
  };

  // 1. Config Migration
  const configExists = fs.existsSync(LEGACY_CONFIG_FILE);
  let initialConfig = {
    provider: 'gemini',
    model: 'gemini-2.0-flash-lite',
    geminiKey: '',
    openrouterKey: '',
    systemPrompt: '',
    autoAiEnabled: 0,
    imageOnly: 0
  };

  if (configExists) {
    try {
      const raw = fs.readFileSync(LEGACY_CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      initialConfig = {
        provider: parsed.provider || 'gemini',
        model: parsed.model || 'gemini-2.0-flash-lite',
        geminiKey: parsed.geminiKey || '',
        openrouterKey: parsed.openrouterKey || '',
        systemPrompt: parsed.systemPrompt || '',
        autoAiEnabled: parsed.autoAiEnabled ? 1 : 0,
        imageOnly: parsed.imageOnly ? 1 : 0
      };
      console.log('[SQLite Migration] Loaded existing configuration from JSON.');
    } catch (err) {
      console.error('[SQLite Migration Error] Failed to read legacy config:', err);
    }
  }

  // Ensure config row exists
  db.prepare(`
    INSERT OR IGNORE INTO ai_config (id, provider, model, geminiKey, openrouterKey, systemPrompt, autoAiEnabled, imageOnly)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    initialConfig.provider,
    initialConfig.model,
    initialConfig.geminiKey,
    initialConfig.openrouterKey,
    initialConfig.systemPrompt,
    initialConfig.autoAiEnabled,
    initialConfig.imageOnly
  );

  if (configExists) {
    try {
      fs.renameSync(LEGACY_CONFIG_FILE, path.join(DATA_DIR, 'ai-config.json.backup'));
      console.log('[SQLite Migration] Renamed legacy config to backup file.');
    } catch (err) {
      console.warn('[SQLite Migration Warning] Could not rename config file:', err);
    }
  }

  // 2. Messages Migration
  if (fs.existsSync(LEGACY_DB_FILE)) {
    try {
      const raw = fs.readFileSync(LEGACY_DB_FILE, 'utf-8');
      const messages = JSON.parse(raw);
      if (Array.isArray(messages) && messages.length > 0 && isTableEmpty('messages')) {
        console.log(`[SQLite Migration] Importing ${messages.length} messages from legacy JSON database...`);
        const insertStmt = db.prepare(`
          INSERT OR IGNORE INTO messages (id, [from], [to], type, body, timestamp, direction, tempMediaUrl, metaResponse, rawData, ingestedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        db.transaction((msgs) => {
          for (const msg of msgs) {
            const msgId = msg.id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            insertStmt.run(
              msgId,
              msg.from || 'unknown',
              msg.to || null,
              msg.type || 'text',
              msg.body || '',
              msg.timestamp || Math.floor(Date.now() / 1000),
              msg.direction || 'inbound',
              msg.tempMediaUrl || null,
              msg.metaResponse ? JSON.stringify(msg.metaResponse) : null,
              msg.rawData ? JSON.stringify(msg.rawData) : null,
              msg.ingestedAt || new Date().toISOString()
            );
          }
        })(messages);
        console.log('[SQLite Migration] Messages successfully imported.');
      }
      fs.renameSync(LEGACY_DB_FILE, path.join(DATA_DIR, 'db.json.backup'));
      console.log('[SQLite Migration] Renamed legacy db.json to backup file.');
    } catch (err) {
      console.error('[SQLite Migration Error] Failed to migrate messages:', err);
    }
  }

  // 3. AI History Migration
  if (fs.existsSync(LEGACY_HISTORY_FILE)) {
    try {
      const raw = fs.readFileSync(LEGACY_HISTORY_FILE, 'utf-8');
      const history = JSON.parse(raw);
      if (Array.isArray(history) && history.length > 0 && isTableEmpty('ai_history')) {
        console.log(`[SQLite Migration] Importing ${history.length} history entries from legacy JSON...`);
        const insertStmt = db.prepare(`
          INSERT OR IGNORE INTO ai_history (time, entry)
          VALUES (?, ?)
        `);

        db.transaction((entries) => {
          for (const entry of entries) {
            const time = entry.time || new Date().toISOString();
            insertStmt.run(time, JSON.stringify(entry));
          }
        })(history);
        console.log('[SQLite Migration] History successfully imported.');
      }
      fs.renameSync(LEGACY_HISTORY_FILE, path.join(DATA_DIR, 'ai-history.json.backup'));
      console.log('[SQLite Migration] Renamed legacy ai-history.json to backup file.');
    } catch (err) {
      console.error('[SQLite Migration Error] Failed to migrate history:', err);
    }
  }
}

runLegacyMigrations();

// ============================================================
// Exported Database Handlers
// ============================================================

/**
 * Read messages from the SQLite database.
 * Returns an array of message records.
 */
export async function readMessages() {
  try {
    const rows = db.prepare(`SELECT * FROM messages ORDER BY ingestedAt DESC`).all();
    return rows.map(row => ({
      ...row,
      metaResponse: row.metaResponse ? JSON.parse(row.metaResponse) : null,
      rawData: row.rawData ? JSON.parse(row.rawData) : null
    }));
  } catch (error) {
    console.error('Error reading messages from SQLite database:', error);
    throw error;
  }
}

/**
 * Save a message payload to the SQLite database.
 * Inserts a new record or updates an existing record on conflict.
 */
export async function saveMessage(payload) {
  try {
    const existing = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(payload.id);
    const ingestedAt = payload.ingestedAt || (existing ? existing.ingestedAt : new Date().toISOString());

    const merged = {
      id: payload.id,
      from: payload.from !== undefined ? payload.from : (existing ? existing.from : 'unknown'),
      to: payload.to !== undefined ? payload.to : (existing ? existing.to : null),
      type: payload.type !== undefined ? payload.type : (existing ? existing.type : 'text'),
      body: payload.body !== undefined ? payload.body : (existing ? existing.body : ''),
      timestamp: payload.timestamp !== undefined ? payload.timestamp : (existing ? existing.timestamp : Math.floor(Date.now() / 1000)),
      direction: payload.direction !== undefined ? payload.direction : (existing ? existing.direction : 'inbound'),
      tempMediaUrl: payload.tempMediaUrl !== undefined ? payload.tempMediaUrl : (existing ? existing.tempMediaUrl : null),
      metaResponse: payload.metaResponse !== undefined 
        ? (payload.metaResponse ? JSON.stringify(payload.metaResponse) : null)
        : (existing ? existing.metaResponse : null),
      rawData: payload.rawData !== undefined 
        ? (payload.rawData ? JSON.stringify(payload.rawData) : null)
        : (existing ? existing.rawData : null),
      ingestedAt
    };

    const stmt = db.prepare(`
      INSERT INTO messages (id, [from], [to], type, body, timestamp, direction, tempMediaUrl, metaResponse, rawData, ingestedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        [from] = excluded.[from],
        [to] = excluded.[to],
        type = excluded.type,
        body = excluded.body,
        timestamp = excluded.timestamp,
        direction = excluded.direction,
        tempMediaUrl = excluded.tempMediaUrl,
        metaResponse = excluded.metaResponse,
        rawData = excluded.rawData,
        ingestedAt = excluded.ingestedAt
    `);

    stmt.run(
      merged.id,
      merged.from,
      merged.to,
      merged.type,
      merged.body,
      merged.timestamp,
      merged.direction,
      merged.tempMediaUrl,
      merged.metaResponse,
      merged.rawData,
      merged.ingestedAt
    );

    // Fetch and return the stored record to maintain consistent payload response
    const savedRow = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(payload.id);
    return {
      ...savedRow,
      metaResponse: savedRow.metaResponse ? JSON.parse(savedRow.metaResponse) : null,
      rawData: savedRow.rawData ? JSON.parse(savedRow.rawData) : null
    };
  } catch (error) {
    console.error('Error saving message to SQLite database:', error);
    throw error;
  }
}

/**
 * Clear all message logs in the SQLite database.
 */
export async function clearMessages() {
  try {
    db.prepare(`DELETE FROM messages`).run();
  } catch (error) {
    console.error('Error clearing messages from SQLite database:', error);
    throw error;
  }
}

/**
 * Read AI configuration from the database.
 */
export async function readAIConfig() {
  try {
    const row = db.prepare(`SELECT * FROM ai_config WHERE id = 1`).get();
    if (!row) {
      return {
        provider: 'gemini',
        model: 'gemini-2.0-flash-lite',
        geminiKey: '',
        openrouterKey: '',
        systemPrompt: '',
        autoAiEnabled: false,
        imageOnly: false
      };
    }
    return {
      provider: row.provider,
      model: row.model,
      geminiKey: row.geminiKey,
      openrouterKey: row.openrouterKey,
      systemPrompt: row.systemPrompt,
      autoAiEnabled: row.autoAiEnabled === 1,
      imageOnly: row.imageOnly === 1
    };
  } catch (error) {
    console.error('Error reading AI config from SQLite:', error);
    return {
      provider: 'gemini',
      model: 'gemini-2.0-flash-lite',
      geminiKey: '',
      openrouterKey: '',
      systemPrompt: '',
      autoAiEnabled: false,
      imageOnly: false
    };
  }
}

/**
 * Write AI configuration updates to the database.
 */
export async function writeAIConfig(cfg) {
  try {
    const current = await readAIConfig();
    const merged = { ...current, ...cfg };

    db.prepare(`
      INSERT INTO ai_config (id, provider, model, geminiKey, openrouterKey, systemPrompt, autoAiEnabled, imageOnly)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        geminiKey = excluded.geminiKey,
        openrouterKey = excluded.openrouterKey,
        systemPrompt = excluded.systemPrompt,
        autoAiEnabled = excluded.autoAiEnabled,
        imageOnly = excluded.imageOnly
    `).run(
      merged.provider,
      merged.model,
      merged.geminiKey,
      merged.openrouterKey,
      merged.systemPrompt,
      merged.autoAiEnabled ? 1 : 0,
      merged.imageOnly ? 1 : 0
    );

    return merged;
  } catch (error) {
    console.error('Error writing AI config to SQLite:', error);
    throw error;
  }
}

/**
 * Read AI Playground test history.
 */
export async function readAIHistory() {
  try {
    const rows = db.prepare(`SELECT entry FROM ai_history ORDER BY time DESC`).all();
    return rows.map(row => JSON.parse(row.entry));
  } catch (error) {
    console.error('Error reading AI history from SQLite:', error);
    return [];
  }
}

/**
 * Write AI Playground test history array.
 */
export async function writeAIHistory(history) {
  try {
    const deleteStmt = db.prepare(`DELETE FROM ai_history`);
    const insertStmt = db.prepare(`INSERT OR REPLACE INTO ai_history (time, entry) VALUES (?, ?)`);

    db.transaction(() => {
      deleteStmt.run();
      for (const entry of history) {
        insertStmt.run(entry.time, JSON.stringify(entry));
      }
    })();
  } catch (error) {
    console.error('Error writing AI history to SQLite:', error);
    throw error;
  }
}

/**
 * Delete a specific AI History entry by time parameter.
 */
export async function deleteAIHistoryEntry(time) {
  try {
    db.prepare(`DELETE FROM ai_history WHERE time = ?`).run(time);
  } catch (error) {
    console.error('Error deleting AI history entry from SQLite:', error);
    throw error;
  }
}

/**
 * Fetch last N text messages for a contact, sorted chronologically.
 */
export async function getChatHistory(phoneNumber, limit = 9) {
  try {
    const rows = db.prepare(`
      SELECT * FROM messages 
      WHERE ([from] = ? OR [to] = ?) 
        AND type = 'text'
        AND body IS NOT NULL AND body <> ''
      ORDER BY ingestedAt DESC 
      LIMIT ?
    `).all(phoneNumber, phoneNumber, limit);
    return rows.reverse().map(row => ({
      ...row,
      metaResponse: row.metaResponse ? JSON.parse(row.metaResponse) : null,
      rawData: row.rawData ? JSON.parse(row.rawData) : null
    }));
  } catch (error) {
    console.error('Error fetching chat history from SQLite:', error);
    return [];
  }
}
