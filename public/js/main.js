// Gilded Brawl — Client Controller, 60 FPS Loop, Smooth Interpolation & Server Sync
import { CHARACTERS, CHARACTER_MAP } from '/shared/characters.js';
import { getBiomeAt, BIOMES, WORLD_SIZE, OBSTACLES } from '/shared/map.js';
import { getHeroSprites } from './sprites.js';
import { ArenaRenderer } from './renderer.js';
import { sfx } from './audio.js';

// Each browser tab gets a unique clientId so every browser client is counted as a player!
function getClientId() {
  let id = sessionStorage.getItem('gilded_brawl_client_id');
  if (!id) {
    id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    sessionStorage.setItem('gilded_brawl_client_id', id);
  }
  return id;
}

const CLIENT_ID = getClientId();
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
let selectedCharId = sessionStorage.getItem('gilded_brawl_char') || CHARACTERS[0].id;
let playerName = sessionStorage.getItem('gilded_brawl_name') || '';
if (playerName) nameInput.value = playerName;

let isJoined = false;
let latestWorld = null;
let lastEventId = 0;
let syncInFlight = false;
let flushNeeded = false;
let pendingActions = [];
let lastLeaderboardHtml = '';
const renderPlayers = new Map(); // id -> smoothly interpolated player state
const renderProjectiles = new Map(); // id -> smoothly extrapolated projectile state

// Input state
const keys = new Set();
let mouseScreen = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
let lastArenaAimWorld = null;
let mouseDown = false;
let localCds = { basic: 0, s0: 0, s1: 0, s2: 0 };
let lastForcedSeq = 0;

function resolveLocalObstacles(x, y, radius) {
  const margin = 44;
  let nx = Math.max(margin + radius, Math.min(WORLD_SIZE - margin - radius, x));
  let ny = Math.max(margin + radius, Math.min(WORLD_SIZE - margin - radius, y));
  for (const ob of OBSTACLES) {
    const dx = nx - ob.x;
    const dy = ny - ob.y;
    const minD = radius + ob.r;
    const d2 = dx * dx + dy * dy;
    if (d2 < minD * minD) {
      const d = Math.sqrt(d2) || 0.001;
      const push = minD - d;
      nx += (dx / d) * push;
      ny += (dy / d) * push;
    }
  }
  return { x: nx, y: ny };
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
    const sp = getHeroSprites(ch.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'char-card';
    btn.style.setProperty('--i', String(idx));
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', ch.id === selectedCharId ? 'true' : 'false');
    btn.dataset.charId = ch.id;
    btn.innerHTML = `
      <img src="${sp.portrait}" alt="${ch.name}" width="40" height="40" />
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
  const sp = getHeroSprites(ch.id);
  document.getElementById('preview-portrait').src = sp.portrait;
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
async function joinArena(name, charId, preservePos = false) {
  const me = preservePos ? renderPlayers.get(CLIENT_ID) : null;
  const res = await fetch('/api/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: CLIENT_ID,
      name,
      charId,
      x: me ? Math.round(me.x) : undefined,
      y: me ? Math.round(me.y) : undefined,
    }),
  });
  if (!res.ok) throw new Error('Join failed');
  const snap = await res.json();
  isJoined = true;
  playerName = name;
  selectedCharId = charId;
  sessionStorage.setItem('gilded_brawl_name', name);
  sessionStorage.setItem('gilded_brawl_char', charId);

  applySnapshot(snap, !preservePos);
  updateHeroHudStatic();
  hudEl.hidden = false;
  btnCancelSwitch.hidden = false;
  if (dialogEl.open) await closeOnboardingDialog();
}

function updateHeroHudStatic() {
  const ch = CHARACTER_MAP[selectedCharId] || CHARACTERS[0];
  const sp = getHeroSprites(ch.id);
  hudPortrait.src = sp.portrait;
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
    console.error(err);
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

function queueAction(actionKey, fromHudClick = false) {
  if (!isJoined || dialogEl.open) return;
  const cdKey = actionKey === 'basic' ? 'basic' : actionKey === 'skill0' ? 's0' : actionKey === 'skill1' ? 's1' : 's2';
  if (localCds[cdKey] > 0.08) return; // Don't queue while clearly on cooldown

  const aimWorld = getCurrentAimWorld(fromHudClick);
  pendingActions.push({ key: actionKey, tx: Math.round(aimWorld.x), ty: Math.round(aimWorld.y) });
  flashSlot(actionKey);

  // Flush immediately instead of waiting for next 70ms poll!
  if (!syncInFlight) {
    syncWithServer();
  } else {
    flushNeeded = true;
  }
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

  if (code === 'KeyJ') {
    e.preventDefault();
    sfx.unlock();
    queueAction('skill0');
  } else if (code === 'KeyK') {
    e.preventDefault();
    sfx.unlock();
    queueAction('skill1');
  } else if (code === 'KeyL') {
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
  if (!e.target || !e.target.closest('button, input, dialog')) {
    lastArenaAimWorld = renderer.screenToWorld(e.clientX, e.clientY);
  }
});

window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || dialogEl.open || !isJoined) return;
  if (e.target && e.target.closest('button, input, dialog')) return;
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
  const payload = JSON.stringify({ clientId: CLIENT_ID });
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

async function syncWithServer() {
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    if (!isJoined) {
      // Lightweight spectate snapshot while on onboarding screen
      const res = await fetch(`/api/status?clientId=${encodeURIComponent(CLIENT_ID)}&since=${lastEventId}`);
      if (res.ok) applySnapshot(await res.json(), false);
      return;
    }

    const { ix, iy } = getMoveVector();
    const me = renderPlayers.get(CLIENT_ID);
    const aimWorld = renderer.screenToWorld(mouseScreen.x, mouseScreen.y);
    const aim = me ? Math.atan2(aimWorld.y - me.y, aimWorld.x - me.x) : 0;

    if (mouseDown && !dialogEl.open) {
      pendingActions.push({ key: 'basic', tx: Math.round(aimWorld.x), ty: Math.round(aimWorld.y) });
    }

    const actions = pendingActions.splice(0, 4);
    const res = await fetch('/api/tick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: CLIENT_ID,
        ix,
        iy,
        cx: me ? Math.round(me.x * 10) / 10 : undefined,
        cy: me ? Math.round(me.y * 10) / 10 : undefined,
        moving: Math.hypot(ix, iy) > 0.1,
        aim,
        actions,
        lastEventId,
      }),
    });

    if (res.ok) {
      const snap = await res.json();
      // Auto-rejoin transparently preserving current position if serverless cold-started
      if (!snap.joined && isJoined && playerName) {
        await joinArena(playerName, selectedCharId, true);
        return;
      }
      applySnapshot(snap, false);
    }
  } catch {
    // Transient network hiccup — next tick will recover
  } finally {
    syncInFlight = false;
    if (flushNeeded) {
      flushNeeded = false;
      syncWithServer();
    }
  }
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
  if (snap.lastEventId) lastEventId = snap.lastEventId;

  // Reconcile players
  const seen = new Set();
  for (const sp of snap.players) {
    seen.add(sp.id);
    const existing = renderPlayers.get(sp.id);
    if (!existing || snapImmediate) {
      renderPlayers.set(sp.id, { ...sp, tx: sp.x, ty: sp.y });
      if (sp.id === CLIENT_ID) lastForcedSeq = sp.fseq || 1;
    } else {
      existing.tx = sp.x;
      existing.ty = sp.y;
      if (sp.id !== CLIENT_ID) {
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
      existing.charId = sp.charId;
      existing.name = sp.name;
      existing.cds = sp.cds;
      existing.force = sp.force;

      if (sp.id === CLIENT_ID) {
        if (sp.cds) localCds = { ...sp.cds };
        // Only snap/force-move self on server-authoritative displacements (dash, blink, hook, respawn, new round, knockback)
        if ((sp.fseq || 1) !== lastForcedSeq) {
          lastForcedSeq = sp.fseq || 1;
          existing.x = sp.x;
          existing.y = sp.y;
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

  // Reconcile projectiles smoothly (never snap backwards!)
  const seenProj = new Set();
  if (Array.isArray(snap.projectiles)) {
    for (const pr of snap.projectiles) {
      seenProj.add(pr.id);
      const existing = renderProjectiles.get(pr.id);
      if (!existing) {
        renderProjectiles.set(pr.id, { ...pr });
      } else {
        existing.vx = pr.vx;
        existing.vy = pr.vy;
        existing.ox = pr.ox;
        existing.oy = pr.oy;
        // Only nudge gently if drifted far; otherwise let smooth 60 FPS extrapolation run
        if (Math.hypot(existing.x - pr.x, existing.y - pr.y) > 95) {
          existing.x = pr.x;
          existing.y = pr.y;
        }
      }
    }
  }
  for (const id of renderProjectiles.keys()) {
    if (!seenProj.has(id)) renderProjectiles.delete(id);
  }

  // Process combat events
  if (Array.isArray(snap.events)) {
    for (const evt of snap.events) {
      renderer.pushEventFx(evt);
      if (evt.type === 'ko') {
        pushKillToast(`☠ ${evt.attackerName} KO'd ${evt.victimName}`);
        sfx.play('ko');
      } else if (evt.type === 'round_end') {
        sfx.play('round_end');
      } else if (evt.type === 'round_start') {
        sfx.play('round_start');
      } else if (evt.type === 'hit' && (evt.attackerId === CLIENT_ID || evt.targetId === CLIENT_ID)) {
        sfx.play('hit');
      } else if (evt.type === 'heal' && evt.targetId === CLIENT_ID) {
        sfx.play('heal');
      } else if (evt.type === 'slash' || evt.type === 'nova' || evt.type === 'blast' || evt.type === 'beam' || evt.type === 'lightning' || evt.type === 'dash') {
        sfx.play(evt.type);
      }
    }
  }

  updateHud(snap);
}

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

  const me = snap.players.find((p) => p.id === CLIENT_ID);
  if (me) {
    const biomeId = getBiomeAt(me.x, me.y);
    const biomeObj = Object.values(BIOMES).find((b) => b.id === biomeId);
    hudBiome.textContent = biomeObj ? biomeObj.name : 'Gilded Courtyard';

    hudHpText.textContent = `${me.hp} / ${me.maxHp}${me.shield > 0 ? ` (+${me.shield})` : ''}`;
    hudHpFill.style.width = `${Math.max(0, Math.min(100, (me.hp / me.maxHp) * 100))}%`;
    hudShieldFill.style.width = `${Math.max(0, Math.min(100, (me.shield / me.maxHp) * 100))}%`;

    respawnBanner.hidden = me.alive;
    if (!me.alive) respawnSec.textContent = me.respawn.toFixed(1);

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
        row.id === CLIENT_ID ? 'is-self' : '',
        !row.online ? 'is-offline' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const medal = idx === 0 && row.wins > 0 ? '👑' : `${idx + 1}.`;
      return `
        <li class="${cls}">
          <span class="lb-rank">${medal}</span>
          <span class="lb-name">${escapeHtml(row.name)}</span>
          <span class="lb-hp">${row.online ? `${row.hp}hp` : 'off'}</span>
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
    summarySub.textContent = sum.winnerId
      ? `Victory with ${sum.winnerHp} / ${sum.winnerMaxHp} HP remaining!`
      : 'Waiting for challengers...';
    summaryCountdown.textContent = Math.max(0, Math.ceil(snap.timeLeft));
    summaryStandings.innerHTML = (sum.standings || [])
      .map(
        (s, i) => `
        <li>
          <span>#${i + 1} ${escapeHtml(s.name)}</span>
          <span class="tabular">${s.hp} HP · ${s.kos} KO · ${s.damage} dmg</span>
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
      p.orbit += dt * 5.2;
    }
    if (p.id === CLIENT_ID && isJoined && p.alive) {
      if (liveAimWorld) {
        p.aim = Math.atan2(liveAimWorld.y - p.y, liveAimWorld.x - p.x);
      }
      if (latestWorld?.phase === 'playing') {
        const ch = CHARACTER_MAP[p.charId] || CHARACTERS[0];
        if (mvLen > 0.01) {
          const sp = ch.speed * (p.slow ? 0.56 : 1) * (p.haste ? 1.38 : 1);
          const next = resolveLocalObstacles(
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

  // Extrapolate projectiles smoothly at 60 FPS
  for (const pr of renderProjectiles.values()) {
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
  }

  renderer.updateFx(dt);
  renderer.render(latestWorld, CLIENT_ID, renderPlayers, renderProjectiles, now / 1000, dt, liveAimWorld);

  requestAnimationFrame(frame);
}

// Boot
renderRoster();
dialogEl.showModal();
setInterval(syncWithServer, SYNC_MS);
syncWithServer();
requestAnimationFrame(frame);
