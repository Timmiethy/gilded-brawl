// Top-down 2D minimap of the whole world
import { WORLD_SIZE, OBSTACLES } from '/shared/map.js';

export function drawMinimap(canvas, world, selfId, players) {
  const m = canvas.getContext('2d');
  const size = canvas.width;
  const scale = size / WORLD_SIZE;

  const quad = [
    ['#2a3140', 0, 0],
    ['#3a2622', size / 2, 0],
    ['#24402a', 0, size / 2],
    ['#40536a', size / 2, size / 2],
  ];
  for (const [c, x, y] of quad) {
    m.fillStyle = c;
    m.fillRect(x, y, size / 2, size / 2);
  }
  m.beginPath();
  m.arc(size / 2, size / 2, 420 * scale, 0, Math.PI * 2);
  m.fillStyle = '#5c5444';
  m.fill();
  m.strokeStyle = 'rgba(255, 224, 130, 0.5)';
  m.lineWidth = 1;
  m.stroke();

  m.fillStyle = 'rgba(10, 12, 18, 0.7)';
  for (const ob of OBSTACLES) {
    m.beginPath();
    m.arc(ob.x * scale, ob.y * scale, Math.max(1.5, ob.r * scale), 0, Math.PI * 2);
    m.fill();
  }

  if (world?.zones) {
    for (const z of world.zones) {
      if (z.kind !== 'portal') continue;
      m.fillStyle = z.c;
      for (const [x, y] of [
        [z.x, z.y],
        [z.bx, z.by],
      ]) {
        m.beginPath();
        m.arc(x * scale, y * scale, 2.5, 0, Math.PI * 2);
        m.fill();
      }
    }
  }

  if (world?.shrines) {
    for (const sh of world.shrines) {
      if (!sh.active) continue;
      m.fillStyle = '#81c784';
      m.fillRect(sh.x * scale - 2, sh.y * scale - 2, 4, 4);
    }
  }

  const leaders = new Set(world?.leaderIds || []);
  for (const p of players.values()) {
    if (!p.alive) continue;
    const isSelf = p.id === selfId;
    const px = p.x * scale;
    const py = p.y * scale;
    if (!isSelf && leaders.has(p.id)) {
      m.strokeStyle = '#ffd54f';
      m.lineWidth = 1.5;
      m.beginPath();
      m.arc(px, py, 5, 0, Math.PI * 2);
      m.stroke();
    }
    m.fillStyle = isSelf ? '#fff59d' : '#ff5252';
    m.beginPath();
    m.arc(px, py, isSelf ? 4 : 3, 0, Math.PI * 2);
    m.fill();
  }
}
