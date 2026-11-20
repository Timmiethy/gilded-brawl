// Visual effects: GPU point particles, projectile meshes, zone & telegraph visuals synced from the
// server snapshot, and short-lived transient effects spawned by combat events.
import { THREE, TAU, ease, clamp01, makeGlowSprite, energyMaterial, fresnelMaterial } from './core.js';

const CHEST = 24;

// ---------- Particles ----------
// Ring buffer of point sprites. When full, the oldest particle is reused — dropping the oldest spark of
// a crowded fight is invisible degradation, not a budget failure anyone needs to see.
class Particles {
  constructor(scene, capacity, additive) {
    this.capacity = capacity;
    this.next = 0;
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.alpha = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.baseAlpha = new Float32Array(capacity);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float size;
        attribute float alpha;
        attribute vec3 color;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float uScale;
        void main() {
          vColor = color;
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = alpha > 0.0 ? size * uScale / -mv.z : 0.0;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: additive
        ? /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.05, d) * vAlpha;
          gl_FragColor = vec4(vColor * a * 1.6, a);
        }`
        : /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.15, d) * vAlpha;
          gl_FragColor = vec4(vColor, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 20 : 10;
    scene.add(this.points);
  }

  spawn(x, y, z, vx, vy, vz, color, size, life, { gravity = 0, drag = 1.5, grow = 0, alpha = 1 } = {}) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = color.r;
    this.col[i * 3 + 1] = color.g;
    this.col[i * 3 + 2] = color.b;
    this.life[i] = this.maxLife[i] = life;
    this.grav[i] = gravity;
    this.drag[i] = drag;
    this.grow[i] = grow;
    this.baseSize[i] = size;
    this.baseAlpha[i] = alpha;
  }

  update(dt, scale) {
    this.mat.uniforms.uScale.value = scale;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      const damp = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= damp;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * damp - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= damp;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = Math.max(0.5, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.alpha[i] = this.baseAlpha[i] * Math.min(1, k * 1.6) * Math.min(1, (1 - k) * 12 + 0.2);
      this.size[i] = this.baseSize[i] * (1 + this.grow[i] * (1 - k));
    }
    for (const name of ['position', 'color', 'alpha', 'size']) this.geo.attributes[name].needsUpdate = true;
  }
}

// ---------- Shared geometry ----------
const SHARED = new Set();
function shared(geo) {
  SHARED.add(geo);
  return geo;
}
const G = {
  ring: shared(new THREE.RingGeometry(0.86, 1, 72)),
  thinRing: shared(new THREE.RingGeometry(0.95, 1, 72)),
  disc: shared(new THREE.CircleGeometry(1, 64)),
  sphere: shared(new THREE.SphereGeometry(1, 24, 16)),
  ico: shared(new THREE.IcosahedronGeometry(1, 1)),
  cylY: shared(new THREE.CylinderGeometry(1, 1, 1, 20, 1, true)),
  hemi: shared(new THREE.SphereGeometry(1, 40, 20, 0, TAU, 0, Math.PI / 2)),
  torus: shared(new THREE.TorusGeometry(1, 0.07, 10, 64)),
  box: shared(new THREE.BoxGeometry(1, 1, 1)),
  cone: shared(new THREE.ConeGeometry(1, 1, 10)),
};

function flat(mesh, y = 1) {
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  return mesh;
}

function canvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const TEX = {};
function clockTexture() {
  return (TEX.clock ??= canvasTexture(256, (g, s) => {
    g.translate(s / 2, s / 2);
    g.strokeStyle = '#fff';
    g.lineWidth = 6;
    g.beginPath();
    g.arc(0, 0, s / 2 - 6, 0, TAU);
    g.stroke();
    g.lineWidth = 2;
    g.beginPath();
    g.arc(0, 0, s / 2 - 22, 0, TAU);
    g.stroke();
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * TAU;
      const r0 = i % 5 === 0 ? s / 2 - 40 : s / 2 - 30;
      g.lineWidth = i % 5 === 0 ? 5 : 2;
      g.beginPath();
      g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      g.lineTo(Math.cos(a) * (s / 2 - 22), Math.sin(a) * (s / 2 - 22));
      g.stroke();
    }
    g.font = 'bold 22px Georgia';
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const numerals = ['XII', 'III', 'VI', 'IX'];
    numerals.forEach((n, i) => {
      const a = (i / 4) * TAU - Math.PI / 2;
      g.fillText(n, Math.cos(a) * (s / 2 - 62), Math.sin(a) * (s / 2 - 62));
    });
  }));
}
function spiralTexture() {
  return (TEX.spiral ??= canvasTexture(256, (g, s) => {
    g.translate(s / 2, s / 2);
    for (let arm = 0; arm < 4; arm++) {
      g.beginPath();
      for (let i = 0; i <= 120; i++) {
        const t = i / 120;
        const a = arm * (TAU / 4) + t * 5.2;
        const r = t * (s / 2 - 4);
        if (i === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.strokeStyle = 'rgba(255,255,255,0.9)';
      g.lineWidth = 10;
      g.stroke();
    }
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.3, 'rgba(255,255,255,0.15)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(-s / 2, -s / 2, s, s);
  }));
}
function mandalaTexture() {
  return (TEX.mandala ??= canvasTexture(256, (g, s) => {
    g.translate(s / 2, s / 2);
    for (let layer = 0; layer < 3; layer++) {
      const n = 8 + layer * 4;
      for (let i = 0; i < n; i++) {
        g.save();
        g.rotate((i / n) * TAU + layer * 0.3);
        g.fillStyle = `rgba(255,255,255,${0.5 - layer * 0.12})`;
        g.beginPath();
        g.ellipse(0, -(30 + layer * 32), 10 + layer * 3, 30 + layer * 8, 0, 0, TAU);
        g.fill();
        g.restore();
      }
    }
  }));
}
function crosshairTexture() {
  return (TEX.cross ??= canvasTexture(128, (g, s) => {
    g.translate(s / 2, s / 2);
    g.strokeStyle = '#fff';
    g.lineWidth = 5;
    g.beginPath();
    g.arc(0, 0, s / 2 - 10, 0, TAU);
    g.stroke();
    for (let i = 0; i < 4; i++) {
      g.rotate(Math.PI / 2);
      g.beginPath();
      g.moveTo(0, s / 2 - 4);
      g.lineTo(0, s / 2 - 30);
      g.stroke();
    }
    g.beginPath();
    g.arc(0, 0, 4, 0, TAU);
    g.fill();
  }));
}

// Flat jagged ribbon (lightning / tracer) through points at a given height, facing up
function ribbonGeometry(pts, width) {
  const verts = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * width * 0.5;
    const nz = (dx / len) * width * 0.5;
    verts.push(a.x + nx, a.y, a.z + nz, a.x - nx, a.y, a.z - nz, b.x + nx, b.y, b.z + nz);
    verts.push(b.x + nx, b.y, b.z + nz, a.x - nx, a.y, a.z - nz, b.x - nx, b.y, b.z - nz);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  return geo;
}

function jagged(x1, z1, x2, z2, y, jitter, segs = 8) {
  const pts = [{ x: x1, y, z: z1 }];
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    pts.push({ x: x1 + (x2 - x1) * t + (Math.random() - 0.5) * jitter, y: y + (Math.random() - 0.5) * jitter * 0.4, z: z1 + (z2 - z1) * t + (Math.random() - 0.5) * jitter });
  }
  pts.push({ x: x2, y, z: z2 });
  return pts;
}

function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry && !SHARED.has(o.geometry)) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
}

const tmpColor = new THREE.Color();
const C = (hex) => tmpColor.set(hex || '#ffffff').clone();

// ---------- Effects system ----------
export class FxSystem {
  constructor(scene, lights, { reducedMotion = false } = {}) {
    this.scene = scene;
    this.lights = lights;
    this.reducedMotion = reducedMotion;
    // Receipt: a 60-player brawl spawns ~4–5k sparks/s living ≈0.6s → ~3k alive; 8192 is the tripwire.
    this.glow = new Particles(scene, 8192, true);
    this.smoke = new Particles(scene, 2048, false);
    this.transients = [];
    this.projectiles = new Map();
    this.zones = new Map();
    this.blasts = new Map();
    this.shake = 0;
    this.punch = 0;
    this.textQueue = []; // floating combat text for the overlay: {x, y, z, text, color, big}
  }

  addShake(amount) {
    if (this.reducedMotion) return;
    this.shake = Math.min(16, Math.max(this.shake, amount));
  }

  burst(x, y, z, color, count, speed, opts = {}) {
    const c = C(color);
    // Smoke puffs grow; at full size a dozen of them hid a quarter of the screen on bright ground
    const smokeK = opts.smoke ? 0.6 : 1;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const up = opts.up ?? 0.6;
      const sp = speed * (0.35 + Math.random() * 0.75);
      const el = (Math.random() - 0.2) * up;
      (opts.smoke ? this.smoke : this.glow).spawn(
        x,
        y,
        z,
        Math.cos(a) * sp * Math.cos(el),
        Math.sin(el) * sp + (opts.lift || 0),
        Math.sin(a) * sp * Math.cos(el),
        c,
        (opts.size || 6) * smokeK * (0.6 + Math.random() * 0.8),
        (opts.life || 0.6) * (0.6 + Math.random() * 0.6),
        { gravity: opts.gravity ?? 120, drag: opts.drag ?? 2.2, grow: opts.grow ?? 0, alpha: (opts.alpha ?? 1) * (opts.smoke ? 0.7 : 1) }
      );
    }
  }

  ringBurst(x, z, radius, color, count, y = 4, opts = {}) {
    const c = C(color);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + Math.random() * 0.2;
      const out = opts.out ?? 60;
      this.glow.spawn(x + Math.cos(a) * radius, y, z + Math.sin(a) * radius, Math.cos(a) * out, opts.lift ?? 30, Math.sin(a) * out, c, opts.size || 6, opts.life || 0.6, { gravity: 20, drag: 2 });
    }
  }

  transient(obj, duration, fn, light = null) {
    if (obj) this.scene.add(obj);
    this.transients.push({ obj, t: 0, duration, fn, light });
  }

  shockwave(x, z, radius, color, duration = 0.5, y = 1.5, width = 1) {
    const m = flat(new THREE.Mesh(G.ring, energyMaterial(color, 0.9)), y);
    m.position.x = x;
    m.position.z = z;
    this.transient(m, duration, (k) => {
      const r = Math.max(0.01, radius * ease.outCubic(k));
      m.scale.set(r, r, r * width);
      m.material.opacity = 0.9 * (1 - k);
    });
  }

  flash(x, y, z, color, size, duration = 0.25, strength = 4) {
    const s = makeGlowSprite(color, size, 1);
    s.position.set(x, y, z);
    this.transient(
      s,
      duration,
      (k) => {
        s.material.opacity = 1 - k;
        s.scale.setScalar(size * (0.6 + k * 0.6));
      },
      { x, y, z, color, strength, distance: size * 4 }
    );
  }

  // ----- Combat events -----
  event(evt, ctx) {
    const y0 = CHEST;
    switch (evt.type) {
      case 'hit': {
        const x = evt.x;
        const z = evt.y + 20;
        this.burst(x, y0, z, evt.color, 9, 150, { size: 5, life: 0.45 });
        this.flash(x, y0, z, evt.color, 26, 0.16, 2);
        this.textQueue.push({ x, y: 46, z, text: `-${evt.dmg}`, color: evt.color || '#ff8a80', big: evt.dmg >= 24 });
        if (evt.targetId === ctx.selfId) this.addShake(Math.min(9, 3 + evt.dmg * 0.2));
        else if (evt.dmg >= 24) this.addShake(3);
        break;
      }
      case 'heal': {
        const z = evt.y + 22;
        for (let i = 0; i < 14; i++) {
          this.glow.spawn(evt.x + (Math.random() - 0.5) * 30, 8 + Math.random() * 20, z + (Math.random() - 0.5) * 30, 0, 50 + Math.random() * 40, 0, C('#81ffa0'), 6, 0.9, { gravity: -10, drag: 1 });
        }
        this.shockwave(evt.x, z, 34, '#81ffa0', 0.5);
        this.textQueue.push({ x: evt.x, y: 50, z, text: `+${evt.amount}`, color: '#81ffa0', big: false });
        break;
      }
      case 'slash':
        this.slash(evt);
        break;
      case 'nova':
        this.nova(evt.x, evt.y, evt.r, evt.color, false);
        break;
      case 'blast':
        this.nova(evt.x, evt.y, evt.r, evt.color, true, evt.big);
        break;
      case 'dash':
        this.dash(evt);
        break;
      case 'beam':
        this.beam(evt);
        break;
      case 'lightning':
        this.lightning(evt.segments, evt.color, 0.34, 12);
        break;
      case 'tracer':
        this.tracers(evt);
        break;
      case 'ripple':
        this.ripple(evt);
        break;
      case 'blink_chain':
        this.blinkChain(evt);
        break;
      case 'rewind':
        this.rewind(evt);
        break;
      case 'swap':
        this.swap(evt);
        break;
      case 'portal':
        this.flash(evt.x1, 20, evt.y1, evt.color, 70, 0.3, 4);
        this.flash(evt.x2, 20, evt.y2, evt.color, 90, 0.4, 5);
        this.burst(evt.x2, 20, evt.y2, evt.color, 26, 160, { gravity: 0, size: 6 });
        break;
      case 'portal_open':
        this.shockwave(evt.x1, evt.y1, 70, evt.color, 0.5);
        this.shockwave(evt.x2, evt.y2, 70, evt.color, 0.5);
        break;
      case 'stealth':
        this.burst(evt.x, 20, evt.y, '#2a2f3a', 30, 90, { smoke: true, size: 26, life: 1.1, gravity: -20, grow: 1.4, alpha: 0.75 });
        this.burst(evt.x, 20, evt.y, evt.color, 16, 120, { size: 5 });
        break;
      case 'reveal':
        this.burst(evt.x, 24, evt.y, evt.color || '#e0f7fa', 22, 110, { size: 5, gravity: 0 });
        this.shockwave(evt.x, evt.y, 44, evt.color || '#e0f7fa', 0.35);
        break;
      case 'bounce':
        this.burst(evt.x, 22, evt.y, evt.color, 10, 180, { size: 4, life: 0.3 });
        this.flash(evt.x, 22, evt.y, evt.color, 30, 0.12, 2);
        break;
      case 'fizzle':
        this.burst(evt.x, 22, evt.y, '#cfd8dc', 10, 60, { smoke: true, size: 12, life: 0.5, gravity: -30, grow: 1, alpha: 0.5 });
        this.burst(evt.x, 22, evt.y, evt.color, 8, 120, { size: 4, life: 0.3 });
        break;
      case 'cursed':
        this.flash(evt.x, 30, evt.y, evt.color, 70, 0.3, 4);
        this.burst(evt.x, 30, evt.y, evt.color, 18, 140, { size: 5 });
        break;
      case 'deadeye':
        this.flash(evt.x, 30, evt.y, evt.color, 60, 0.4, 3);
        break;
      case 'ko':
        this.ko(evt);
        break;
      case 'respawn':
        this.respawn(evt);
        break;
      case 'shrine':
        this.pillar(evt.x, evt.y, '#5dff9a', 26, 220, 0.8);
        this.burst(evt.x, 40, evt.y, '#81ffa0', 30, 120, { gravity: -20, size: 6 });
        break;
      case 'cast':
        this.burst(evt.x, y0, evt.y, evt.color, 6, 90, { size: 4, life: 0.35 });
        break;
    }
  }

  slash(evt) {
    const range = evt.range;
    const arc = evt.arc;
    const geo = new THREE.RingGeometry(range * 0.35, range, 40, 1, -arc / 2, arc);
    const mat = energyMaterial(evt.color, 0.75);
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    const holder = new THREE.Group();
    holder.position.set(evt.x, evt.heavy ? 6 : 18, evt.y);
    holder.rotation.y = -evt.angle;
    holder.add(m);
    const edgeGeo = new THREE.RingGeometry(range * 0.93, range * 1.02, 40, 1, -arc / 2, arc);
    const edge = new THREE.Mesh(edgeGeo, energyMaterial('#ffffff', 1));
    edge.rotation.x = -Math.PI / 2;
    edge.position.y = 0.5;
    holder.add(edge);
    const dur = evt.heavy ? 0.38 : 0.24;
    this.transient(holder, dur, (k) => {
      const e = ease.outCubic(k);
      holder.scale.setScalar(0.75 + e * 0.3);
      holder.rotation.y = -evt.angle - (1 - e) * 0.5;
      mat.opacity = 0.75 * (1 - k);
      edge.material.opacity = 1 - k;
    });
    const tipX = evt.x + Math.cos(evt.angle) * range * 0.7;
    const tipZ = evt.y + Math.sin(evt.angle) * range * 0.7;
    this.burst(tipX, 16, tipZ, evt.color, evt.heavy ? 22 : 8, evt.heavy ? 220 : 130, { size: 5, life: 0.4 });
    if (evt.heavy) {
      this.burst(tipX, 6, tipZ, '#8d7b68', 18, 120, { smoke: true, size: 30, life: 1, gravity: -10, grow: 1.2, alpha: 0.55 });
      this.shockwave(tipX, tipZ, range * 0.5, evt.color, 0.45);
      this.addShake(9);
      this.punch = Math.max(this.punch, 0.5);
    }
  }

  nova(x, z, r, color, isBlast, big = false) {
    this.shockwave(x, z, r, color, 0.55, 1.5);
    this.shockwave(x, z, r * 0.7, '#ffffff', 0.4, 2);
    const dome = new THREE.Mesh(G.hemi, energyMaterial(color, 0.45));
    dome.position.set(x, 0, z);
    this.transient(
      dome,
      0.45,
      (k) => {
        const s = Math.max(0.01, r * ease.outCubic(k));
        dome.scale.set(s, s * 0.35, s);
        dome.material.opacity = 0.45 * (1 - k);
      },
      { x, y: 30, z, color, strength: isBlast ? 7 : 5, distance: r * 2.2 }
    );
    this.ringBurst(x, z, r * 0.4, color, Math.min(48, 16 + r * 0.1), 6, { out: r * 1.6, lift: 60, size: 7 });
    if (isBlast) {
      this.burst(x, 10, z, '#5d4f45', 14, 80, { smoke: true, size: 34, life: 1.2, gravity: -24, grow: 1.6, alpha: 0.6 });
      this.burst(x, 10, z, color, 24, 260, { size: 6, gravity: 260, up: 1.4 });
      this.flash(x, 30, z, color, r * 1.4, 0.3, 8);
      this.addShake(big ? 12 : 7);
      if (big) this.punch = Math.max(this.punch, 1);
    } else {
      this.addShake(5);
    }
  }

  dash(evt) {
    const dx = evt.x2 - evt.x1;
    const dz = evt.y2 - evt.y1;
    const len = Math.hypot(dx, dz);
    if (len < 2) return;
    const geo = new THREE.PlaneGeometry(len, 22);
    const m = new THREE.Mesh(geo, energyMaterial(evt.color, 0.6));
    m.rotation.x = -Math.PI / 2;
    const holder = new THREE.Group();
    holder.position.set((evt.x1 + evt.x2) / 2, 12, (evt.y1 + evt.y2) / 2);
    holder.rotation.y = -Math.atan2(dz, dx);
    holder.add(m);
    this.transient(holder, 0.35, (k) => {
      m.material.opacity = 0.6 * (1 - k);
      m.scale.y = 1 - k * 0.7;
    });
    for (let i = 0; i < 10; i++) {
      const t = i / 10;
      this.glow.spawn(evt.x1 + dx * t, 18, evt.y1 + dz * t, (Math.random() - 0.5) * 40, 20, (Math.random() - 0.5) * 40, C(evt.color), 7, 0.5, { gravity: 0 });
      this.smoke.spawn(evt.x1 + dx * t, 4, evt.y1 + dz * t, 0, 12, 0, C('#8a7c6c'), 20, 0.7, { gravity: -6, grow: 1, alpha: 0.4 });
    }
    this.flash(evt.x2, 20, evt.y2, evt.color, 50, 0.25, 3);
  }

  beam(evt) {
    const dx = evt.x2 - evt.x1;
    const dz = evt.y2 - evt.y1;
    const len = Math.hypot(dx, dz);
    const holder = new THREE.Group();
    holder.position.set(evt.x1, 24, evt.y1);
    holder.rotation.y = -Math.atan2(dz, dx);
    const outer = new THREE.Mesh(G.cylY, energyMaterial(evt.color, 0.7));
    const inner = new THREE.Mesh(G.cylY, energyMaterial('#ffffff', 1));
    for (const [mesh, w] of [
      [outer, evt.width / 2],
      [inner, evt.width / 6],
    ]) {
      mesh.rotation.z = Math.PI / 2;
      mesh.position.x = len / 2;
      mesh.scale.set(w, len, w);
      holder.add(mesh);
    }
    this.transient(
      holder,
      0.5,
      (k) => {
        const w = 1 - ease.inCubic(k);
        outer.scale.set((evt.width / 2) * w, len, (evt.width / 2) * w);
        inner.scale.set((evt.width / 6) * w, len, (evt.width / 6) * w);
        outer.material.opacity = 0.7 * (1 - k);
      },
      { x: evt.x1, y: 30, z: evt.y1, color: evt.color, strength: 8, distance: 400 }
    );
    for (let i = 0; i < 30; i++) {
      const t = Math.random();
      this.glow.spawn(evt.x1 + dx * t, 24, evt.y1 + dz * t, (Math.random() - 0.5) * 80, (Math.random() - 0.2) * 80, (Math.random() - 0.5) * 80, C(evt.color), 6, 0.6, { gravity: 0 });
    }
    this.flash(evt.x2, 24, evt.y2, evt.color, 90, 0.4, 6);
    this.addShake(8);
  }

  lightning(segments, color, duration, width, { shake = true } = {}) {
    const holder = new THREE.Group();
    const mat = energyMaterial(color, 1);
    const core = energyMaterial('#ffffff', 1);
    const build = () => {
      for (const ch of [...holder.children]) {
        ch.geometry.dispose();
        holder.remove(ch);
      }
      for (const s of segments) {
        const pts = jagged(s.x1, s.y1, s.x2, s.y2, 28, 26);
        holder.add(new THREE.Mesh(ribbonGeometry(pts, width), mat));
        holder.add(new THREE.Mesh(ribbonGeometry(pts, width * 0.35), core));
      }
    };
    build();
    let since = 0;
    const end = segments[segments.length - 1];
    this.transient(
      holder,
      duration,
      (k, dt) => {
        since += dt;
        if (since > 0.05) {
          since = 0;
          build();
        }
        mat.opacity = 1 - k;
        core.opacity = 1 - k;
      },
      { x: end.x2, y: 30, z: end.y2, color, strength: 6, distance: 300 }
    );
    for (const s of segments) this.burst(s.x2, 26, s.y2, color, 10, 160, { size: 5, life: 0.35 });
    if (shake) this.addShake(4);
  }

  tracers(evt) {
    for (const s of evt.segments || []) {
      const pts = [
        { x: s.x1, y: 26, z: s.y1 },
        { x: s.x2, y: 26, z: s.y2 },
      ];
      const m = new THREE.Mesh(ribbonGeometry(pts, 5), energyMaterial('#fff8e1', 1));
      this.transient(m, 0.22, (k) => (m.material.opacity = 1 - k));
      this.burst(s.x2, 26, s.y2, evt.color, 14, 200, { size: 5 });
    }
    this.flash(evt.x, 28, evt.y, '#ffecb3', 80, 0.18, 8);
    this.addShake(10);
    this.punch = Math.max(this.punch, 0.8);
  }

  ripple(evt) {
    const torus = new THREE.Mesh(G.torus, energyMaterial(evt.color, 0.9));
    torus.rotation.x = Math.PI / 2;
    torus.position.set(evt.x, 8, evt.y);
    const sheet = flat(new THREE.Mesh(G.disc, energyMaterial(evt.color, 0.18)), 2);
    sheet.position.x = evt.x;
    sheet.position.z = evt.y;
    const holder = new THREE.Group();
    holder.add(torus, sheet);
    const dur = evt.duration + 0.25;
    let emitted = 0;
    this.transient(holder, dur, (k) => {
      const grow = clamp01((k * dur) / evt.duration);
      const r = Math.max(0.01, evt.r * ease.outCubic(grow));
      torus.scale.set(r, r, 30 * (1 - grow * 0.6));
      sheet.scale.setScalar(r);
      torus.material.opacity = 0.9 * (1 - clamp01((k * dur - evt.duration) / 0.25));
      sheet.material.opacity = 0.18 * (1 - k);
      while (emitted < grow * 40) {
        const a = Math.random() * TAU;
        this.glow.spawn(evt.x + Math.cos(a) * r, 10, evt.y + Math.sin(a) * r, Math.cos(a) * 60, 40, Math.sin(a) * 60, C(evt.color), 8, 0.5, { gravity: 60 });
        emitted++;
      }
    });
    this.addShake(7);
    this.punch = Math.max(this.punch, 0.6);
  }

  blinkChain(evt) {
    const pts = evt.points;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const delay = i * 0.06;
      const ghost = makeGlowSprite(evt.color, 60, 0.9);
      ghost.position.set(p.x, 26, p.y);
      ghost.visible = false;
      this.transient(ghost, 0.5 + delay, (k) => {
        const t = k * (0.5 + delay) - delay;
        ghost.visible = t > 0;
        ghost.material.opacity = 0.9 * (1 - clamp01(t / 0.5));
      });
      if (i > 0) {
        const a = pts[i - 1];
        const m = new THREE.Mesh(ribbonGeometry([{ x: a.x, y: 22, z: a.y }, { x: p.x, y: 22, z: p.y }], 8), energyMaterial(evt.color, 1));
        this.transient(m, 0.4, (k) => (m.material.opacity = 1 - k));
        this.burst(p.x, 24, p.y, evt.color, 12, 160, { size: 5 });
      }
    }
    this.addShake(6);
  }

  rewind(evt) {
    const path = evt.path || [];
    path.forEach((p, i) => {
      const s = makeGlowSprite(evt.color, 44, 0.7);
      s.position.set(p.x, 24, p.y);
      const delay = (path.length - i) * 0.03;
      this.transient(s, 0.6 + delay, (k) => {
        const t = k * (0.6 + delay);
        s.material.opacity = t < delay ? 0.7 : 0.7 * (1 - (t - delay) / 0.6);
      });
    });
    const clock = flat(new THREE.Mesh(G.disc, energyMaterial(evt.color, 0.9)), 2);
    clock.material.map = clockTexture();
    clock.position.x = evt.x;
    clock.position.z = evt.y;
    this.transient(clock, 0.7, (k) => {
      clock.scale.setScalar(60 * ease.outBack(Math.min(1, k * 2)));
      clock.rotation.z = -k * 6;
      clock.material.opacity = 0.9 * (1 - k);
    });
    this.flash(evt.x, 24, evt.y, evt.color, 80, 0.35, 5);
  }

  swap(evt) {
    for (const [ax, az, bx, bz] of [
      [evt.x1, evt.y1, evt.x2, evt.y2],
      [evt.x2, evt.y2, evt.x1, evt.y1],
    ]) {
      for (let i = 0; i < 16; i++) {
        const t = i / 16;
        const lift = Math.sin(t * Math.PI) * 50;
        this.glow.spawn(ax + (bx - ax) * t, 20 + lift, az + (bz - az) * t, 0, 0, 0, C(evt.color), 8, 0.35 + t * 0.3, { gravity: 0 });
      }
      this.flash(bx, 24, bz, evt.color, 70, 0.3, 4);
    }
  }

  ko(evt) {
    this.burst(evt.x, 24, evt.y, evt.color || '#ffd54f', 40, 260, { size: 7, gravity: 200, up: 1.2 });
    this.burst(evt.x, 20, evt.y, '#3a3f4b', 16, 70, { smoke: true, size: 30, life: 1.2, gravity: -20, grow: 1.5, alpha: 0.6 });
    this.shockwave(evt.x, evt.y, 90, evt.color || '#ffd54f', 0.6);
    // Soul wisp spirals up out of the body
    const soul = makeGlowSprite('#e0f7fa', 30, 1);
    soul.position.set(evt.x, 20, evt.y);
    this.transient(soul, 1.4, (k) => {
      soul.position.set(evt.x + Math.sin(k * 12) * 12 * (1 - k), 20 + ease.outCubic(k) * 140, evt.y + Math.cos(k * 12) * 12 * (1 - k));
      soul.material.opacity = 1 - k;
      if (Math.random() < 0.5) this.glow.spawn(soul.position.x, soul.position.y, soul.position.z, 0, -10, 0, C('#b2ebf2'), 5, 0.5, { gravity: 0 });
    });
    this.textQueue.push({ x: evt.x, y: 70, z: evt.y, text: 'KO!', color: '#ffd54f', big: true, ko: true });
    this.addShake(10);
  }

  respawn(evt) {
    this.pillar(evt.x, evt.y, evt.color || '#fff59d', 30, 320, 0.9);
    this.shockwave(evt.x, evt.y, 60, evt.color || '#fff59d', 0.6);
    this.ringBurst(evt.x, evt.y, 30, evt.color || '#fff59d', 24, 4, { out: 20, lift: 140, size: 6, life: 0.9 });
  }

  pillar(x, z, color, radius, height, duration) {
    const m = new THREE.Mesh(G.cylY, energyMaterial(color, 0.7));
    m.position.set(x, height / 2, z);
    this.transient(
      m,
      duration,
      (k) => {
        const w = radius * (1 - ease.inCubic(k)) + 0.01;
        m.scale.set(w, height * (0.4 + ease.outCubic(Math.min(1, k * 3)) * 0.6), w);
        m.material.opacity = 0.7 * (1 - k);
      },
      { x, y: 40, z, color, strength: 6, distance: 260 }
    );
  }

  // ----- Snapshot-driven entities -----
  syncProjectiles(renderProjectiles, t, dt) {
    const seen = new Set();
    for (const pr of renderProjectiles.values()) {
      seen.add(pr.id);
      let e = this.projectiles.get(pr.id);
      if (!e) {
        e = this.makeProjectile(pr);
        this.projectiles.set(pr.id, e);
        this.scene.add(e.group);
      }
      const g = e.group;
      g.position.set(pr.x, CHEST, pr.y);
      const heading = Math.atan2(pr.vy, pr.vx);
      g.rotation.y = -heading;
      if (e.spin) e.spin.rotation[e.spinAxis] += dt * e.spinSpeed;
      if (e.wobble) e.wobble.scale.setScalar(1 + Math.sin(t * 20 + pr.id) * 0.15);
      if (e.rope) {
        const has = pr.ox !== undefined;
        e.rope.visible = has;
        if (has) {
          const dx = pr.x - pr.ox;
          const dz = pr.y - pr.oy;
          const len = Math.hypot(dx, dz);
          e.rope.position.set((pr.x + pr.ox) / 2, CHEST, (pr.y + pr.oy) / 2);
          e.rope.rotation.set(0, -Math.atan2(dz, dx), Math.PI / 2);
          e.rope.scale.set(1.4, len, 1.4);
        }
      }
      // Trail particles
      e.emit += dt * e.trailRate;
      while (e.emit >= 1) {
        e.emit -= 1;
        this.glow.spawn(pr.x + (Math.random() - 0.5) * 4, CHEST + (Math.random() - 0.5) * 4, pr.y + (Math.random() - 0.5) * 4, -pr.vx * 0.05, 4, -pr.vy * 0.05, e.color, pr.r * 1.4, 0.3, { gravity: 0, drag: 4 });
      }
      this.lights.request(pr.x, CHEST, pr.y, pr.c, 1.4, 120);
    }
    for (const [id, e] of this.projectiles) {
      if (!seen.has(id)) {
        this.scene.remove(e.group);
        disposeTree(e.group);
        if (e.rope) {
          this.scene.remove(e.rope);
          disposeTree(e.rope);
        }
        this.projectiles.delete(id);
      }
    }
  }

  makeProjectile(pr) {
    const group = new THREE.Group();
    const color = C(pr.c);
    const r = pr.r || 7;
    const e = { group, color, emit: 0, trailRate: 60 };
    const glow = makeGlowSprite(pr.c, r * 5, 0.9);
    group.add(glow);
    const hot = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.8), toneMapped: false });
    switch (pr.k) {
      case 'cog': {
        const gear = new THREE.Group();
        const brass = new THREE.MeshStandardMaterial({ color: 0xd4a24c, metalness: 1, roughness: 0.3, emissive: 0x6b4a00 });
        const disc = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 2.5, 16), brass);
        gear.add(disc);
        for (let i = 0; i < 8; i++) {
          const tooth = new THREE.Mesh(G.box, brass);
          tooth.scale.set(2.6, 2.5, 2.6);
          tooth.position.set(Math.cos((i / 8) * TAU) * (r + 1), 0, Math.sin((i / 8) * TAU) * (r + 1));
          gear.add(tooth);
        }
        group.add(gear);
        Object.assign(e, { spin: gear, spinAxis: 'y', spinSpeed: 18 });
        break;
      }
      case 'needle': {
        const needle = new THREE.Mesh(new THREE.ConeGeometry(r * 0.5, r * 5, 8), hot);
        needle.rotation.z = -Math.PI / 2;
        group.add(needle);
        e.trailRate = 90;
        break;
      }
      case 'shuriken': {
        const s = new THREE.Shape();
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU;
          const rad = i % 2 === 0 ? r * 1.6 : r * 0.45;
          if (i === 0) s.moveTo(Math.cos(a) * rad, Math.sin(a) * rad);
          else s.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
        }
        s.closePath();
        const star = new THREE.Mesh(
          new THREE.ExtrudeGeometry(s, { depth: 1.2, bevelEnabled: false }),
          new THREE.MeshStandardMaterial({ color: 0xf4efe6, roughness: 0.6, emissive: color, emissiveIntensity: 0.6, side: THREE.DoubleSide })
        );
        star.rotation.x = -Math.PI / 2;
        const spinner = new THREE.Group();
        spinner.add(star);
        group.add(spinner);
        Object.assign(e, { spin: spinner, spinAxis: 'y', spinSpeed: 26 });
        break;
      }
      case 'wisp': {
        const core = new THREE.Mesh(G.sphere, hot);
        core.scale.setScalar(r * 0.7);
        group.add(core);
        e.wobble = core;
        e.trailRate = 120;
        break;
      }
      case 'spore': {
        const spore = new THREE.Mesh(G.ico, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2, flatShading: true }));
        spore.scale.setScalar(r * 0.9);
        group.add(spore);
        Object.assign(e, { spin: spore, spinAxis: 'x', spinSpeed: 5, wobble: spore });
        break;
      }
      case 'coin': {
        const coin = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1.4, 18), new THREE.MeshStandardMaterial({ color: 0xffd54f, metalness: 1, roughness: 0.25, emissive: 0x7a5200 }));
        coin.rotation.z = Math.PI / 2;
        const spinner = new THREE.Group();
        spinner.add(coin);
        group.add(spinner);
        Object.assign(e, { spin: spinner, spinAxis: 'x', spinSpeed: 22, trailRate: 40 });
        break;
      }
      case 'chain': {
        const ringMesh = new THREE.Mesh(new THREE.TorusGeometry(r * 0.8, r * 0.28, 8, 18), new THREE.MeshStandardMaterial({ color: pr.c, roughness: 0.5, emissive: color, emissiveIntensity: 0.4 }));
        ringMesh.rotation.x = Math.PI / 2;
        group.add(ringMesh);
        const rope = new THREE.Mesh(G.cylY, new THREE.MeshStandardMaterial({ color: 0xd7ccc8, roughness: 0.9 }));
        rope.visible = false;
        this.scene.add(rope);
        e.rope = rope;
        group.userData.rope = rope;
        e.trailRate = 20;
        break;
      }
      case 'bomb': {
        const bomb = new THREE.Mesh(G.sphere, new THREE.MeshStandardMaterial({ color: 0x212121, roughness: 0.35, metalness: 0.5 }));
        bomb.scale.setScalar(r);
        group.add(bomb);
        const fuse = makeGlowSprite('#ffab40', r * 2.4, 1);
        fuse.position.y = r * 1.1;
        group.add(fuse);
        e.wobble = fuse;
        break;
      }
      default: {
        const core = new THREE.Mesh(G.sphere, hot);
        core.scale.setScalar(r);
        group.add(core);
      }
    }
    return e;
  }

  syncZones(zones, t, dt) {
    const seen = new Set();
    for (const z of zones || []) {
      seen.add(z.id);
      let e = this.zones.get(z.id);
      if (!e) {
        e = this.makeZone(z);
        e.born = t;
        this.zones.set(z.id, e);
        this.scene.add(e.group);
      }
      e.update(z, t, dt, Math.min(1, (t - e.born) / 0.35));
    }
    for (const [id, e] of this.zones) {
      if (seen.has(id)) continue;
      this.zones.delete(id);
      const g = e.group;
      this.transient(null, 0.35, (k) => {
        g.scale.setScalar(Math.max(0.01, 1 - ease.inCubic(k)));
        if (k >= 1) {
          this.scene.remove(g);
          disposeTree(g);
        }
      });
    }
  }

  makeZone(z) {
    const group = new THREE.Group();
    group.position.set(z.x, 0, z.y);
    const color = C(z.c);
    const r = z.r;
    const fx = this;
    const baseRing = flat(new THREE.Mesh(G.ring, energyMaterial(z.c, 0.8)), 1.4);
    baseRing.scale.setScalar(r);

    if (z.kind === 'portal') {
      const ends = [];
      for (const [x, zz] of [
        [z.x, z.y],
        [z.bx, z.by],
      ]) {
        const end = new THREE.Group();
        end.position.set(x - z.x, 0, zz - z.y);
        const swirl = flat(new THREE.Mesh(G.disc, energyMaterial(z.c, 0.9)), 1.6);
        swirl.material.map = spiralTexture();
        swirl.scale.setScalar(r * 1.25);
        const halo = new THREE.Mesh(new THREE.TorusGeometry(r * 1.1, 2.6, 10, 48), energyMaterial(z.c, 1));
        halo.position.y = r * 1.15;
        const glowS = makeGlowSprite(z.c, r * 4, 0.6);
        glowS.position.y = r;
        end.add(swirl, halo, glowS);
        group.add(end);
        ends.push({ end, swirl, halo, x, z: zz });
      }
      return {
        group,
        update(zz, t, dt, born) {
          group.scale.setScalar(ease.outBack(born));
          for (const [i, en] of ends.entries()) {
            en.swirl.rotation.z = -t * (i ? -3 : 3);
            en.halo.rotation.y = t * 1.2;
            en.halo.rotation.x = Math.sin(t * 2) * 0.15;
            if (Math.random() < dt * 30) {
              const a = Math.random() * TAU;
              fx.glow.spawn(en.x + Math.cos(a) * r * 1.4, 4, en.z + Math.sin(a) * r * 1.4, -Math.cos(a) * 50, 50, -Math.sin(a) * 50, color, 6, 0.6, { gravity: 0 });
            }
            fx.lights.request(en.x, 30, en.z, zz.c, 3, 200);
          }
        },
      };
    }

    if (z.kind === 'trail') {
      const MAX = 96;
      const puddles = new THREE.InstancedMesh(G.disc, new THREE.MeshStandardMaterial({ color: 0x6d3f22, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.85 }), MAX);
      puddles.count = 0;
      puddles.receiveShadow = true;
      group.add(puddles);
      group.position.set(0, 0, 0);
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
      return {
        group,
        update(zz, t, dt) {
          const pts = zz.pts || [];
          const n = Math.min(MAX, pts.length / 2);
          for (let i = 0; i < n; i++) {
            const wob = 1 + Math.sin(t * 3 + i) * 0.05;
            m4.compose(new THREE.Vector3(pts[i * 2], 0.9, pts[i * 2 + 1]), q, new THREE.Vector3(r * wob, r * 0.85 * wob, 1));
            puddles.setMatrixAt(i, m4);
          }
          // Steam: a fixed rate for the whole trail (≈10 wisps/s), from random puddles
          if (n > 0 && Math.random() < dt * 10) {
            const i = Math.floor(Math.random() * n);
            fx.smoke.spawn(pts[i * 2] + (Math.random() - 0.5) * r, 3, pts[i * 2 + 1] + (Math.random() - 0.5) * r, 0, 22, 0, C('#dfe6ea'), 12, 0.9, { gravity: -6, grow: 1, alpha: 0.22 });
          }
          puddles.count = n;
          puddles.instanceMatrix.needsUpdate = true;
        },
      };
    }

    if (z.kind === 'turret') {
      const range = flat(new THREE.Mesh(G.thinRing, energyMaterial(z.c, 0.35)), 1.2);
      range.scale.setScalar(r);
      const machine = new THREE.Group();
      const paint = new THREE.MeshStandardMaterial({ color: 0x0277bd, metalness: 0.4, roughness: 0.4 });
      const body = new THREE.Mesh(G.box, paint);
      body.scale.set(16, 26, 12);
      body.position.y = 13;
      body.castShadow = true;
      const screen = new THREE.Mesh(G.box, new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.5), toneMapped: false }));
      screen.scale.set(10, 10, 1);
      screen.position.set(0, 16, 6.2);
      const antenna = new THREE.Mesh(G.sphere, new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(2), toneMapped: false }));
      antenna.scale.setScalar(4);
      antenna.position.y = 32;
      machine.add(body, screen, antenna, makeGlowSprite(z.c, 30, 0.8));
      machine.children[3].position.y = 32;
      group.add(range, machine);
      return {
        group,
        update(zz, t, dt, born) {
          machine.scale.setScalar(ease.outBack(born));
          machine.rotation.y = Math.sin(t * 2) * 0.3;
          range.material.opacity = 0.25 + Math.sin(t * 4) * 0.1;
          fx.lights.request(zz.x, 32, zz.y, zz.c, 1.6, 140);
        },
      };
    }

    // Area zones
    const v = z.v;
    if (v === 'stasis') {
      const face = flat(new THREE.Mesh(G.disc, energyMaterial(z.c, 0.55)), 1.6);
      face.material.map = clockTexture();
      face.scale.setScalar(r);
      const dome = new THREE.Mesh(G.hemi, fresnelMaterial(z.c, { power: 1.8, intensity: 1.1, opacity: 0.8 }));
      dome.scale.set(r, r * 0.6, r);
      const hands = [];
      for (const [len, w, speed] of [
        [0.7, 5, -0.6],
        [0.5, 8, -0.08],
      ]) {
        const h = new THREE.Group();
        const bar = flat(new THREE.Mesh(G.box, energyMaterial('#ffffff', 0.9)), 2);
        bar.scale.set(w, r * len, 1);
        bar.position.z = -(r * len) / 2;
        bar.position.y = 2.2;
        h.add(bar);
        group.add(h);
        hands.push({ h, speed });
      }
      group.add(face, dome);
      return {
        group,
        update(zz, t, dt, born) {
          group.scale.setScalar(ease.outBack(born));
          for (const hd of hands) hd.h.rotation.y += dt * hd.speed * 6;
          dome.material.uniforms.uTime.value = t;
          fx.lights.request(zz.x, 40, zz.y, zz.c, 2, 260);
        },
      };
    }
    if (v === 'whirl') {
      const swirl = flat(new THREE.Mesh(G.disc, energyMaterial(z.c, 0.7)), 1.5);
      swirl.material.map = spiralTexture();
      swirl.scale.setScalar(r);
      group.add(swirl, baseRing);
      return {
        group,
        update(zz, t, dt, born) {
          group.scale.setScalar(ease.outBack(born));
          swirl.rotation.z = t * 4;
          for (let i = 0; i < 4; i++) {
            if (Math.random() > dt * 60) continue;
            const a = Math.random() * TAU;
            const rr = r * (0.6 + Math.random() * 0.4);
            fx.glow.spawn(zz.x + Math.cos(a) * rr, 4 + Math.random() * 10, zz.y + Math.sin(a) * rr, -Math.cos(a + 0.8) * rr * 1.4, 10, -Math.sin(a + 0.8) * rr * 1.4, color, 6, 0.7, { gravity: 0, drag: 0.5 });
          }
          fx.lights.request(zz.x, 30, zz.y, zz.c, 2.2, 260);
        },
      };
    }
    if (v === 'dome') {
      const dome = new THREE.Mesh(G.hemi, fresnelMaterial(z.c, { power: 2, intensity: 1.2, opacity: 0.95, hex: true }));
      dome.scale.set(r, r * 0.75, r);
      group.add(dome, baseRing);
      let arcT = 0;
      return {
        group,
        update(zz, t, dt, born) {
          group.scale.setScalar(ease.outBack(born));
          dome.material.uniforms.uTime.value = t;
          arcT -= dt;
          if (arcT <= 0) {
            arcT = 0.12 + Math.random() * 0.2;
            const a1 = Math.random() * TAU;
            const a2 = a1 + 0.6 + Math.random();
            fx.lightning([{ x1: zz.x + Math.cos(a1) * r * 0.9, y1: zz.y + Math.sin(a1) * r * 0.9, x2: zz.x + Math.cos(a2) * r * 0.9, y2: zz.y + Math.sin(a2) * r * 0.9 }], zz.c, 0.14, 4, { shake: false });
          }
          fx.lights.request(zz.x, 40, zz.y, zz.c, 2.4, 300);
        },
      };
    }
    if (v === 'bloom') {
      const petals = flat(new THREE.Mesh(G.disc, energyMaterial(z.c, 0.6)), 1.5);
      petals.material.map = mandalaTexture();
      petals.scale.setScalar(r);
      const inner = flat(new THREE.Mesh(G.disc, energyMaterial('#ce93d8', 0.5)), 1.8);
      inner.material.map = mandalaTexture();
      inner.scale.setScalar(r * 0.6);
      group.add(petals, inner, baseRing);
      return {
        group,
        update(zz, t, dt, born) {
          group.scale.setScalar(ease.outBack(born));
          petals.rotation.z = t * 0.5;
          inner.rotation.z = -t * 0.8;
          const hue = (t * 0.15) % 1;
          petals.material.color.setHSL(0.85 + hue * 0.15, 0.8, 0.6);
          if (Math.random() < dt * 40) {
            const a = Math.random() * TAU;
            const rr = Math.random() * r;
            fx.glow.spawn(zz.x + Math.cos(a) * rr, 3, zz.y + Math.sin(a) * rr, 0, 30 + Math.random() * 30, 0, C(Math.random() < 0.5 ? '#f48fb1' : '#ce93d8'), 6, 1.2, { gravity: -5, drag: 0.6 });
          }
          fx.lights.request(zz.x, 30, zz.y, zz.c, 2, 260);
        },
      };
    }
    const fill = flat(new THREE.Mesh(G.disc, energyMaterial(z.c, 0.18)), 1.2);
    fill.scale.setScalar(r);
    group.add(fill, baseRing);
    return {
      group,
      update(zz, t, dt, born) {
        group.scale.setScalar(ease.outBack(born));
        fill.material.opacity = 0.14 + Math.sin(t * 5) * 0.05;
      },
    };
  }

  syncBlasts(blasts, renderPlayers, t, dt) {
    const seen = new Set();
    for (const b of blasts || []) {
      seen.add(b.id);
      let e = this.blasts.get(b.id);
      if (!e) {
        e = this.makeBlast(b);
        this.blasts.set(b.id, e);
        this.scene.add(e.group);
      }
      e.target = b;
      e.update(b, renderPlayers, t, dt);
    }
    for (const [id, e] of this.blasts) {
      if (!seen.has(id)) {
        this.scene.remove(e.group);
        disposeTree(e.group);
        this.blasts.delete(id);
      }
    }
  }

  makeBlast(b) {
    const group = new THREE.Group();
    const fx = this;
    if (b.kind === 'deadeye') {
      const marks = new Map();
      return {
        group,
        update(bb, players, t) {
          const owner = players.get(bb.ownerId);
          for (const id of bb.tg || []) {
            const p = players.get(id);
            let m = marks.get(id);
            if (!m) {
              const cross = flat(new THREE.Mesh(G.disc, energyMaterial(bb.c, 1)), 2);
              cross.material.map = crosshairTexture();
              const laser = new THREE.Mesh(G.cylY, energyMaterial(bb.c, 0.6));
              group.add(cross, laser);
              m = { cross, laser };
              marks.set(id, m);
            }
            m.cross.visible = !!p && p.alive;
            m.laser.visible = !!p && !!owner && p.alive;
            if (!p) continue;
            const s = 40 * (2.2 - ease.outCubic(bb.p) * 1.2);
            m.cross.scale.setScalar(s);
            m.cross.position.set(p.x, 2, p.y);
            m.cross.rotation.z = t * 3;
            m.cross.material.opacity = 0.6 + Math.sin(t * 30) * 0.4 * bb.p;
            if (owner) {
              const dx = p.x - owner.x;
              const dz = p.y - owner.y;
              const len = Math.hypot(dx, dz);
              m.laser.position.set((p.x + owner.x) / 2, 26, (p.y + owner.y) / 2);
              m.laser.rotation.set(0, -Math.atan2(dz, dx), Math.PI / 2);
              m.laser.scale.set(0.8, len, 0.8);
              m.laser.material.opacity = 0.25 + bb.p * 0.5;
            }
          }
        },
      };
    }
    if (b.kind === 'bomb') {
      const bomb = new THREE.Group();
      const ball = new THREE.Mesh(G.sphere, new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.3, metalness: 0.6, emissive: 0xff1744, emissiveIntensity: 0 }));
      ball.scale.setScalar(9);
      const fuse = makeGlowSprite('#ffab40', 22, 1);
      fuse.position.y = 10;
      bomb.add(ball, fuse);
      const ring = flat(new THREE.Mesh(G.ring, energyMaterial(b.c, 0.8)), 1.6);
      ring.scale.setScalar(b.r);
      const fill = flat(new THREE.Mesh(G.disc, energyMaterial(b.c, 0.18)), 1.3);
      group.add(bomb, ring, fill);
      return {
        group,
        update(bb, players, t) {
          const host = bb.at ? players.get(bb.at) : null;
          const x = host ? host.x : bb.x;
          const z = host ? host.y : bb.y;
          bomb.position.set(x, 76, z);
          bomb.rotation.y = t * 2;
          ring.position.set(x, 1.6, z);
          fill.position.set(x, 1.3, z);
          fill.scale.setScalar(Math.max(0.01, bb.r * bb.p));
          // Blink faster as the fuse burns down
          const blink = Math.sin(t * (8 + bb.p * 40)) > 0 ? 1 : 0;
          ball.material.emissiveIntensity = blink * (0.5 + bb.p * 2);
          fuse.scale.setScalar(16 + Math.random() * 10);
          if (Math.random() < 0.6) fx.glow.spawn(x, 88, z, (Math.random() - 0.5) * 50, 40, (Math.random() - 0.5) * 50, C('#ffab40'), 4, 0.35, { gravity: 120 });
          fx.lights.request(x, 70, z, '#ff6d00', 1.5 + blink * 2, 160);
        },
      };
    }
    const ring = flat(new THREE.Mesh(G.ring, energyMaterial(b.c, 0.9)), 1.6);
    ring.scale.setScalar(b.r);
    const fill = flat(new THREE.Mesh(G.disc, energyMaterial(b.c, 0.22)), 1.3);
    group.add(ring, fill);
    group.position.set(b.x, 0, b.y);
    let meteor = null;
    if (b.v === 'meteor') {
      meteor = new THREE.Group();
      const rock = new THREE.Mesh(G.ico, new THREE.MeshStandardMaterial({ color: 0x3e2723, emissive: 0xff6d00, emissiveIntensity: 1.4, flatShading: true, roughness: 0.8 }));
      rock.scale.setScalar(13);
      meteor.add(rock, makeGlowSprite(b.c, 90, 0.9));
      group.add(meteor);
    }
    return {
      group,
      update(bb, players, t) {
        fill.scale.setScalar(Math.max(0.01, bb.r * ease.inCubic(bb.p)));
        ring.material.opacity = 0.5 + Math.sin(t * 20) * 0.3;
        if (meteor) {
          const h = (1 - bb.p) * 520;
          meteor.position.set(-h * 0.35, h + 10, -h * 0.5);
          meteor.children[0].rotation.x += 0.2;
          fx.glow.spawn(bb.x + meteor.position.x, meteor.position.y, bb.y + meteor.position.z, 0, 30, 0, C(bb.c), 22, 0.4, { gravity: 0, grow: 0.6 });
          fx.smoke.spawn(bb.x + meteor.position.x, meteor.position.y + 6, bb.y + meteor.position.z, 0, 10, 0, C('#3e3a38'), 26, 0.8, { gravity: 0, grow: 1, alpha: 0.5 });
        } else if (bb.v === 'geyser' && Math.random() < 0.35) {
          const a = Math.random() * TAU;
          const rr = Math.random() * bb.r * 0.5;
          fx.smoke.spawn(bb.x + Math.cos(a) * rr, 2, bb.y + Math.sin(a) * rr, 0, 40 + bb.p * 80, 0, C('#dfe6ea'), 12, 0.5, { gravity: 0, grow: 0.8, alpha: 0.3 });
        }
      },
    };
  }

  update(dt, t, viewportScale) {
    for (let i = this.transients.length - 1; i >= 0; i--) {
      const tr = this.transients[i];
      tr.t += dt;
      const k = Math.min(1, tr.t / tr.duration);
      tr.fn(k, dt);
      if (tr.light) {
        this.lights.request(tr.light.x, tr.light.y, tr.light.z, tr.light.color, tr.light.strength * (1 - k), tr.light.distance);
      }
      if (k >= 1) {
        if (tr.obj) {
          this.scene.remove(tr.obj);
          disposeTree(tr.obj);
        }
        this.transients.splice(i, 1);
      }
    }
    this.glow.update(dt, viewportScale);
    this.smoke.update(dt, viewportScale);
    this.shake = Math.max(0, this.shake - dt * 26);
    this.punch = Math.max(0, this.punch - dt * 3);
  }
}
