// Authoritative in-RAM multiplayer game engine for Gilded Brawl
import { CHARACTER_MAP, CHARACTERS } from '../public/shared/characters.js';
import {
  WORLD_SIZE,
  ROUND_DURATION_SEC,
  INTERMISSION_SEC,
  SPAWN_POINTS,
  SHRINE_SPOTS,
  PRACTICE_TOTEM_SPOTS,
} from '../public/shared/map.js';
import { MARGIN, resolveCircleObstacles, obstacleNormal, dashDistance, traceDash } from '../public/shared/physics.js';

const PLAYER_TIMEOUT_MS = 12_000;
const RESPAWN_TIME_SEC = 4.0;
const MAX_PLAYERS = 60;
const MAX_PLAYERS_PER_IP = 4;
const MAX_LEADERBOARD = 200;

// Tripwires, sized from the roster (receipts below) so healthy play never touches them.
// Projectiles: worst kit alive at once is Moss (2 thorn arrows + 7 Razor Volley thorns) ≈ 10 per player.
//   60 players × 10 = 600 → cap 1024.
// Zones / delayed blasts: every zone lasts less than its cooldown and every blast delay is ≤ 0.5s against
//   a ≥ 6s cooldown, so ≤ 1 each per player → 60 → cap 128.
// Events: a 60-player brawl emits a few hundred events per second; 1024 keeps ~2s of history for slow clients.
const MAX_PROJECTILES = 1024;
const MAX_ZONES = 128;
const MAX_DELAYED_BLASTS = 128;
const MAX_EVENTS = 1024;
// Trail points: Scalding Spill lasts 3s at hasted speed (210 × 1.38 ≈ 290 px/s) ≈ 870px / 18px ≈ 48 points.
const MAX_TRAIL_POINTS = 96;

// Movement budget: a client may bank up to this much unspent travel time (covers a 600ms network stall)
// plus a fixed slack for server-side displacements (player separation, obstacle push-out).
const MOVE_BANK_SEC = 0.6;
const MOVE_SLACK_PX = 48;

const lastBudgetWarnAt = new Map();
function warnBudget(name, limit) {
  const now = Date.now();
  if (now - (lastBudgetWarnAt.get(name) || 0) < 10_000) return;
  lastBudgetWarnAt.set(name, now);
  console.warn(`[engine] budget ${name}=${limit} reached; the newest entity was dropped. Remeasure the receipt in game/engine.js.`);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function distSq(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function createInitialState() {
  const now = Date.now();
  return {
    roundNumber: 1,
    phase: 'playing', // 'playing' | 'intermission'
    phaseEndAt: now + ROUND_DURATION_SEC * 1000,
    lastStepAt: now,
    clock: now, // simulation time of the current step; every timestamp inside the sim uses it
    nextEntityId: 1,
    nextEventId: 1,
    nextPlayerNum: 1,
    // The session key is the client's secret credential; it never leaves the server.
    // Everything else (snapshots, events, leaderboard) uses the public player id.
    sessions: new Map(), // session key -> public player id
    players: new Map(), // public player id -> player object
    leaderboard: new Map(), // public player id -> { id, session, name, charId, wins, kos, damage }
    projectiles: [],
    zones: [], // DoT zones, gravity wells, turrets
    delayedBlasts: [], // thunderstrike, comet drop, bramble snare
    shrines: SHRINE_SPOTS.map((s) => ({ ...s, active: true, respawnAt: 0 })),
    totems: PRACTICE_TOTEM_SPOTS.map((t) => ({ ...t, hp: t.maxHp, alive: true, respawnAt: 0, hitFlash: 0 })),
    events: [],
    lastRoundSummary: null,
  };
}

export function getState() {
  if (!globalThis.__GILDED_BRAWL_STATE__) {
    globalThis.__GILDED_BRAWL_STATE__ = createInitialState();
  }
  return globalThis.__GILDED_BRAWL_STATE__;
}

function pushEvent(state, evt) {
  evt.id = state.nextEventId++;
  evt.t = state.clock;
  state.events.push(evt);
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
}

function pickSpawn(state) {
  let best = SPAWN_POINTS[0];
  let bestScore = -1;
  for (const sp of SPAWN_POINTS) {
    let minD = Infinity;
    for (const p of state.players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - sp.x, p.y - sp.y);
      if (d < minD) minD = d;
    }
    const jitter = Math.random() * 80;
    const score = (minD === Infinity ? 1000 : minD) + jitter;
    if (score > bestScore) {
      bestScore = score;
      best = sp;
    }
  }
  return {
    x: best.x + (Math.random() - 0.5) * 36,
    y: best.y + (Math.random() - 0.5) * 36,
  };
}

// visibleOnly: auto-aimed effects (homing, chains, turrets, lock-ons) cannot pick a stealthed player.
// Area damage still lands on them — they are physically there.
function getAllTargets(state, attackerId, visibleOnly = false) {
  const targets = [];
  for (const p of state.players.values()) {
    if (p.id === attackerId || !p.alive) continue;
    if (visibleOnly && p.stealthTimer > 0) continue;
    targets.push({ kind: 'player', ref: p, x: p.x, y: p.y, r: p.radius });
  }
  for (const t of state.totems) {
    if (t.alive) {
      targets.push({ kind: 'totem', ref: t, x: t.x, y: t.y, r: 22 });
    }
  }
  return targets;
}

function nearestTarget(state, attackerId, x, y, maxDist, exclude = null) {
  let best = null;
  let bestD = maxDist;
  for (const tw of getAllTargets(state, attackerId, true)) {
    if (exclude && exclude.has(tw.ref.id)) continue;
    const d = Math.hypot(tw.x - x, tw.y - y);
    if (d <= bestD) {
      bestD = d;
      best = tw;
    }
  }
  return best;
}

function applyDamage(state, attacker, targetWrap, rawDamage, opts = {}) {
  const dmg = Math.max(1, Math.round(rawDamage));
  if (targetWrap.kind === 'totem') {
    const t = targetWrap.ref;
    t.hp = Math.max(0, t.hp - dmg);
    t.hitFlash = 0.16;
    pushEvent(state, {
      type: 'hit',
      x: t.x,
      y: t.y - 18,
      dmg,
      color: opts.color || '#ffe082',
      targetId: t.id,
      attackerId: attacker?.id || null,
    });
    if (t.hp <= 0) {
      t.alive = false;
      t.respawnAt = state.clock + 5000;
      pushEvent(state, { type: 'blast', x: t.x, y: t.y, r: 48, color: '#ffe082' });
    }
    // Practice totems are for testing combos: they grant no lifesteal, so they cannot be farmed for healing.
    return;
  }

  const victim = targetWrap.ref;
  if (!victim.alive) return;

  let remaining = dmg;
  if (victim.shield > 0) {
    const absorbed = Math.min(victim.shield, remaining);
    victim.shield -= absorbed;
    remaining -= absorbed;
  }
  victim.hp = Math.max(0, victim.hp - remaining);
  victim.hitFlash = 0.18;

  if (attacker) {
    attacker.roundDamage += dmg;
    const lb = state.leaderboard.get(attacker.id);
    if (lb) lb.damage += dmg;
    if (opts.lifesteal) healPlayer(state, attacker, opts.lifesteal);
  }

  if (opts.knockback && opts.kx !== undefined && opts.ky !== undefined) {
    victim.kbx += opts.kx * opts.knockback;
    victim.kby += opts.ky * opts.knockback;
    victim.forceSyncUntil = state.clock + 350;
  }
  if (opts.slow) victim.slowTimer = Math.max(victim.slowTimer, opts.slow);
  if (opts.silence) victim.silenceTimer = Math.max(victim.silenceTimer, opts.silence);

  pushEvent(state, {
    type: 'hit',
    x: victim.x,
    y: victim.y - 20,
    dmg,
    color: opts.color || '#ff8a80',
    targetId: victim.id,
    attackerId: attacker?.id || null,
  });

  if (victim.hp <= 0) killPlayer(state, victim, attacker);
}

function killPlayer(state, victim, attacker) {
  victim.alive = false;
  victim.respawnTimer = RESPAWN_TIME_SEC;
  victim.shield = 0;
  victim.orbitTimer = 0;
  victim.stealthTimer = 0;
  victim.trailTimer = 0;
  victim.silenceTimer = 0;
  victim.history = [];
  if (attacker && attacker.id !== victim.id) {
    attacker.roundKos += 1;
    const lb = state.leaderboard.get(attacker.id);
    if (lb) lb.kos += 1;
  }
  pushEvent(state, {
    type: 'ko',
    x: victim.x,
    y: victim.y,
    victimId: victim.id,
    victimName: victim.name,
    attackerId: attacker ? attacker.id : null,
    attackerName: attacker ? attacker.name : 'Arena',
    color: victim.color,
  });
}

function healPlayer(state, player, amount) {
  if (!player.alive) return;
  const before = player.hp;
  player.hp = Math.min(player.maxHp, Math.round(player.hp + amount));
  const actual = player.hp - before;
  if (actual > 0) {
    pushEvent(state, { type: 'heal', x: player.x, y: player.y - 22, amount: actual, targetId: player.id });
  }
}

function teleportPlayer(player, x, y) {
  const r = resolveCircleObstacles(x, y, player.radius);
  player.x = r.x;
  player.y = r.y;
  player.kbx = 0;
  player.kby = 0;
  player.forcedSeq += 1;
}

function addZone(state, zone) {
  if (state.zones.length >= MAX_ZONES) {
    warnBudget('MAX_ZONES', MAX_ZONES);
    return null;
  }
  zone.id = state.nextEntityId++;
  state.zones.push(zone);
  return zone;
}

function addBlast(state, blast) {
  if (state.delayedBlasts.length >= MAX_DELAYED_BLASTS) {
    warnBudget('MAX_DELAYED_BLASTS', MAX_DELAYED_BLASTS);
    return;
  }
  blast.id = state.nextEntityId++;
  blast.totalDelay = blast.delay;
  state.delayedBlasts.push(blast);
}

function spawnProjectile(state, player, def, angle, damage) {
  if (state.projectiles.length >= MAX_PROJECTILES) {
    warnBudget('MAX_PROJECTILES', MAX_PROJECTILES);
    return;
  }
  const cx = Math.cos(angle);
  const cy = Math.sin(angle);
  const outLife = def.range / def.speed;
  state.projectiles.push({
    id: state.nextEntityId++,
    ownerId: player.id,
    visual: def.visual || 'orb',
    x: player.x + cx * (player.radius + 8),
    y: player.y + cy * (player.radius + 8),
    vx: cx * def.speed,
    vy: cy * def.speed,
    speed: def.speed,
    radius: def.radius || 8,
    damage,
    age: 0,
    outLife,
    // A boomerang may fly out and back; everything else lives for its range
    life: def.returns ? outLife * 2.5 : outLife,
    color: def.color,
    pierce: !!def.pierce,
    splash: def.splash || 0,
    knockback: def.knockback || 0,
    slow: def.slow || 0,
    silence: def.silence || 0,
    lifesteal: def.lifesteal || 0,
    bounces: def.bounces || 0,
    homing: def.homing || 0,
    returns: !!def.returns,
    returning: false,
    onHit: def.onHit || null,
    curseDelay: def.curseDelay || 1.5,
    curseRadius: def.curseRadius || 110,
    portalLockId: 0,
    hitSet: new Set(),
  });
}

function castAction(state, player, actionKey, aimX, aimY) {
  if (state.phase !== 'playing' || !player.alive) return;
  const charDef = CHARACTER_MAP[player.charId];
  if (!charDef) return;

  const isBasic = actionKey === 'basic';
  const skillIdx = actionKey === 'skill0' ? 0 : actionKey === 'skill1' ? 1 : actionKey === 'skill2' ? 2 : -1;
  if (!isBasic && skillIdx < 0) return;
  // Silence blocks skills, not the basic attack
  if (!isBasic && player.silenceTimer > 0) return;

  const def = isBasic ? charDef.basic : charDef.skills[skillIdx];
  const cdKey = isBasic ? 'basic' : `s${skillIdx}`;
  if (player.cooldowns[cdKey] > 0) return;

  player.cooldowns[cdKey] = def.cooldown;
  player.attackAnim = 0.22;

  // Attacking from stealth reveals you, and that first attack hits harder
  let power = 1;
  if (player.stealthTimer > 0 && def.type !== 'stealth') {
    power = player.ambushMult || 1;
    player.stealthTimer = 0;
    pushEvent(state, { type: 'reveal', x: player.x, y: player.y, color: player.color });
  }
  const dmg = (def.damage || 0) * power;

  const dx = aimX - player.x;
  const dy = aimY - player.y;
  const angle = Math.atan2(dy, dx);
  player.aim = angle;
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const targetDist = Math.hypot(dx, dy);
  const aimPoint = (maxRange, pad = 30) => {
    const d = Math.min(targetDist, maxRange);
    return {
      x: clamp(player.x + dirX * d, MARGIN + pad, WORLD_SIZE - MARGIN - pad),
      y: clamp(player.y + dirY * d, MARGIN + pad, WORLD_SIZE - MARGIN - pad),
    };
  };
  if (def.speedBuff) player.speedBuffTimer = Math.max(player.speedBuffTimer, def.speedBuff);

  switch (def.type) {
    case 'projectile': {
      spawnProjectile(state, player, def, angle, dmg);
      pushEvent(state, { type: 'cast', x: player.x, y: player.y, sound: isBasic ? 'shoot' : 'skill', color: def.color });
      break;
    }

    case 'spread_proj': {
      const count = def.count || 3;
      const spread = def.spread || 0.4;
      for (let i = 0; i < count; i++) {
        const frac = count === 1 ? 0 : i / (count - 1) - 0.5;
        spawnProjectile(state, player, def, angle + frac * spread, dmg);
      }
      pushEvent(state, { type: 'cast', x: player.x, y: player.y, sound: 'spread', color: def.color });
      break;
    }

    case 'melee':
    case 'cone_slam': {
      const range = def.range || 80;
      const halfArc = (def.arc || 1.4) / 2;
      for (const tw of getAllTargets(state, player.id)) {
        const d = Math.hypot(tw.x - player.x, tw.y - player.y);
        if (d > range + tw.r) continue;
        const aTo = Math.atan2(tw.y - player.y, tw.x - player.x);
        if (Math.abs(angleDiff(aTo, angle)) <= halfArc || d < player.radius + tw.r + 12) {
          applyDamage(state, player, tw, dmg, {
            color: def.color,
            knockback: def.knockback || 100,
            kx: d > 0.01 ? (tw.x - player.x) / d : dirX,
            ky: d > 0.01 ? (tw.y - player.y) / d : dirY,
          });
        }
      }
      pushEvent(state, {
        type: 'slash',
        actorId: player.id,
        x: player.x,
        y: player.y,
        angle,
        range,
        arc: def.arc || 1.4,
        color: def.color,
        heavy: def.type === 'cone_slam',
      });
      break;
    }

    case 'dash_strike': {
      const startX = player.x;
      const startY = player.y;
      const { path, end } = traceDash(startX, startY, dirX, dirY, dashDistance(def, targetDist), player.radius);
      const hitIds = new Set();
      for (const pt of path) {
        for (const tw of getAllTargets(state, player.id)) {
          if (hitIds.has(tw.ref.id)) continue;
          if (Math.hypot(tw.x - pt.x, tw.y - pt.y) <= (def.radius || 44) + tw.r) {
            hitIds.add(tw.ref.id);
            applyDamage(state, player, tw, dmg, {
              color: def.color,
              knockback: def.knockback || 200,
              kx: dirX,
              ky: dirY,
            });
          }
        }
      }
      player.x = end.x;
      player.y = end.y;
      player.forcedSeq += 1;
      pushEvent(state, {
        type: 'dash',
        actorId: player.id,
        x1: startX,
        y1: startY,
        x2: player.x,
        y2: player.y,
        color: def.color,
      });
      break;
    }

    case 'blink_chain': {
      const points = [{ x: player.x, y: player.y }];
      const hit = new Set();
      for (let h = 0; h < (def.hops || 3); h++) {
        const tw = nearestTarget(state, player.id, player.x, player.y, def.range || 500, hit);
        if (!tw) break;
        hit.add(tw.ref.id);
        const d = Math.hypot(tw.x - player.x, tw.y - player.y) || 1;
        const back = player.radius + tw.r + 4;
        teleportPlayer(player, tw.x - ((tw.x - player.x) / d) * back, tw.y - ((tw.y - player.y) / d) * back);
        applyDamage(state, player, tw, dmg, { color: def.color });
        points.push({ x: player.x, y: player.y });
      }
      if (points.length === 1) {
        // Nobody in reach: refund most of the cooldown instead of wasting the ultimate
        player.cooldowns[cdKey] = 0.5;
        pushEvent(state, { type: 'fizzle', x: player.x, y: player.y, color: def.color });
        break;
      }
      pushEvent(state, { type: 'blink_chain', actorId: player.id, points, color: def.color });
      break;
    }

    case 'shield_pulse':
    case 'heal_nova': {
      if (def.shield) {
        player.shield = Math.max(player.shield, def.shield);
        player.shieldTimer = def.duration || 4.0;
      }
      if (def.heal) healPlayer(state, player, def.heal);
      const r = def.radius || 140;
      for (const tw of getAllTargets(state, player.id)) {
        const d = Math.hypot(tw.x - player.x, tw.y - player.y);
        if (d <= r + tw.r) {
          applyDamage(state, player, tw, dmg, {
            color: def.color,
            knockback: def.knockback || 0,
            kx: d > 0.01 ? (tw.x - player.x) / d : 1,
            ky: d > 0.01 ? (tw.y - player.y) / d : 0,
            slow: def.slow || 0,
          });
        }
      }
      pushEvent(state, { type: 'nova', actorId: player.id, x: player.x, y: player.y, r, color: def.color });
      break;
    }

    case 'orbit': {
      player.orbitTimer = def.duration || 4.5;
      player.orbitDamage = dmg || 9;
      player.orbitRadius = def.orbitRadius || 100;
      player.orbitCount = def.orbitCount || 2;
      player.orbitColor = def.color;
      player.orbitTick = 0;
      pushEvent(state, { type: 'cast', x: player.x, y: player.y, sound: 'skill', color: def.color });
      break;
    }

    case 'stealth': {
      player.stealthTimer = def.duration || 3;
      player.ambushMult = def.ambush || 1;
      pushEvent(state, { type: 'stealth', x: player.x, y: player.y, color: def.color });
      break;
    }

    case 'rewind': {
      const target = state.clock - (def.seconds || 2) * 1000;
      const idx = player.history.findIndex((h) => h.t >= target);
      if (idx < 0) break;
      const from = player.history[idx];
      // Afterimages along the path we unwind (every other sample keeps the event small)
      const path = player.history.slice(idx).filter((_, i) => i % 2 === 0).map((h) => ({ x: h.x, y: h.y }));
      path.push({ x: player.x, y: player.y });
      teleportPlayer(player, from.x, from.y);
      if (from.hp > player.hp) healPlayer(state, player, Math.min(player.maxHp, from.hp) - player.hp);
      player.history = [];
      pushEvent(state, { type: 'rewind', actorId: player.id, path, x: player.x, y: player.y, color: def.color });
      break;
    }

    case 'zone':
    case 'turret': {
      const at = aimPoint(def.range || 350);
      addZone(state, {
        ownerId: player.id,
        kind: def.type,
        visual: def.visual || def.type,
        x: at.x,
        y: at.y,
        radius: def.radius || 90,
        damage: dmg,
        remaining: def.duration || 3.5,
        duration: def.duration || 3.5,
        tickRate: def.tickRate || 0.6,
        tickTimer: 0.08,
        slow: def.slow || 0,
        pull: def.pull || 0,
        silence: def.silence || 0,
        projSlow: def.projSlow || 0,
        barrier: !!def.barrier,
        color: def.color,
      });
      pushEvent(state, { type: 'cast', x: at.x, y: at.y, sound: 'zone', color: def.color });
      break;
    }

    case 'portal': {
      const at = aimPoint(def.range || 700);
      const exit = resolveCircleObstacles(at.x, at.y, 20);
      const z = addZone(state, {
        ownerId: player.id,
        kind: 'portal',
        visual: 'portal',
        x: player.x,
        y: player.y,
        bx: exit.x,
        by: exit.y,
        radius: def.radius || 34,
        remaining: def.duration || 6,
        duration: def.duration || 6,
        color: def.color,
      });
      // The caster stands in the entrance: they must step out before it can take them
      if (z) player.portalLockId = z.id;
      pushEvent(state, { type: 'portal_open', x1: player.x, y1: player.y, x2: exit.x, y2: exit.y, color: def.color });
      break;
    }

    case 'trail': {
      const z = addZone(state, {
        ownerId: player.id,
        kind: 'trail',
        visual: 'trail',
        x: player.x,
        y: player.y,
        points: [{ x: player.x, y: player.y, until: state.clock + (def.linger || 2) * 1000 }],
        linger: def.linger || 2,
        radius: def.radius || 32,
        damage: dmg,
        remaining: (def.duration || 3) + (def.linger || 2),
        duration: (def.duration || 3) + (def.linger || 2),
        tickRate: def.tickRate || 0.4,
        tickTimer: 0.1,
        slow: def.slow || 0,
        color: def.color,
      });
      if (z) {
        player.trailTimer = def.duration || 3;
        player.trailZoneId = z.id;
      }
      pushEvent(state, { type: 'cast', x: player.x, y: player.y, sound: 'skill', color: def.color });
      break;
    }

    case 'ripple': {
      addZone(state, {
        ownerId: player.id,
        kind: 'ripple',
        x: player.x,
        y: player.y,
        radius: def.radius || 360,
        age: 0,
        duration: def.duration || 0.7,
        remaining: def.duration || 0.7,
        damage: dmg,
        knockback: def.knockback || 0,
        slow: def.slow || 0,
        silence: def.silence || 0,
        color: def.color,
        hitSet: new Set(),
      });
      pushEvent(state, {
        type: 'ripple',
        actorId: player.id,
        x: player.x,
        y: player.y,
        r: def.radius || 360,
        duration: def.duration || 0.7,
        color: def.color,
      });
      break;
    }

    case 'delayed_blast': {
      const center = aimPoint(def.range || 400);
      const count = def.count || 1;
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const rr = i === 0 ? 0 : Math.sqrt(Math.random()) * (def.scatter || 0);
        addBlast(state, {
          kind: 'blast',
          visual: def.visual || null,
          ownerId: player.id,
          x: clamp(center.x + Math.cos(a) * rr, MARGIN + 30, WORLD_SIZE - MARGIN - 30),
          y: clamp(center.y + Math.sin(a) * rr, MARGIN + 30, WORLD_SIZE - MARGIN - 30),
          radius: def.radius || 85,
          damage: dmg,
          delay: (def.delay || 0.45) + i * (def.stagger || 0),
          slow: def.slow || 0,
          knockback: def.knockback || 0,
          color: def.color,
        });
      }
      pushEvent(state, { type: 'cast', x: center.x, y: center.y, sound: 'charge', color: def.color });
      break;
    }

    case 'deadeye': {
      const halfArc = (def.arc || 2) / 2;
      const targetIds = [];
      for (const tw of getAllTargets(state, player.id, true)) {
        if (tw.kind !== 'player') continue;
        const d = Math.hypot(tw.x - player.x, tw.y - player.y);
        const aTo = Math.atan2(tw.y - player.y, tw.x - player.x);
        if (d <= def.range && Math.abs(angleDiff(aTo, angle)) <= halfArc) targetIds.push(tw.ref.id);
      }
      addBlast(state, {
        kind: 'deadeye',
        ownerId: player.id,
        x: player.x,
        y: player.y,
        radius: 0,
        damage: dmg,
        delay: def.delay || 0.8,
        range: def.range,
        targetIds,
        color: def.color,
      });
      pushEvent(state, { type: 'deadeye', actorId: player.id, targetIds, x: player.x, y: player.y, color: def.color });
      break;
    }

    case 'chain_lightning': {
      const hitSet = new Set();
      let curX = player.x;
      let curY = player.y;
      const segments = [];
      for (let bounce = 0; bounce < (def.bounces || 3); bounce++) {
        let best = null;
        let bestScore = Infinity;
        const maxR = segments.length === 0 ? def.range || 640 : 420;
        for (const tw of getAllTargets(state, player.id, true)) {
          if (hitSet.has(tw.ref.id)) continue;
          const d = Math.hypot(tw.x - curX, tw.y - curY);
          if (d > maxR) continue;
          // The first strike prefers targets close to the aim ray
          const score =
            segments.length === 0 ? d + Math.abs(angleDiff(Math.atan2(tw.y - curY, tw.x - curX), angle)) * 160 : d;
          if (score < bestScore) {
            bestScore = score;
            best = tw;
          }
        }
        if (!best) break;
        hitSet.add(best.ref.id);
        segments.push({ x1: curX, y1: curY, x2: best.x, y2: best.y });
        applyDamage(state, player, best, dmg * (segments.length === 1 ? 1 : 0.78), { color: def.color });
        curX = best.x;
        curY = best.y;
      }
      if (segments.length === 0) {
        segments.push({ x1: player.x, y1: player.y, x2: player.x + dirX * 440, y2: player.y + dirY * 440 });
      }
      pushEvent(state, { type: 'lightning', actorId: player.id, segments, color: def.color });
      break;
    }

    case 'beam': {
      const range = def.range || 520;
      const halfW = (def.width || 40) / 2;
      const endX = clamp(player.x + dirX * range, MARGIN, WORLD_SIZE - MARGIN);
      const endY = clamp(player.y + dirY * range, MARGIN, WORLD_SIZE - MARGIN);
      const vx = endX - player.x;
      const vy = endY - player.y;
      const len2 = vx * vx + vy * vy || 1;
      for (const tw of getAllTargets(state, player.id)) {
        // Point-to-segment distance
        const t = clamp(((tw.x - player.x) * vx + (tw.y - player.y) * vy) / len2, 0, 1);
        const d = Math.hypot(tw.x - (player.x + t * vx), tw.y - (player.y + t * vy));
        if (d <= halfW + tw.r) applyDamage(state, player, tw, dmg, { color: def.color });
      }
      pushEvent(state, {
        type: 'beam',
        actorId: player.id,
        x1: player.x,
        y1: player.y,
        x2: endX,
        y2: endY,
        width: def.width || 40,
        color: def.color,
      });
      break;
    }
  }
}

function finishRound(state, now) {
  const active = [...state.players.values()];
  // Winning condition: most kills (roundKos) wins; if equal, more health (hp) wins; if both equal, tied players win together!
  active.sort((a, b) => {
    if (b.roundKos !== a.roundKos) return b.roundKos - a.roundKos;
    if (b.hp !== a.hp) return b.hp - a.hp;
    return b.roundDamage - a.roundDamage;
  });

  let winners = [];
  if (active.length > 0) {
    const top = active[0];
    winners = active.filter((p) => p.roundKos === top.roundKos && p.hp === top.hp);
    for (const w of winners) {
      const lb = state.leaderboard.get(w.id);
      if (lb) {
        lb.wins += 1;
        lb.name = w.name;
        lb.charId = w.charId;
      }
    }
  }

  const primary = winners[0] || null;
  const winnerNameStr = winners.length > 0 ? winners.map((w) => w.name).join(' & ') : 'No Challengers';

  state.lastRoundSummary = {
    roundNumber: state.roundNumber,
    winnerId: primary ? primary.id : null,
    winnerIds: winners.map((w) => w.id),
    winnerNames: winners.map((w) => w.name),
    winnerName: winnerNameStr,
    isTie: winners.length > 1,
    winnerCharId: primary ? primary.charId : null,
    winnerKos: primary ? primary.roundKos : 0,
    winnerHp: primary ? primary.hp : 0,
    winnerMaxHp: primary ? primary.maxHp : 0,
    standings: active.slice(0, 6).map((p) => ({
      id: p.id,
      name: p.name,
      charId: p.charId,
      hp: p.hp,
      maxHp: p.maxHp,
      damage: p.roundDamage,
      kos: p.roundKos,
    })),
  };

  state.phase = 'intermission';
  state.phaseEndAt = now + INTERMISSION_SEC * 1000;
  // All combat stops at the bell: hounds must not keep biting through the intermission.
  for (const p of state.players.values()) {
    p.orbitTimer = 0;
    p.trailTimer = 0;
    p.stealthTimer = 0;
  }
  state.projectiles = [];
  state.zones = [];
  state.delayedBlasts = [];

  pushEvent(state, {
    type: 'round_end',
    winnerName: state.lastRoundSummary.winnerName,
    winnerKos: state.lastRoundSummary.winnerKos,
    winnerHp: state.lastRoundSummary.winnerHp,
    roundNumber: state.roundNumber,
  });
}

function startNextRound(state, now) {
  state.roundNumber += 1;
  state.phase = 'playing';
  state.phaseEndAt = now + ROUND_DURATION_SEC * 1000;
  state.projectiles = [];
  state.zones = [];
  state.delayedBlasts = [];

  for (const s of state.shrines) {
    s.active = true;
    s.respawnAt = 0;
  }
  for (const t of state.totems) {
    t.hp = t.maxHp;
    t.alive = true;
    t.respawnAt = 0;
  }
  for (const p of state.players.values()) {
    const charDef = CHARACTER_MAP[p.charId] || CHARACTERS[0];
    const sp = pickSpawn(state);
    p.x = sp.x;
    p.y = sp.y;
    p.forcedSeq = (p.forcedSeq || 0) + 1;
    p.hp = charDef.hp;
    p.maxHp = charDef.hp;
    p.alive = true;
    p.respawnTimer = 0;
    p.shield = 0;
    p.shieldTimer = 0;
    p.slowTimer = 0;
    p.speedBuffTimer = 0;
    p.orbitTimer = 0;
    p.silenceTimer = 0;
    p.stealthTimer = 0;
    p.trailTimer = 0;
    p.portalLockId = 0;
    p.history = [];
    p.kbx = 0;
    p.kby = 0;
    p.roundDamage = 0;
    p.roundKos = 0;
    p.cooldowns = { basic: 0, s0: 0, s1: 0, s2: 0 };
  }

  pushEvent(state, { type: 'round_start', roundNumber: state.roundNumber });
}

export function stepEngine(now = Date.now()) {
  const state = getState();
  const elapsedMs = now - state.lastStepAt;
  if (elapsedMs <= 0) return state;
  state.clock = now;

  // Prune disconnected players
  for (const [id, p] of state.players.entries()) {
    if (now - p.lastSeen > PLAYER_TIMEOUT_MS) {
      state.players.delete(id);
    }
  }

  // Advance simulation in safe substeps (max 50ms each, cap total catchup to 3s for physics)
  const simMs = Math.min(elapsedMs, 3000);
  const steps = Math.max(1, Math.ceil(simMs / 40));
  const dt = simMs / 1000 / steps;

  for (let s = 0; s < steps; s++) {
    stepPhysics(state, dt, now);
  }

  // Round timer transitions (always exact wall-clock!)
  if (state.phase === 'playing' && now >= state.phaseEndAt) {
    finishRound(state, now);
  } else if (state.phase === 'intermission' && now >= state.phaseEndAt) {
    startNextRound(state, now);
  }

  state.lastStepAt = now;
  return state;
}

function stepPhysics(state, dt, now) {
  // Respawn shrines & totems
  for (const sh of state.shrines) {
    if (!sh.active && now >= sh.respawnAt) sh.active = true;
  }
  for (const t of state.totems) {
    if (t.hitFlash > 0) t.hitFlash = Math.max(0, t.hitFlash - dt);
    if (!t.alive && now >= t.respawnAt) {
      t.alive = true;
      t.hp = t.maxHp;
    }
  }

  const zonesById = new Map(state.zones.map((z) => [z.id, z]));

  // Players movement, cooldowns, status effects
  for (const p of state.players.values()) {
    if (p.hitFlash > 0) p.hitFlash = Math.max(0, p.hitFlash - dt);
    if (p.attackAnim > 0) p.attackAnim = Math.max(0, p.attackAnim - dt);

    for (const k of ['basic', 's0', 's1', 's2']) {
      if (p.cooldowns[k] > 0) p.cooldowns[k] = Math.max(0, p.cooldowns[k] - dt);
    }

    if (!p.alive) {
      p.respawnTimer -= dt;
      if (p.respawnTimer <= 0 && state.phase === 'playing') {
        const sp = pickSpawn(state);
        p.x = sp.x;
        p.y = sp.y;
        p.forcedSeq += 1;
        p.hp = Math.round(p.maxHp * 0.65);
        p.alive = true;
        p.kbx = 0;
        p.kby = 0;
        p.slowTimer = 0;
        p.silenceTimer = 0;
        p.shield = 0;
        p.history = [];
        pushEvent(state, { type: 'respawn', playerId: p.id, x: p.x, y: p.y, color: p.color });
      }
      continue;
    }

    if (p.shieldTimer > 0) {
      p.shieldTimer -= dt;
      if (p.shieldTimer <= 0) p.shield = 0;
    }
    if (p.slowTimer > 0) p.slowTimer = Math.max(0, p.slowTimer - dt);
    if (p.speedBuffTimer > 0) p.speedBuffTimer = Math.max(0, p.speedBuffTimer - dt);
    if (p.silenceTimer > 0) p.silenceTimer = Math.max(0, p.silenceTimer - dt);
    if (p.stealthTimer > 0) {
      p.stealthTimer = Math.max(0, p.stealthTimer - dt);
      if (p.stealthTimer === 0) pushEvent(state, { type: 'reveal', x: p.x, y: p.y, color: p.color });
    }

    // Rewind history: one sample every 0.1s, 3.5s deep (Rewind looks back at most 2s)
    p.historyTick -= dt;
    if (p.historyTick <= 0) {
      p.historyTick = 0.1;
      p.history.push({ t: now, x: p.x, y: p.y, hp: p.hp });
      while (p.history.length && p.history[0].t < now - 3500) p.history.shift();
    }

    // Scalding trail: drop a point every 18px travelled
    if (p.trailTimer > 0) {
      p.trailTimer = Math.max(0, p.trailTimer - dt);
      const z = zonesById.get(p.trailZoneId);
      if (z) {
        const last = z.points[z.points.length - 1];
        if ((!last || Math.hypot(p.x - last.x, p.y - last.y) >= 18) && z.points.length < MAX_TRAIL_POINTS) {
          z.points.push({ x: p.x, y: p.y, until: now + z.linger * 1000 });
        }
      }
    }

    // Orbiting storm orbs
    if (p.orbitTimer > 0) {
      p.orbitTimer = Math.max(0, p.orbitTimer - dt);
      p.orbitAngle = (p.orbitAngle || 0) + dt * 4.2;
      p.orbitTick = (p.orbitTick || 0) - dt;
      if (p.orbitTick <= 0) {
        p.orbitTick = 0.45;
        for (const tw of getAllTargets(state, p.id)) {
          if (Math.hypot(tw.x - p.x, tw.y - p.y) <= p.orbitRadius + tw.r + 16) {
            applyDamage(state, p, tw, p.orbitDamage, { color: p.orbitColor });
          }
        }
      }
    }

    if (state.phase === 'playing') {
      if (Math.hypot(p.kbx, p.kby) > 4) {
        const nextPos = resolveCircleObstacles(p.x + p.kbx * dt, p.y + p.kby * dt, p.radius);
        p.x = nextPos.x;
        p.y = nextPos.y;
        p.kbx *= Math.pow(0.02, dt);
        p.kby *= Math.pow(0.02, dt);
      } else {
        p.kbx = 0;
        p.kby = 0;
      }

      // Shrine pickups
      for (const sh of state.shrines) {
        if (!sh.active) continue;
        if (p.hp < p.maxHp && distSq(p.x, p.y, sh.x, sh.y) <= (p.radius + 24) ** 2) {
          sh.active = false;
          sh.respawnAt = now + sh.respawn * 1000;
          healPlayer(state, p, sh.heal);
          pushEvent(state, { type: 'shrine', x: sh.x, y: sh.y, playerName: p.name });
        }
      }
    }
  }

  // Player-to-player soft separation
  const alivePlayers = [...state.players.values()].filter((p) => p.alive);
  for (let i = 0; i < alivePlayers.length; i++) {
    for (let j = i + 1; j < alivePlayers.length; j++) {
      const a = alivePlayers[i];
      const b = alivePlayers[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const minD = a.radius + b.radius;
      const d2 = dx * dx + dy * dy;
      if (d2 < minD * minD && d2 > 0.001) {
        const d = Math.sqrt(d2);
        const overlap = (minD - d) * 0.5;
        const ux = dx / d;
        const uy = dy / d;
        const ra = resolveCircleObstacles(a.x - ux * overlap, a.y - uy * overlap, a.radius);
        const rb = resolveCircleObstacles(b.x + ux * overlap, b.y + uy * overlap, b.radius);
        a.x = ra.x;
        a.y = ra.y;
        b.x = rb.x;
        b.y = rb.y;
      }
    }
  }

  stepProjectiles(state, dt);
  stepZones(state, dt, now);
  stepBlasts(state, dt);
}

// A portal pair moves anything inside one end to the other. `lock` remembers the portal an entity just
// used, so it is not bounced straight back; the lock clears once the entity is outside both ends.
function portalTransfer(z, ent, entRadius) {
  const inA = distSq(ent.x, ent.y, z.x, z.y) < (z.radius + entRadius * 0.3) ** 2;
  const inB = distSq(ent.x, ent.y, z.bx, z.by) < (z.radius + entRadius * 0.3) ** 2;
  if (ent.portalLockId === z.id) {
    if (!inA && !inB) ent.portalLockId = 0;
    return null;
  }
  if (!inA && !inB) return null;
  ent.portalLockId = z.id;
  return inA ? { x: z.bx, y: z.by } : { x: z.x, y: z.y };
}

function stepProjectiles(state, dt) {
  const portals = state.zones.filter((z) => z.kind === 'portal');
  const stasis = state.zones.filter((z) => z.projSlow > 0);
  const barriers = state.zones.filter((z) => z.barrier);

  const next = [];
  for (const pr of state.projectiles) {
    // Enemy stasis bubbles slow the projectile's clock (it moves and ages slower inside)
    let factor = 1;
    for (const z of stasis) {
      if (z.ownerId !== pr.ownerId && distSq(pr.x, pr.y, z.x, z.y) <= z.radius * z.radius) {
        factor = Math.min(factor, z.projSlow);
      }
    }
    const pdt = dt * factor;
    const owner = state.players.get(pr.ownerId);
    pr.age += pdt;
    pr.life -= pdt;

    let dead = pr.life <= 0;
    let fizzled = false;

    if (pr.returns && !pr.returning && pr.age >= pr.outLife) {
      pr.returning = true;
      pr.hitSet.clear();
    }
    if (pr.returning) {
      if (!owner || !owner.alive) {
        dead = true;
        fizzled = true;
      } else {
        const d = Math.hypot(owner.x - pr.x, owner.y - pr.y) || 1;
        pr.vx = ((owner.x - pr.x) / d) * pr.speed;
        pr.vy = ((owner.y - pr.y) / d) * pr.speed;
      }
    } else if (pr.homing > 0) {
      const tgt = nearestTarget(state, pr.ownerId, pr.x, pr.y, 520);
      if (tgt) {
        const cur = Math.atan2(pr.vy, pr.vx);
        const turn = clamp(angleDiff(Math.atan2(tgt.y - pr.y, tgt.x - pr.x), cur), -pr.homing * pdt, pr.homing * pdt);
        pr.vx = Math.cos(cur + turn) * pr.speed;
        pr.vy = Math.sin(cur + turn) * pr.speed;
      }
    }

    pr.x += pr.vx * pdt;
    pr.y += pr.vy * pdt;

    // A returning boomerang is caught by its owner
    if (!dead && pr.returning && owner && Math.hypot(owner.x - pr.x, owner.y - pr.y) < owner.radius + pr.radius) {
      dead = true;
      fizzled = true;
    }

    // Walls & obstacles
    if (!dead) {
      const n = obstacleNormal(pr.x, pr.y, pr.radius);
      if (n) {
        if (pr.onHit === 'grapple' && owner && owner.alive) {
          const d = Math.hypot(pr.vx, pr.vy) || 1;
          const back = owner.radius + pr.radius + 6;
          const x1 = owner.x;
          const y1 = owner.y;
          teleportPlayer(owner, pr.x - (pr.vx / d) * back, pr.y - (pr.vy / d) * back);
          pushEvent(state, { type: 'dash', x1, y1, x2: owner.x, y2: owner.y, color: pr.color });
          dead = true;
          fizzled = true;
        } else if (pr.bounces > 0 || (pr.returns && !pr.returning)) {
          const dot = pr.vx * n.nx + pr.vy * n.ny;
          if (dot < 0) {
            pr.vx -= 2 * dot * n.nx;
            pr.vy -= 2 * dot * n.ny;
          }
          const out = resolveCircleObstacles(pr.x, pr.y, pr.radius);
          pr.x = out.x;
          pr.y = out.y;
          if (pr.bounces > 0) pr.bounces -= 1;
          else pr.returning = true;
          pr.hitSet.clear();
          pushEvent(state, { type: 'bounce', x: pr.x, y: pr.y, color: pr.color });
        } else {
          dead = true;
        }
      }
    }

    // Enemy barrier domes delete the shot
    if (!dead) {
      for (const z of barriers) {
        if (z.ownerId !== pr.ownerId && distSq(pr.x, pr.y, z.x, z.y) <= z.radius * z.radius) {
          dead = true;
          fizzled = true;
          pushEvent(state, { type: 'fizzle', x: pr.x, y: pr.y, color: z.color });
          break;
        }
      }
    }

    // Portals carry shots too
    if (!dead) {
      for (const z of portals) {
        const to = portalTransfer(z, pr, pr.radius);
        if (to) {
          pr.x = to.x;
          pr.y = to.y;
          break;
        }
      }
    }

    if (!dead) {
      for (const tw of getAllTargets(state, pr.ownerId)) {
        if (pr.hitSet.has(tw.ref.id)) continue;
        if (distSq(pr.x, pr.y, tw.x, tw.y) > (pr.radius + tw.r) ** 2) continue;
        pr.hitSet.add(tw.ref.id);
        onProjectileHit(state, pr, owner, tw);
        if (pr.onHit === 'curse') fizzled = true; // the bomb does the damage, not a splash
        if (!pr.pierce) {
          dead = true;
          break;
        }
      }
    }

    if (dead && pr.splash > 0 && !fizzled) {
      for (const tw of getAllTargets(state, pr.ownerId)) {
        if (pr.hitSet.has(tw.ref.id)) continue;
        const d = Math.hypot(tw.x - pr.x, tw.y - pr.y);
        if (d <= pr.splash + tw.r) {
          applyDamage(state, owner, tw, pr.damage * 0.75, {
            color: pr.color,
            knockback: pr.knockback * 0.8,
            kx: d > 0.01 ? (tw.x - pr.x) / d : 1,
            ky: d > 0.01 ? (tw.y - pr.y) / d : 0,
          });
        }
      }
      pushEvent(state, { type: 'blast', x: pr.x, y: pr.y, r: pr.splash, color: pr.color });
    }

    if (!dead) next.push(pr);
  }
  state.projectiles = next;
}

function onProjectileHit(state, pr, owner, tw) {
  const isPlayer = tw.kind === 'player';
  const canAct = owner && owner.alive;
  if (pr.onHit === 'curse') {
    addBlast(state, {
      kind: 'bomb',
      ownerId: pr.ownerId,
      attachId: isPlayer ? tw.ref.id : null,
      x: tw.x,
      y: tw.y,
      radius: pr.curseRadius,
      damage: pr.damage,
      delay: pr.curseDelay,
      knockback: 160,
      color: pr.color,
    });
    pushEvent(state, { type: 'cursed', x: tw.x, y: tw.y, targetId: tw.ref.id, color: pr.color });
    return;
  }
  if (pr.onHit === 'hook' && canAct && isPlayer) {
    const dx = owner.x - tw.x;
    const dy = owner.y - tw.y;
    const d = Math.hypot(dx, dy) || 1;
    const pullD = Math.max(0, d - 68);
    teleportPlayer(tw.ref, tw.x + (dx / d) * pullD, tw.y + (dy / d) * pullD);
    applyDamage(state, owner, tw, pr.damage, { color: pr.color, slow: 1.0 });
    pushEvent(state, { type: 'dash', x1: tw.x, y1: tw.y, x2: tw.ref.x, y2: tw.ref.y, color: pr.color });
    return;
  }
  if (pr.onHit === 'swap' && canAct && isPlayer) {
    const ox = owner.x;
    const oy = owner.y;
    teleportPlayer(owner, tw.ref.x, tw.ref.y);
    teleportPlayer(tw.ref, ox, oy);
    applyDamage(state, owner, tw, pr.damage, { color: pr.color });
    pushEvent(state, { type: 'swap', x1: ox, y1: oy, x2: owner.x, y2: owner.y, color: pr.color });
    return;
  }
  if (pr.onHit === 'grapple' && canAct) {
    const d = Math.hypot(tw.x - owner.x, tw.y - owner.y) || 1;
    const back = owner.radius + tw.r + 4;
    const x1 = owner.x;
    const y1 = owner.y;
    teleportPlayer(owner, tw.x - ((tw.x - owner.x) / d) * back, tw.y - ((tw.y - owner.y) / d) * back);
    applyDamage(state, owner, tw, pr.damage, { color: pr.color });
    pushEvent(state, { type: 'dash', x1, y1, x2: owner.x, y2: owner.y, color: pr.color });
    return;
  }
  const vLen = Math.hypot(pr.vx, pr.vy) || 1;
  applyDamage(state, owner, tw, pr.damage, {
    color: pr.color,
    knockback: pr.knockback,
    kx: pr.vx / vLen,
    ky: pr.vy / vLen,
    slow: pr.slow,
    silence: pr.silence,
    lifesteal: pr.lifesteal,
  });
}

function stepZones(state, dt, now) {
  const next = [];
  for (const z of state.zones) {
    z.remaining -= dt;
    const owner = state.players.get(z.ownerId);

    if (z.kind === 'portal') {
      for (const p of state.players.values()) {
        if (!p.alive) continue;
        const to = portalTransfer(z, p, p.radius);
        if (to) {
          const x1 = p.x;
          const y1 = p.y;
          teleportPlayer(p, to.x, to.y);
          pushEvent(state, { type: 'portal', x1, y1, x2: p.x, y2: p.y, color: z.color });
        }
      }
    } else if (z.kind === 'ripple') {
      z.age += dt;
      const r = z.radius * Math.min(1, z.age / z.duration);
      for (const tw of getAllTargets(state, z.ownerId)) {
        if (z.hitSet.has(tw.ref.id)) continue;
        const d = Math.hypot(tw.x - z.x, tw.y - z.y);
        if (d > r + tw.r) continue;
        z.hitSet.add(tw.ref.id);
        applyDamage(state, owner, tw, z.damage, {
          color: z.color,
          knockback: z.knockback,
          kx: d > 0.01 ? (tw.x - z.x) / d : 1,
          ky: d > 0.01 ? (tw.y - z.y) / d : 0,
          slow: z.slow,
          silence: z.silence,
        });
      }
    } else {
      if (z.kind === 'trail') z.points = z.points.filter((pt) => pt.until > now);

      // Continuous gravity pull
      if (z.pull > 0) {
        for (const tw of getAllTargets(state, z.ownerId)) {
          if (tw.kind !== 'player') continue;
          const dx = z.x - tw.x;
          const dy = z.y - tw.y;
          const d = Math.hypot(dx, dy);
          if (d > 14 && d <= z.radius + tw.r) {
            const dest = resolveCircleObstacles(
              tw.ref.x + (dx / d) * z.pull * dt,
              tw.ref.y + (dy / d) * z.pull * dt,
              tw.r
            );
            tw.ref.x = dest.x;
            tw.ref.y = dest.y;
            tw.ref.forceSyncUntil = now + 200;
          }
        }
      }

      z.tickTimer -= dt;
      if (z.tickTimer <= 0) {
        z.tickTimer = z.tickRate;
        if (z.kind === 'turret') {
          const nearest = nearestTarget(state, z.ownerId, z.x, z.y, z.radius);
          if (nearest) {
            applyDamage(state, owner, nearest, z.damage, { color: z.color });
            pushEvent(state, {
              type: 'lightning',
              segments: [{ x1: z.x, y1: z.y - 12, x2: nearest.x, y2: nearest.y }],
              color: z.color,
            });
          }
        } else {
          for (const tw of getAllTargets(state, z.ownerId)) {
            const inside =
              z.kind === 'trail'
                ? z.points.some((pt) => distSq(tw.x, tw.y, pt.x, pt.y) <= (z.radius + tw.r) ** 2)
                : distSq(tw.x, tw.y, z.x, z.y) <= (z.radius + tw.r) ** 2;
            if (inside) {
              applyDamage(state, owner, tw, z.damage, { color: z.color, slow: z.slow, silence: z.silence });
            }
          }
        }
      }
    }

    if (z.remaining > 0) next.push(z);
  }
  state.zones = next;
}

function stepBlasts(state, dt) {
  const next = [];
  for (const b of state.delayedBlasts) {
    // A time bomb rides on its victim until it goes off
    if (b.kind === 'bomb' && b.attachId) {
      const v = state.players.get(b.attachId);
      if (v && v.alive) {
        b.x = v.x;
        b.y = v.y;
      }
    }
    b.delay -= dt;
    if (b.delay > 0) {
      next.push(b);
      continue;
    }
    const owner = state.players.get(b.ownerId);

    if (b.kind === 'deadeye') {
      // Targets that died, vanished into stealth, or ran far out of range dodge the shot
      if (!owner || !owner.alive) continue;
      const segments = [];
      for (const id of b.targetIds) {
        const t = state.players.get(id);
        if (!t || !t.alive || t.stealthTimer > 0) continue;
        if (Math.hypot(t.x - owner.x, t.y - owner.y) > b.range * 1.25) continue;
        segments.push({ x1: owner.x, y1: owner.y, x2: t.x, y2: t.y });
        applyDamage(state, owner, { kind: 'player', ref: t, x: t.x, y: t.y, r: t.radius }, b.damage, {
          color: b.color,
        });
      }
      pushEvent(state, { type: 'tracer', actorId: owner.id, x: owner.x, y: owner.y, segments, color: b.color });
      continue;
    }

    for (const tw of getAllTargets(state, b.ownerId)) {
      const d = Math.hypot(tw.x - b.x, tw.y - b.y);
      if (d <= b.radius + tw.r) {
        applyDamage(state, owner, tw, b.damage, {
          color: b.color,
          slow: b.slow,
          knockback: b.knockback,
          kx: d > 0.01 ? (tw.x - b.x) / d : 1,
          ky: d > 0.01 ? (tw.y - b.y) / d : 0,
        });
      }
    }
    pushEvent(state, { type: 'blast', x: b.x, y: b.y, r: b.radius, color: b.color, big: b.kind === 'bomb' });
  }
  state.delayedBlasts = next;
}

function sanitizeName(name) {
  return (
    String(name || 'Wanderer')
      .trim()
      .replace(/[^\p{L}\p{N}\s_\-'.!]/gu, '')
      .replace(/\s+/g, ' ')
      .slice(0, 18) || 'Wanderer'
  );
}

function applyCharacter(player, charDef) {
  player.charId = charDef.id;
  player.speed = charDef.speed;
  player.radius = charDef.radius;
  player.color = charDef.color;
}

function pruneLeaderboardForNewEntry(state) {
  if (state.leaderboard.size < MAX_LEADERBOARD) return;
  // Drop the lowest-win offline entry (and its session) to keep RAM strictly bounded
  let victim = null;
  for (const entry of state.leaderboard.values()) {
    if (!state.players.has(entry.id) && (!victim || entry.wins < victim.wins)) victim = entry;
  }
  if (victim) {
    state.leaderboard.delete(victim.id);
    state.sessions.delete(victim.session);
  }
}

// Joins a new player, or switches hero for an existing one. Switching keeps HP ratio, life state,
// cooldowns and position, so re-submitting the hero dialog can never heal, revive, or reset skills.
export function joinPlayer({ session, name, charId, ip }) {
  const now = Date.now();
  const state = stepEngine(now);
  const safeName = sanitizeName(name);
  const charDef = CHARACTER_MAP[charId] || CHARACTERS[0];

  const knownId = state.sessions.get(session);
  const existing = knownId ? state.players.get(knownId) : null;

  if (existing) {
    const hpRatio = existing.maxHp > 0 ? existing.hp / existing.maxHp : 1;
    applyCharacter(existing, charDef);
    existing.name = safeName;
    existing.maxHp = charDef.hp;
    existing.hp = existing.alive ? Math.max(1, Math.round(charDef.hp * hpRatio)) : 0;
    existing.orbitTimer = 0;
    existing.trailTimer = 0;
    existing.history = []; // Rewind must not restore HP measured against another hero's max HP
    existing.lastSeen = now;
    const resolved = resolveCircleObstacles(existing.x, existing.y, existing.radius);
    existing.x = resolved.x;
    existing.y = resolved.y;
    const lb = state.leaderboard.get(existing.id);
    if (lb) {
      lb.name = safeName;
      lb.charId = charDef.id;
    }
    return buildSnapshot(state, existing.id, 0);
  }

  if (state.players.size >= MAX_PLAYERS) {
    return { error: `Arena is full (max_players=${MAX_PLAYERS}). Try again shortly.`, status: 429 };
  }
  if (ip && ip !== 'unknown') {
    let sameIpCount = 0;
    for (const p of state.players.values()) {
      if (p.ip === ip) sameIpCount += 1;
    }
    if (sameIpCount >= MAX_PLAYERS_PER_IP) {
      return {
        error: `Too many active players from this network (max_players_per_ip=${MAX_PLAYERS_PER_IP}).`,
        status: 429,
      };
    }
  }

  // A returning session keeps its public id, so its leaderboard wins follow it across reloads.
  let id = knownId;
  if (!id) {
    pruneLeaderboardForNewEntry(state);
    id = `pl${state.nextPlayerNum++}`;
    state.sessions.set(session, id);
  }

  const sp = pickSpawn(state);
  const player = {
    id,
    ip: ip || 'unknown',
    name: safeName,
    x: sp.x,
    y: sp.y,
    aim: 0,
    inputX: 0,
    inputY: 0,
    kbx: 0,
    kby: 0,
    moving: false,
    hp: charDef.hp,
    maxHp: charDef.hp,
    alive: true,
    respawnTimer: 0,
    shield: 0,
    shieldTimer: 0,
    slowTimer: 0,
    speedBuffTimer: 0,
    silenceTimer: 0,
    stealthTimer: 0,
    ambushMult: 1,
    trailTimer: 0,
    trailZoneId: 0,
    portalLockId: 0,
    history: [],
    historyTick: 0,
    orbitTimer: 0,
    orbitAngle: 0,
    orbitRadius: 100,
    orbitCount: 2,
    orbitColor: '#ffffff',
    orbitDamage: 0,
    orbitTick: 0,
    hitFlash: 0,
    attackAnim: 0,
    cooldowns: { basic: 0, s0: 0, s1: 0, s2: 0 },
    roundDamage: 0,
    roundKos: 0,
    forcedSeq: 1,
    forceSyncUntil: 0,
    moveBudget: 0,
    lastMoveAt: now,
    joinedAt: now,
    lastSeen: now,
  };
  applyCharacter(player, charDef);
  state.players.set(id, player);

  const lb = state.leaderboard.get(id);
  if (lb) {
    lb.name = safeName;
    lb.charId = charDef.id;
  } else {
    state.leaderboard.set(id, { id, session, name: safeName, charId: charDef.id, wins: 0, kos: 0, damage: 0 });
  }

  return buildSnapshot(state, id, 0);
}

export function leavePlayer(session) {
  const state = stepEngine(Date.now());
  const id = state.sessions.get(session);
  if (id) state.players.delete(id);
  return { ok: true };
}

function finiteOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function handleTick(payload) {
  const now = Date.now();
  const { session, ix, iy, cx, cy, fseq, moving, aim, actions, lastEventId } = payload || {};
  const state = stepEngine(now);
  const id = state.sessions.get(session);
  const player = id ? state.players.get(id) : null;

  if (player) {
    let speedMult = 1;
    if (player.slowTimer > 0) speedMult *= 0.56;
    if (player.speedBuffTimer > 0) speedMult *= 1.38;
    const speed = player.speed * speedMult;
    // Token-bucket movement budget: travel allowance grows with real elapsed time, never with tick count,
    // so sending ticks faster cannot move a player faster.
    const elapsedSec = Math.max(0, (now - player.lastMoveAt) / 1000);
    player.moveBudget = Math.min(player.moveBudget + speed * elapsedSec, speed * MOVE_BANK_SEC + MOVE_SLACK_PX);
    player.lastMoveAt = now;
    player.lastSeen = now;
    player.inputX = clamp(finiteOr(ix, 0), -1, 1);
    player.inputY = clamp(finiteOr(iy, 0), -1, 1);
    player.moving = Boolean(moving) || Math.hypot(player.inputX, player.inputY) > 0.1;
    const aimN = Number(aim);
    if (Number.isFinite(aimN)) player.aim = Math.atan2(Math.sin(aimN), Math.cos(aimN));

    // Accept the client-predicted position only if the client has seen the latest server-forced move
    // (fseq ack) — otherwise in-flight ticks would drag a hooked/dashed/respawned player back.
    const ncx = Number(cx);
    const ncy = Number(cy);
    if (
      state.phase === 'playing' &&
      player.alive &&
      now >= player.forceSyncUntil &&
      Number(fseq) === player.forcedSeq &&
      Number.isFinite(ncx) &&
      Number.isFinite(ncy)
    ) {
      const dx = ncx - player.x;
      const dy = ncy - player.y;
      const dist = Math.hypot(dx, dy);
      const step = Math.min(dist, player.moveBudget);
      const targetX = dist > step ? player.x + (dx / dist) * step : ncx;
      const targetY = dist > step ? player.y + (dy / dist) * step : ncy;
      player.moveBudget -= step;
      const resolved = resolveCircleObstacles(targetX, targetY, player.radius);
      player.x = resolved.x;
      player.y = resolved.y;
    }

    if (Array.isArray(actions)) {
      for (const act of actions.slice(0, 4)) {
        if (act && typeof act.key === 'string') {
          castAction(state, player, act.key, finiteOr(act.tx, player.x), finiteOr(act.ty, player.y));
        }
      }
    }
  }

  return buildSnapshot(state, player ? player.id : '', finiteOr(lastEventId, 0));
}

export function buildSnapshot(state, selfId, sinceEventId = 0) {
  const now = Date.now();
  const timeLeft = Math.max(0, (state.phaseEndAt - now) / 1000);

  // Determine current round leader(s): most KOs, tie-broken by HP (all tied players share the crown)
  let bestKos = -1;
  let bestHp = -1;
  for (const p of state.players.values()) {
    if (p.roundKos > bestKos || (p.roundKos === bestKos && p.hp > bestHp)) {
      bestKos = p.roundKos;
      bestHp = p.hp;
    }
  }
  const leaderIds = [];
  for (const p of state.players.values()) {
    if (p.roundKos === bestKos && p.hp === bestHp) leaderIds.push(p.id);
  }
  const leaderId = leaderIds[0] || null;

  const players = [];
  for (const p of state.players.values()) {
    // True stealth: enemies are not sent a stealthed player at all, so no client (or cheat) can draw them
    const stealthed = p.alive && p.stealthTimer > 0;
    if (stealthed && p.id !== selfId) continue;
    players.push({
      id: p.id,
      name: p.name,
      charId: p.charId,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      aim: Math.round(p.aim * 100) / 100,
      moving: p.moving,
      hp: p.hp,
      maxHp: p.maxHp,
      kos: p.roundKos,
      shield: Math.round(p.shield),
      alive: p.alive,
      respawn: Math.round(p.respawnTimer * 10) / 10,
      slow: p.slowTimer > 0,
      haste: p.speedBuffTimer > 0,
      hit: p.hitFlash > 0,
      atk: p.attackAnim > 0,
      silenced: p.silenceTimer > 0,
      stealth: stealthed,
      trail: p.trailTimer > 0,
      orbit: p.orbitTimer > 0 ? Math.round(p.orbitAngle * 100) / 100 : null,
      orbitR: p.orbitTimer > 0 ? p.orbitRadius : undefined,
      orbitN: p.orbitTimer > 0 ? p.orbitCount : undefined,
      orbitC: p.orbitTimer > 0 ? p.orbitColor : undefined,
      fseq: p.forcedSeq || 1,
      force: now < (p.forceSyncUntil || 0),
      cds:
        p.id === selfId
          ? {
              basic: Math.round(p.cooldowns.basic * 100) / 100,
              s0: Math.round(p.cooldowns.s0 * 100) / 100,
              s1: Math.round(p.cooldowns.s1 * 100) / 100,
              s2: Math.round(p.cooldowns.s2 * 100) / 100,
            }
          : undefined,
    });
  }

  const leaderboard = [...state.leaderboard.values()]
    .map((entry) => {
      const live = state.players.get(entry.id);
      return {
        id: entry.id,
        name: entry.name,
        charId: entry.charId,
        wins: entry.wins,
        kos: entry.kos,
        roundKos: live ? live.roundKos : 0,
        online: !!live,
        hp: live ? live.hp : 0,
        maxHp: live ? live.maxHp : 0,
      };
    })
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.online !== a.online) return Number(b.online) - Number(a.online);
      if (b.roundKos !== a.roundKos) return b.roundKos - a.roundKos;
      if (b.hp !== a.hp) return b.hp - a.hp;
      return b.kos - a.kos;
    })
    .slice(0, 12);

  // A fresh cursor (0) or one from a previous server process (ahead of ours) gets no backlog, only our cursor,
  // so a page load never replays old KOs and a server restart never silences a client.
  const latestEventId = state.nextEventId - 1;
  const cursorValid = sinceEventId > 0 && sinceEventId <= latestEventId;
  const events = cursorValid ? state.events.filter((e) => e.id > sinceEventId) : [];

  return {
    now,
    selfId: state.players.has(selfId) ? selfId : null,
    joined: state.players.has(selfId),
    roundNumber: state.roundNumber,
    phase: state.phase,
    timeLeft: Math.round(timeLeft * 10) / 10,
    leaderId,
    leaderIds,
    playerCount: state.players.size,
    players,
    projectiles: state.projectiles.map((pr) => {
      // Line skills draw a rope back to their thrower
      const owner = pr.onHit === 'hook' || pr.onHit === 'grapple' ? state.players.get(pr.ownerId) : null;
      return {
        id: pr.id,
        ownerId: pr.ownerId,
        x: Math.round(pr.x),
        y: Math.round(pr.y),
        vx: Math.round(pr.vx),
        vy: Math.round(pr.vy),
        r: pr.radius,
        c: pr.color,
        k: pr.visual,
        ox: owner ? Math.round(owner.x) : undefined,
        oy: owner ? Math.round(owner.y) : undefined,
      };
    }),
    // Ripples are drawn from their 'ripple' event; the zone only times the hits
    zones: state.zones
      .filter((z) => z.kind !== 'ripple')
      .map((z) => ({
        id: z.id,
        kind: z.kind,
        v: z.visual,
        ownerId: z.ownerId,
        x: Math.round(z.x),
        y: Math.round(z.y),
        r: z.radius,
        c: z.color,
        rem: Math.round(z.remaining * 10) / 10,
        dur: z.duration,
        bx: z.kind === 'portal' ? Math.round(z.bx) : undefined,
        by: z.kind === 'portal' ? Math.round(z.by) : undefined,
        pts: z.kind === 'trail' ? z.points.flatMap((pt) => [Math.round(pt.x), Math.round(pt.y)]) : undefined,
      })),
    blasts: state.delayedBlasts.map((b) => ({
      id: b.id,
      kind: b.kind,
      v: b.visual || undefined,
      x: Math.round(b.x),
      y: Math.round(b.y),
      r: b.radius,
      c: b.color,
      p: Math.round((1 - b.delay / b.totalDelay) * 100) / 100,
      at: b.kind === 'bomb' ? b.attachId : undefined,
      tg: b.kind === 'deadeye' ? b.targetIds : undefined,
      ownerId: b.ownerId,
    })),
    shrines: state.shrines.map((s) => ({ id: s.id, x: s.x, y: s.y, active: s.active })),
    totems: state.totems.map((t) => ({
      id: t.id,
      x: t.x,
      y: t.y,
      hp: t.hp,
      maxHp: t.maxHp,
      alive: t.alive,
      hit: t.hitFlash > 0,
    })),
    leaderboard,
    lastRoundSummary: state.lastRoundSummary,
    events,
    lastEventId: latestEventId,
  };
}
