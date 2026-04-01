'use strict';

// ═══════════════════════════════════════════════════════════════════
// ── CONFIG — edit these before distributing ────────────────────────
// ═══════════════════════════════════════════════════════════════════

/**
 * WebSocket server address.
 * • Local:  ws://localhost:3001
 * • Remote: wss://your-ngrok-id.ngrok-free.app   (run: ngrok http 3001)
 */
const WS_URL = 'ws://bore.pub:53400';

/**
 * Shared encryption secret.
 * Everyone using the same server MUST have the same value here.
 * The server NEVER sees this — it only relays encrypted ciphertext.
 * Change this before distributing your build.
 */
const CHANNEL_SECRET = '1c2e995f2d4ce44cfda608e875e0848542c9f2c2273fadef08550974027963fe';

// ─────────────────────────────────────────────────────────────────
// Auth config
// ─────────────────────────────────────────────────────────────────
const WEBSITE_LOGIN = 'https://welias123.github.io/thiscord/login.html';

// Will be set after auth
let MY_USERNAME = 'User';
let MY_DISC     = '0000';

function getOrCreateDiscriminator() {
  let disc = localStorage.getItem('tc-discriminator');
  if (!disc) {
    disc = String(Math.floor(Math.random() * 9999) + 1).padStart(4, '0');
    localStorage.setItem('tc-discriminator', disc);
  }
  return disc;
}

// ═══════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════
const state = {
  activeChannel: 'general',
  activeChannelType: 'text',
  micMuted: false,
  deafened: false,
  inVoice: false,
  voiceChannel: null,

  // Audio Lab
  micStream: null,
  micAudioCtx: null,
  micAnalyser: null,
  micAnimFrame: null,
  micGainNode: null,
  loopbackAudio: null,
  loopbackEnabled: false,

  // Screen share
  screenStream: null,
  selectedSourceId: null,

  // WebSocket
  ws: null,
  wsConnected: false,
  wsReconnectDelay: 1000,
  wsReconnectTimer: null,

  // Messages: channel → Array (decrypted, ready to render)
  messages: {
    general: [],
    announcements: [],
    'dev-talk': [],
    media: [],
  },

  // WebRTC voice
  peerConnections: new Map(),   // username → RTCPeerConnection
  remoteAudios: new Map(),      // username → <audio> element
  voiceMembers: new Set(),      // usernames currently in this voice channel

  // Online users (from server broadcasts)
  onlineUsers: [],

  // DMs
  dmConversations: {},   // username → Array of decrypted messages
  activeDm: null,        // username of active DM partner

  // Servers (persisted in localStorage)
  servers: JSON.parse(localStorage.getItem('tc-servers') || '[]'),
  activeServer: 'main',
};

const CHANNEL_TOPICS = {
  general: 'Welcome to ThisCord — the fastest way to communicate',
  announcements: 'Official announcements only',
  'dev-talk': 'Technical discussions and dev updates',
  media: 'Share screenshots, clips, and links',
};

// ═══════════════════════════════════════════════════════════════════
// DOM helpers
// ═══════════════════════════════════════════════════════════════════
const $  = (id) => document.getElementById(id);
const $$ = (sel, root = document) => root.querySelectorAll(sel);

function toast(msg, type = '') {
  let container = $('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast${type ? ' ' + type : ''}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ═══════════════════════════════════════════════════════════════════
// Encryption — AES-256-GCM via Web Crypto API
// ═══════════════════════════════════════════════════════════════════
const _keyCache = new Map();

/**
 * Derives a unique AES-256-GCM key per channel using PBKDF2.
 * Keys are cached so derivation only runs once per channel per session.
 */
async function getChannelKey(channel) {
  if (_keyCache.has(channel)) return _keyCache.get(channel);

  const passphrase  = CHANNEL_SECRET + ':' + channel;
  const saltStr     = 'thiscord-v1-' + channel;

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name:       'PBKDF2',
      salt:       new TextEncoder().encode(saltStr),
      iterations: 100_000,
      hash:       'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  _keyCache.set(channel, key);
  return key;
}

/** Encrypt plaintext → { ciphertext (base64), iv (base64) } */
async function encryptMsg(plaintext, channel) {
  const key = await getChannelKey(channel);
  const iv  = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );

  return {
    ciphertext: bufToB64(encrypted),
    iv:         bufToB64(iv.buffer),
  };
}

/** Decrypt { ciphertext (base64), iv (base64) } → plaintext */
async function decryptMsg(ciphertext, iv, channel) {
  const key    = await getChannelKey(channel);
  const ctBuf  = b64ToBuf(ciphertext);
  const ivBuf  = b64ToBuf(iv);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(ivBuf) },
    key,
    ctBuf
  );

  return new TextDecoder().decode(decrypted);
}

function bufToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b64ToBuf(b64) {
  const binary = atob(b64);
  const buf    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

// ═══════════════════════════════════════════════════════════════════
// WebSocket Client
// ═══════════════════════════════════════════════════════════════════
function setupWebSocket() {
  connectWS();
}

function connectWS() {
  if (state.ws && state.ws.readyState <= 1) return; // already connecting/open

  let ws;
  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.warn('WS connect failed:', err.message);
    scheduleReconnect();
    return;
  }

  state.ws = ws;

  ws.addEventListener('open', () => {
    state.wsConnected = true;
    state.wsReconnectDelay = 1000;
    updateConnectionStatus(true);

    // Authenticate
    wsSend({ type: 'auth', username: MY_USERNAME });

    // Join the active channel
    wsSend({ type: 'join', channel: state.activeChannel });

    toast('Connected to server', 'success');
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleWsMsg(msg);
  });

  ws.addEventListener('close', () => {
    state.wsConnected = false;
    updateConnectionStatus(false);
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // 'close' fires right after, so reconnect is handled there
  });

  // Heartbeat ping every 25s to keep connection alive through ngrok/proxies
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      wsSend({ type: 'ping' });
    } else {
      clearInterval(pingInterval);
    }
  }, 25_000);
}

function scheduleReconnect() {
  clearTimeout(state.wsReconnectTimer);
  state.wsReconnectTimer = setTimeout(() => {
    console.log(`[WS] Reconnecting (delay: ${state.wsReconnectDelay}ms)...`);
    connectWS();
    state.wsReconnectDelay = Math.min(state.wsReconnectDelay * 2, 30_000);
  }, state.wsReconnectDelay);
}

function wsSend(data) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(data));
  }
}

async function handleWsMsg(msg) {
  switch (msg.type) {

    case 'welcome':
      console.log('[WS] Server:', msg.message);
      break;

    case 'auth-ok':
      console.log('[WS] Authenticated as:', msg.username);
      break;

    case 'history': {
      const ch   = msg.channel;
      const msgs = msg.messages || [];
      // Decrypt all history messages
      const decrypted = await Promise.all(msgs.map(m => decryptEnvelope(m)));
      state.messages[ch] = decrypted.filter(Boolean);
      if (ch === state.activeChannel) renderMessages();
      break;
    }

    case 'message': {
      const ch  = msg.channel;
      const dec = await decryptEnvelope(msg);
      if (!dec) return;

      if (!state.messages[ch]) state.messages[ch] = [];
      state.messages[ch].push(dec);

      if (ch.startsWith('dm:')) {
        onDmMessage(ch, dec);
      } else if (ch === state.activeChannel) {
        appendMessage(dec);
        showNotification(`#${ch}`, `${dec.author}: ${dec.text?.slice(0, 80) || ''}`);
      } else {
        markUnread(ch);
        showNotification(`#${ch}`, `${dec.author}: ${dec.text?.slice(0, 80) || ''}`);
      }
      break;
    }

    case 'presence': {
      const { event, username, channel } = msg;
      if (event === 'join' && username !== MY_USERNAME) {
        toast(`${username} joined #${channel}`);
        showNotification(`#${channel}`, `${username} joined the channel`);
      }
      break;
    }

    case 'users': {
      state.onlineUsers = msg.users || [];
      renderOnlineUsers();
      break;
    }

    case 'voice-members': {
      // Server sends existing voice members when we first join
      handleVoiceMembersList(msg.channel, msg.members || []);
      break;
    }

    case 'voice-presence': {
      handleVoicePresence(msg);
      break;
    }

    case 'signal': {
      handleRTCSignal(msg.from, msg.data);
      break;
    }

    case 'error':
      toast(msg.message || 'Server error', 'error');
      break;

    case 'pong':
      break;

    case 'kicked': {
      toast(`⛔ ${msg.reason || 'You were kicked.'}`, 'error');
      setTimeout(() => { state.ws?.close(); showLoginScreen(); }, 1500);
      break;
    }

    case 'message-deleted': {
      const delId = msg.id;
      document.querySelectorAll(`[data-msg-id="${delId}"]`).forEach(el => {
        el.style.transition = 'opacity 0.3s';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 310);
      });
      break;
    }

    default: break;
  }
}

/** Decrypt a server message envelope into a renderable object */
async function decryptEnvelope(envelope) {
  try {
    const plaintext = await decryptMsg(envelope.ciphertext, envelope.iv, envelope.channel);
    const time = new Date(envelope.timestamp).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit',
    });
    return {
      id:     envelope.id,
      author: envelope.author,
      avatar: envelope.author.charAt(0).toUpperCase(),
      tag:    envelope.author === MY_USERNAME ? 'self' : 'other',
      time,
      text:   plaintext,
    };
  } catch (err) {
    // Decryption failed = wrong key or corrupted message
    console.warn('[Crypto] Decryption failed:', err.message);
    return null;
  }
}

function updateConnectionStatus(connected) {
  const dot   = $('status-dot');
  const label = $('user-status-text');
  if (connected) {
    dot.className   = 'status-dot online';
    label.textContent = 'Online';
  } else {
    dot.className   = 'status-dot offline';
    label.textContent = 'Connecting...';
  }
}

function markUnread(channel) {
  const btn = document.querySelector(`.channel[data-channel="${channel}"]`);
  if (!btn || btn.classList.contains('active')) return;
  if (!btn.querySelector('.unread-badge')) {
    const badge = document.createElement('span');
    badge.className = 'unread-badge';
    badge.textContent = '•';
    btn.appendChild(badge);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Auth — Login, Session, Profile
// ═══════════════════════════════════════════════════════════════════

function checkAuth() {
  // Simple username-based login (persistent, no expiry)
  const savedName = localStorage.getItem('tc-username');
  if (savedName) {
    applyUsername(savedName);
    return;
  }
  // Fallback: OAuth session
  const session = getStoredSession();
  if (session && !isSessionExpired(session)) {
    applySession(session);
  } else {
    localStorage.removeItem('tc-session');
    showLoginScreen();
  }
}

// ── Hardcoded admin identity ──────────────────────────────────────
const ADMIN_USERNAME = 'Elias';
const ADMIN_KEY      = 'tc$3li4s-PRIME-2k26!';   // must match server-config.json

function applyUsername(name) {
  MY_DISC     = getOrCreateDiscriminator();
  MY_USERNAME = `${name}#${MY_DISC}`;

  // Auto-grant admin if this is the owner's device
  if (name.toLowerCase() === ADMIN_USERNAME.toLowerCase()) {
    localStorage.setItem('tc-admin-key', ADMIN_KEY);
  }

  $('username-display').textContent    = name;
  $('user-disc-display').textContent   = `#${MY_DISC}`;
  $('user-avatar').textContent         = name[0].toUpperCase();
  $('user-status-text').textContent    = 'Online';
  $('members-self-avatar').textContent = name[0].toUpperCase();
  $('members-self-name').textContent   = MY_USERNAME;
  // Show crown only if actually admin
  const roleEl = $('self-member-role');
  if (roleEl) roleEl.textContent = isAdmin() ? '👑 Admin' : '';
  $('profile-display-name').textContent = MY_USERNAME;
  $('profile-email-el').textContent    = '—';
  $('profile-avatar-el').textContent   = name[0].toUpperCase();
  $('profile-since').textContent       = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long' });

  // Titlebar profile chip
  $('tb-profile-avatar').textContent = name[0].toUpperCase();
  $('tb-profile-name').textContent   = name;
  const chip = $('tb-profile-chip');
  chip.style.display = 'flex';
  if (!chip.dataset.bound) {
    chip.addEventListener('click', openProfileModal);
    chip.dataset.bound = '1';
  }

  hideLoginScreen();
  initApp();
}

function getStoredSession() {
  try { return JSON.parse(localStorage.getItem('tc-session')); }
  catch { return null; }
}

function isSessionExpired(session) {
  if (!session.expiresAt) return false;
  return Date.now() > session.expiresAt * 1000 - 60_000; // 1 min buffer
}

function isAdmin() {
  return !!localStorage.getItem('tc-admin-key');
}

function showLoginScreen() {
  $('login-screen').style.display = 'flex';
}

function hideLoginScreen() {
  const el = $('login-screen');
  el.style.transition = 'opacity 0.4s ease';
  el.style.opacity = '0';
  setTimeout(() => { el.style.display = 'none'; el.style.opacity = '1'; }, 400);
}

function applySession(session) {
  const user     = session.user || {};
  const baseName = user.name || user.email?.split('@')[0] || 'User';
  MY_DISC        = getOrCreateDiscriminator();
  MY_USERNAME    = `${baseName}#${MY_DISC}`;

  // Update user panel
  $('username-display').textContent    = baseName;
  $('user-disc-display').textContent   = `#${MY_DISC}`;
  $('user-avatar').textContent         = baseName[0].toUpperCase();
  $('user-status-text').textContent    = 'Online';

  // Update members panel self-entry
  $('members-self-avatar').textContent = baseName[0].toUpperCase();
  $('members-self-name').textContent   = MY_USERNAME;

  // Update profile modal fields
  $('profile-display-name').textContent = MY_USERNAME;
  $('profile-email-el').textContent     = user.email || '—';
  $('profile-avatar-el').textContent    = baseName[0].toUpperCase();

  const provider = user.provider || 'oauth';
  const providerEmoji = provider === 'google' ? '🔵 Google' : provider === 'github' ? '⚫ GitHub' : '🔗 OAuth';
  $('profile-provider-badge').textContent = providerEmoji;

  if (session.createdAt) {
    $('profile-since').textContent = new Date(session.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } else {
    $('profile-since').textContent = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
  }

  // If avatar URL from OAuth provider, show image
  if (user.avatar_url) {
    const img = document.createElement('img');
    img.src = user.avatar_url;
    img.onerror = () => { $('profile-avatar-el').textContent = MY_USERNAME[0].toUpperCase(); };
    $('profile-avatar-el').textContent = '';
    $('profile-avatar-el').appendChild(img);
  }

  // Titlebar profile chip
  $('tb-profile-avatar').textContent = baseName[0].toUpperCase();
  $('tb-profile-name').textContent   = baseName;
  const chipEl = $('tb-profile-chip');
  chipEl.style.display = 'flex';
  if (!chipEl.dataset.bound) {
    chipEl.addEventListener('click', openProfileModal);
    chipEl.dataset.bound = '1';
  }

  hideLoginScreen();

  // Now init everything that needs auth
  initApp();
}

function handleAuthCallback(rawUrl) {
  // URL format: thiscord://auth/callback#access_token=...&refresh_token=...&expires_in=...
  try {
    const hashPart    = rawUrl.includes('#') ? rawUrl.split('#')[1] : rawUrl.split('?')[1] || '';
    const params      = new URLSearchParams(hashPart);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const expiresIn   = parseInt(params.get('expires_in') || '3600', 10);

    if (!accessToken) {
      toast('Authentication failed — no token received', 'error');
      return;
    }

    const user = decodeJWT(accessToken);
    const session = {
      accessToken,
      refreshToken,
      expiresAt:  Math.floor(Date.now() / 1000) + expiresIn,
      createdAt:  Date.now(),
      user,
    };

    localStorage.setItem('tc-session', JSON.stringify(session));
    applySession(session);
    toast(`Welcome, ${user.name || user.email}! 🎉`, 'success');
  } catch (err) {
    console.error('Auth callback error:', err);
    toast('Authentication error: ' + err.message, 'error');
  }
}

function decodeJWT(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return {
      id:         payload.sub,
      email:      payload.email,
      name:       payload.user_metadata?.full_name || payload.user_metadata?.name || payload.user_metadata?.user_name || payload.email?.split('@')[0],
      avatar_url: payload.user_metadata?.avatar_url || payload.user_metadata?.picture,
      provider:   payload.app_metadata?.provider,
    };
  } catch {
    return { email: 'unknown@user', name: 'User' };
  }
}

function signOut() {
  localStorage.removeItem('tc-session');
  localStorage.removeItem('tc-username');
  state.ws?.close();
  state.wsConnected = false;

  $('username-display').textContent  = 'User';
  $('user-avatar').textContent       = '?';
  $('tb-profile-chip').style.display = 'none';
  closeProfileModal();

  showLoginScreen();
  toast('Signed out 👋');
}

// ── Profile Modal ─────────────────────────────────────────────────
function setupProfileModal() {
  // Open via user avatar in panel
  $('user-avatar').style.cursor = 'pointer';
  $('user-avatar').addEventListener('click', openProfileModal);
  $('self-member-item').addEventListener('click', openProfileModal);

  $('profile-close').addEventListener('click', closeProfileModal);
  $('profile-overlay').addEventListener('click', e => {
    if (e.target === $('profile-overlay')) closeProfileModal();
  });

  $('profile-signout').addEventListener('click', signOut);
}

function openProfileModal()  { $('profile-overlay').classList.add('open'); }
function closeProfileModal() { $('profile-overlay').classList.remove('open'); }

// ── Login Screen buttons ──────────────────────────────────────────
function setupLoginScreen() {
  $('login-btn-min').addEventListener('click', () => window.electronAPI?.minimize());
  $('login-btn-max').addEventListener('click', () => window.electronAPI?.maximize());
  $('login-btn-close').addEventListener('click', () => window.electronAPI?.close());

  const input  = $('login-name-input');
  const btn    = $('login-enter-btn');

  function doEnter() {
    const name = input.value.trim().replace(/[#]/g, '').slice(0, 32);
    if (!name) { input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 400); return; }
    localStorage.setItem('tc-username', name);
    applyUsername(name);
  }

  btn.addEventListener('click', doEnter);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doEnter(); });
  input.focus();

  // Still listen for OAuth deep-link callbacks (fallback)
  window.electronAPI?.onAuthCallback?.((url) => handleAuthCallback(url));
}

// ═══════════════════════════════════════════════════════════════════
// Titlebar
// ═══════════════════════════════════════════════════════════════════
function setupTitlebar() {
  $('btn-min').addEventListener('click', () => window.electronAPI?.minimize());
  $('btn-max').addEventListener('click', () => window.electronAPI?.maximize());
  $('btn-close').addEventListener('click', () => window.electronAPI?.close());
}

// ═══════════════════════════════════════════════════════════════════
// Channel Navigation
// ═══════════════════════════════════════════════════════════════════
function setupChannels() {
  $$('.channel').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ch   = btn.dataset.channel;
      const type = btn.dataset.type;

      $$('.channel').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      btn.querySelector('.unread-badge')?.remove();

      if (type === 'text') {
        // Leave old channel on server
        if (state.activeChannel !== ch) {
          wsSend({ type: 'leave', channel: state.activeChannel });
        }

        state.activeChannel      = ch;
        state.activeChannelType  = 'text';

        $('active-ch-name').textContent  = ch;
        $('msg-input').placeholder       = `Message #${ch}`;
        $('active-ch-topic').textContent = CHANNEL_TOPICS[ch] || '';

        showView('view-chat');

        // Join new channel and get history from server
        if (state.wsConnected) {
          state.messages[ch] = []; // clear stale local data; history comes from server
          renderMessages(); // show empty while loading
          wsSend({ type: 'join', channel: ch });
        } else {
          renderMessages();
        }

      } else if (type === 'voice') {
        joinVoice(ch);
      }
    });
  });
}

function showView(id) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $(id)?.classList.add('active');
}

// ═══════════════════════════════════════════════════════════════════
// Chat — Render
// ═══════════════════════════════════════════════════════════════════
function renderMessages() {
  const container = $('messages');
  container.innerHTML = '';
  const msgs = state.messages[state.activeChannel] || [];

  const sys = document.createElement('div');
  sys.className   = 'msg-system';
  sys.textContent = msgs.length === 0
    ? `This is the beginning of #${state.activeChannel} — no messages yet`
    : `This is the beginning of #${state.activeChannel}`;
  container.appendChild(sys);

  msgs.forEach((msg, i) => {
    const prev = msgs[i - 1];
    const isContinuation = prev && prev.author === msg.author;
    appendMessageEl(container, msg, isContinuation);
  });

  scrollToBottom();
}

/** Append a single decrypted message to the messages container */
function appendMessage(msg) {
  const container = $('messages');
  const msgs      = state.messages[state.activeChannel] || [];
  const prev      = msgs[msgs.length - 2]; // new message is already pushed
  const isCont    = prev && prev.author === msg.author;
  appendMessageEl(container, msg, isCont);
  scrollToBottom();
}

function appendMessageEl(container, msg, isContinuation) {
  const adminBtn = isAdmin() && msg.id
    ? `<button class="msg-del-btn" title="Delete">✕</button>`
    : '';

  if (isContinuation) {
    const cont = document.createElement('div');
    cont.className = 'msg-continuation';
    if (msg.id) cont.dataset.msgId = msg.id;
    cont.innerHTML = `
      <span class="msg-time-hover">${escapeHtml(msg.time)}</span>
      <span class="msg-text">${escapeHtml(msg.text)}</span>
      ${adminBtn}
    `;
    if (isAdmin() && msg.id) {
      cont.querySelector('.msg-del-btn').addEventListener('click', e => {
        e.stopPropagation();
        adminDeleteMsg(msg.id, msg.channel || state.activeChannel);
      });
    }
    container.appendChild(cont);
  } else {
    const group = document.createElement('div');
    group.className = 'msg-group';
    if (msg.id) group.dataset.msgId = msg.id;
    const authorClass = msg.tag === 'self' ? '' : 'other-name';
    group.innerHTML = `
      <div class="msg-avatar">${escapeHtml(msg.avatar)}</div>
      <div class="msg-content">
        <div class="msg-meta">
          <span class="msg-author ${authorClass}">${escapeHtml(msg.author)}</span>
          <span class="msg-time">${escapeHtml(msg.time)}</span>
          ${adminBtn}
        </div>
        <span class="msg-text">${escapeHtml(msg.text)}</span>
      </div>
    `;
    if (isAdmin() && msg.id) {
      group.querySelector('.msg-del-btn').addEventListener('click', e => {
        e.stopPropagation();
        adminDeleteMsg(msg.id, msg.channel || state.activeChannel);
      });
    }
    container.appendChild(group);
  }
}

function adminDeleteMsg(id, channel) {
  const secret = localStorage.getItem('tc-admin-key');
  if (!secret || !id) return;
  wsSend({ type: 'admin-delete-message', id, channel, secret });
}

function adminKick(username) {
  const secret = localStorage.getItem('tc-admin-key');
  if (!secret) return;
  if (!confirm(`Kick ${username}?`)) return;
  wsSend({ type: 'admin-kick', target: username, secret });
  toast(`Kicked ${username}`);
}

function scrollToBottom() {
  const c = $('messages');
  c.scrollTop = c.scrollHeight;
}

// ═══════════════════════════════════════════════════════════════════
// Chat — Send
// ═══════════════════════════════════════════════════════════════════
function setupChat() {
  const input   = $('msg-input');
  const sendBtn = $('send-btn');

  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    if (state.wsConnected) {
      try {
        const { ciphertext, iv } = await encryptMsg(text, state.activeChannel);
        wsSend({
          type:       'message',
          channel:    state.activeChannel,
          ciphertext,
          iv,
        });
        // Do NOT render locally — wait for server echo so all clients (including us) get the same flow
      } catch (err) {
        console.error('Encryption failed:', err);
        toast('Failed to encrypt message', 'error');
      }
    } else {
      // Offline fallback — local only, not sent to server
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const msg  = { id: Date.now(), author: MY_USERNAME, avatar: MY_USERNAME[0], tag: 'self', time, text };
      if (!state.messages[state.activeChannel]) state.messages[state.activeChannel] = [];
      state.messages[state.activeChannel].push(msg);
      appendMessage(msg);
      toast('Offline — message not sent to server', 'error');
    }
  }

  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════════════════
// User Panel — mic & deafen toggles
// ═══════════════════════════════════════════════════════════════════
function setupUserPanel() {
  $('mic-btn').addEventListener('click', toggleMic);
  $('deaf-btn').addEventListener('click', toggleDeafen);
}

function toggleMic() {
  state.micMuted = !state.micMuted;
  $('mic-btn').classList.toggle('muted', state.micMuted);
  if (state.micStream) {
    state.micStream.getAudioTracks().forEach(t => { t.enabled = !state.micMuted; });
  }
  toast(state.micMuted ? 'Microphone muted' : 'Microphone unmuted');
}

function toggleDeafen() {
  state.deafened = !state.deafened;
  $('deaf-btn').classList.toggle('muted', state.deafened);
  if (state.loopbackAudio) state.loopbackAudio.muted = state.deafened;
  toast(state.deafened ? 'Deafened' : 'Undeafened');
}

// ═══════════════════════════════════════════════════════════════════
// Settings Modal
// ═══════════════════════════════════════════════════════════════════
function setupSettings() {
  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-overlay').addEventListener('click', e => {
    if (e.target === $('settings-overlay')) closeSettings();
  });

  $$('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.settings-tab').forEach(t => t.classList.remove('active'));
      $$('.settings-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $(`panel-${tab.dataset.tab}`)?.classList.add('active');
    });
  });

  $('preview-screen-btn').addEventListener('click', openPicker);

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); openSettings(); }
    if (e.key === 'Escape') { closeSettings(); closePicker(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'm') { e.preventDefault(); toggleMic(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'd') { e.preventDefault(); toggleDeafen(); }
  });
}

function openSettings()  { $('settings-overlay').classList.add('open'); }
function closeSettings() { $('settings-overlay').classList.remove('open'); }

// ═══════════════════════════════════════════════════════════════════
// Audio Lab — Device Enumeration
// ═══════════════════════════════════════════════════════════════════
async function populateDevices() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    const devices = await navigator.mediaDevices.enumerateDevices();

    const inputSel  = $('input-device');
    const outputSel = $('output-device');
    const cameraSel = $('camera-device');

    inputSel.innerHTML = outputSel.innerHTML = cameraSel.innerHTML = '';
    let inputs = 0, outputs = 0, cameras = 0;

    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value       = d.deviceId;
      opt.textContent = d.label || `Device ${d.deviceId.slice(0, 8)}`;

      if (d.kind === 'audioinput')  { inputSel.appendChild(opt);               inputs++;  }
      if (d.kind === 'audiooutput') { outputSel.appendChild(opt.cloneNode(true)); outputs++; }
      if (d.kind === 'videoinput')  { cameraSel.appendChild(opt.cloneNode(true)); cameras++; }
    });

    if (!inputs)  inputSel.innerHTML  = '<option>No microphones found</option>';
    if (!outputs) outputSel.innerHTML = '<option>Default output</option>';
    if (!cameras) cameraSel.innerHTML = '<option>No cameras found</option>';

    tmp?.getTracks().forEach(t => t.stop());
    navigator.mediaDevices.addEventListener('devicechange', populateDevices);
  } catch (err) {
    console.warn('Device enumeration failed:', err);
    toast('Could not access audio devices', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════
// Audio Lab — Mic Test + Volume Meter
// ═══════════════════════════════════════════════════════════════════
function setupAudioLab() {
  $('start-mic-test').addEventListener('click', startMicTest);
  $('stop-mic-test').addEventListener('click', stopMicTest);
  setupLoopback();
  setupVolumeSliders();
}

async function startMicTest() {
  if (state.micStream) return;
  try {
    const deviceId   = $('input-device').value;
    const constraints = { audio: deviceId ? { deviceId: { exact: deviceId } } : true };
    state.micStream  = await navigator.mediaDevices.getUserMedia(constraints);

    state.micAudioCtx = new AudioContext();
    const source      = state.micAudioCtx.createMediaStreamSource(state.micStream);

    state.micGainNode = state.micAudioCtx.createGain();
    state.micGainNode.gain.value = $('input-vol').value / 100;

    state.micAnalyser = state.micAudioCtx.createAnalyser();
    state.micAnalyser.fftSize = 256;
    state.micAnalyser.smoothingTimeConstant = 0.7;

    source.connect(state.micGainNode);
    state.micGainNode.connect(state.micAnalyser);

    if (state.loopbackEnabled) enableLoopback();

    startVolumeMeterLoop();
    $('start-mic-test').disabled = true;
    $('start-mic-test').classList.add('dim');
    $('stop-mic-test').disabled  = false;
    $('stop-mic-test').classList.remove('dim');
    toast('Mic test started', 'success');
  } catch {
    toast('Microphone access denied', 'error');
  }
}

function stopMicTest() {
  cancelAnimationFrame(state.micAnimFrame);
  state.micStream?.getTracks().forEach(t => t.stop());
  state.micStream = null;
  state.micAudioCtx?.close();
  state.micAudioCtx = null;
  if (state.loopbackAudio) state.loopbackAudio.srcObject = null;

  $('vol-bar').style.width  = '0%';
  $('vol-label').textContent = '0%';
  $('start-mic-test').disabled = false;
  $('start-mic-test').classList.remove('dim');
  $('stop-mic-test').disabled  = true;
  $('stop-mic-test').classList.add('dim');
  toast('Mic test stopped');
}

function startVolumeMeterLoop() {
  const data = new Uint8Array(state.micAnalyser.frequencyBinCount);
  const bar  = $('vol-bar');
  const lbl  = $('vol-label');
  function tick() {
    state.micAnalyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const pct = Math.min(100, Math.round((avg / 100) * 100));
    bar.style.width    = pct + '%';
    lbl.textContent    = pct + '%';
    bar.style.filter   = pct > 80 ? 'hue-rotate(40deg)' : '';
    state.micAnimFrame = requestAnimationFrame(tick);
  }
  tick();
}

// ═══════════════════════════════════════════════════════════════════
// Audio Lab — Loopback
// ═══════════════════════════════════════════════════════════════════
function setupLoopback() {
  const toggle = $('loopback-toggle');
  toggle.addEventListener('click', () => {
    state.loopbackEnabled = !state.loopbackEnabled;
    toggle.classList.toggle('on', state.loopbackEnabled);
    toggle.setAttribute('aria-checked', String(state.loopbackEnabled));
    if (state.loopbackEnabled && state.micStream) {
      enableLoopback();
      toast('Loopback on — use headphones to avoid feedback!');
    } else {
      disableLoopback();
      toast('Loopback disabled');
    }
  });
}

function enableLoopback() {
  if (!state.micStream) return;
  if (!state.loopbackAudio) {
    state.loopbackAudio = new Audio();
    state.loopbackAudio.muted = state.deafened;
    document.body.appendChild(state.loopbackAudio);
  }
  state.loopbackAudio.srcObject = state.micStream;
  state.loopbackAudio.play().catch(console.warn);
}

function disableLoopback() {
  if (state.loopbackAudio) state.loopbackAudio.srcObject = null;
}

// ═══════════════════════════════════════════════════════════════════
// Audio Lab — Volume Sliders
// ═══════════════════════════════════════════════════════════════════
function setupVolumeSliders() {
  const inputVol = $('input-vol');
  const inputVal = $('input-vol-val');
  inputVol.addEventListener('input', () => {
    inputVal.textContent = inputVol.value + '%';
    if (state.micGainNode) state.micGainNode.gain.value = inputVol.value / 100;
  });

  const outputVol = $('output-vol');
  const outputVal = $('output-vol-val');
  outputVol.addEventListener('input', () => {
    outputVal.textContent = outputVol.value + '%';
    if (state.loopbackAudio) state.loopbackAudio.volume = outputVol.value / 100;
  });
}

// ═══════════════════════════════════════════════════════════════════
// Screen Share
// ═══════════════════════════════════════════════════════════════════
function setupScreenShare() {
  $('share-screen-btn').addEventListener('click', openPicker);
  $('vc-screen-btn').addEventListener('click', openPicker);
  $('picker-close').addEventListener('click', closePicker);
  $('picker-cancel').addEventListener('click', closePicker);
  $('picker-overlay').addEventListener('click', e => {
    if (e.target === $('picker-overlay')) closePicker();
  });
  $('picker-share').addEventListener('click', startSharing);
  $('stop-share-btn').addEventListener('click', stopSharing);

  // Fullscreen button
  $('screen-fullscreen-btn').addEventListener('click', toggleScreenFullscreen);

  // Double-click the preview to also go fullscreen
  $('vc-screen-preview').addEventListener('dblclick', toggleScreenFullscreen);
}

function toggleScreenFullscreen() {
  const el = $('vc-screen-preview');
  if (!document.fullscreenElement) {
    el.requestFullscreen().catch(err => {
      toast('Fullscreen not available: ' + err.message, 'error');
    });
  } else {
    document.exitFullscreen();
  }
}

async function openPicker() {
  const grid = $('sources-grid');
  grid.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px">Loading sources...</div>';
  $('picker-overlay').classList.add('open');
  $('picker-share').disabled = true;
  state.selectedSourceId = null;

  try {
    const sources = await window.electronAPI.getCaptureSources();
    grid.innerHTML = '';
    if (!sources.length) {
      grid.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px">No sources found.</div>';
      return;
    }
    sources.forEach(src => {
      const item  = document.createElement('div');
      item.className     = 'source-item';
      item.dataset.sourceId = src.id;
      item.innerHTML = `
        <img class="source-thumb" src="${src.thumbnail}" alt="${escapeHtml(src.name)}">
        <div class="source-name">${escapeHtml(src.name)}</div>
      `;
      item.addEventListener('click', () => {
        $$('.source-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        state.selectedSourceId = src.id;
        $('picker-share').disabled = false;
      });
      grid.appendChild(item);
    });
  } catch (err) {
    grid.innerHTML = `<div style="color:var(--red);font-size:13px;padding:8px">Failed: ${escapeHtml(err.message)}</div>`;
  }
}

function closePicker() {
  $('picker-overlay').classList.remove('open');
}

async function startSharing() {
  if (!state.selectedSourceId) return;
  closePicker();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource:   'desktop',
          chromeMediaSourceId: state.selectedSourceId,
          maxWidth:  1920,
          maxHeight: 1080,
          maxFrameRate: 30,
          minFrameRate: 30,
        },
      },
    });
    state.screenStream = stream;

    const settingsPrev = $('screen-preview-vid');
    settingsPrev.srcObject = stream;
    settingsPrev.style.display = 'block';

    $('vc-screen-preview').srcObject = stream;
    $('vc-screen-preview-wrap').style.display = 'flex';
    $('vc-screen-btn').classList.add('active');
    $('share-screen-btn').classList.add('active');

    stream.getVideoTracks()[0].addEventListener('ended', stopSharing);
    toast('Screen sharing started — 30 FPS', 'success');
  } catch (err) {
    toast('Screen capture failed: ' + err.message, 'error');
  }
}

function stopSharing() {
  state.screenStream?.getTracks().forEach(t => t.stop());
  state.screenStream = null;
  const prev = $('screen-preview-vid');
  prev.srcObject = null;
  prev.style.display = 'none';
  $('vc-screen-preview-wrap').style.display = 'none';
  $('vc-screen-preview').srcObject = null;
  $('vc-screen-btn').classList.remove('active');
  $('share-screen-btn').classList.remove('active');
  toast('Screen sharing stopped');
}

// ═══════════════════════════════════════════════════════════════════
// Voice Channels
// ═══════════════════════════════════════════════════════════════════
function joinVoice(channelName) {
  state.inVoice      = true;
  state.voiceChannel = channelName;

  $('voice-ch-name').textContent = channelName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  updateVoiceParticipantsUI();
  showView('view-voice');

  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      state.micStream = stream;
      stream.getAudioTracks().forEach(t => { t.enabled = !state.micMuted; });
      // Tell server we joined voice — server will reply with voice-members
      wsSend({ type: 'voice-join', channel: channelName });
      toast(`Joined ${channelName}`, 'success');
    })
    .catch(() => {
      // Still join without mic
      wsSend({ type: 'voice-join', channel: channelName });
      toast(`Joined ${channelName} (no mic)`, 'success');
    });

  setupVoiceControls();
}

function leaveVoice() {
  wsSend({ type: 'voice-leave', channel: state.voiceChannel });
  cleanupAllPeerConnections();

  state.inVoice      = false;
  state.voiceChannel = null;
  state.micStream?.getTracks().forEach(t => t.stop());
  state.micStream = null;
  if (state.screenStream) stopSharing();
  showView('view-chat');
  $$('.channel').forEach(b => b.classList.remove('active'));
  document.querySelector(`.channel[data-channel="${state.activeChannel}"]`)?.classList.add('active');
  toast('Disconnected from voice');
}

function setupVoiceControls() {
  $('vc-disconnect').onclick = leaveVoice;

  $('vc-mic-btn').onclick = () => {
    toggleMic();
    const btn = $('vc-mic-btn');
    btn.classList.toggle('danger', state.micMuted);
    btn.querySelector('span').textContent = state.micMuted ? 'Mic Off' : 'Mic On';
  };

  $('vc-cam-btn').onclick = async () => {
    const btn = $('vc-cam-btn');
    if (btn.classList.contains('active')) {
      btn.classList.remove('active');
      btn.querySelector('span').textContent = 'Camera';
      toast('Camera stopped');
    } else {
      try {
        await navigator.mediaDevices.getUserMedia({ video: true });
        btn.classList.add('active');
        btn.querySelector('span').textContent = 'Camera On';
        toast('Camera on', 'success');
      } catch { toast('Camera access denied', 'error'); }
    }
  };
}

// ═══════════════════════════════════════════════════════════════════
// Members panel toggle
// ═══════════════════════════════════════════════════════════════════
function setupMembersToggle() {
  $('members-toggle-btn').addEventListener('click', () => {
    $('members-panel').classList.toggle('hidden');
    $('members-toggle-btn').classList.toggle('active');
  });
}

// ═══════════════════════════════════════════════════════════════════
// Desktop Notifications
// ═══════════════════════════════════════════════════════════════════
function setupNotifications() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function showNotification(title, body) {
  if (!document.hidden) return; // only notify when window not focused
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(`ThisCord — ${title}`, { body, icon: '' });
  } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════════
// WebRTC Voice
// ═══════════════════════════════════════════════════════════════════
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ],
};

// Queue ICE candidates that arrive before setRemoteDescription is done
const pendingCandidates = new Map(); // username → RTCIceCandidate[]

function createPeerConnection(remoteUsername) {
  if (state.peerConnections.has(remoteUsername)) {
    state.peerConnections.get(remoteUsername).close();
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.peerConnections.set(remoteUsername, pc);

  // Add local mic stream tracks
  if (state.micStream) {
    state.micStream.getAudioTracks().forEach(t => pc.addTrack(t, state.micStream));
  }

  // When we receive remote audio
  pc.ontrack = (event) => {
    if (!event.streams || !event.streams[0]) return;
    let audio = state.remoteAudios.get(remoteUsername);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      audio.style.display = 'none';
      document.body.appendChild(audio);
      state.remoteAudios.set(remoteUsername, audio);
    }
    audio.srcObject = event.streams[0];
    audio.muted = !!state.deafened;
    audio.play().catch(() => {});   // force play in Electron
    updateVoiceParticipantsUI();
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      wsSend({ type: 'signal', to: remoteUsername, data: { type: 'candidate', candidate: event.candidate } });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      removePeerConnection(remoteUsername);
    }
  };

  return pc;
}

function removePeerConnection(username) {
  const pc = state.peerConnections.get(username);
  if (pc) { pc.close(); state.peerConnections.delete(username); }
  const audio = state.remoteAudios.get(username);
  if (audio) { audio.srcObject = null; audio.remove(); state.remoteAudios.delete(username); }
  pendingCandidates.delete(username);
}

function cleanupAllPeerConnections() {
  state.peerConnections.forEach((_, username) => removePeerConnection(username));
  state.voiceMembers.clear();
}

/** Called when server tells us who's already in the voice channel */
async function handleVoiceMembersList(channel, members) {
  if (channel !== state.voiceChannel) return;
  state.voiceMembers = new Set(members);
  updateVoiceParticipantsUI();

  // We just joined — send offers to all existing members
  for (const member of members) {
    if (member === MY_USERNAME) continue;
    const pc = createPeerConnection(member);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsSend({ type: 'signal', to: member, data: { type: 'offer', sdp: offer } });
    } catch (err) {
      console.warn('[RTC] Offer failed:', err.message);
    }
  }
}

/** Called when someone joins or leaves a voice channel */
function handleVoicePresence(msg) {
  const { event, username, channel } = msg;

  if (event === 'join') {
    if (channel === state.voiceChannel && username !== MY_USERNAME) {
      state.voiceMembers.add(username);
      toast(`${username} joined voice`);
      showNotification(`Voice — ${channel}`, `${username} joined`);
    }
  } else if (event === 'leave') {
    if (state.voiceMembers.has(username)) {
      state.voiceMembers.delete(username);
      removePeerConnection(username);
      toast(`${username} left voice`);
    }
  }

  updateVoiceParticipantsUI();

  // Also refresh voice member counts in sidebar
  updateVoiceChannelCounts();
}

/** Handle incoming WebRTC signals */
async function handleRTCSignal(from, data) {
  if (!state.inVoice) return;
  if (!data || !data.type) return;

  try {
    if (data.type === 'offer') {
      const pc = createPeerConnection(from);
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

      // Flush any ICE candidates that arrived before the offer was processed
      const queued = pendingCandidates.get(from) || [];
      for (const c of queued) await pc.addIceCandidate(c).catch(() => {});
      pendingCandidates.delete(from);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsSend({ type: 'signal', to: from, data: { type: 'answer', sdp: answer } });

    } else if (data.type === 'answer') {
      const pc = state.peerConnections.get(from);
      if (pc && pc.signalingState !== 'stable') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

        // Flush queued ICE candidates
        const queued = pendingCandidates.get(from) || [];
        for (const c of queued) await pc.addIceCandidate(c).catch(() => {});
        pendingCandidates.delete(from);
      }

    } else if (data.type === 'candidate') {
      const pc = state.peerConnections.get(from);
      if (pc && pc.remoteDescription && pc.remoteDescription.type) {
        // Remote description already set — add immediately
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } else {
        // Remote description not ready yet — queue it
        if (!pendingCandidates.has(from)) pendingCandidates.set(from, []);
        pendingCandidates.get(from).push(new RTCIceCandidate(data.candidate));
      }
    }
  } catch (err) {
    console.warn('[RTC] Signal handling error:', err.message);
  }
}

/** Rebuild the participants grid in the voice view */
function updateVoiceParticipantsUI() {
  const grid = $('participants-grid');
  if (!grid) return;
  grid.innerHTML = '';

  // Self card
  const self = document.createElement('div');
  self.className = 'participant self';
  self.innerHTML = `
    <div class="participant-avatar">${MY_USERNAME[0]?.toUpperCase() || '?'}</div>
    <div class="participant-name">${escapeHtml(MY_USERNAME)} (You)</div>
    <div class="participant-status">
      <div class="status-dot online small"></div>
      ${state.micMuted ? 'Muted' : 'Connected'}
    </div>
  `;
  grid.appendChild(self);

  // Remote peers
  state.voiceMembers.forEach(username => {
    if (username === MY_USERNAME) return;
    const card = document.createElement('div');
    card.className = 'participant';
    card.innerHTML = `
      <div class="participant-avatar">${username[0]?.toUpperCase() || '?'}</div>
      <div class="participant-name">${escapeHtml(username)}</div>
      <div class="participant-status">
        <div class="status-dot online small"></div> Connected
      </div>
    `;
    grid.appendChild(card);
  });

  if (state.voiceMembers.size === 0 || (state.voiceMembers.size === 1 && state.voiceMembers.has(MY_USERNAME))) {
    const waiting = document.createElement('div');
    waiting.className = 'participant waiting';
    waiting.innerHTML = `
      <div class="participant-avatar wait">?</div>
      <div class="participant-name muted-text">Waiting for others...</div>
    `;
    grid.appendChild(waiting);
  }
}

function updateVoiceChannelCounts() {
  // Update voice channel button labels with member counts from onlineUsers
  const voiceMap = {};
  state.onlineUsers.forEach(u => {
    if (u.voiceChannel) {
      voiceMap[u.voiceChannel] = (voiceMap[u.voiceChannel] || 0) + 1;
    }
  });
  $$('.channel[data-type="voice"]').forEach(btn => {
    const ch = btn.dataset.channel;
    const count = voiceMap[ch] || 0;
    const existing = btn.querySelector('.vc-member-count');
    if (count > 0) {
      if (existing) existing.textContent = count;
      else {
        const span = document.createElement('span');
        span.className = 'vc-member-count';
        span.textContent = count;
        btn.appendChild(span);
      }
    } else {
      existing?.remove();
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// Online Users
// ═══════════════════════════════════════════════════════════════════
function renderOnlineUsers() {
  const panel = document.querySelector('.members-panel');
  if (!panel) return;

  panel.querySelectorAll('.member-item.dynamic').forEach(el => el.remove());
  panel.querySelector('.members-label').textContent = `Online — ${state.onlineUsers.length}`;

  state.onlineUsers.forEach(u => {
    if (u.username === MY_USERNAME) return;
    const item = document.createElement('div');
    item.className = 'member-item dynamic';
    item.style.cursor = 'pointer';
    item.innerHTML = `
      <div class="member-avatar-wrap">
        <div class="member-avatar">${u.username[0]?.toUpperCase() || '?'}</div>
        <div class="status-dot online small"></div>
      </div>
      <div class="member-info">
        <span class="member-name">${escapeHtml(u.username)}</span>
        <span class="member-role">${u.voiceChannel ? `🔊 ${u.voiceChannel}` : ''}</span>
      </div>
      ${isAdmin() ? `<button class="kick-member-btn" title="Kick">⊘</button>` : ''}
    `;
    item.addEventListener('click', e => {
      if (!e.target.classList.contains('kick-member-btn')) openDm(u.username);
    });
    if (isAdmin()) {
      item.querySelector('.kick-member-btn').addEventListener('click', e => {
        e.stopPropagation();
        adminKick(u.username);
      });
    }
    panel.querySelector('.members-group').appendChild(item);
  });

  updateVoiceChannelCounts();
}

// ═══════════════════════════════════════════════════════════════════
// Direct Messages
// ═══════════════════════════════════════════════════════════════════
function getDmChannel(otherUser) {
  return 'dm:' + [MY_USERNAME, otherUser].sort().join(':');
}

function getDmKey(otherUser) {
  // Use a DM-specific key derived from both usernames (sorted) + shared secret
  return CHANNEL_SECRET + ':dm:' + [MY_USERNAME, otherUser].sort().join(':');
}

async function getChannelKeyForDm(otherUser) {
  const ch = getDmChannel(otherUser);
  if (_keyCache.has(ch)) return _keyCache.get(ch);

  const passphrase = getDmKey(otherUser);
  const saltStr    = 'thiscord-dm-v1-' + [MY_USERNAME, otherUser].sort().join(':');

  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode(saltStr), iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']
  );

  _keyCache.set(ch, key);
  return key;
}

function openDm(username) {
  state.activeDm = username;
  $('new-dm-overlay').classList.remove('open');

  // Make sure the DM conversation array exists
  if (!state.dmConversations[username]) state.dmConversations[username] = [];

  // Join the DM channel on the server
  const ch = getDmChannel(username);
  if (!state.messages[ch]) {
    state.messages[ch] = [];
    wsSend({ type: 'join', channel: ch });
  }

  // Update header
  $('dm-hdr-avatar').textContent  = username[0]?.toUpperCase() || '?';
  $('dm-hdr-name').textContent    = username;
  $('dm-hdr-status').textContent  = 'Direct Message';
  $('dm-input').placeholder       = `Message @${username}`;

  // Show DM view
  showView('view-dm');

  // Mark active in DM list
  $$('.dm-item').forEach(b => b.classList.remove('active'));
  document.querySelector(`.dm-item[data-dm="${CSS.escape(username)}"]`)?.classList.add('active');

  renderDmMessages(username);
  updateDmList();
}

function renderDmMessages(username) {
  const ch = getDmChannel(username);
  const container = $('dm-messages');
  container.innerHTML = '';

  const msgs = state.messages[ch] || [];
  const sys = document.createElement('div');
  sys.className   = 'msg-system';
  sys.textContent = `This is the beginning of your DM with ${username}`;
  container.appendChild(sys);

  msgs.forEach((msg, i) => {
    const prev = msgs[i - 1];
    appendMessageEl(container, msg, prev && prev.author === msg.author);
  });

  container.scrollTop = container.scrollHeight;
}

function setupDmInput() {
  const input   = $('dm-input');
  const sendBtn = $('dm-send-btn');

  async function sendDm() {
    const text = input.value.trim();
    if (!text || !state.activeDm) return;
    input.value = '';

    const ch = getDmChannel(state.activeDm);

    if (state.wsConnected) {
      try {
        // Use the DM channel key (same derivation as regular channels but DM-namespaced)
        const { ciphertext, iv } = await encryptMsg(text, ch);
        wsSend({ type: 'message', channel: ch, ciphertext, iv });
      } catch (err) {
        toast('Failed to send DM', 'error');
      }
    } else {
      toast('Not connected', 'error');
    }
  }

  sendBtn.addEventListener('click', sendDm);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDm(); }
  });
}

function updateDmList() {
  const list = $('dm-list');
  if (!list) return;
  list.innerHTML = '';

  const seen = new Set();

  // Show active DM conversations (channels we've joined)
  Object.keys(state.messages).forEach(ch => {
    if (!ch.startsWith('dm:')) return;
    const parts = ch.replace('dm:', '').split(':');
    const other = parts.find(p => p !== MY_USERNAME);
    if (!other || seen.has(other)) return;
    seen.add(other);

    const btn = document.createElement('button');
    btn.className = `dm-item${state.activeDm === other ? ' active' : ''}`;
    btn.dataset.dm = other;
    btn.innerHTML = `
      <div class="dm-avatar">${other[0]?.toUpperCase() || '?'}</div>
      <span class="dm-name">${escapeHtml(other)}</span>
    `;
    btn.addEventListener('click', () => openDm(other));
    list.appendChild(btn);
  });
}

function setupDmModal() {
  $('new-dm-btn').addEventListener('click', () => {
    renderDmUserPicker();
    $('new-dm-overlay').classList.add('open');
  });
  $('new-dm-close').addEventListener('click', () => $('new-dm-overlay').classList.remove('open'));
  $('new-dm-overlay').addEventListener('click', e => {
    if (e.target === $('new-dm-overlay')) $('new-dm-overlay').classList.remove('open');
  });
}

function renderDmUserPicker() {
  const list = $('dm-user-list');
  list.innerHTML = '';

  const others = state.onlineUsers.filter(u => u.username !== MY_USERNAME);
  if (!others.length) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">No other users online right now.</div>';
    return;
  }

  others.forEach(u => {
    const btn = document.createElement('button');
    btn.className = 'dm-user-pick-btn';
    btn.innerHTML = `
      <div class="dm-avatar">${u.username[0]?.toUpperCase() || '?'}</div>
      <span>${escapeHtml(u.username)}</span>
      <div class="status-dot online small" style="margin-left:auto"></div>
    `;
    btn.addEventListener('click', () => openDm(u.username));
    list.appendChild(btn);
  });
}

// intercept incoming messages to DM channels and route to DM view
const _origHandleWsMsg = handleWsMsg;
// (DM messages arrive as regular 'message' events on the dm: channel — already handled by handleWsMsg)

// When a message arrives on a DM channel, also update the DM list + notify
function onDmMessage(ch, msg) {
  updateDmList();
  const other = ch.replace('dm:', '').split(':').find(p => p !== MY_USERNAME);
  if (other && state.activeDm !== other) {
    showNotification(`DM from ${msg.author}`, msg.text?.slice(0, 80) || '');
    // badge on dm item
    const item = document.querySelector(`.dm-item[data-dm="${CSS.escape(other)}"]`);
    if (item && !item.querySelector('.unread-badge')) {
      const b = document.createElement('span');
      b.className = 'unread-badge';
      b.textContent = '•';
      item.appendChild(b);
    }
  }
  // If the DM view is active for this user, append the message
  if (state.activeDm === other) {
    appendMessage(msg, 'dm-messages');
  }
}

// ═══════════════════════════════════════════════════════════════════
// Server Creation
// ═══════════════════════════════════════════════════════════════════
function setupServerModal() {
  document.querySelector('.server-icon.add-server').addEventListener('click', openServerModal);
  $('server-modal-close').addEventListener('click', closeServerModal);
  $('server-modal-overlay').addEventListener('click', e => {
    if (e.target === $('server-modal-overlay')) closeServerModal();
  });

  // Tab switching
  $$('.server-modal-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.server-modal-tab').forEach(t => t.classList.remove('active'));
      $$('.server-modal-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $(`stab-${tab.dataset.stab}`)?.classList.add('active');
    });
  });

  $('create-server-btn').addEventListener('click', createServer);
  $('create-server-name').addEventListener('keydown', e => { if (e.key === 'Enter') createServer(); });
  $('join-server-btn').addEventListener('click', joinServer);
  $('join-server-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinServer(); });
}

function openServerModal()  { $('server-modal-overlay').classList.add('open'); }
function closeServerModal() { $('server-modal-overlay').classList.remove('open'); }

function createServer() {
  const name = $('create-server-name').value.trim();
  if (!name) { toast('Enter a server name', 'error'); return; }

  const id = crypto.randomUUID().slice(0, 8);
  const server = { id, name, channels: ['general', 'off-topic', 'media'] };
  state.servers.push(server);
  persistServers();
  closeServerModal();
  $('create-server-name').value = '';

  renderServerBar();
  switchServer(id);
  toast(`Server "${name}" created! Share code: ${id}`, 'success');

  // Copy invite to clipboard
  navigator.clipboard?.writeText(id).catch(() => {});
}

function joinServer() {
  const code = $('join-server-code').value.trim();
  if (!code) { toast('Enter an invite code', 'error'); return; }

  if (state.servers.find(s => s.id === code)) {
    toast('You already have this server', 'error');
    return;
  }

  const server = { id: code, name: `Server ${code.slice(0, 4)}`, channels: ['general', 'off-topic', 'media'] };
  state.servers.push(server);
  persistServers();
  closeServerModal();
  $('join-server-code').value = '';

  renderServerBar();
  switchServer(code);
  toast(`Joined server ${code}`, 'success');
}

function persistServers() {
  localStorage.setItem('tc-servers', JSON.stringify(state.servers));
}

function switchServer(id) {
  state.activeServer = id;

  // Update server bar active state
  $$('.server-icon[data-server]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.server === id);
  });

  // Rebuild sidebar channel list for this server
  const server = id === 'main' ? null : state.servers.find(s => s.id === id);
  if (!server) {
    // Back to main server
    document.querySelector('.server-name').textContent = 'ThisCord HQ';
    rebuildChannelList([
      { name: 'general', emoji: '💬' },
      { name: 'announcements', emoji: '📢' },
      { name: 'dev-talk', emoji: '💻' },
      { name: 'media', emoji: '🎨' },
    ], id);
  } else {
    document.querySelector('.server-name').textContent = server.name;
    rebuildChannelList(server.channels.map(ch => ({ name: ch, emoji: '' })), id);
  }
}

function rebuildChannelList(channels, serverId) {
  const scroll = document.querySelector('.channels-scroll');
  if (!scroll) return;

  // Only rebuild the text channels group, keep voice group
  const textGroup = scroll.querySelector('.ch-group');
  if (!textGroup) return;

  // Remove old channel buttons
  textGroup.querySelectorAll('.channel').forEach(el => el.remove());

  const prefix = serverId === 'main' ? '' : serverId + ':';

  channels.forEach((ch, i) => {
    const btn = document.createElement('button');
    const fullCh = prefix + ch.name;
    btn.className = `channel${i === 0 ? ' active' : ''}`;
    btn.dataset.type    = 'text';
    btn.dataset.channel = fullCh;
    btn.innerHTML = `<span class="ch-hash">#</span><span class="ch-label">${escapeHtml(ch.name)} ${ch.emoji}</span>`;
    btn.addEventListener('click', () => {
      $$('.channel').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      btn.querySelector('.unread-badge')?.remove();

      if (state.activeChannel !== fullCh) {
        wsSend({ type: 'leave', channel: state.activeChannel });
      }
      state.activeChannel     = fullCh;
      state.activeChannelType = 'text';
      $('active-ch-name').textContent  = ch.name;
      $('msg-input').placeholder       = `Message #${ch.name}`;
      $('active-ch-topic').textContent = CHANNEL_TOPICS[fullCh] || '';

      showView('view-chat');

      if (state.wsConnected) {
        state.messages[fullCh] = state.messages[fullCh] || [];
        renderMessages();
        wsSend({ type: 'join', channel: fullCh });
      } else {
        renderMessages();
      }
    });
    textGroup.appendChild(btn);
  });

  // Switch to first channel
  if (channels.length > 0) {
    const firstCh = prefix + channels[0].name;
    if (state.activeChannel !== firstCh) {
      wsSend({ type: 'leave', channel: state.activeChannel });
      state.activeChannel = firstCh;
      if (!state.messages[firstCh]) state.messages[firstCh] = [];
      $('active-ch-name').textContent  = channels[0].name;
      $('msg-input').placeholder       = `Message #${channels[0].name}`;
      $('active-ch-topic').textContent = '';
      if (state.wsConnected) wsSend({ type: 'join', channel: firstCh });
      showView('view-chat');
      renderMessages();
    }
  }
}

function renderServerBar() {
  // Remove old custom server icons
  $$('.server-icon[data-server]:not([data-server="main"])').forEach(el => el.remove());

  const bar = document.querySelector('.server-bar');
  const addBtn = bar.querySelector('.server-icon.add-server');

  state.servers.forEach(server => {
    const btn = document.createElement('button');
    btn.className = 'server-icon';
    btn.dataset.server = server.id;
    btn.dataset.tip    = server.name;
    btn.title          = server.name;
    btn.textContent    = server.name.slice(0, 2).toUpperCase();
    btn.addEventListener('click', () => switchServer(server.id));
    bar.insertBefore(btn, addBtn);
  });
}

function setupAdminKey() {
  const input  = $('admin-key-input');
  const btn    = $('admin-key-save');
  const status = $('admin-status-line');
  if (!input || !btn) return;

  const current = localStorage.getItem('tc-admin-key') || '';
  if (current) {
    input.value = current;
    status.textContent = '👑 Admin mode active';
    status.className = 'admin-status-line active';
  }

  btn.addEventListener('click', () => {
    const key = input.value.trim();
    if (key) {
      localStorage.setItem('tc-admin-key', key);
      status.textContent = '👑 Admin mode active';
      status.className = 'admin-status-line active';
      toast('Admin key saved 👑');
    } else {
      localStorage.removeItem('tc-admin-key');
      status.textContent = 'Admin mode off';
      status.className = 'admin-status-line';
      toast('Admin key removed');
    }
  });
}

function setupUpdateNotifications() {
  window.electronAPI?.onUpdateAvailable?.((info) => {
    toast(`Update v${info?.version || 'new'} available — downloading…`);
  });
  window.electronAPI?.onUpdateDownloaded?.((info) => {
    const t = document.createElement('div');
    t.className = 'update-banner';
    t.innerHTML = `⬆️ Update v${info?.version || 'new'} ready — <button id="restart-update-btn">Restart & Install</button>`;
    document.body.appendChild(t);
    $('restart-update-btn')?.addEventListener('click', () => window.electronAPI.installUpdate());
  });
}

// ═══════════════════════════════════════════════════════════════════
// Init — split into two phases
// ═══════════════════════════════════════════════════════════════════

/** Phase 1: runs immediately, sets up login screen and static UI */
function init() {
  setupLoginScreen();   // login buttons + auth callback listener
  setupTitlebar();
  setupUserPanel();
  setupProfileModal();
  setupSettings();
  setupMembersToggle();
  checkAuth();          // shows login screen OR calls initApp()
}

/** Phase 2: runs only after successful auth */
async function initApp() {
  setupChannels();
  setupChat();
  setupScreenShare();
  setupDmInput();
  setupDmModal();
  setupServerModal();
  setupNotifications();
  renderServerBar();

  $('stop-mic-test').disabled = true;
  $('stop-mic-test').classList.add('dim');

  await populateDevices();
  setupAudioLab();

  renderMessages();
  updateDmList();
  setupWebSocket();
  setupAdminKey();
  setupUpdateNotifications();
}

document.addEventListener('DOMContentLoaded', init);
