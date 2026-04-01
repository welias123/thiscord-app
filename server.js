/**
 * ThisCord WebSocket Server
 * Run: node server.js
 * Expose publicly: bore local 3001 --to bore.pub --port 53400
 *
 * Architecture:
 *  - Relay only: stores & forwards encrypted ciphertext
 *  - Server CANNOT read message content (AES-256-GCM encrypted client-side)
 *  - Supports text channels, DMs, voice presence, WebRTC signaling, server creation
 */

'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

const PORT        = process.env.PORT || 3001;
const MAX_HISTORY = 100;
const MAX_MSG_LEN = 8192;
const RATE_LIMIT  = 10;
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

const DEFAULT_CHANNELS = ['general', 'announcements', 'dev-talk', 'media'];
const DEFAULT_VOICE    = ['lounge', 'gaming', 'stream-stage'];

// ── Server state ──────────────────────────────────────────────────
const rooms          = new Map();   // channelKey → Set<WebSocket>
const history        = new Map();   // channelKey → Array<MessageEnvelope>
const clients        = new Map();   // ws → ClientInfo
const clientsByName  = new Map();   // username → ws  (latest auth wins)
const voiceRooms     = new Map();   // voiceKey → Set<username>

// Pre-create default channels
DEFAULT_CHANNELS.forEach(ch => {
  rooms.set(ch, new Set());
  history.set(ch, []);
});
DEFAULT_VOICE.forEach(ch => {
  voiceRooms.set(ch, new Set());
});

// ── Standalone WebSocket server ───────────────────────────────────
const wss = new WebSocketServer({
  port: PORT,
  perMessageDeflate: false,
});

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  log(`[+] ${ip} connected`);

  clients.set(ws, {
    username:     'Anonymous',
    ip,
    channels:     new Set(),
    voiceChannel: null,
    msgCount:     0,
    rateClearTimer: null,
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

      // Leave voice channel
      if (client.voiceChannel) {
        handleVoiceLeave(ws, client, client.voiceChannel);
      }

      // Leave all text channels
      client.channels.forEach(ch => {
        rooms.get(ch)?.delete(ws);
        broadcast(ch, {
          type: 'presence', event: 'leave',
          username: client.username, channel: ch, timestamp: Date.now(),
        });
      });

      if (clientsByName.get(client.username) === ws) {
        clientsByName.delete(client.username);
      }

      log(`[-] ${client.username} (${ip}) disconnected`);
      broadcastUserList();
    }
    clients.delete(ws);
  });

  ws.on('error', err => log(`[!] WS error: ${err.message}`));

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
      log(`[~] Auth: "${name}" from ${client.ip}`);
      broadcastUserList();
      break;
    }

    case 'join': {
      const ch = String(msg.channel || '').slice(0, 128);
      if (!ch) return;

      // Create channel on-demand (supports DMs: dm:A:B, custom servers: srvId:channel)
      if (!rooms.has(ch)) {
        rooms.set(ch, new Set());
        history.set(ch, []);
      }

      client.channels.add(ch);
      rooms.get(ch).add(ws);

      const hist = history.get(ch) || [];
      send(ws, { type: 'history', channel: ch, messages: hist });

      broadcast(ch, {
        type: 'presence', event: 'join',
        username: client.username, channel: ch, timestamp: Date.now(),
      }, ws);

      log(`[~] "${client.username}" joined #${ch}`);
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

      // Rate limiting
      client.msgCount++;
      if (client.msgCount > RATE_LIMIT) {
        send(ws, { type: 'error', message: 'Rate limited — slow down!' });
        return;
      }
      if (!client.rateClearTimer) {
        client.rateClearTimer = setTimeout(() => {
          client.msgCount     = 0;
          client.rateClearTimer = null;
        }, 3000);
      }

      const envelope = {
        type:       'message',
        id:         crypto.randomUUID(),
        channel:    ch,
        author:     client.username,
        ciphertext: msg.ciphertext,
        iv:         msg.iv,
        timestamp:  Date.now(),
      };

      const hist = history.get(ch);
      hist.push(envelope);
      if (hist.length > MAX_HISTORY) hist.shift();

      broadcast(ch, envelope);
      break;
    }

    // ── Voice presence ────────────────────────────────────────────

    case 'voice-join': {
      const ch = String(msg.channel || '').slice(0, 128);
      if (!ch) return;

      if (!voiceRooms.has(ch)) voiceRooms.set(ch, new Set());

      // Leave current voice first
      if (client.voiceChannel && client.voiceChannel !== ch) {
        handleVoiceLeave(ws, client, client.voiceChannel);
      }

      client.voiceChannel = ch;
      const vcRoom = voiceRooms.get(ch);

      // Tell joiner who's already here (so they can initiate WebRTC offers)
      send(ws, { type: 'voice-members', channel: ch, members: [...vcRoom] });

      vcRoom.add(client.username);

      // Broadcast to all clients so they can update voice participant lists
      broadcastAll({
        type: 'voice-presence', event: 'join',
        username: client.username, channel: ch, timestamp: Date.now(),
      });

      log(`[~] "${client.username}" joined voice #${ch}`);
      break;
    }

    case 'voice-leave': {
      const ch = String(msg.channel || client.voiceChannel || '');
      if (ch) handleVoiceLeave(ws, client, ch);
      break;
    }

    // ── WebRTC signaling relay ─────────────────────────────────────

    case 'signal': {
      const target   = String(msg.to || '').slice(0, 32);
      const targetWs = clientsByName.get(target);
      if (!targetWs) return;

      // Validate signal data is a plain object
      const data = msg.data;
      if (!data || typeof data !== 'object') return;

      send(targetWs, {
        type: 'signal',
        from: client.username,
        data,
      });
      break;
    }

    // ── Ping / keep-alive ─────────────────────────────────────────

    case 'ping': {
      send(ws, { type: 'pong', ts: Date.now() });
      break;
    }

    case 'admin-kick': {
      if (!ADMIN_SECRET || msg.secret !== ADMIN_SECRET) {
        send(ws, { type: 'error', message: 'Not authorized' });
        return;
      }
      const target = String(msg.target || '').slice(0, 32);
      const targetWs = clientsByName.get(target);
      if (targetWs) {
        send(targetWs, { type: 'kicked', reason: 'You were kicked by an admin.' });
        setTimeout(() => targetWs.close(), 200);
        log(`[ADMIN] "${client.username}" kicked "${target}"`);
      }
      break;
    }

    case 'admin-delete-message': {
      if (!ADMIN_SECRET || msg.secret !== ADMIN_SECRET) return;
      const dch = String(msg.channel || '').slice(0, 128);
      const did = String(msg.id || '').slice(0, 64);
      const dhist = history.get(dch);
      if (dhist) {
        const didx = dhist.findIndex(m => m.id === did);
        if (didx !== -1) dhist.splice(didx, 1);
      }
      broadcast(dch, { type: 'message-deleted', id: did, channel: dch });
      log(`[ADMIN] Message "${did}" deleted from #${dch} by "${client.username}"`);
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
  broadcastAll({
    type: 'voice-presence', event: 'leave',
    username: client.username, channel: ch, timestamp: Date.now(),
  });
  log(`[~] "${client.username}" left voice #${ch}`);
}

// ── User list ─────────────────────────────────────────────────────
function broadcastUserList() {
  const users = [...clients.values()].map(c => ({
    username:     c.username,
    voiceChannel: c.voiceChannel,
  }));
  broadcastAll({ type: 'users', users });
}

// ── Helpers ───────────────────────────────────────────────────────
function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(channel, data, exclude = null) {
  const room = rooms.get(channel);
  if (!room) return;
  const json = JSON.stringify(data);
  room.forEach(ws => {
    if (ws !== exclude && ws.readyState === WebSocket.OPEN) ws.send(json);
  });
}

function broadcastAll(data) {
  const json = JSON.stringify(data);
  clients.forEach((_, ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  });
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`${ts}  ${msg}`);
}

// ── Start ─────────────────────────────────────────────────────────
wss.on('listening', () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║      ThisCord WebSocket Server       ║');
  console.log('╚══════════════════════════════════════╝\n');
  console.log(`  ✓  Listening on  ws://localhost:${PORT}`);
  console.log(`  ✓  Channels:     ${DEFAULT_CHANNELS.join(', ')}`);
  console.log(`  ✓  Voice:        ${DEFAULT_VOICE.join(', ')}`);
  console.log(`  ✓  Encryption:   AES-256-GCM (client-side)`);
  console.log(`  ✓  Features:     WebRTC signaling, DMs, dynamic channels`);
  console.log(`\n  To expose publicly:`);
  console.log(`  → bore local ${PORT} --to bore.pub --port 53400`);
  console.log(`  → ws://bore.pub:53400\n`);
});
