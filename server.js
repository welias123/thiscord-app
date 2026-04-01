'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ── Config (server-config.json sits next to the exe / script) ────
const CONFIG_DIR  = process.pkg
  ? path.dirname(process.execPath)   // running as bundled .exe
  : __dirname;                       // running as node server.js
const CONFIG_PATH = path.join(CONFIG_DIR, 'server-config.json');

let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}

const PORT         = config.port        || process.env.PORT         || 3001;
const ADMIN_SECRET = config.adminSecret || process.env.ADMIN_SECRET || '';
const MAX_HISTORY  = 100;
const MAX_MSG_LEN  = 8192;
const RATE_LIMIT   = 10;

const DEFAULT_CHANNELS = ['general', 'announcements', 'dev-talk', 'media'];
const DEFAULT_VOICE    = ['lounge', 'gaming', 'stream-stage'];

// ── Server state ──────────────────────────────────────────────────
const rooms         = new Map();
const history       = new Map();
const clients       = new Map();
const clientsByName = new Map();
const voiceRooms    = new Map();
const START_TIME    = Date.now();

DEFAULT_CHANNELS.forEach(ch => { rooms.set(ch, new Set()); history.set(ch, []); });
DEFAULT_VOICE.forEach(ch => voiceRooms.set(ch, new Set()));

// ── Live dashboard log buffer ─────────────────────────────────────
const LOG_LINES = [];
const MAX_LOG   = 18;

function log(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  LOG_LINES.push(`  \x1b[90m${ts}\x1b[0m  ${msg}`);
  if (LOG_LINES.length > MAX_LOG) LOG_LINES.shift();
}

// ── ANSI helpers ──────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  purple: '\x1b[35m',
  white:  '\x1b[97m',
  grey:   '\x1b[90m',
};

function pad(str, len) {
  return String(str).slice(0, len).padEnd(len);
}

function renderDashboard() {
  const W = 72;
  const line  = `${C.grey}${'─'.repeat(W)}${C.reset}`;
  const upSec = Math.floor((Date.now() - START_TIME) / 1000);
  const h = String(Math.floor(upSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((upSec % 3600) / 60)).padStart(2, '0');
  const s = String(upSec % 60).padStart(2, '0');

  const out = [];
  out.push('\x1b[2J\x1b[H'); // clear + cursor home

  // Header
  out.push(`${C.purple}${C.bold}  ⚡ ThisCord Server${C.reset}  ${C.grey}ws://bore.pub:53400${C.reset}`);
  out.push(line);
  out.push(`  ${C.bold}Status:${C.reset} ${C.green}● RUNNING${C.reset}   ${C.bold}Port:${C.reset} ${PORT}   ${C.bold}Uptime:${C.reset} ${h}:${m}:${s}   ${C.bold}Admin:${C.reset} ${ADMIN_SECRET ? `${C.green}YES${C.reset}` : `${C.red}NO${C.reset}`}`);
  out.push('');

  // Connections table
  const count = clients.size;
  out.push(`  ${C.bold}${C.white}ACTIVE CONNECTIONS${C.reset}  ${C.yellow}${count}${C.reset}`);
  out.push(line);

  if (count === 0) {
    out.push(`  ${C.grey}No connections yet — waiting for users to join…${C.reset}`);
  } else {
    // Header row
    out.push(
      `  ${C.bold}${C.grey}` +
      pad('USERNAME', 26) + '  ' +
      pad('IP', 18) + '  ' +
      pad('CH', 4) + '  ' +
      'VOICE' +
      C.reset
    );
    out.push(line);

    clients.forEach((client) => {
      const name  = client.username === 'Anonymous' ? `${C.grey}Anonymous${C.reset}` : `${C.green}${pad(client.username, 26)}${C.reset}`;
      const ip    = pad(client.ip, 18);
      const chs   = pad(client.channels.size, 4);
      const voice = client.voiceChannel ? `${C.cyan}🔊 ${client.voiceChannel}${C.reset}` : `${C.grey}—${C.reset}`;
      out.push(`  ${name}  ${C.grey}${ip}${C.reset}  ${C.yellow}${chs}${C.reset}  ${voice}`);
    });
  }

  out.push('');
  out.push(line);

  // Event log
  out.push(`  ${C.bold}${C.white}EVENT LOG${C.reset}`);
  out.push(line);
  if (LOG_LINES.length === 0) {
    out.push(`  ${C.grey}No events yet${C.reset}`);
  } else {
    LOG_LINES.forEach(l => out.push(l));
  }

  out.push('');
  out.push(line);
  out.push(`  ${C.grey}Press Ctrl+C to stop the server${C.reset}`);

  process.stdout.write(out.join('\n') + '\n');
}

// ── WebSocket server ──────────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT, perMessageDeflate: false });

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  log(`${C.green}[+]${C.reset} New connection from ${C.white}${ip}${C.reset}`);

  clients.set(ws, {
    username: 'Anonymous', ip,
    channels: new Set(), voiceChannel: null,
    msgCount: 0, rateClearTimer: null,
  });

  ws.on('message', (raw) => {
    if (raw.length > MAX_MSG_LEN + 512) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client) {
      clearTimeout(client.rateClearTimer);
      if (client.voiceChannel) handleVoiceLeave(ws, client, client.voiceChannel);
      client.channels.forEach(ch => {
        rooms.get(ch)?.delete(ws);
        broadcast(ch, { type: 'presence', event: 'leave', username: client.username, channel: ch, timestamp: Date.now() });
      });
      if (clientsByName.get(client.username) === ws) clientsByName.delete(client.username);
      log(`${C.red}[-]${C.reset} ${C.white}${client.username}${C.reset} ${C.grey}(${ip})${C.reset} disconnected`);
      broadcastUserList();
    }
    clients.delete(ws);
  });

  ws.on('error', err => log(`${C.red}[!]${C.reset} WS error: ${err.message}`));

  send(ws, { type: 'welcome', message: 'Connected to ThisCord', channels: DEFAULT_CHANNELS });
});

// ── Message handler ───────────────────────────────────────────────
function handleMessage(ws, msg) {
  const client = clients.get(ws);
  if (!client || typeof msg !== 'object' || !msg.type) return;

  switch (msg.type) {

    case 'auth': {
      const name = String(msg.username || 'Anonymous').replace(/[<>&"']/g, '').slice(0, 32) || 'Anonymous';
      client.username = name;
      clientsByName.set(name, ws);
      send(ws, { type: 'auth-ok', username: name });
      log(`${C.cyan}[~]${C.reset} ${C.white}${name}${C.reset} authenticated from ${C.grey}${client.ip}${C.reset}`);
      broadcastUserList();
      break;
    }

    case 'join': {
      const ch = String(msg.channel || '').slice(0, 128);
      if (!ch) return;
      if (!rooms.has(ch)) { rooms.set(ch, new Set()); history.set(ch, []); }
      client.channels.add(ch);
      rooms.get(ch).add(ws);
      const hist = history.get(ch) || [];
      send(ws, { type: 'history', channel: ch, messages: hist });
      broadcast(ch, { type: 'presence', event: 'join', username: client.username, channel: ch, timestamp: Date.now() }, ws);
      break;
    }

    case 'leave': {
      const ch = String(msg.channel || '');
      client.channels.delete(ch);
      rooms.get(ch)?.delete(ws);
      break;
    }

    case 'message': {
      const ch = String(msg.channel || '');
      if (!client.channels.has(ch))   return;
      if (!rooms.has(ch))             return;
      if (!msg.ciphertext || !msg.iv) return;
      if (typeof msg.ciphertext !== 'string' || typeof msg.iv !== 'string') return;
      if (msg.ciphertext.length > MAX_MSG_LEN) return;

      client.msgCount++;
      if (client.msgCount > RATE_LIMIT) { send(ws, { type: 'error', message: 'Rate limited — slow down!' }); return; }
      if (!client.rateClearTimer) {
        client.rateClearTimer = setTimeout(() => { client.msgCount = 0; client.rateClearTimer = null; }, 3000);
      }

      const envelope = {
        type: 'message', id: crypto.randomUUID(), channel: ch,
        author: client.username, ciphertext: msg.ciphertext, iv: msg.iv, timestamp: Date.now(),
      };
      const hist = history.get(ch);
      hist.push(envelope);
      if (hist.length > MAX_HISTORY) hist.shift();
      broadcast(ch, envelope);
      log(`${C.grey}[msg]${C.reset} ${C.white}${client.username}${C.reset} → #${ch}`);
      break;
    }

    case 'voice-join': {
      const ch = String(msg.channel || '').slice(0, 128);
      if (!ch) return;
      if (!voiceRooms.has(ch)) voiceRooms.set(ch, new Set());
      if (client.voiceChannel && client.voiceChannel !== ch) handleVoiceLeave(ws, client, client.voiceChannel);
      client.voiceChannel = ch;
      const vcRoom = voiceRooms.get(ch);
      send(ws, { type: 'voice-members', channel: ch, members: [...vcRoom] });
      vcRoom.add(client.username);
      broadcastAll({ type: 'voice-presence', event: 'join', username: client.username, channel: ch, timestamp: Date.now() });
      log(`${C.cyan}[🔊]${C.reset} ${C.white}${client.username}${C.reset} joined voice #${ch}`);
      break;
    }

    case 'voice-leave': {
      const ch = String(msg.channel || client.voiceChannel || '');
      if (ch) handleVoiceLeave(ws, client, ch);
      break;
    }

    case 'signal': {
      const target   = String(msg.to || '').slice(0, 32);
      const targetWs = clientsByName.get(target);
      if (!targetWs) return;
      const data = msg.data;
      if (!data || typeof data !== 'object') return;
      send(targetWs, { type: 'signal', from: client.username, data });
      break;
    }

    case 'ping': {
      send(ws, { type: 'pong', ts: Date.now() });
      break;
    }

    case 'admin-kick': {
      if (!ADMIN_SECRET || msg.secret !== ADMIN_SECRET) { send(ws, { type: 'error', message: 'Not authorized' }); return; }
      const target   = String(msg.target || '').slice(0, 32);
      const targetWs = clientsByName.get(target);
      if (targetWs) {
        send(targetWs, { type: 'kicked', reason: 'You were kicked by an admin.' });
        setTimeout(() => targetWs.close(), 200);
        log(`${C.red}[KICK]${C.reset} ${C.white}${client.username}${C.reset} kicked ${C.yellow}${target}${C.reset}`);
      }
      break;
    }

    case 'admin-delete-message': {
      if (!ADMIN_SECRET || msg.secret !== ADMIN_SECRET) return;
      const dch   = String(msg.channel || '').slice(0, 128);
      const did   = String(msg.id || '').slice(0, 64);
      const dhist = history.get(dch);
      if (dhist) { const i = dhist.findIndex(m => m.id === did); if (i !== -1) dhist.splice(i, 1); }
      broadcast(dch, { type: 'message-deleted', id: did, channel: dch });
      log(`${C.red}[DEL]${C.reset} Message deleted in #${dch} by ${C.white}${client.username}${C.reset}`);
      break;
    }

    default: break;
  }
}

// ── Voice helpers ─────────────────────────────────────────────────
function handleVoiceLeave(ws, client, ch) {
  const vcRoom = voiceRooms.get(ch);
  if (!vcRoom) return;
  vcRoom.delete(client.username);
  client.voiceChannel = null;
  broadcastAll({ type: 'voice-presence', event: 'leave', username: client.username, channel: ch, timestamp: Date.now() });
  log(`${C.grey}[🔇]${C.reset} ${C.white}${client.username}${C.reset} left voice #${ch}`);
}

function broadcastUserList() {
  const users = [...clients.values()].map(c => ({ username: c.username, voiceChannel: c.voiceChannel }));
  broadcastAll({ type: 'users', users });
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(channel, data, exclude = null) {
  const room = rooms.get(channel);
  if (!room) return;
  const json = JSON.stringify(data);
  room.forEach(ws => { if (ws !== exclude && ws.readyState === WebSocket.OPEN) ws.send(json); });
}

function broadcastAll(data) {
  const json = JSON.stringify(data);
  clients.forEach((_, ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(json); });
}

// ── Start ─────────────────────────────────────────────────────────
wss.on('listening', () => {
  log(`${C.green}[✓]${C.reset} Server listening on port ${C.white}${PORT}${C.reset}`);
  log(`${C.green}[✓]${C.reset} Admin: ${ADMIN_SECRET ? `${C.green}enabled${C.reset}` : `${C.red}disabled (no secret set)${C.reset}`}`);
  log(`${C.green}[✓]${C.reset} Bore tunnel: ${C.grey}bore.pub:53400${C.reset}`);
  renderDashboard();
  // Redraw every second
  setInterval(renderDashboard, 1000);
});
