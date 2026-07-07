import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { 
  saveMessage, 
  readMessages, 
  clearMessages,
  readAIConfig,
  writeAIConfig,
  readAIHistory,
  writeAIHistory,
  deleteAIHistoryEntry
} from './db.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public', {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('.css') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Active Server-Sent Events (SSE) clients
let clients = [];

// Helper to broadcast messages to all connected SSE clients
function broadcast(payload) {
  clients.forEach(client => {
    client.write(`data: ${JSON.stringify(payload)}\n\n`);
  });
}

// Helper to download media via fetch with timeout
async function downloadMedia(url, type, messageId) {
  try {
    const extMap = {
      image: '.jpg',
      audio: '.ogg',
      video: '.mp4'
    };
    const ext = extMap[type] || '.bin';
    const uploadsDir = path.resolve('public/uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    const fileName = `${messageId}${ext}`;
    const localFilePath = path.join(uploadsDir, fileName);

    console.log(`[Media Downloader] Downloading media from: ${url}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Connection': 'close'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await fs.promises.writeFile(localFilePath, buffer);
    console.log(`[Media Downloader] Successfully saved media to: ${localFilePath}`);
    return `/uploads/${fileName}`;
  } catch (err) {
    console.error(`[Media Downloader Error] Failed to download media for ${messageId}: ${err.name} ${err.message}`);
    return null;
  }
}

// ============================================================
// Helper: Send a WhatsApp text reply via Meta API + save locally
// ============================================================
async function sendWhatsAppReply(to, body) {
  const accessToken = process.env.WA_ACCESS_TOKEN;
  const phoneId = process.env.WA_PHONE_NUMBER_ID;
  if (!phoneId) {
    console.error('[sendWhatsAppReply] WA_PHONE_NUMBER_ID is not set in .env!');
  }

  let metaApiResponse = null;
  let messageId = `outbound_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  if (accessToken && accessToken.trim() !== '') {
    const metaUrl = `https://graph.facebook.com/v25.0/${phoneId}/messages`;
    const res = await fetch(metaUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[WA Reply] Meta API error:', data);
    } else {
      console.log(`[WA Reply] Sent to +${to}: "${body.substring(0, 60)}"`);
      metaApiResponse = data;
      if (data.messages && data.messages[0] && data.messages[0].id) {
        messageId = data.messages[0].id;
      }
    }
  } else {
    console.log('[WA Reply] WA_ACCESS_TOKEN not configured. Saving locally only.');
  }

  // Save to local DB and broadcast so it appears in the Chat View
  const outboundRecord = {
    id: messageId,
    from: 'system',
    to: to,
    type: 'text',
    body: body,
    timestamp: Math.floor(Date.now() / 1000),
    direction: 'outbound',
    metaResponse: metaApiResponse
  };
  const savedRecord = await saveMessage(outboundRecord);
  broadcast(savedRecord);

  return metaApiResponse;
}

// ============================================================
// Helper: Process an image with AI (Gemini or OpenRouter)
// ============================================================
async function callAIWithImage(imageBase64, mimeType, aiConfig) {
  const provider = aiConfig.provider || 'gemini';
  const model = aiConfig.model || (provider === 'gemini' ? 'gemini-2.0-flash-lite' : 'google/gemini-2.0-flash-lite-001');
  const apiKey = provider === 'openrouter' ? aiConfig.openrouterKey : aiConfig.geminiKey;

  if (!apiKey || apiKey.trim() === '') {
    throw new Error(`No API key configured for ${provider}`);
  }

  let responseText = '';

  if (provider === 'gemini') {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const userParts = [{ inlineData: { mimeType, data: imageBase64 } }];
    const geminiBody = { contents: [{ role: 'user', parts: userParts }] };
    if (aiConfig.systemPrompt) {
      geminiBody.system_instruction = { parts: [{ text: aiConfig.systemPrompt }] };
    }
    const geminiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody)
    });
    const geminiData = await geminiRes.json();
    if (!geminiRes.ok) throw new Error(geminiData?.error?.message || 'Gemini API error');
    responseText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '(No response)';
  } else if (provider === 'openrouter') {
    const apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
    const messages = [];
    if (aiConfig.systemPrompt) messages.push({ role: 'system', content: aiConfig.systemPrompt });
    messages.push({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }]
    });
    const orRes = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'WA Bot Auto AI'
      },
      body: JSON.stringify({ model, messages })
    });
    const orData = await orRes.json();
    if (!orRes.ok) throw new Error(orData?.error?.message || 'OpenRouter API error');
    responseText = orData?.choices?.[0]?.message?.content || '(No response)';
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  return responseText;
}

// ============================================================
// Toggle API: Auto AI reply for images
// ============================================================
app.get('/api/auto-ai/toggle', async (req, res) => {
  try {
    const cfg = await readAIConfig();
    return res.json({ success: true, enabled: !!cfg.autoAiEnabled });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auto-ai/toggle', async (req, res) => {
  try {
    const { enabled } = req.body;
    const cfg = await readAIConfig();
    cfg.autoAiEnabled = !!enabled;
    await writeAIConfig(cfg);
    console.log(`[Auto AI] Toggle set to ${cfg.autoAiEnabled ? 'ON' : 'OFF'}`);
    return res.json({ success: true, enabled: cfg.autoAiEnabled });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Webhook Receiver
app.post(WEBHOOK_PATH, async (req, res) => {
  try {
    const payload = req.body;
    console.log(`[Webhook] Received payload at ${new Date().toISOString()}:`, JSON.stringify(payload, null, 2));

    // Save payload to JSON database
    const savedRecord = await saveMessage(payload);

    // Broadcast in real-time to active SSE connections
    broadcast(savedRecord);

    // Download media synchronously while the temp URL is still fresh
    let localPath = null;
    if (payload.tempMediaUrl && (payload.type === 'image' || payload.type === 'audio' || payload.type === 'video')) {
      try {
        localPath = await downloadMedia(payload.tempMediaUrl, payload.type, payload.id);
        if (localPath) {
          const updatedRecord = await saveMessage({
            id: payload.id,
            tempMediaUrl: localPath
          });
          broadcast(updatedRecord);
        }
      } catch (dlErr) {
        console.error('[Media Downloader Sync Error]', dlErr.message);
      }
    }

    // Respond
    res.status(200).json({
      success: true,
      message: 'Webhook received, stored, and broadcasted successfully.',
      receivedAt: savedRecord.ingestedAt
    });

    // AI processing (async)
    if (payload.type === 'image') {
      (async () => {
        try {
          const cfg = await readAIConfig();
          const fromNumber = payload.from;

          if (cfg.autoAiEnabled) {
            // 1s delay then send template message
            await new Promise(r => setTimeout(r, 1000));
            await sendWhatsAppReply(fromNumber, 'Mohon tunggu, memproses gambar..');

            if (localPath) {
              const fullPath = path.resolve('public' + localPath);
              const imageBuffer = await fs.promises.readFile(fullPath);
              const base64 = imageBuffer.toString('base64');
              const ext = path.extname(localPath).toLowerCase();
              const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
              const mimeType = mimeMap[ext] || 'image/jpeg';

              console.log(`[Auto AI] Processing image from +${fromNumber} with ${cfg.provider}...`);
              try {
                const aiReply = await callAIWithImage(base64, mimeType, cfg);
                await sendWhatsAppReply(fromNumber, aiReply);
              } catch (aiErr) {
                console.error(`[Auto AI] AI error for +${fromNumber}:`, aiErr.message);
                await sendWhatsAppReply(fromNumber, 'Maaf, terjadi kesalahan saat memproses gambar.');
              }
            } else {
              await sendWhatsAppReply(fromNumber, 'Maaf, gagal mengunduh gambar.');
            }
          } else {
            await sendWhatsAppReply(fromNumber, 'Sistem sedang dalam perbaikan,silahkan cek kembali beberapa menit lagi');
          }
        } catch (err) {
          console.error('[Auto AI Background Error]', err);
        }
      })();
    }
  } catch (error) {
    console.error('[Webhook Error] Error processing incoming payload:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: 'Internal server error while parsing webhook payload.'
      });
    }
  }
});

// ============================================================
// API: AI Config Store (persistent provider/model/key/prompt)
// ============================================================

// GET /api/config — return current AI config (keys are redacted in response)
app.get('/api/config', async (req, res) => {
  try {
    const cfg = await readAIConfig();
    return res.json({ success: true, config: cfg });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/config — save AI config
app.post('/api/config', async (req, res) => {
  try {
    const { provider, model, geminiKey, openrouterKey, systemPrompt } = req.body;
    const existing = await readAIConfig();
    const updated = await writeAIConfig({
      provider: provider ?? existing.provider,
      model: model ?? existing.model,
      geminiKey: geminiKey ?? existing.geminiKey,
      openrouterKey: openrouterKey ?? existing.openrouterKey,
      systemPrompt: systemPrompt ?? existing.systemPrompt,
    });
    console.log(`[Config] AI config saved. Provider: ${updated.provider}, Model: ${updated.model}`);
    return res.json({ success: true, config: updated });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});


app.get('/api/messages', async (req, res) => {
  try {
    const messages = await readMessages();
    return res.json(messages);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// API: Clear message log
app.delete('/api/messages', async (req, res) => {
  try {
    await clearMessages();
    // Broadcast clear event to reset client UIs
    broadcast({ type: 'SYSTEM_CLEAR' });
    return res.json({ success: true, message: 'Message database cleared.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// API: Send/Simulated reply message
app.post('/api/messages/send', async (req, res) => {
  try {
    const { to, body } = req.body;
    if (!to || !body) {
      return res.status(400).json({ success: false, error: 'Recipient phone (to) and message body (body) are required.' });
    }

    const accessToken = process.env.WA_ACCESS_TOKEN;
    const phoneId = process.env.WA_PHONE_NUMBER_ID;

    let metaApiResponse = null;
    let actualSent = false;
    let messageId = `outbound_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    if (accessToken && accessToken.trim() !== '') {
      // Send actual request to Meta Graph API
      const metaUrl = `https://graph.facebook.com/v25.0/${phoneId}/messages`;
      console.log(`[Meta API] Dispatching message to +${to} via Phone ID: ${phoneId}...`);

      const response = await fetch(metaUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to,
          type: 'text',
          text: {
            body: body
          }
        })
      });

      const responseText = await response.text();
      let responseData;
      try {
        responseData = JSON.parse(responseText);
      } catch (e) {
        responseData = { raw: responseText };
      }

      if (!response.ok) {
        console.error('[Meta API Error] Failed to dispatch message:', responseData);
        return res.status(response.status).json({
          success: false,
          error: 'Meta Cloud API rejected the outbound message.',
          metaError: responseData
        });
      }

      console.log('[Meta API Success] Message sent successfully:', responseData);
      metaApiResponse = responseData;
      actualSent = true;
      if (responseData.messages && responseData.messages[0] && responseData.messages[0].id) {
        messageId = responseData.messages[0].id;
      }
    } else {
      console.log('[Meta API] WA_ACCESS_TOKEN not configured. Simulating outbound send...');
    }

    const outboundPayload = {
      id: messageId,
      from: 'system',
      to: to,
      type: 'text',
      body: body,
      timestamp: Math.floor(Date.now() / 1000),
      direction: 'outbound',
      metaResponse: metaApiResponse
    };

    const savedRecord = await saveMessage(outboundPayload);
    broadcast(savedRecord);

    return res.json({
      success: true,
      message: actualSent ? 'Message sent via Meta API and stored.' : 'Simulated message stored (WA_ACCESS_TOKEN not set).',
      data: savedRecord
    });
  } catch (error) {
    console.error('[Send Reply Catch Error]:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// API: Server-Sent Events Stream for live updates
app.get('/api/stream', (req, res) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // Establish stream connection immediately

  // Add client to active clients list
  clients.push(res);
  console.log(`[SSE] Client connected. Active streams: ${clients.length}`);

  // Send an initial handshake/keep-alive
  res.write(`data: ${JSON.stringify({ type: 'SYSTEM_CONNECTED', activeClients: clients.length })}\n\n`);

  // Periodic ping to keep connection open in some environments
  const keepAliveInterval = setInterval(() => {
    res.write(': ping\n\n');
  }, 20000);

  // Clean up when client disconnects
  req.on('close', () => {
    clearInterval(keepAliveInterval);
    clients = clients.filter(client => client !== res);
    console.log(`[SSE] Client disconnected. Active streams: ${clients.length}`);
  });
});

// ============================================================
// API: AI Test Endpoint (Gemini & OpenRouter)
// ============================================================
app.post('/api/ai-test', async (req, res) => {
  const startTime = Date.now();
  try {
    // Load saved config as defaults; request body overrides
    const savedCfg = await readAIConfig();

    const provider = req.body.provider || savedCfg.provider || 'gemini';
    const model = req.body.model || savedCfg.model;
    const systemPrompt = req.body.systemPrompt ?? savedCfg.systemPrompt;
    const userMessage = req.body.userMessage;
    const imageBase64 = req.body.imageBase64;
    const imageMimeType = req.body.imageMimeType;

    // Resolve the right API key based on provider
    let apiKey = req.body.apiKey;
    if (!apiKey || apiKey.trim() === '') {
      apiKey = provider === 'openrouter' ? savedCfg.openrouterKey : savedCfg.geminiKey;
    }

    if (!apiKey || apiKey.trim() === '') {
      return res.status(400).json({ success: false, error: `API key is required. Set it in the AI Tester config or pass it in the request.` });

    }
    if (!userMessage && !imageBase64) {
      return res.status(400).json({ success: false, error: 'A user message or image is required.' });
    }

    let responseText = '';

    // ---- GEMINI ----
    if (provider === 'gemini') {
      const geminiModel = model || 'gemini-2.0-flash-lite';
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;

      // Build the user parts array
      const userParts = [];
      if (imageBase64 && imageMimeType) {
        userParts.push({ inlineData: { mimeType: imageMimeType, data: imageBase64 } });
      }
      if (userMessage) {
        userParts.push({ text: userMessage });
      }

      const geminiBody = {
        contents: [{ role: 'user', parts: userParts }]
      };

      if (systemPrompt) {
        geminiBody.system_instruction = { parts: [{ text: systemPrompt }] };
      }

      console.log(`[AI Test] Dispatching request to Gemini API. Model: ${geminiModel}`);
      const geminiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody)
      });

      const geminiData = await geminiRes.json();
      if (!geminiRes.ok) {
        console.error('[AI Test] Gemini API error:', geminiData);
        return res.status(geminiRes.status).json({
          success: false,
          error: geminiData?.error?.message || 'Gemini API error',
          raw: geminiData
        });
      }

      responseText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '(No text response)';
    }

    // ---- OPENROUTER ----
    else if (provider === 'openrouter') {
      const orModel = model || 'google/gemini-2.0-flash-lite-001';
      const apiUrl = 'https://openrouter.ai/api/v1/chat/completions';

      const messages = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }

      // Build user content
      const userContent = [];
      if (imageBase64 && imageMimeType) {
        userContent.push({
          type: 'image_url',
          image_url: { url: `data:${imageMimeType};base64,${imageBase64}` }
        });
      }
      if (userMessage) {
        userContent.push({ type: 'text', text: userMessage });
      }

      messages.push({
        role: 'user',
        content: userContent.length === 1 && userContent[0].type === 'text'
          ? userContent[0].text
          : userContent
      });

      console.log(`[AI Test] Dispatching request to OpenRouter API. Model: ${orModel}`);
      const orRes = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'WA Bot AI Tester'
        },
        body: JSON.stringify({ model: orModel, messages })
      });

      const orData = await orRes.json();
      if (!orRes.ok) {
        console.error('[AI Test] OpenRouter API error:', orData);
        return res.status(orRes.status).json({
          success: false,
          error: orData?.error?.message || 'OpenRouter API error',
          raw: orData
        });
      }

      responseText = orData?.choices?.[0]?.message?.content || '(No text response)';
    }

    else {
      return res.status(400).json({ success: false, error: `Unknown provider: ${provider}. Use 'gemini' or 'openrouter'.` });
    }

    const elapsed = Date.now() - startTime;
    console.log(`[AI Test] Response received in ${elapsed}ms.`);

    return res.json({
      success: true,
      provider,
      model: model || '(default)',
      responseText,
      elapsedMs: elapsed
    });

  } catch (err) {
    console.error('[AI Test] Unhandled error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// Auth: PIN-based login
// ============================================================
const AUTH_PIN = process.env.PIN || '1122';
const validTokens = new Set();

app.post('/api/auth/login', (req, res) => {
  const { pin } = req.body;
  if (pin !== AUTH_PIN) {
    return res.status(401).json({ success: false, error: 'Invalid PIN' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  validTokens.add(token);
  return res.json({ success: true, token });
});

app.get('/api/auth/check', (req, res) => {
  const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token || !validTokens.has(token)) {
    return res.json({ valid: false });
  }
  return res.json({ valid: true });
});

// ============================================================
// AI Test History persistence
// ============================================================

app.get('/api/ai-history', async (req, res) => {
  try {
    const history = await readAIHistory();
    return res.json({ success: true, history });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/ai-history', async (req, res) => {
  try {
    const { entry } = req.body;
    if (!entry) return res.status(400).json({ success: false, error: 'Missing entry' });
    const history = await readAIHistory();
    history.unshift(entry);
    // Keep max 100 entries
    if (history.length > 100) history.length = 100;
    await writeAIHistory(history);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/ai-history', async (req, res) => {
  try {
    await writeAIHistory([]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/ai-history/:time', async (req, res) => {
  try {
    const time = decodeURIComponent(req.params.time);
    await deleteAIHistoryEntry(time);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/config/landing — return landing page URL from env
app.get('/api/config/landing', (req, res) => {
  const url = process.env.LANDINGPAGE || null;
  return res.json({ url });
});

// Start the server
app.listen(PORT, async () => {
  console.log(`==================================================`);
  console.log(` WhatsApp Webhook Receiver Server Started!`);
  console.log(` Port: ${PORT}`);
  console.log(` Webhook URL: http://localhost:${PORT}${WEBHOOK_PATH}`);
  console.log(` Web Dashboard: http://localhost:${PORT}`);
  console.log(`==================================================`);

  // Start Cloudflare Tunnel if requested in environment variables
  // Start Cloudflare Tunnel if requested in environment variables
  if (process.env.CF_TUNNEL === 'true' || process.env.CF_TUNNEL === 'TRUE') {
    console.log('[Cloudflare Tunnel] Starting tunnel...');
    try {
      const { spawn } = await import('child_process');
      const fs = await import('fs');

      const token = process.env.CF_TUNNEL_TOKEN;
      let bin = 'cloudflared';

      if (process.platform === 'win32') {
        const x86Path = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
        const x64Path = 'C:\\Program Files\\cloudflared\\cloudflared.exe';
        if (fs.existsSync(x86Path)) {
          bin = x86Path;
        } else if (fs.existsSync(x64Path)) {
          bin = x64Path;
        } else {
          bin = 'cloudflared.exe';
        }
      }

      const args = [];
      if (!token || token === 'xxxx') {
        console.warn('[Cloudflare Tunnel Warning] CF_TUNNEL_TOKEN is not configured in .env! Defaulting to local tunnel...');
        args.push('tunnel', '--url', `http://localhost:${PORT}`);
      } else {
        console.log(`[Cloudflare Tunnel] Establishing tunnel with token: ${token.substring(0, 4)}...`);
        args.push('tunnel', 'run', '--token', token);
      }

      console.log(`[Cloudflare Tunnel] Spawning global tunnel: ${bin} ${args.join(' ')}`);
      const cfTunnelProc = spawn(bin, args, { stdio: 'inherit' });
      cfTunnelProc.on('error', (err) => console.error('[Cloudflare Tunnel Error] Spawn error:', err));
      cfTunnelProc.on('exit', (code) => {
        console.warn(`[Cloudflare Tunnel Warning] Tunnel process exited with code ${code}. Express server is still running.`);
      });
    } catch (err) {
      console.error('[Cloudflare Tunnel Error] Failed to initialize tunnel:', err);
    }
  }
});

