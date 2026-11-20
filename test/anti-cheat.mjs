// Exploit regressions found in the adversarial review. Run: npm test
import * as E from '../game/engine.js';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) {
    fails++;
    console.log('  FAIL', msg);
  }
};
const st = E.getState();
const S = (n) => `${n}_session_0123456789abcdef`;
const self = (sess) => st.players.get(st.sessions.get(sess));

// Ticking faster must not move a player faster than its speed (token-bucket movement budget)
E.joinPlayer({ session: S('cheat'), name: 'Cheat', charId: 'tock', ip: '1.1.1.1' });
const p = self(S('cheat'));
const x0 = p.x;
const y0 = p.y;
const t0 = Date.now();
while (Date.now() - t0 < 1000) {
  E.handleTick({ session: S('cheat'), cx: p.x + 500, cy: p.y, fseq: p.forcedSeq });
  await new Promise((r) => setTimeout(r, 20));
}
const moved = Math.hypot(p.x - x0, p.y - y0);
ok(moved <= p.speed + 60, `speed hack moved ${moved.toFixed(0)}px in 1s (speed ${p.speed})`);

// An honest 14 Hz client moving at full speed is never clamped
E.joinPlayer({ session: S('honest'), name: 'Honest', charId: 'marrow', ip: '1.1.1.2' });
const h = self(S('honest'));
h.x = 300;
h.y = 1300;
let cx = h.x;
let last = Date.now();
let lag = 0;
for (let i = 0; i < 28; i++) {
  await new Promise((r) => setTimeout(r, 70));
  const now = Date.now();
  cx += (h.speed * (now - last)) / 1000;
  last = now;
  E.handleTick({ session: S('honest'), cx, cy: 1300, fseq: h.forcedSeq });
  lag = Math.max(lag, cx - h.x);
}
ok(lag < 5, `honest client lagged ${lag.toFixed(1)}px behind its own position`);

// Snapshots never contain session keys; a public id cannot be used to kick someone
E.joinPlayer({ session: S('victim'), name: 'Victim', charId: 'fold', ip: '2.2.2.2' });
const snap = E.buildSnapshot(st, '', 0);
ok(!JSON.stringify(snap).includes('_session_'), 'snapshot leaks a session key');
E.leavePlayer(snap.players.find((q) => q.name === 'Victim').id);
ok(!!self(S('victim')), 'leave() with a public id removed the player');

// Switching hero keeps death, HP ratio and cooldowns
const v = self(S('victim'));
v.hp = 0;
v.alive = false;
v.respawnTimer = 4;
v.cooldowns.s2 = 9;
E.joinPlayer({ session: S('victim'), name: 'Victim', charId: 'steep', ip: '2.2.2.2' });
ok(!v.alive && v.hp === 0 && v.cooldowns.s2 === 9, 'hero switch revived or reset cooldowns');

// The client cannot choose its spawn point
E.joinPlayer({ session: S('tele'), name: 'Tele', charId: 'tock', x: 560, y: 600, ip: '3.3.3.3' });
const tp = self(S('tele'));
ok(Math.hypot(tp.x - 560, tp.y - 600) > 5, 'join x/y teleported the player');

// Ticks sent before the client saw a forced move are ignored
const before = tp.x;
E.handleTick({ session: S('tele'), cx: tp.x + 30, cy: tp.y, fseq: tp.forcedSeq - 1 });
ok(tp.x === before, 'stale-fseq tick moved the player');

// A fresh or stale event cursor never replays history
ok(E.buildSnapshot(st, '', 0).events.length === 0, 'fresh cursor replayed old events');
ok(E.buildSnapshot(st, '', 999999).events.length === 0, 'stale cursor returned events');

console.log(fails ? `anti-cheat: ${fails} FAILURES` : 'anti-cheat: ALL PASS');
process.exit(fails ? 1 : 0);
