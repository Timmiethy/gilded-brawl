// Casts every move of every hero against test targets on a fake clock, then checks each mechanic.
// Run: npm test
import * as E from '../game/engine.js';
import { CHARACTERS } from '../public/shared/characters.js';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL', msg); } };

let T;
function fresh() {
  globalThis.__GILDED_BRAWL_STATE__ = undefined;
  const st = E.getState();
  T = Date.now() + 1000;
  E.stepEngine(T);
  return st;
}
function step(st, ms) { for (let t = 0; t < ms; t += 33) { T += 33; E.stepEngine(T); } }
let n = 0;
function join(st, charId, x, y) {
  const session = `test_session_${n++}_xxxxxxxxxxxx`;
  E.joinPlayer({ session, name: charId + n, charId, ip: `10.0.0.${n}` });
  const p = st.players.get(st.sessions.get(session));
  p.x = x; p.y = y; p.lastSeen = Infinity; p.history = [];
  return { p, session };
}
function cast(st, who, key, tx, ty) {
  who.p.cooldowns = { basic: 0, s0: 0, s1: 0, s2: 0 };
  E.handleTick({ session: who.session, actions: [{ key, tx, ty }] });
}
function hasNaN(st) {
  for (const p of st.players.values()) if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.hp)) return true;
  for (const pr of st.projectiles) if (!Number.isFinite(pr.x) || !Number.isFinite(pr.y)) return true;
  return false;
}
const evTypes = (st, since) => st.events.filter((e) => e.id > since).map((e) => e.type);

// ---- 1. Every move of every hero: no crash, no NaN, damage where the move deals damage ----
console.log('== all moves');
for (const ch of CHARACTERS) {
  const moves = [['basic', ch.basic], ['skill0', ch.skills[0]], ['skill1', ch.skills[1]], ['skill2', ch.skills[2]]];
  for (const [key, def] of moves) {
    const st = fresh();
    const caster = join(st, ch.id, 1200, 1650);
    const d1 = join(st, 'steep', 1290, 1650);
    const d2 = join(st, 'steep', 1270, 1580);
    for (const d of [d1, d2]) d.p.forceSyncUntil = Infinity;
    // History so Rewind has a past
    step(st, 300); caster.p.x = 1150; step(st, 2200);
    if (def.type !== 'rewind') caster.p.x = 1200;
    const hpBefore = d1.p.hp + d2.p.hp;
    const since = st.nextEventId - 1;
    try {
      cast(st, caster, key, d1.p.x, d1.p.y);
      step(st, 3000);
    } catch (e) { ok(false, `${ch.id} ${key} threw ${e.stack}`); continue; }
    const dealt = hpBefore - (d1.p.hp + d2.p.hp);
    const evs = evTypes(st, since);
    ok(!hasNaN(st), `${ch.id} ${key} produced NaN`);
    const damaging = def.damage > 0 && !['rewind', 'stealth', 'portal', 'trail'].includes(def.type);
    if (damaging) ok(dealt > 0 || evs.includes('hit'), `${ch.id} ${key} (${def.type}) dealt no damage; events: ${[...new Set(evs)].join(',')}`);
  }
}

// ---- 2. Mechanics ----
console.log('== mechanics');
{ // rewind
  const st = fresh(); const c = join(st, 'tock', 1200, 1650);
  step(st, 300); const startX = c.p.x; c.p.hp = 115; step(st, 200);
  c.p.x = 1500; c.p.hp = 40; step(st, 1900);
  const fseq = c.p.forcedSeq; cast(st, c, 'skill0', 1300, 1650);
  ok(Math.abs(c.p.x - startX) < 5, `rewind x ${c.p.x} expected ~${startX}`);
  ok(c.p.hp === 115, `rewind hp ${c.p.hp} expected 115`);
  ok(c.p.forcedSeq === fseq + 1, 'rewind bumps fseq');
}
{ // stealth hides, ambush, reveal
  const st = fresh(); const c = join(st, 'marrow', 1200, 1650); const e = join(st, 'steep', 1290, 1650);
  cast(st, c, 'skill0', 1300, 1650);
  const other = E.buildSnapshot(st, e.p.id, 0); const mine = E.buildSnapshot(st, c.p.id, 0);
  ok(!other.players.some((q) => q.id === c.p.id), 'stealthed player hidden from enemy snapshot');
  ok(mine.players.find((q) => q.id === c.p.id)?.stealth === true, 'stealthed player sees self with stealth flag');
  const hp = e.p.hp; cast(st, c, 'skill1', e.p.x, e.p.y); step(st, 300);
  ok(c.p.stealthTimer === 0, 'attack reveals');
  ok(hp - e.p.hp >= Math.round(12 * 1.5) - 1, `ambush dmg ${hp - e.p.hp} expected 18`);
}
{ // swap
  const st = fresh(); const c = join(st, 'marrow', 1200, 1650); const e = join(st, 'steep', 1400, 1650);
  cast(st, c, 'skill1', 1400, 1650); step(st, 400);
  ok(c.p.x > 1350 && e.p.x < 1250, `swap positions caster ${c.p.x} enemy ${e.p.x}`);
}
{ // silence blocks skills, not basic
  const st = fresh(); const c = join(st, 'marrow', 1200, 1650); const e = join(st, 'tock', 1300, 1650);
  cast(st, c, 'skill2', 1300, 1650); step(st, 800);
  ok(e.p.silenceTimer > 0, 'banshee silences');
  e.p.cooldowns = { basic: 0, s0: 0, s1: 0, s2: 0 };
  E.handleTick({ session: e.session, actions: [{ key: 'skill1', tx: 1200, ty: 1650 }, { key: 'basic', tx: 1200, ty: 1650 }] });
  ok(e.p.cooldowns.s1 === 0, 'silenced skill not cast');
  ok(e.p.cooldowns.basic > 0, 'silenced basic still cast');
}
{ // grapple to wall
  const st = fresh(); const c = join(st, 'fold', 1200, 1650);
  cast(st, c, 'skill0', 1200, 2300); step(st, 1200);
  ok(c.p.y > 2200, `grapple to south wall y=${c.p.y.toFixed(0)}`);
}
{ // boomerang returns and is caught
  const st = fresh(); const c = join(st, 'fold', 1200, 1650);
  cast(st, c, 'skill1', 1600, 1650); step(st, 400);
  ok(st.projectiles.length === 2, 'two shuriken out');
  step(st, 2500);
  ok(st.projectiles.length === 0, `shuriken caught/expired (${st.projectiles.length} left)`);
  const e = join(st, 'steep', 1350, 1650); e.p.forceSyncUntil = Infinity;
  const hp = e.p.hp; cast(st, c, 'skill1', 1350, 1650); step(st, 2500);
  ok(hp - e.p.hp >= 11 * 3, `boomerang hits on the way out and back (dmg ${hp - e.p.hp})`);
}
{ // ricochet off a wall reaches a target around a corner
  const st = fresh(); const c = join(st, 'prickle', 1200, 2200);
  cast(st, c, 'skill0', 1300, 2400); step(st, 300);
  ok(st.events.some((e) => e.type === 'bounce'), 'trick shot bounced off wall');
}
{ // homing curves toward target
  const st = fresh(); const c = join(st, 'marrow', 1200, 1650); const e = join(st, 'steep', 1450, 1520); e.p.forceSyncUntil = Infinity;
  const hp = e.p.hp; cast(st, c, 'basic', 1500, 1650); step(st, 1200);
  ok(e.p.hp < hp, 'homing wisp found an off-axis target');
}
{ // curse attaches and explodes on the victim after its delay
  const st = fresh(); const c = join(st, 'tock', 1200, 1650); const e = join(st, 'steep', 1350, 1650);
  cast(st, c, 'skill2', 1350, 1650); step(st, 300);
  ok(st.delayedBlasts.some((b) => b.kind === 'bomb' && b.attachId === e.p.id), 'bomb attached');
  e.p.x = 1500; e.p.forceSyncUntil = Infinity; const hp = e.p.hp; step(st, 1800);
  ok(hp - e.p.hp >= 30, `bomb followed victim and exploded (dmg ${hp - e.p.hp})`);
}
{ // deadeye hits locked targets, misses ones that vanish
  const st = fresh(); const c = join(st, 'prickle', 1200, 1650); const a = join(st, 'steep', 1450, 1650); const b = join(st, 'marrow', 1420, 1550);
  const hpa = a.p.hp; cast(st, c, 'skill2', 1450, 1650);
  b.p.stealthTimer = 3; step(st, 1100);
  ok(hpa - a.p.hp >= 29, `high noon hit locked target (dmg ${hpa - a.p.hp})`);
  ok(b.p.hp === b.p.maxHp, 'high noon missed target that stealthed');
}
{ // blink chain
  const st = fresh(); const c = join(st, 'fold', 1200, 1650); const a = join(st, 'steep', 1400, 1650); const b = join(st, 'steep', 1500, 1500);
  const ha = a.p.hp, hb = b.p.hp; cast(st, c, 'skill2', 1400, 1650);
  ok(ha - a.p.hp >= 22 && hb - b.p.hp >= 22, 'thousand folds hit both');
  const st2 = fresh(); const lone = join(st2, 'fold', 300, 1300); cast(st2, lone, 'skill2', 400, 1300);
  ok(lone.p.cooldowns.s2 <= 0.5, 'thousand folds refunds with no target');
}
{ // portal: player walks in, comes out the other end, does not bounce back
  const st = fresh(); const c = join(st, 'nell', 1200, 1650); const w = join(st, 'steep', 1100, 1650);
  cast(st, c, 'skill0', 1200, 2100);
  const z = st.zones.find((q) => q.kind === 'portal');
  ok(z && Math.abs(z.by - 2100) < 5, 'portal exit at cursor');
  step(st, 200); ok(c.p.y < 1700, 'caster not instantly teleported (lock)');
  w.p.x = z.x; w.p.y = z.y; step(st, 100);
  ok(Math.hypot(w.p.x - z.bx, w.p.y - z.by) < 30, `walker teleported to exit (${w.p.x.toFixed(0)},${w.p.y.toFixed(0)})`);
  step(st, 1500);
  ok(Math.hypot(w.p.x - z.bx, w.p.y - z.by) < 30, 'walker did not bounce back while standing in the exit');
  // projectiles through portal
  const st2 = fresh(); const n2 = join(st2, 'nell', 1200, 1650); const shooter = join(st2, 'bronte', 1000, 1650);
  cast(st2, n2, 'skill0', 1200, 2100); const z2 = st2.zones.find((q) => q.kind === 'portal');
  n2.p.x = 900; n2.p.y = 1300;
  cast(st2, shooter, 'basic', 1300, 1650); step(st2, 400);
  const shot = st2.projectiles.find((pr) => pr.ownerId === shooter.p.id);
  ok(z2 && shot && Math.abs(shot.y - z2.by) < 20 && shot.x > z2.bx, `shot came out of the portal exit (${shot?.x.toFixed(0)},${shot?.y.toFixed(0)})`);
}
{ // barrier deletes enemy shots, stasis slows them
  const st = fresh(); const b = join(st, 'bronte', 1200, 1650); const s = join(st, 'prickle', 1600, 1650);
  cast(st, b, 'skill1', 1350, 1650); cast(st, s, 'basic', 1000, 1650); step(st, 800);
  ok(st.events.some((e) => e.type === 'fizzle'), 'static dome fizzled an enemy shot');
  const st2 = fresh(); const t = join(st2, 'tock', 1200, 1650); const s2 = join(st2, 'prickle', 1600, 1650);
  cast(st2, t, 'skill1', 1450, 1650); cast(st2, s2, 'basic', 1000, 1650); step(st2, 400);
  const pr = st2.projectiles.find((q) => q.ownerId === s2.p.id);
  ok(pr && pr.x > 1300, `stasis slowed the needle (x=${pr?.x.toFixed(0)})`);
}
{ // trail damages followers
  const st = fresh(); const c = join(st, 'steep', 1200, 1650); const e = join(st, 'tock', 1200, 1650 + 200); e.p.forceSyncUntil = Infinity;
  cast(st, c, 'skill0', 1300, 1650);
  for (let i = 0; i < 20; i++) { c.p.y += 10; step(st, 50); }
  e.p.x = 1200; e.p.y = 1700; const hp = e.p.hp; step(st, 900);
  ok(e.p.hp < hp, 'tea trail damaged a foe standing in it');
  ok(st.zones.find((z) => z.kind === 'trail').points.length > 5, 'trail has points');
}
{ // stealth does not leak through orbit / snapshot when dead; hero switch keeps state
  const st = fresh(); const c = join(st, 'tock', 1200, 1650);
  c.p.hp = 30; c.p.cooldowns.s1 = 5;
  E.joinPlayer({ session: c.session, name: 'x', charId: 'vendetta', ip: '1.2.3.4' });
  ok(c.p.hp === Math.round(170 * 30 / 115) && c.p.cooldowns.s1 === 5, `switch keeps ratio+cd (hp ${c.p.hp})`);
}
console.log(fails ? `${fails} FAILURES` : 'ALL PASS');
process.exit(fails ? 1 : 0);
