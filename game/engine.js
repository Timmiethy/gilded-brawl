// Authoritative in-RAM multiplayer game engine for Gilded Brawl
import { CHARACTER_MAP, CHARACTERS } from '../public/shared/characters.js';
import {
  WORLD_SIZE,
  ROUND_DURATION_SEC,
  INTERMISSION_SEC,
  OBSTACLES,
  SPAWN_POINTS,
  SHRINE_SPOTS,
  PRACTICE_TOTEM_SPOTS,
} from '../public/shared/map.js';

const PLAYER_TIMEOUT_MS = 12_000;
const RESPAWN_TIME_SEC = 4.0;
const MAX_EVENTS = 160;
const MAX_PLAYERS = 60;
const MAX_PLAYERS_PER_IP = 4;
const MAX_LEADERBOARD = 200;
const MAX_PROJECTILES = 120;
const MAX_ZONES = 40;
const MAX_DELAYED_BLASTS = 30;
const MARGIN = 44;

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
    nextEntityId: 1,
    nextEventId: 1,
    players: new Map(), // clientId -> player object
    leaderboard: new Map(), // clientId -> { id, name, charId, wins, kos, damage }
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
  evt.t = Date.now();
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

function resolveCircleObstacles(x, y, radius) {
  let nx = clamp(x, MARGIN + radius, WORLD_SIZE - MARGIN - radius);
  let ny = clamp(y, MARGIN + radius, WORLD_SIZE - MARGIN - radius);
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

function hitsObstacle(x, y, radius) {
  if (x < MARGIN || x > WORLD_SIZE - MARGIN || y < MARGIN || y > WORLD_SIZE - MARGIN) return true;
  for (const ob of OBSTACLES) {
    const minD = radius + ob.r;
    if (distSq(x, y, ob.x, ob.y) < minD * minD) return true;
  }
  return false;
}

function getAllTargets(state, attackerId) {
  const targets = [];
  for (const p of state.players.values()) {
    if (p.id !== attackerId && p.alive) {
      targets.push({ kind: 'player', ref: p, x: p.x, y: p.y, r: p.radius });
    }
  }
  for (const t of state.totems) {
    if (t.alive) {
      targets.push({ kind: 'totem', ref: t, x: t.x, y: t.y, r: 22 });
    }
  }
  return targets;
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
      t.respawnAt = Date.now() + 5000;
      pushEvent(state, { type: 'blast', x: t.x, y: t.y, r: 48, color: '#ffe082' });
    }
    if (attacker && opts.lifesteal) {
      healPlayer(state, attacker, opts.lifesteal);
    }
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
    if (opts.lifesteal) {
      healPlayer(state, attacker, opts.lifesteal);
    }
  }

  if (opts.knockback && opts.kx !== undefined && opts.ky !== undefined) {
    victim.kbx += opts.kx * opts.knockback;
    victim.kby += opts.ky * opts.knockback;
    victim.forceSyncUntil = Date.now() + 350;
  }
  if (opts.slow) {
    victim.slowTimer = Math.max(victim.slowTimer, opts.slow);
  }

  pushEvent(state, {
    type: 'hit',
    x: victim.x,
    y: victim.y - 20,
    dmg,
    color: opts.color || '#ff8a80',
    targetId: victim.id,
    attackerId: attacker?.id || null,
  });

  if (victim.hp <= 0) {
    victim.alive = false;
    victim.respawnTimer = RESPAWN_TIME_SEC;
    victim.shield = 0;
    victim.orbitTimer = 0;
    if (attacker && attacker.id !== victim.id) {
      attacker.roundKos += 1;
      const lb = state.leaderboard.get(attacker.id);
      if (lb) lb.kos += 1;
    }
    pushEvent(state, {
      type: 'ko',
      x: victim.x,
      y: victim.y,
      victimName: victim.name,
      attackerName: attacker ? attacker.name : 'Arena',
      color: victim.color,
    });
  }
}

function healPlayer(state, player, amount) {
  if (!player.alive) return;
  const before = player.hp;
  player.hp = Math.min(player.maxHp, Math.round(player.hp + amount));
  const actual = player.hp - before;
  if (actual > 0) {
    pushEvent(state, {
      type: 'heal',
      x: player.x,
      y: player.y - 22,
      amount: actual,
      targetId: player.id,
    });
  }
}

function castAction(state, player, actionKey, aimX, aimY) {
  if (state.phase !== 'playing' || !player.alive) return;
  const charDef = CHARACTER_MAP[player.charId];
  if (!charDef) return;

  const isBasic = actionKey === 'basic';
  const skillIdx = actionKey === 'skill0' ? 0 : actionKey === 'skill1' ? 1 : actionKey === 'skill2' ? 2 : -1;
  if (!isBasic && skillIdx < 0) return;

  const def = isBasic ? charDef.basic : charDef.skills[skillIdx];
  const cdKey = isBasic ? 'basic' : `s${skillIdx}`;
  if (player.cooldowns[cdKey] > 0) return;

  player.cooldowns[cdKey] = def.cooldown;
  player.attackAnim = 0.22;

  const dx = aimX - player.x;
  const dy = aimY - player.y;
  const angle = Math.atan2(dy, dx);
  player.aim = angle;
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const targetDist = Math.hypot(dx, dy);

  switch (def.type) {
    case 'projectile':
    case 'explosive_proj':
    case 'hook': {
      if (state.projectiles.length >= MAX_PROJECTILES) break;
      state.projectiles.push({
        id: state.nextEntityId++,
        ownerId: player.id,
        kind: def.type,
        x: player.x + dirX * (player.radius + 8),
        y: player.y + dirY * (player.radius + 8),
        vx: dirX * def.speed,
        vy: dirY * def.speed,
        radius: def.radius || 8,
        damage: def.damage,
        life: def.range / def.speed,
        color: def.color,
        pierce: !!def.pierce,
        splash: def.splash || 0,
        knockback: def.knockback || 0,
        slow: def.slow || 0,
        lifesteal: def.lifesteal || 0,
        hitSet: new Set(),
      });
      pushEvent(state, { type: 'cast', x: player.x, y: player.y, sound: isBasic ? 'shoot' : 'skill', color: def.color });
      break;
    }

    case 'spread_proj': {
      const count = def.count || 3;
      const spread = def.spread || 0.4;
      for (let i = 0; i < count; i++) {
        if (state.projectiles.length >= MAX_PROJECTILES) break;
        const frac = count === 1 ? 0 : i / (count - 1) - 0.5;
        const a = angle + frac * spread;
        const cx = Math.cos(a);
        const cy = Math.sin(a);
        state.projectiles.push({
          id: state.nextEntityId++,
          ownerId: player.id,
          kind: 'projectile',
          x: player.x + cx * (player.radius + 8),
          y: player.y + cy * (player.radius + 8),
          vx: cx * def.speed,
          vy: cy * def.speed,
          radius: def.radius || 7,
          damage: def.damage,
          life: def.range / def.speed,
          color: def.color,
          pierce: !!def.pierce,
          splash: 0,
          knockback: def.knockback || 0,
          slow: def.slow || 0,
          lifesteal: def.lifesteal || 0,
          hitSet: new Set(),
        });
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
        if (d <= range + tw.r) {
          const aTo = Math.atan2(tw.y - player.y, tw.x - player.x);
          if (Math.abs(angleDiff(aTo, angle)) <= halfArc || d < player.radius + tw.r + 12) {
            const nx = d > 0.01 ? (tw.x - player.x) / d : dirX;
            const ny = d > 0.01 ? (tw.y - player.y) / d : dirY;
            applyDamage(state, player, tw, def.damage, {
              color: def.color,
              knockback: def.knockback || 100,
              kx: nx,
              ky: ny,
              lifesteal: def.lifesteal || 0,
            });
          }
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

    case 'dash_strike':
    case 'blink_strike': {
      const steps = def.type === 'blink_strike' ? 6 : 10;
      const dist = Math.min(def.distance || 220, Math.max(90, targetDist));
      const startX = player.x;
      const startY = player.y;
      let cx = player.x;
      let cy = player.y;
      const hitIds = new Set();

      for (let i = 1; i <= steps; i++) {
        const tx = startX + dirX * (dist * (i / steps));
        const ty = startY + dirY * (dist * (i / steps));
        if (hitsObstacle(tx, ty, player.radius - 2)) {
          if (def.type === 'dash_strike') break;
          else continue;
        }
        cx = tx;
        cy = ty;
        if (def.type === 'dash_strike') {
          for (const tw of getAllTargets(state, player.id)) {
            const tid = tw.ref.id;
            if (hitIds.has(tid)) continue;
            if (Math.hypot(tw.x - cx, tw.y - cy) <= (def.radius || 44) + tw.r) {
              hitIds.add(tid);
              applyDamage(state, player, tw, def.damage, {
                color: def.color,
                knockback: def.knockback || 200,
                kx: dirX,
                ky: dirY,
              });
            }
          }
        }
      }

      const resolved = resolveCircleObstacles(cx, cy, player.radius);
      player.x = resolved.x;
      player.y = resolved.y;
      player.forcedSeq = (player.forcedSeq || 0) + 1;

      if (def.type === 'blink_strike') {
        for (const tw of getAllTargets(state, player.id)) {
          if (Math.hypot(tw.x - player.x, tw.y - player.y) <= (def.radius || 75) + tw.r) {
            applyDamage(state, player, tw, def.damage, { color: def.color });
          }
        }
      }
      if (def.speedBuff) {
        player.speedBuffTimer = Math.max(player.speedBuffTimer, def.speedBuff);
      }
      pushEvent(state, {
        type: 'dash',
        actorId: player.id,
        playerId: player.id,
        x1: startX,
        y1: startY,
        x2: player.x,
        y2: player.y,
        color: def.color,
      });
      break;
    }

    case 'nova':
    case 'shield_pulse':
    case 'heal_nova': {
      if (def.shield) {
        player.shield = Math.max(player.shield, def.shield);
        player.shieldTimer = def.duration || 4.0;
      }
      if (def.heal) {
        healPlayer(state, player, def.heal);
      }
      if (def.speedBuff) {
        player.speedBuffTimer = Math.max(player.speedBuffTimer, def.speedBuff);
      }
      const r = def.radius || 140;
      for (const tw of getAllTargets(state, player.id)) {
        const d = Math.hypot(tw.x - player.x, tw.y - player.y);
        if (d <= r + tw.r) {
          const nx = d > 0.01 ? (tw.x - player.x) / d : 1;
          const ny = d > 0.01 ? (tw.y - player.y) / d : 0;
          applyDamage(state, player, tw, def.damage, {
            color: def.color,
            knockback: def.knockback || 0,
            kx: nx,
            ky: ny,
            slow: def.slow || 0,
            lifesteal: def.lifesteal || 0,
          });
        }
      }
      pushEvent(state, { type: 'nova', actorId: player.id, x: player.x, y: player.y, r, color: def.color });
      break;
    }

    case 'orbit_hounds': {
      player.orbitTimer = def.duration || 4.5;
      player.orbitDamage = def.damage || 9;
      player.orbitRadius = def.orbitRadius || 72;
      player.orbitTick = 0;
      pushEvent(state, { type: 'cast', x: player.x, y: player.y, sound: 'howl', color: def.color });
      break;
    }

    case 'zone':
    case 'turret': {
      if (state.zones.length >= MAX_ZONES) state.zones.shift();
      const clampedDist = Math.min(targetDist, def.range || 350);
      const zx = clamp(player.x + dirX * clampedDist, MARGIN + 30, WORLD_SIZE - MARGIN - 30);
      const zy = clamp(player.y + dirY * clampedDist, MARGIN + 30, WORLD_SIZE - MARGIN - 30);
      state.zones.push({
        id: state.nextEntityId++,
        ownerId: player.id,
        kind: def.type,
        x: zx,
        y: zy,
        radius: def.radius || 90,
        damage: def.damage,
        remaining: def.duration || 3.5,
        tickRate: def.tickRate || 0.6,
        tickTimer: 0.08,
        slow: def.slow || 0,
        pull: def.pull || 0,
        color: def.color,
      });
      pushEvent(state, { type: 'cast', x: zx, y: zy, sound: 'zone', color: def.color });
      break;
    }

    case 'delayed_blast': {
      if (state.delayedBlasts.length >= MAX_DELAYED_BLASTS) state.delayedBlasts.shift();
      const clampedDist = Math.min(targetDist, def.range || 400);
      const bx = clamp(player.x + dirX * clampedDist, MARGIN + 30, WORLD_SIZE - MARGIN - 30);
      const by = clamp(player.y + dirY * clampedDist, MARGIN + 30, WORLD_SIZE - MARGIN - 30);
      state.delayedBlasts.push({
        id: state.nextEntityId++,
        ownerId: player.id,
        x: bx,
        y: by,
        radius: def.radius || 85,
        damage: def.damage,
        delay: def.delay || 0.45,
        totalDelay: def.delay || 0.45,
        slow: def.slow || 0,
        knockback: def.knockback || 0,
        color: def.color,
      });
      pushEvent(state, { type: 'cast', x: bx, y: by, sound: 'charge', color: def.color });
      break;
    }

    case 'chain_lightning': {
      const targets = getAllTargets(state, player.id);
      const hitSet = new Set();
      let curX = player.x;
      let curY = player.y;
      const segments = [];
      let bounces = def.bounces || 3;

      // First target closest to aim ray within range
      while (bounces > 0) {
        let best = null;
        let bestScore = Infinity;
        for (const tw of targets) {
          if (hitSet.has(tw.ref.id)) continue;
          const d = Math.hypot(tw.x - curX, tw.y - curY);
          const maxR = segments.length === 0 ? def.range || 340 : 210;
          if (d <= maxR) {
            let score = d;
            if (segments.length === 0) {
              const aTo = Math.atan2(tw.y - curY, tw.x - curX);
              score += Math.abs(angleDiff(aTo, angle)) * 160;
            }
            if (score < bestScore) {
              bestScore = score;
              best = tw;
            }
          }
        }
        if (!best) break;
        hitSet.add(best.ref.id);
        segments.push({ x1: curX, y1: curY, x2: best.x, y2: best.y });
        applyDamage(state, player, best, def.damage * (segments.length === 1 ? 1 : 0.78), {
          color: def.color,
        });
        curX = best.x;
        curY = best.y;
        bounces--;
      }

      if (segments.length === 0) {
        segments.push({
          x1: player.x,
          y1: player.y,
          x2: player.x + dirX * 220,
          y2: player.y + dirY * 220,
        });
      }
      pushEvent(state, { type: 'lightning', actorId: player.id, segments, color: def.color });
      break;
    }

    case 'beam': {
      const range = def.range || 520;
      const halfW = (def.width || 40) / 2;
      const endX = clamp(player.x + dirX * range, MARGIN, WORLD_SIZE - MARGIN);
      const endY = clamp(player.y + dirY * range, MARGIN, WORLD_SIZE - MARGIN);
      for (const tw of getAllTargets(state, player.id)) {
        // Point-to-segment distance
        const vx = endX - player.x;
        const vy = endY - player.y;
        const len2 = vx * vx + vy * vy || 1;
        const t = clamp(((tw.x - player.x) * vx + (tw.y - player.y) * vy) / len2, 0, 1);
        const px = player.x + t * vx;
        const py = player.y + t * vy;
        const d = Math.hypot(tw.x - px, tw.y - py);
        if (d <= halfW + tw.r) {
          applyDamage(state, player, tw, def.damage, { color: def.color });
        }
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
  active.sort((a, b) => {
    if (b.hp !== a.hp) return b.hp - a.hp;
    if (b.roundDamage !== a.roundDamage) return b.roundDamage - a.roundDamage;
    return a.joinedAt - b.joinedAt;
  });

  let winner = null;
  if (active.length > 0) {
    winner = active[0];
    const lb = state.leaderboard.get(winner.id);
    if (lb) {
      lb.wins += 1;
      lb.name = winner.name;
      lb.charId = winner.charId;
    }
  }

  state.lastRoundSummary = {
    roundNumber: state.roundNumber,
    winnerId: winner ? winner.id : null,
    winnerName: winner ? winner.name : 'No Challengers',
    winnerCharId: winner ? winner.charId : null,
    winnerHp: winner ? winner.hp : 0,
    winnerMaxHp: winner ? winner.maxHp : 0,
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
  state.projectiles = [];
  state.zones = [];
  state.delayedBlasts = [];

  pushEvent(state, {
    type: 'round_end',
    winnerName: state.lastRoundSummary.winnerName,
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
        p.forcedSeq = (p.forcedSeq || 0) + 1;
        p.hp = Math.round(p.maxHp * 0.65);
        p.alive = true;
        p.kbx = 0;
        p.kby = 0;
        p.slowTimer = 0;
        p.shield = 0;
      }
      continue;
    }

    if (p.shieldTimer > 0) {
      p.shieldTimer -= dt;
      if (p.shieldTimer <= 0) p.shield = 0;
    }
    if (p.slowTimer > 0) p.slowTimer = Math.max(0, p.slowTimer - dt);
    if (p.speedBuffTimer > 0) p.speedBuffTimer = Math.max(0, p.speedBuffTimer - dt);

    // Orbiting spectral hounds (Tibo skill E)
    if (p.orbitTimer > 0) {
      p.orbitTimer = Math.max(0, p.orbitTimer - dt);
      p.orbitAngle = (p.orbitAngle || 0) + dt * 5.2;
      p.orbitTick = (p.orbitTick || 0) - dt;
      if (p.orbitTick <= 0) {
        p.orbitTick = 0.45;
        const r = p.orbitRadius || 72;
        for (const tw of getAllTargets(state, p.id)) {
          if (Math.hypot(tw.x - p.x, tw.y - p.y) <= r + tw.r + 16) {
            applyDamage(state, p, tw, p.orbitDamage || 9, { color: '#fff59d' });
          }
        }
      }
    }

    if (state.phase === 'playing') {
      const hasKnockback = Math.hypot(p.kbx, p.kby) > 4;
      if (hasKnockback) {
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
        a.x -= ux * overlap;
        a.y -= uy * overlap;
        b.x += ux * overlap;
        b.y += uy * overlap;
      }
    }
  }

  // Projectiles
  const nextProjs = [];
  for (const pr of state.projectiles) {
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    pr.life -= dt;

    let dead = pr.life <= 0 || hitsObstacle(pr.x, pr.y, pr.radius);
    const owner = state.players.get(pr.ownerId);

    if (!dead) {
      for (const tw of getAllTargets(state, pr.ownerId)) {
        if (pr.hitSet.has(tw.ref.id)) continue;
        if (distSq(pr.x, pr.y, tw.x, tw.y) <= (pr.radius + tw.r) ** 2) {
          pr.hitSet.add(tw.ref.id);
          const vLen = Math.hypot(pr.vx, pr.vy) || 1;
          if (pr.kind === 'hook' && owner && tw.kind === 'player') {
            // Yank enemy toward owner
            const dx = owner.x - tw.x;
            const dy = owner.y - tw.y;
            const d = Math.hypot(dx, dy) || 1;
            const pullD = Math.max(0, d - 68);
            const dest = resolveCircleObstacles(tw.x + (dx / d) * pullD, tw.y + (dy / d) * pullD, tw.r);
            tw.ref.x = dest.x;
            tw.ref.y = dest.y;
            tw.ref.forcedSeq = (tw.ref.forcedSeq || 0) + 1;
            applyDamage(state, owner, tw, pr.damage, { color: pr.color, slow: 1.0 });
            pushEvent(state, { type: 'dash', x1: tw.x, y1: tw.y, x2: dest.x, y2: dest.y, color: pr.color });
          } else {
            applyDamage(state, owner, tw, pr.damage, {
              color: pr.color,
              knockback: pr.knockback,
              kx: pr.vx / vLen,
              ky: pr.vy / vLen,
              slow: pr.slow,
              lifesteal: pr.lifesteal,
            });
          }
          if (!pr.pierce) {
            dead = true;
            break;
          }
        }
      }
    }

    if (dead && pr.splash > 0) {
      for (const tw of getAllTargets(state, pr.ownerId)) {
        if (pr.hitSet.has(tw.ref.id)) continue;
        const d = Math.hypot(tw.x - pr.x, tw.y - pr.y);
        if (d <= pr.splash + tw.r) {
          const nx = d > 0.01 ? (tw.x - pr.x) / d : 1;
          const ny = d > 0.01 ? (tw.y - pr.y) / d : 0;
          applyDamage(state, owner, tw, pr.damage * 0.75, {
            color: pr.color,
            knockback: pr.knockback * 0.8,
            kx: nx,
            ky: ny,
          });
        }
      }
      pushEvent(state, { type: 'blast', x: pr.x, y: pr.y, r: pr.splash, color: pr.color });
    }

    if (!dead) nextProjs.push(pr);
  }
  state.projectiles = nextProjs;

  // Zones & Turrets
  const nextZones = [];
  for (const z of state.zones) {
    z.remaining -= dt;
    z.tickTimer -= dt;
    const owner = state.players.get(z.ownerId);

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

    if (z.tickTimer <= 0) {
      z.tickTimer = z.tickRate;
      if (z.kind === 'turret') {
        // Zap nearest target in range
        let nearest = null;
        let minD = z.radius;
        for (const tw of getAllTargets(state, z.ownerId)) {
          const d = Math.hypot(tw.x - z.x, tw.y - z.y);
          if (d <= minD) {
            minD = d;
            nearest = tw;
          }
        }
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
          if (Math.hypot(tw.x - z.x, tw.y - z.y) <= z.radius + tw.r) {
            applyDamage(state, owner, tw, z.damage, { color: z.color, slow: z.slow });
          }
        }
      }
    }

    if (z.remaining > 0) nextZones.push(z);
  }
  state.zones = nextZones;

  // Delayed Blasts
  const nextBlasts = [];
  for (const b of state.delayedBlasts) {
    b.delay -= dt;
    if (b.delay <= 0) {
      const owner = state.players.get(b.ownerId);
      for (const tw of getAllTargets(state, b.ownerId)) {
        const d = Math.hypot(tw.x - b.x, tw.y - b.y);
        if (d <= b.radius + tw.r) {
          const nx = d > 0.01 ? (tw.x - b.x) / d : 1;
          const ny = d > 0.01 ? (tw.y - b.y) / d : 0;
          applyDamage(state, owner, tw, b.damage, {
            color: b.color,
            slow: b.slow,
            knockback: b.knockback,
            kx: nx,
            ky: ny,
          });
        }
      }
      pushEvent(state, { type: 'blast', x: b.x, y: b.y, r: b.radius, color: b.color });
    } else {
      nextBlasts.push(b);
    }
  }
  state.delayedBlasts = nextBlasts;
}

export function joinPlayer({ clientId, name, charId, x, y, ip }) {
  const now = Date.now();
  const state = stepEngine(now);
  const safeId = String(clientId || '').slice(0, 48) || `p_${Math.random().toString(36).slice(2, 10)}`;
  const safeName =
    String(name || 'Wanderer')
      .trim()
      .replace(/[^\p{L}\p{N}\s_\-'.!]/gu, '')
      .replace(/\s+/g, ' ')
      .slice(0, 18) || 'Wanderer';
  const charDef = CHARACTER_MAP[charId] || CHARACTERS[0];

  const existing = state.players.get(safeId);
  if (!existing) {
    if (state.players.size >= MAX_PLAYERS) {
      return { error: 'Arena is currently full (60/60 players). Try again shortly.', status: 429 };
    }
    if (ip && ip !== 'unknown') {
      let sameIpCount = 0;
      for (const p of state.players.values()) {
        if (p.ip === ip) sameIpCount += 1;
      }
      if (sameIpCount >= MAX_PLAYERS_PER_IP) {
        return { error: 'Too many active players from this network (max 4).', status: 429 };
      }
    }
  }

  let sp;
  if (existing) {
    sp = { x: existing.x, y: existing.y };
  } else if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
    sp = resolveCircleObstacles(Number(x), Number(y), charDef.radius);
  } else {
    sp = pickSpawn(state);
  }

  const player = {
    id: safeId,
    ip: ip || existing?.ip || 'unknown',
    name: safeName,
    charId: charDef.id,
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
    speed: charDef.speed,
    radius: charDef.radius,
    color: charDef.color,
    alive: true,
    respawnTimer: 0,
    shield: 0,
    shieldTimer: 0,
    slowTimer: 0,
    speedBuffTimer: 0,
    orbitTimer: 0,
    orbitAngle: 0,
    orbitRadius: 72,
    orbitDamage: 9,
    orbitTick: 0,
    hitFlash: 0,
    attackAnim: 0,
    cooldowns: { basic: 0, s0: 0, s1: 0, s2: 0 },
    roundDamage: existing ? existing.roundDamage : 0,
    roundKos: existing ? existing.roundKos : 0,
    forcedSeq: existing ? existing.forcedSeq || 1 : 1,
    forceSyncUntil: 0,
    lastMoveAt: now,
    joinedAt: existing ? existing.joinedAt : now,
    lastSeen: now,
  };

  state.players.set(safeId, player);

  if (!state.leaderboard.has(safeId)) {
    if (state.leaderboard.size >= MAX_LEADERBOARD) {
      // Prune lowest-win offline entry to keep RAM strictly bounded
      let victimKey = null;
      let minWins = Infinity;
      for (const [k, entry] of state.leaderboard.entries()) {
        if (!state.players.has(k) && entry.wins < minWins) {
          minWins = entry.wins;
          victimKey = k;
        }
      }
      if (victimKey) state.leaderboard.delete(victimKey);
    }
    state.leaderboard.set(safeId, {
      id: safeId,
      name: safeName,
      charId: charDef.id,
      wins: 0,
      kos: 0,
      damage: 0,
    });
  } else {
    const lb = state.leaderboard.get(safeId);
    lb.name = safeName;
    lb.charId = charDef.id;
  }

  return buildSnapshot(state, safeId, 0);
}

export function leavePlayer(clientId) {
  const state = stepEngine(Date.now());
  if (clientId) state.players.delete(clientId);
  return { ok: true };
}

export function handleTick(payload) {
  const now = Date.now();
  const { clientId, ix, iy, cx, cy, moving, aim, actions, lastEventId } = payload || {};
  const state = stepEngine(now);
  const player = state.players.get(clientId);

  if (player) {
    const dtMove = Math.min(0.6, Math.max(0.016, (now - (player.lastMoveAt || now)) / 1000));
    player.lastSeen = now;
    player.lastMoveAt = now;
    player.inputX = clamp(Number(ix) || 0, -1, 1);
    player.inputY = clamp(Number(iy) || 0, -1, 1);
    player.moving = Boolean(moving) || Math.hypot(player.inputX, player.inputY) > 0.1;
    if (Number.isFinite(Number(aim))) player.aim = Number(aim);

    // Accept smooth client-predicted position when alive & playing, clamped to valid max speed + obstacles
    if (
      state.phase === 'playing' &&
      player.alive &&
      now >= (player.forceSyncUntil || 0) &&
      Number.isFinite(Number(cx)) &&
      Number.isFinite(Number(cy))
    ) {
      let speedMult = 1;
      if (player.slowTimer > 0) speedMult *= 0.56;
      if (player.speedBuffTimer > 0) speedMult *= 1.38;
      const maxStep = player.speed * speedMult * dtMove + 48;
      const dx = Number(cx) - player.x;
      const dy = Number(cy) - player.y;
      const dist = Math.hypot(dx, dy);
      const targetX = dist > maxStep ? player.x + (dx / dist) * maxStep : Number(cx);
      const targetY = dist > maxStep ? player.y + (dy / dist) * maxStep : Number(cy);
      const resolved = resolveCircleObstacles(targetX, targetY, player.radius);
      player.x = resolved.x;
      player.y = resolved.y;
    }

    if (Array.isArray(actions)) {
      for (const act of actions.slice(0, 4)) {
        if (act && act.key) {
          castAction(state, player, act.key, Number(act.tx) || player.x, Number(act.ty) || player.y);
        }
      }
    }
  }

  return buildSnapshot(state, clientId, Number(lastEventId) || 0);
}

export function buildSnapshot(state, selfId, sinceEventId = 0) {
  const now = Date.now();
  const timeLeft = Math.max(0, (state.phaseEndAt - now) / 1000);

  // Determine current HP leader
  let leaderId = null;
  let maxHpFound = -1;
  for (const p of state.players.values()) {
    if (p.hp > maxHpFound) {
      maxHpFound = p.hp;
      leaderId = p.id;
    }
  }

  const players = [];
  for (const p of state.players.values()) {
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
      shield: Math.round(p.shield),
      alive: p.alive,
      respawn: Math.round(p.respawnTimer * 10) / 10,
      slow: p.slowTimer > 0,
      haste: p.speedBuffTimer > 0,
      hit: p.hitFlash > 0,
      atk: p.attackAnim > 0,
      orbit: p.orbitTimer > 0 ? Math.round(p.orbitAngle * 100) / 100 : null,
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
        online: !!live,
        hp: live ? live.hp : 0,
        maxHp: live ? live.maxHp : 0,
      };
    })
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.online !== a.online) return Number(b.online) - Number(a.online);
      if (b.hp !== a.hp) return b.hp - a.hp;
      return b.kos - a.kos;
    })
    .slice(0, 12);

  const events = sinceEventId > 0 ? state.events.filter((e) => e.id > sinceEventId) : state.events.slice(-12);

  return {
    now,
    joined: state.players.has(selfId),
    roundNumber: state.roundNumber,
    phase: state.phase,
    timeLeft: Math.round(timeLeft * 10) / 10,
    leaderId,
    playerCount: state.players.size,
    players,
    projectiles: state.projectiles.map((pr) => {
      const owner = pr.kind === 'hook' ? state.players.get(pr.ownerId) : null;
      return {
        id: pr.id,
        ownerId: pr.ownerId,
        x: Math.round(pr.x),
        y: Math.round(pr.y),
        vx: Math.round(pr.vx),
        vy: Math.round(pr.vy),
        r: pr.radius,
        c: pr.color,
        k: pr.kind,
        ox: owner ? Math.round(owner.x) : undefined,
        oy: owner ? Math.round(owner.y) : undefined,
      };
    }),
    zones: state.zones.map((z) => ({
      id: z.id,
      kind: z.kind,
      x: Math.round(z.x),
      y: Math.round(z.y),
      r: z.radius,
      c: z.color,
      rem: Math.round(z.remaining * 10) / 10,
    })),
    blasts: state.delayedBlasts.map((b) => ({
      id: b.id,
      x: Math.round(b.x),
      y: Math.round(b.y),
      r: b.radius,
      c: b.color,
      p: Math.round((1 - b.delay / b.totalDelay) * 100) / 100,
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
    lastEventId: state.events.length ? state.events[state.events.length - 1].id : sinceEventId,
  };
}
