// Gilded Brawl — Client Controller, 60 FPS Loop, Smooth Interpolation & Server Sync
import { CHARACTERS, CHARACTER_MAP } from '/shared/characters.js';
import { getBiomeAt, BIOMES } from '/shared/map.js';
import { resolveCircleObstacles, dashDistance, traceDash } from '/shared/physics.js';
import { ArenaRenderer } from './render/renderer.js';
import { getHeroPortrait } from './render/heroes.js';
import { sfx } from './audio.js';

// Each browser tab holds a secret session key (a bearer credential — never shown to other players).
// The server answers with our public player id (`selfId`), which is what every snapshot refers to.
const SESSION_STORAGE_KEY = 'gilded_brawl_session';
function newSession() {
  const s = crypto.randomUUID();
  sessionStorage.setItem(SESSION_STORAGE_KEY, s);
  return s;
}
let SESSION = sessionStorage.getItem(SESSION_STORAGE_KEY) || newSession();
let selfId = null;
const SYNC_MS = 70; // ~14 Hz authoritative server tick

// DOM references
const canvas = document.getElementById('arena-canvas');
const minimapCanvas = document.getElementById('minimap-canvas');
const hudEl = document.getElementById('hud');
const dialogEl = document.getElementById('onboarding-dialog');
const formEl = document.getElementById('onboarding-form');
const nameInput = document.getElementById('player-name-input');
const charGridEl = document.getElementById('character-grid');
const btnCancelSwitch = document.getElementById('btn-cancel-switch');
const btnSwitchHero = document.getElementById('btn-switch-hero');
const btnMute = document.getElementById('btn-mute');
const joinErrorEl = document.getElementById('join-error');

const hudRound = document.getElementById('hud-round');
const hudBiome = document.getElementById('hud-biome');
const hudTimer = document.getElementById('hud-timer');
const hudPlayers = document.getElementById('hud-players');
const leaderboardList = document.getElementById('leaderboard-list');
const killFeedEl = document.getElementById('kill-feed');
const respawnBanner = document.getElementById('respawn-banner');
const respawnSec = document.getElementById('respawn-sec');
const hudPortrait = document.getElementById('hud-portrait');
const hudHeroName = document.getElementById('hud-hero-name');
const hudPlayerName = document.getElementById('hud-player-name');
const hudHpText = document.getElementById('hud-hp-text');
const hudHpFill = document.getElementById('hud-hp-fill');
const hudShieldFill = document.getElementById('hud-shield-fill');
const roundOverlay = document.getElementById('round-overlay');
const summaryKicker = document.getElementById('summary-kicker');
const summaryWinner = document.getElementById('summary-winner');
const summarySub = document.getElementById('summary-sub');
const summaryStandings = document.getElementById('summary-standings');
const summaryCountdown = document.getElementById('summary-countdown');

const renderer = new ArenaRenderer(canvas, minimapCanvas);

// Client state
let selectedCharId = CHARACTER_MAP[sessionStorage.getItem('gilded_brawl_char')]
  ? sessionStorage.getItem('gilded_brawl_char')
  : CHARACTERS[0].id;
let playerName = sessionStorage.getItem('gilded_brawl_name') || '';
if (playerName) nameInput.value = playerName;

let isJoined = false;
let rejoinInFlight = null;
let warnedRateLimit = false;

// Connection watchdog. Receipt: the slowest healthy reply measured on the free Render plan was
// 4.4 s, so 6 s without any successful reply is a tripwire, not a hiccup — tell the player.
const CONNECTION_LOST_MS = 6000;
let lastServerOkAt = performance.now();
let lastServerError = '';
function markServerOk() {
  lastServerOkAt = performance.now();
  lastServerError = '';
}
let latestWorld = null;
let lastEventId = 0;
let syncInFlight = false;
let lastAppliedTickSeq = 0;
let nextTickSeq = 1;
let pendingActions = [];
let lastLeaderboardHtml = '';
const renderPlayers = new Map(); // id -> smoothly interpolated player state
const renderProjectiles = new Map(); // id -> smoothly extrapolated projectile state
let localProjSeq = 1;
let lastLocalDashAt = 0;

// Input state
const keys = new Set();
let mouseScreen = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
let lastArenaAimWorld = null;
let mouseDown = false;
let localCds = { basic: 0, s0: 0, s1: 0, s2: 0 };
let lastForcedSeq = 0;

// "Duplicate tab" copies sessionStorage, so the copy would share (and fight over) our player.
// Ask other tabs whether they already own this session; if one does, take a fresh one before joining.
const tabChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('gilded_brawl_tabs') : null;
if (tabChannel) {
  tabChannel.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.session !== SESSION) return;
    if (msg.type === 'probe') tabChannel.postMessage({ type: 'taken', session: SESSION });
    else if (msg.type === 'taken' && !isJoined) SESSION = newSession();
  };
  tabChannel.postMessage({ type: 'probe', session: SESSION });
}

// --- Accessible Validation Sync (validate-input-after-interaction) ---
const announcer = document.createElement('div');
announcer.setAttribute('aria-live', 'polite');
announcer.classList.add('visually-hidden');
document.body.append(announcer);

function syncNameAria(announce = false) {
  const supportsUserInvalid = CSS.supports('selector(:user-invalid)');
  const invalid = supportsUserInvalid
    ? nameInput.matches(':user-invalid')
    : nameInput.classList.contains('user-invalid-fallback');
  nameInput.setAttribute('aria-invalid', invalid ? 'true' : 'false');
  const errorId = nameInput.dataset.error;
  const ids = (nameInput.getAttribute('aria-describedby') || '')
    .split(/\s+/)
    .filter((id) => id && id !== errorId);
  if (invalid && errorId) ids.push(errorId);
  if (ids.length) nameInput.setAttribute('aria-describedby', ids.join(' '));
  if (invalid && announce) {
    announcer.textContent = 'Challenger Name: Please enter a challenger name (1 to 18 characters).';
  }
}

nameInput.setAttribute('aria-invalid', 'false');
nameInput.addEventListener('blur', () => {
  if (!CSS.supports('selector(:user-invalid)')) {
    nameInput.classList.toggle('user-invalid-fallback', !nameInput.validity.valid);
    nameInput.classList.toggle('user-valid-fallback', nameInput.validity.valid);
  }
  syncNameAria(true);
});
nameInput.addEventListener('input', () => {
  if (!CSS.supports('selector(:user-invalid)')) {
    nameInput.classList.toggle('user-invalid-fallback', !nameInput.validity.valid);
    nameInput.classList.toggle('user-valid-fallback', nameInput.validity.valid);
  }
  syncNameAria(false);
});

// Top-layer exit fallback for browsers lacking overlay or discrete display transitions
let supportsDisplayTransition;
function canTransitionDisplay() {
  if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
  if (!window.CSS?.supports?.('transition-behavior', 'allow-discrete') || !document.body) {
    return false;
  }
  const probe = document.createElement('div');
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  supportsDisplayTransition = getComputedStyle(probe).display === 'block';
  probe.remove();
  return supportsDisplayTransition;
}

function supportsTopLayerExit() {
  return Boolean(window.CSS?.supports?.('overlay', 'auto') && canTransitionDisplay());
}

async function closeOnboardingDialog() {
  if (!dialogEl.open) return;
  if (!supportsTopLayerExit()) {
    dialogEl.setAttribute('data-closing', '');
    const anims = dialogEl.getAnimations({ subtree: true });
    if (anims.length > 0) {
      await Promise.race([
        Promise.allSettled(anims.map((a) => a.finished)),
        new Promise((r) => setTimeout(r, 600)),
      ]);
    }
    if (!dialogEl.hasAttribute('data-closing')) return;
    dialogEl.removeAttribute('data-closing');
  }
  dialogEl.close();
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }
}

// Prevent Escape closing onboarding dialog before the player has joined; animate exit when allowed
dialogEl.addEventListener('cancel', (e) => {
  e.preventDefault();
  if (isJoined) closeOnboardingDialog();
});

// --- Build Onboarding 10-Hero Roster ---
function renderRoster() {
  charGridEl.innerHTML = '';
  CHARACTERS.forEach((ch, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'char-card';
    btn.style.setProperty('--i', String(idx));
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', ch.id === selectedCharId ? 'true' : 'false');
    btn.dataset.charId = ch.id;
    btn.innerHTML = `
      <img src="${getHeroPortrait(ch.id)}" alt="${ch.name}" width="40" height="40" />
      <div>
        <div class="char-card-name">${ch.name}</div>
        <div class="char-card-role">${ch.role} · ${ch.hp} HP</div>
      </div>
    `;
    btn.addEventListener('click', () => {
      selectedCharId = ch.id;
      updateRosterSelection();
      sfx.unlock();
      sfx.play('shoot');
    });
    charGridEl.appendChild(btn);
  });
  updateRosterSelection();
}

function updateRosterSelection() {
  for (const card of charGridEl.querySelectorAll('.char-card')) {
    card.setAttribute('aria-checked', card.dataset.charId === selectedCharId ? 'true' : 'false');
  }
  const ch = CHARACTER_MAP[selectedCharId] || CHARACTERS[0];
  document.getElementById('preview-portrait').src = getHeroPortrait(ch.id);
  document.getElementById('preview-role').textContent = ch.role;
  document.getElementById('preview-name').textContent = ch.name;
  document.getElementById('preview-title').textContent = ch.title;
  document.getElementById('preview-blurb').textContent = ch.blurb;
  document.getElementById('preview-hp').textContent = ch.hp;
  document.getElementById('preview-speed').textContent = ch.speed;

  const kitEl = document.getElementById('preview-kit');
  const allMoves = [
    { key: 'CLICK', ...ch.basic },
    ...ch.skills,
  ];
  kitEl.innerHTML = allMoves
    .map(
      (m) => `
      <div class="kit-row">
        <div class="kit-head">
          <span>[${m.key}] ${m.name}</span>
          <span class="kit-cd">${m.cooldown}s CD</span>
        </div>
        <div class="kit-desc">${m.desc}</div>
      </div>
    `
    )
    .join('');
}

// --- Join / Switch Hero API ---
async function joinArena(name, charId) {
  const res = await fetch('/api/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: SESSION, name, charId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Join failed (HTTP ${res.status})`);
  }
  const snap = await res.json();
  markServerOk();
  joinErrorEl.hidden = true;
  isJoined = true;
  playerName = name;
  selectedCharId = charId;
  sessionStorage.setItem('gilded_brawl_name', name);
  sessionStorage.setItem('gilded_brawl_char', charId);

  applySnapshot(snap, true);
  updateHeroHudStatic();
  hudEl.hidden = false;
  btnCancelSwitch.hidden = false;
  if (dialogEl.open) await closeOnboardingDialog();
}

function updateHeroHudStatic() {
  const ch = CHARACTER_MAP[selectedCharId] || CHARACTERS[0];
  hudPortrait.src = getHeroPortrait(ch.id);
  hudHeroName.textContent = ch.name;
  hudPlayerName.textContent = playerName;
  document.getElementById('slot-basic-name').textContent = ch.basic.name;
  document.getElementById('slot-s0-name').textContent = ch.skills[0].name;
  document.getElementById('slot-s1-name').textContent = ch.skills[1].name;
  document.getElementById('slot-s2-name').textContent = ch.skills[2].name;
}

formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  sfx.unlock();
  const trimmed = nameInput.value.trim();
  if (!trimmed) {
    nameInput.value = '';
    if (!CSS.supports('selector(:user-invalid)')) {
      nameInput.classList.add('user-invalid-fallback');
    }
    nameInput.reportValidity();
    syncNameAria(true);
    nameInput.focus();
    return;
  }
  try {
    await joinArena(trimmed, selectedCharId);
    sfx.play('round_start');
  } catch (err) {
    // The server names the limit that was hit (arena full, per-network cap, rate limit) — show it
    joinErrorEl.textContent = err.message;
    joinErrorEl.hidden = false;
  }
});

btnSwitchHero.addEventListener('click', () => {
  if (!dialogEl.open) {
    dialogEl.showModal();
  }
});

btnCancelSwitch.addEventListener('click', () => {
  if (dialogEl.open && isJoined) closeOnboardingDialog();
});

btnMute.addEventListener('click', () => {
  sfx.unlock();
  const muted = sfx.toggleMute();
  btnMute.textContent = muted ? '🔇 Muted' : '🔊 Sound';
  btnMute.setAttribute('aria-pressed', String(muted));
});

// Skill slot click support (uses last arena aim rather than clicking downward on HUD)
document.getElementById('skill-slots').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || !isJoined) return;
  sfx.unlock();
  queueAction(btn.dataset.action, true);
  btn.blur();
});

// --- Input Handling (uses physical e.code so WASD + JKL work across all keyboard layouts/IMEs) ---
function getCurrentAimWorld(preferLastArena = false) {
  if (preferLastArena && lastArenaAimWorld) return lastArenaAimWorld;
  return renderer.screenToWorld(mouseScreen.x, mouseScreen.y);
}

function flashSlot(actionKey) {
  const btn = document.querySelector(`.skill-slot[data-action="${actionKey}"]`);
  if (!btn) return;
  btn.classList.remove('cast-flash');
  void btn.offsetWidth;
  btn.classList.add('cast-flash');
}

function predictActionLocally(actionKey, aimWorld) {
  const me = renderPlayers.get(selfId);
  if (!me || !me.alive || latestWorld?.phase !== 'playing') return;
  const ch = CHARACTER_MAP[me.charId] || CHARACTERS[0];
  const isBasic = actionKey === 'basic';
  const skillIdx = actionKey === 'skill0' ? 0 : actionKey === 'skill1' ? 1 : actionKey === 'skill2' ? 2 : -1;
  const def = isBasic ? ch.basic : ch.skills[skillIdx];
  if (!def) return;
  // The server refuses skills while silenced; predicting them would flash a cast that never happens
  if (!isBasic && me.silenced) return;

  const cdKey = isBasic ? 'basic' : `s${skillIdx}`;
  localCds[cdKey] = def.cooldown;
  me.atk = true;
  setTimeout(() => {
    const cur = renderPlayers.get(selfId);
    if (cur) cur.atk = false;
  }, 160);

  const dx = aimWorld.x - me.x;
  const dy = aimWorld.y - me.y;
  const angle = Math.atan2(dy, dx);
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const dist = Math.hypot(dx, dy);

  switch (def.type) {
    case 'projectile': {
      const id = `loc_${localProjSeq++}`;
      renderProjectiles.set(id, {
        id,
        local: true,
        ownerId: selfId,
        x: me.x + dirX * (ch.radius + 8),
        y: me.y + dirY * (ch.radius + 8),
        vx: dirX * def.speed,
        vy: dirY * def.speed,
        r: def.radius || 8,
        c: def.color,
        k: def.visual || 'orb',
        ox: def.onHit === 'hook' || def.onHit === 'grapple' ? me.x : undefined,
        oy: def.onHit === 'hook' || def.onHit === 'grapple' ? me.y : undefined,
        life: Math.min(0.9, def.range / def.speed),
      });
      sfx.play(isBasic ? 'shoot' : 'spread');
      break;
    }
    case 'spread_proj': {
      const count = def.count || 3;
      const spread = def.spread || 0.4;
      for (let i = 0; i < count; i++) {
        const frac = count === 1 ? 0 : i / (count - 1) - 0.5;
        const a = angle + frac * spread;
        const cx = Math.cos(a);
        const cy = Math.sin(a);
        const id = `loc_${localProjSeq++}`;
        renderProjectiles.set(id, {
          id,
          local: true,
          ownerId: selfId,
          x: me.x + cx * (ch.radius + 8),
          y: me.y + cy * (ch.radius + 8),
          vx: cx * def.speed,
          vy: cy * def.speed,
          r: def.radius || 7,
          c: def.color,
          k: def.visual || 'orb',
          life: Math.min(0.9, def.range / def.speed),
        });
      }
      sfx.play('spread');
      break;
    }
    case 'melee':
    case 'cone_slam': {
      renderer.pushEventFx({
        type: 'slash',
        x: me.x,
        y: me.y,
        angle,
        range: def.range || 80,
        arc: def.arc || 1.4,
        color: def.color,
        heavy: def.type === 'cone_slam',
      });
      sfx.play('slash');
      break;
    }
    case 'dash_strike': {
      const sx = me.x;
      const sy = me.y;
      const { end: dest } = traceDash(sx, sy, dirX, dirY, dashDistance(def, dist), ch.radius);
      me.x = dest.x;
      me.y = dest.y;
      lastLocalDashAt = performance.now();
      renderer.pushEventFx({ type: 'dash', x1: sx, y1: sy, x2: dest.x, y2: dest.y, color: def.color });
      sfx.play('dash');
      break;
    }
    case 'shield_pulse':
    case 'heal_nova': {
      renderer.pushEventFx({ type: 'nova', x: me.x, y: me.y, r: def.radius || 140, color: def.color });
      sfx.play(def.type === 'heal_nova' ? 'heal' : 'nova');
      break;
    }
    case 'beam': {
      const range = def.range || 520;
      renderer.pushEventFx({
        type: 'beam',
        x1: me.x,
        y1: me.y,
        x2: me.x + dirX * range,
        y2: me.y + dirY * range,
        width: def.width || 40,
        color: def.color,
      });
      sfx.play('beam');
      break;
    }
    case 'chain_lightning': {
      renderer.pushEventFx({
        type: 'lightning',
        segments: [{ x1: me.x, y1: me.y, x2: me.x + dirX * Math.min(def.range || 680, Math.max(240, dist)), y2: me.y + dirY * Math.min(def.range || 680, Math.max(240, dist)) }],
        color: def.color,
      });
      sfx.play('lightning');
      break;
    }
    case 'ripple':
      renderer.pushEventFx({ type: 'ripple', x: me.x, y: me.y, r: def.radius, duration: def.duration, color: def.color });
      sfx.play('ripple');
      break;
    // Server-authoritative moves (teleports, stealth, lock-ons): the server event draws them
    case 'orbit':
    case 'trail':
      sfx.play('skill');
      break;
    case 'stealth':
      sfx.play('stealth');
      break;
    case 'rewind':
      sfx.play('rewind');
      break;
    case 'portal':
      sfx.play('portal');
      break;
    case 'blink_chain':
      sfx.play('dash');
      break;
    case 'deadeye':
      sfx.play('tracer');
      break;
    default: {
      const clamped = Math.min(dist, def.range || 360);
      renderer.pushEventFx({
        type: 'nova',
        x: me.x + dirX * clamped,
        y: me.y + dirY * clamped,
        r: Math.min(60, def.radius || 60),
        color: def.color,
      });
      sfx.play('shoot');
    }
  }
}

function queueAction(actionKey, fromHudClick = false) {
  if (!isJoined || dialogEl.open) return;
  const cdKey = actionKey === 'basic' ? 'basic' : actionKey === 'skill0' ? 's0' : actionKey === 'skill1' ? 's1' : 's2';
  if (localCds[cdKey] > 0.05) return;

  const aimWorld = getCurrentAimWorld(fromHudClick);
  const act = { key: actionKey, tx: Math.round(aimWorld.x), ty: Math.round(aimWorld.y) };

  // 0ms instant client visual/audio/cooldown prediction
  predictActionLocally(actionKey, aimWorld);
  flashSlot(actionKey);

  // Dispatch immediately WITHOUT waiting for any in-flight background poll!
  sendTickNow([act]);
}

window.addEventListener('keydown', (e) => {
  if (dialogEl.open) return;
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

  const code = e.code;
  keys.add(code);

  if (
    code === 'KeyW' ||
    code === 'KeyA' ||
    code === 'KeyS' ||
    code === 'KeyD' ||
    code === 'ArrowUp' ||
    code === 'ArrowDown' ||
    code === 'ArrowLeft' ||
    code === 'ArrowRight'
  ) {
    e.preventDefault();
  }

  if (e.repeat) return;

  if (code === 'KeyQ') {
    e.preventDefault();
    sfx.unlock();
    queueAction('skill0');
  } else if (code === 'KeyE') {
    e.preventDefault();
    sfx.unlock();
    queueAction('skill1');
  } else if (code === 'KeyR') {
    e.preventDefault();
    sfx.unlock();
    queueAction('skill2');
  }
});

window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
});

window.addEventListener('blur', () => {
  keys.clear();
  mouseDown = false;
});

window.addEventListener('pointermove', (e) => {
  mouseScreen.x = e.clientX;
  mouseScreen.y = e.clientY;
  if (!e.target?.closest?.('button, input, dialog')) {
    lastArenaAimWorld = renderer.screenToWorld(e.clientX, e.clientY);
  }
});

window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || dialogEl.open || !isJoined) return;
  if (e.target?.closest?.('button, input, dialog')) return;
  sfx.unlock();
  mouseDown = true;
  mouseScreen.x = e.clientX;
  mouseScreen.y = e.clientY;
  queueAction('basic');
});

window.addEventListener('pointerup', () => {
  mouseDown = false;
});

window.addEventListener('resize', () => renderer.resize());

window.addEventListener('pagehide', () => {
  if (!isJoined) return;
  const payload = JSON.stringify({ session: SESSION });
  navigator.sendBeacon('/api/leave', new Blob([payload], { type: 'application/json' }));
});

// --- Server Sync Loop ---
function getMoveVector() {
  if (dialogEl.open || !isJoined) return { ix: 0, iy: 0 };
  let ix = 0;
  let iy = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) iy -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) iy += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) ix -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1;
  return { ix, iy };
}

async function sendTickNow(immediateActions = []) {
  const seq = nextTickSeq++;
  const { ix, iy } = getMoveVector();
  const me = renderPlayers.get(selfId);
  const aimWorld = renderer.screenToWorld(mouseScreen.x, mouseScreen.y);
  const aim = me ? Math.atan2(aimWorld.y - me.y, aimWorld.x - me.x) : 0;
  const actions = immediateActions.length ? immediateActions : pendingActions.splice(0, 4);

  try {
    const res = await fetch('/api/tick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: SESSION,
        ix,
        iy,
        cx: me ? Math.round(me.x * 10) / 10 : undefined,
        cy: me ? Math.round(me.y * 10) / 10 : undefined,
        fseq: lastForcedSeq, // ack: the server ignores our position until we have seen its latest forced move
        moving: Math.hypot(ix, iy) > 0.1,
        aim,
        actions,
        lastEventId,
      }),
    });
    if (res.status === 429 && !warnedRateLimit) {
      warnedRateLimit = true;
      console.warn('Gilded Brawl:', (await res.json().catch(() => ({}))).error || 'rate limited');
    }
    if (!res.ok) {
      lastServerError = `Server replied HTTP ${res.status}.`;
      return;
    }
    const snap = await res.json();
    // Check ordering after the body arrives: responses can finish parsing out of order
    if (seq < lastAppliedTickSeq) return;
    lastAppliedTickSeq = seq;
    if (!snap.joined && isJoined && playerName) {
      // Timed out server-side (or server restarted): join again, once, however many ticks notice it
      rejoinInFlight ??= joinArena(playerName, selectedCharId)
        .catch((err) => {
          lastServerError = `Could not rejoin: ${err.message}`;
        })
        .finally(() => {
          rejoinInFlight = null;
        });
      return;
    }
    markServerOk();
    applySnapshot(snap, false);
  } catch (err) {
    // One failed poll is a hiccup; the watchdog shows the banner if they keep failing
    lastServerError = `Network error: ${err.message}.`;
  }
}

async function syncWithServer() {
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    if (!isJoined) {
      const res = await fetch(`/api/status?since=${lastEventId}`);
      if (res.ok) {
        markServerOk();
        applySnapshot(await res.json(), false);
      } else {
        lastServerError = `Server replied HTTP ${res.status}.`;
      }
      return;
    }

    if (mouseDown && !dialogEl.open && localCds.basic <= 0.05) {
      queueAction('basic', false);
      return;
    }

    await sendTickNow([]);
  } catch (err) {
    lastServerError = `Network error: ${err.message}.`;
  } finally {
    syncInFlight = false;
  }
}

const calloutEl = document.getElementById('callout');
function showCallout(main, sub = '', variant = '') {
  const card = document.createElement('div');
  card.className = `callout-card${variant ? ` is-${variant}` : ''}`;
  const m = document.createElement('span');
  m.className = 'callout-main';
  m.textContent = main;
  card.append(m);
  if (sub) {
    const s = document.createElement('span');
    s.className = 'callout-sub';
    s.textContent = sub;
    card.append(s);
  }
  calloutEl.replaceChildren(card);
  card.addEventListener('animationend', () => card.remove());
}

function pushKillToast(text) {
  const el = document.createElement('div');
  el.className = 'kill-toast';
  el.textContent = text;
  killFeedEl.prepend(el);
  while (killFeedEl.children.length > 4) killFeedEl.lastChild.remove();
  setTimeout(() => el.remove(), 4500);
}

function applySnapshot(snap, snapImmediate) {
  latestWorld = snap;
  selfId = snap.selfId;
  if (Number.isFinite(snap.lastEventId)) lastEventId = snap.lastEventId;

  // Reconcile players
  const seen = new Set();
  for (const sp of snap.players) {
    seen.add(sp.id);
    const existing = renderPlayers.get(sp.id);
    if (!existing || snapImmediate) {
      renderPlayers.set(sp.id, { ...sp, tx: sp.x, ty: sp.y });
      if (sp.id === selfId) lastForcedSeq = sp.fseq || 1;
    } else {
      existing.tx = sp.x;
      existing.ty = sp.y;
      if (sp.id !== selfId) {
        existing.aim = sp.aim;
        existing.moving = sp.moving;
      }
      existing.hp = sp.hp;
      existing.maxHp = sp.maxHp;
      existing.shield = sp.shield;
      existing.alive = sp.alive;
      existing.respawn = sp.respawn;
      existing.slow = sp.slow;
      existing.haste = sp.haste;
      existing.hit = sp.hit;
      existing.atk = sp.atk;
      existing.orbit = sp.orbit;
      existing.orbitR = sp.orbitR;
      existing.orbitN = sp.orbitN;
      existing.orbitC = sp.orbitC;
      existing.silenced = sp.silenced;
      existing.stealth = sp.stealth;
      existing.trail = sp.trail;
      existing.charId = sp.charId;
      existing.name = sp.name;
      existing.cds = sp.cds;
      existing.force = sp.force;

      if (sp.id === selfId) {
        if (sp.cds) {
          // Keep optimistic cooldown if a cast was just sent so CD bar never flickers back to 0
          for (const k of ['basic', 's0', 's1', 's2']) {
            if (sp.cds[k] > 0.05 || localCds[k] <= 0.15) {
              localCds[k] = sp.cds[k];
            }
          }
        }
        // Only snap/force-move self on server-authoritative displacements (skip echo right after our own predicted dash)
        if ((sp.fseq || 1) !== lastForcedSeq) {
          lastForcedSeq = sp.fseq || 1;
          if (performance.now() - lastLocalDashAt > 450 || Math.hypot(existing.x - sp.x, existing.y - sp.y) > 260) {
            existing.x = sp.x;
            existing.y = sp.y;
          }
        } else if (sp.force) {
          existing.x += (sp.x - existing.x) * 0.45;
          existing.y += (sp.y - existing.y) * 0.45;
        }
      } else if (Math.hypot(existing.x - sp.x, existing.y - sp.y) > 220) {
        existing.x = sp.x;
        existing.y = sp.y;
      }
    }
  }
  for (const id of renderPlayers.keys()) {
    if (!seen.has(id)) renderPlayers.delete(id);
  }

  // Reconcile projectiles smoothly (replace local predicted ones once server confirms)
  const seenProj = new Set();
  if (Array.isArray(snap.projectiles)) {
    for (const pr of snap.projectiles) {
      seenProj.add(pr.id);
      const existing = renderProjectiles.get(pr.id);
      if (!existing && pr.ownerId === selfId) {
        // A newly confirmed own projectile replaces its local prediction so we don't draw double
        for (const [lid, lpr] of renderProjectiles.entries()) {
          if (lpr.local && lpr.c === pr.c) {
            renderProjectiles.delete(lid);
            break;
          }
        }
      }
      if (!existing) {
        renderProjectiles.set(pr.id, { ...pr });
      } else {
        existing.vx = pr.vx;
        existing.vy = pr.vy;
        existing.ox = pr.ox;
        existing.oy = pr.oy;
        // Homing, ricochet and boomerang shots turn between snapshots: ease toward the server position
        if (Math.hypot(existing.x - pr.x, existing.y - pr.y) > 95) {
          existing.x = pr.x;
          existing.y = pr.y;
        } else {
          existing.x += (pr.x - existing.x) * 0.5;
          existing.y += (pr.y - existing.y) * 0.5;
        }
      }
    }
  }
  for (const [id, pr] of renderProjectiles.entries()) {
    if (!pr.local && !seenProj.has(id)) renderProjectiles.delete(id);
  }

  // Process combat events (skip duplicate VFX/SFX already predicted locally for self)
  if (Array.isArray(snap.events)) {
    for (const evt of snap.events) {
      const selfPredicted =
        evt.actorId === selfId &&
        (evt.type === 'slash' ||
          evt.type === 'nova' ||
          evt.type === 'beam' ||
          evt.type === 'lightning' ||
          evt.type === 'ripple' ||
          evt.type === 'dash');
      if (selfPredicted) continue;

      renderer.pushEventFx(evt);
      if (evt.type === 'ko') {
        pushKillToast(`☠ ${evt.attackerName} KO'd ${evt.victimName}`);
        sfx.play('ko');
        if (evt.attackerId && evt.attackerId === selfId) showCallout('KNOCKOUT!', evt.victimName, 'ko');
      } else if (evt.type === 'round_end') {
        sfx.play('round_end');
      } else if (evt.type === 'round_start') {
        sfx.play('round_start');
        showCallout(`ROUND ${evt.roundNumber}`, 'FIGHT!');
      } else if (evt.type === 'hit' && (evt.attackerId === selfId || evt.targetId === selfId)) {
        sfx.play('hit');
      } else if (evt.type === 'heal' && evt.targetId === selfId) {
        sfx.play('heal');
      } else if (EVENT_SOUNDS.has(evt.type)) {
        sfx.play(evt.type);
      }
    }
  }

  updateHud(snap);
}

const EVENT_SOUNDS = new Set([
  'slash', 'nova', 'blast', 'beam', 'lightning', 'dash', 'ripple', 'portal', 'stealth', 'reveal',
  'rewind', 'bounce', 'swap', 'tracer', 'cursed', 'blink_chain', 'respawn', 'fizzle',
]);

function formatTime(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

function updateHud(snap) {
  hudRound.textContent = `ROUND ${snap.roundNumber}`;
  hudTimer.textContent = formatTime(snap.timeLeft);
  hudTimer.classList.toggle('urgent', snap.phase === 'playing' && snap.timeLeft <= 15);
  hudPlayers.textContent = `${snap.playerCount} ${snap.playerCount === 1 ? 'player' : 'players'}`;

  const me = snap.players.find((p) => p.id === selfId);
  if (me) {
    const biomeId = getBiomeAt(me.x, me.y);
    const biomeObj = Object.values(BIOMES).find((b) => b.id === biomeId);
    hudBiome.textContent = biomeObj ? biomeObj.name : 'Gilded Courtyard';

    hudHpText.textContent = `${me.hp} / ${me.maxHp}${me.shield > 0 ? ` (+${me.shield})` : ''}`;
    hudHpFill.style.width = `${Math.max(0, Math.min(100, (me.hp / me.maxHp) * 100))}%`;
    hudShieldFill.style.width = `${Math.max(0, Math.min(100, (me.shield / me.maxHp) * 100))}%`;

    respawnBanner.hidden = me.alive;
    if (!me.alive) respawnSec.textContent = me.respawn.toFixed(1);

    for (const k of ['s0', 's1', 's2']) {
      document.getElementById(`slot-${k}-cd`)?.parentElement.classList.toggle('is-silenced', !!me.silenced);
    }

    if (me.cds) {
      updateCdSlot('basic', me.cds.basic);
      updateCdSlot('s0', me.cds.s0);
      updateCdSlot('s1', me.cds.s1);
      updateCdSlot('s2', me.cds.s2);
    }
  }

  // Leaderboard (skip DOM rewrite if unchanged to avoid thrashing)
  const lbHtml = (snap.leaderboard || [])
    .map((row, idx) => {
      const cls = [
        'lb-row',
        row.id === selfId ? 'is-self' : '',
        !row.online ? 'is-offline' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const medal = idx === 0 && row.wins > 0 ? '👑' : `${idx + 1}.`;
      return `
        <li class="${cls}">
          <span class="lb-rank">${medal}</span>
          <span class="lb-name">${escapeHtml(row.name)}</span>
          <span class="lb-hp">${row.online ? `${row.roundKos || 0}K · ${row.hp}hp` : 'off'}</span>
          <span class="lb-wins">${row.wins}W</span>
        </li>
      `;
    })
    .join('');
  if (lbHtml !== lastLeaderboardHtml) {
    lastLeaderboardHtml = lbHtml;
    leaderboardList.innerHTML = lbHtml;
  }

  // Intermission Round Summary Overlay
  if (snap.phase === 'intermission' && snap.lastRoundSummary) {
    const sum = snap.lastRoundSummary;
    roundOverlay.hidden = false;
    summaryKicker.textContent = `ROUND ${sum.roundNumber} COMPLETE`;
    summaryWinner.textContent = `👑 ${sum.winnerName}`;
    summarySub.textContent = !sum.winnerId
      ? 'Waiting for challengers...'
      : sum.isTie
        ? `Co-Champions! Tied with ${sum.winnerKos} KOs & ${sum.winnerHp} HP!`
        : `Victory with ${sum.winnerKos} KOs & ${sum.winnerHp} / ${sum.winnerMaxHp} HP!`;
    summaryCountdown.textContent = Math.max(0, Math.ceil(snap.timeLeft));
    summaryStandings.innerHTML = (sum.standings || [])
      .map(
        (s, i) => `
        <li>
          <span>#${i + 1} ${escapeHtml(s.name)}</span>
          <span class="tabular">${s.kos} KO · ${s.hp} HP · ${s.damage} dmg</span>
        </li>
      `
      )
      .join('');
  } else {
    roundOverlay.hidden = true;
  }
}

function updateCdSlot(key, cd, maxCd = 1) {
  const cdEl = document.getElementById(`slot-${key}-cd`);
  const slotBtn = cdEl?.parentElement;
  if (!cdEl || !slotBtn) return;
  if (cd <= 0.05 && slotBtn.classList.contains('on-cd')) {
    // Restart the sweep animation each time this skill comes back
    slotBtn.classList.remove('just-ready');
    void slotBtn.offsetWidth;
    slotBtn.classList.add('just-ready');
  }
  if (cd > 0.05) {
    cdEl.textContent = cd.toFixed(1);
    slotBtn.classList.add('on-cd');
    const pct = Math.max(0, Math.min(100, (cd / Math.max(0.1, maxCd)) * 100));
    slotBtn.style.setProperty('--cd-pct', `${pct}%`);
  } else {
    cdEl.textContent = '';
    slotBtn.classList.remove('on-cd');
    slotBtn.style.setProperty('--cd-pct', '0%');
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// --- 60 FPS Render & Interpolation Loop ---
let lastFrame = performance.now();

function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  // Smoothly interpolate all players (with live 60 FPS aim, orbit extrapolation & local prediction)
  const { ix, iy } = getMoveVector();
  const mvLen = Math.hypot(ix, iy);
  const liveAimWorld = isJoined ? renderer.screenToWorld(mouseScreen.x, mouseScreen.y) : null;

  for (const p of renderPlayers.values()) {
    if (p.orbit !== null && p.orbit !== undefined) {
      p.orbit += dt * 4.2; // matches the server's orbit angular speed
    }
    if (p.id === selfId && isJoined && p.alive) {
      if (liveAimWorld) {
        p.aim = Math.atan2(liveAimWorld.y - p.y, liveAimWorld.x - p.x);
      }
      if (latestWorld?.phase === 'playing') {
        const ch = CHARACTER_MAP[p.charId] || CHARACTERS[0];
        if (mvLen > 0.01) {
          const sp = ch.speed * (p.slow ? 0.56 : 1) * (p.haste ? 1.38 : 1);
          const next = resolveCircleObstacles(
            p.x + (ix / mvLen) * sp * dt,
            p.y + (iy / mvLen) * sp * dt,
            ch.radius
          );
          p.x = next.x;
          p.y = next.y;
          p.moving = true;
        } else {
          p.moving = false;
        }
      } else {
        p.moving = false;
      }
    } else {
      p.x += (p.tx - p.x) * Math.min(1, dt * 16);
      p.y += (p.ty - p.y) * Math.min(1, dt * 16);
    }
  }

  // Smooth 60 FPS cooldown countdown UI
  if (isJoined) {
    const ch = CHARACTER_MAP[selectedCharId] || CHARACTERS[0];
    localCds.basic = Math.max(0, localCds.basic - dt);
    localCds.s0 = Math.max(0, localCds.s0 - dt);
    localCds.s1 = Math.max(0, localCds.s1 - dt);
    localCds.s2 = Math.max(0, localCds.s2 - dt);
    updateCdSlot('basic', localCds.basic, ch.basic.cooldown);
    updateCdSlot('s0', localCds.s0, ch.skills[0].cooldown);
    updateCdSlot('s1', localCds.s1, ch.skills[1].cooldown);
    updateCdSlot('s2', localCds.s2, ch.skills[2].cooldown);
  }

  // Extrapolate projectiles smoothly at 60 FPS (and expire local predicted ones)
  for (const [id, pr] of renderProjectiles.entries()) {
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    if (pr.local) {
      pr.life -= dt;
      if (pr.life <= 0) renderProjectiles.delete(id);
    }
  }

  renderer.render(latestWorld, selfId, renderPlayers, renderProjectiles, now / 1000, dt, liveAimWorld);

  requestAnimationFrame(frame);
}

const connectionBanner = document.getElementById('connection-banner');
const connectionDetail = document.getElementById('connection-detail');
document.getElementById('btn-reload').addEventListener('click', () => location.reload());
let showingLostInDialog = false;
setInterval(() => {
  const lost = performance.now() - lastServerOkAt > CONNECTION_LOST_MS;
  const detail = lastServerError || 'No reply from the server.';
  // A modal <dialog> sits in the top layer above any z-index, so while it is open the message goes
  // into the dialog's own error line instead of the banner
  const inDialog = lost && dialogEl.open;
  connectionBanner.hidden = !lost || inDialog;
  if (lost) connectionDetail.textContent = detail;
  if (inDialog) {
    joinErrorEl.textContent = `Lost connection to the game server. ${detail} Reload the page if this lasts.`;
    joinErrorEl.hidden = false;
    showingLostInDialog = true;
  } else if (showingLostInDialog) {
    joinErrorEl.hidden = true;
    showingLostInDialog = false;
  }
}, 500);

// Boot
renderRoster();
dialogEl.showModal();
setInterval(syncWithServer, SYNC_MS);
syncWithServer();
requestAnimationFrame(frame);
