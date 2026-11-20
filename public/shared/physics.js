// Shared collision & dash geometry — the server simulation and the client prediction both import this,
// so a predicted dash ends exactly where the authoritative one does.
import { WORLD_SIZE, OBSTACLES } from './map.js';

export const MARGIN = 44;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function resolveCircleObstacles(x, y, radius) {
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

export function hitsObstacle(x, y, radius) {
  if (x < MARGIN || x > WORLD_SIZE - MARGIN || y < MARGIN || y > WORLD_SIZE - MARGIN) return true;
  for (const ob of OBSTACLES) {
    const minD = radius + ob.r;
    const dx = x - ob.x;
    const dy = y - ob.y;
    if (dx * dx + dy * dy < minD * minD) return true;
  }
  return false;
}

export function dashDistance(def, targetDist) {
  return Math.min(def.distance || 220, Math.max(90, targetDist));
}

// Samples a dash ('dash_strike' stops at the first obstacle; 'blink_strike' passes through them).
// Returns every sampled point the dasher occupied (for hit checks) and the final resolved position.
export function traceDash(kind, x, y, dirX, dirY, dist, radius) {
  const steps = kind === 'blink_strike' ? 6 : 10;
  const path = [];
  let cx = x;
  let cy = y;
  for (let i = 1; i <= steps; i++) {
    const tx = x + dirX * (dist * (i / steps));
    const ty = y + dirY * (dist * (i / steps));
    if (hitsObstacle(tx, ty, radius - 2)) {
      if (kind === 'dash_strike') break;
      continue;
    }
    cx = tx;
    cy = ty;
    path.push({ x: cx, y: cy });
  }
  return { path, end: resolveCircleObstacles(cx, cy, radius) };
}
