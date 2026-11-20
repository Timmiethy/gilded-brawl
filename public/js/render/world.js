// Static 3D world: painted terrain, obstacle props, shrines, practice dummies, walls, decoration
// and biome ambience. Everything is procedural and seeded, so every client builds the same world.
import { WORLD_SIZE, WORLD_HALF, OBSTACLES, SHRINE_SPOTS, PRACTICE_TOTEM_SPOTS, getBiomeAt } from '/shared/map.js';
import { THREE, TAU, seededRandom, makeGlowSprite } from './core.js';

const COURTYARD_R = 420;

// ---------- Value noise (seeded) ----------
function makeNoise(seed) {
  const rand = seededRandom(seed);
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    perm[i] = i;
    vals[i] = rand();
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const at = (x, y) => vals[perm[(perm[x & 255] + y) & 511]];
  const smooth = (t) => t * t * (3 - 2 * t);
  const noise = (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = smooth(x - xi);
    const yf = smooth(y - yi);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  return (x, y, octaves = 4) => {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    for (let o = 0; o < octaves; o++) {
      sum += noise(x * freq, y * freq) * amp;
      freq *= 2.03;
      amp *= 0.5;
    }
    return sum;
  };
}

const fbm = makeNoise(1337);

const BIOME_COLORS = {
  ruins: [[62, 68, 74], [92, 102, 84]], // weathered slate → moss
  forge: [[46, 34, 31], [74, 52, 42]], // ash basalt → scorched clay
  meadow: [[66, 104, 46], [104, 132, 58]], // deep grass → sunlit grass
  sanctum: [[214, 224, 234], [176, 196, 216]], // snow → shaded snow
  courtyard: [[150, 140, 122], [178, 168, 146]], // sandstone plaza
};

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function biomeColor(id, n) {
  const [a, b] = BIOME_COLORS[id];
  return mix(a, b, n);
}

// ---------- Terrain textures ----------
function paintTerrain() {
  const BASE = 512;
  const SIZE = 2048;
  const k = SIZE / WORLD_SIZE;

  // 1) Low-res noisy biome colors with soft, noise-wobbled borders (upscaled smoothly)
  const base = document.createElement('canvas');
  base.width = base.height = BASE;
  const bctx = base.getContext('2d');
  const img = bctx.createImageData(BASE, BASE);
  for (let py = 0; py < BASE; py++) {
    for (let px = 0; px < BASE; px++) {
      const wx = ((px + 0.5) / BASE) * WORLD_SIZE;
      const wy = ((py + 0.5) / BASE) * WORLD_SIZE;
      const n = fbm(wx / 160, wy / 160);
      const wob = (fbm(wx / 300 + 40, wy / 300) - 0.5) * 160;
      const dCourt = Math.hypot(wx - WORLD_HALF, wy - WORLD_HALF);
      const tx = Math.min(1, Math.max(0, (wx + wob - WORLD_HALF) / 120 + 0.5));
      const ty = Math.min(1, Math.max(0, (wy - wob - WORLD_HALF) / 120 + 0.5));
      const top = mix(biomeColor('ruins', n), biomeColor('forge', n), tx);
      const bottom = mix(biomeColor('meadow', n), biomeColor('sanctum', n), tx);
      let c = mix(top, bottom, ty);
      const tc = Math.min(1, Math.max(0, (COURTYARD_R + 20 - dCourt) / 40));
      c = mix(c, biomeColor('courtyard', n), tc);
      // Fine grain
      const g = (fbm(wx / 18, wy / 18, 2) - 0.5) * 26;
      const i = (py * BASE + px) * 4;
      img.data[i] = c[0] + g;
      img.data[i + 1] = c[1] + g;
      img.data[i + 2] = c[2] + g;
      img.data[i + 3] = 255;
    }
  }
  bctx.putImageData(img, 0, 0);

  const color = document.createElement('canvas');
  color.width = color.height = SIZE;
  const ctx = color.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(base, 0, 0, SIZE, SIZE);

  const glow = document.createElement('canvas');
  glow.width = glow.height = SIZE;
  const gctx = glow.getContext('2d');
  gctx.fillStyle = '#000';
  gctx.fillRect(0, 0, SIZE, SIZE);

  const rough = document.createElement('canvas');
  rough.width = rough.height = 256;
  const rctx = rough.getContext('2d');
  const rk = 256 / WORLD_SIZE;
  rctx.fillStyle = 'rgb(235,235,235)';
  rctx.fillRect(0, 0, 256, 256);

  const rand = seededRandom(99);
  ctx.save();
  ctx.scale(k, k);
  gctx.save();
  gctx.scale(k, k);

  // 2) Dirt roads from the courtyard to every shrine
  ctx.lineCap = 'round';
  for (const sh of SHRINE_SPOTS) {
    if (sh.x === WORLD_HALF && sh.y === WORLD_HALF) continue;
    ctx.strokeStyle = 'rgba(96, 78, 58, 0.55)';
    ctx.lineWidth = 46;
    ctx.beginPath();
    ctx.moveTo(WORLD_HALF, WORLD_HALF);
    const mx = (sh.x + WORLD_HALF) / 2 + (rand() - 0.5) * 160;
    const my = (sh.y + WORLD_HALF) / 2 + (rand() - 0.5) * 160;
    ctx.quadraticCurveTo(mx, my, sh.x, sh.y);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(70, 56, 42, 0.35)';
    ctx.lineWidth = 22;
    ctx.stroke();
  }

  // 3) Ruins: a few worn patches of old flagstones, half buried in the moss
  for (let p = 0; p < 12; p++) {
    const cx = 120 + rand() * 1000;
    const cy = 120 + rand() * 1000;
    if (Math.hypot(cx - WORLD_HALF, cy - WORLD_HALF) < COURTYARD_R + 80) continue;
    // Stones laid on a grid (with wear) instead of scattered at random
    const cell = 30;
    for (let gx = -3; gx <= 3; gx++) {
      for (let gy = -3; gy <= 3; gy++) {
        if (Math.hypot(gx, gy) > 3.2 || rand() < 0.3) continue;
        const x = cx + gx * cell + (gy % 2 ? cell / 2 : 0);
        const y = cy + gy * cell;
        const w = cell - 3;
        const h = cell - 3;
        const shade = 72 + rand() * 22;
        ctx.fillStyle = `rgba(${shade}, ${shade + 3}, ${shade + 6}, ${0.35 + rand() * 0.3})`;
        ctx.strokeStyle = 'rgba(28, 32, 30, 0.35)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // 4) Forge: glowing lava fissures (also painted into the emissive map)
  for (let c = 0; c < 24; c++) {
    let x = WORLD_HALF + 60 + rand() * 1050;
    let y = 60 + rand() * 1050;
    if (Math.hypot(x - WORLD_HALF, y - WORLD_HALF) < COURTYARD_R + 60) continue;
    let a = rand() * TAU;
    const segs = 6 + Math.floor(rand() * 10);
    const path = [[x, y]];
    for (let s = 0; s < segs; s++) {
      a += (rand() - 0.5) * 1.2;
      x += Math.cos(a) * (14 + rand() * 18);
      y += Math.sin(a) * (14 + rand() * 18);
      path.push([x, y]);
    }
    for (const [target, width, style] of [
      [ctx, 8, 'rgba(20, 10, 8, 0.9)'],
      [ctx, 3, 'rgba(230, 100, 30, 0.9)'],
      [gctx, 3, 'rgba(255, 90, 15, 0.8)'],
      [gctx, 1.2, 'rgba(255, 200, 110, 0.9)'],
    ]) {
      target.strokeStyle = style;
      target.lineWidth = width;
      target.lineJoin = 'round';
      target.beginPath();
      path.forEach(([px, py], i) => (i ? target.lineTo(px, py) : target.moveTo(px, py)));
      target.stroke();
    }
  }

  // 5) Meadow: wildflower specks and darker clover
  for (let f = 0; f < 2600; f++) {
    const x = 50 + rand() * 1130;
    const y = WORLD_HALF + 20 + rand() * 1130;
    if (Math.hypot(x - WORLD_HALF, y - WORLD_HALF) < COURTYARD_R + 30) continue;
    const pick = rand();
    ctx.fillStyle =
      pick < 0.55 ? 'rgba(46, 78, 34, 0.5)' : pick < 0.7 ? '#f3e7a1' : pick < 0.85 ? '#e9a6c9' : '#c9d9ff';
    const r = pick < 0.55 ? 6 + rand() * 10 : 1.6 + rand() * 1.6;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }

  // 6) Sanctum: blue-shadowed drifts and glassy ice sheets (smooth in the roughness map)
  rctx.save();
  rctx.scale(rk, rk);
  for (let s = 0; s < 22; s++) {
    const x = WORLD_HALF + 80 + rand() * 1000;
    const y = WORLD_HALF + 80 + rand() * 1000;
    if (Math.hypot(x - WORLD_HALF, y - WORLD_HALF) < COURTYARD_R + 80) continue;
    const rx = 40 + rand() * 90;
    const ry = 26 + rand() * 50;
    const rot = rand() * Math.PI;
    ctx.fillStyle = 'rgba(150, 196, 232, 0.55)';
    ctx.strokeStyle = 'rgba(235, 248, 255, 0.7)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rot, 0, TAU);
    ctx.fill();
    ctx.stroke();
    rctx.fillStyle = 'rgb(40,40,40)';
    rctx.beginPath();
    rctx.ellipse(x, y, rx, ry, rot, 0, TAU);
    rctx.fill();
  }

  // 7) Courtyard: concentric paving, gold inlay rings and a glowing compass sigil
  ctx.save();
  ctx.translate(WORLD_HALF, WORLD_HALF);
  for (let ring = 0; ring < 9; ring++) {
    const r0 = 60 + ring * 42;
    const count = 10 + ring * 7;
    for (let t = 0; t < count; t++) {
      const a0 = (t / count) * TAU + ring * 0.13;
      const a1 = ((t + 1) / count) * TAU + ring * 0.13;
      const shade = 150 + rand() * 30;
      ctx.fillStyle = `rgb(${shade}, ${shade - 8}, ${shade - 26})`;
      ctx.strokeStyle = 'rgba(60, 52, 40, 0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, r0 + 40, a0, a1);
      ctx.arc(0, 0, r0, a1, a0, true);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  for (const [r, w] of [
    [COURTYARD_R - 6, 8],
    [230, 5],
    [72, 4],
  ]) {
    ctx.strokeStyle = '#c9a046';
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();
  }
  // Compass star
  gctx.save();
  gctx.translate(WORLD_HALF, WORLD_HALF);
  for (const [target, fill] of [
    [ctx, '#d9b55c'],
    [gctx, 'rgba(255, 196, 90, 0.55)'],
  ]) {
    target.fillStyle = fill;
    target.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU - Math.PI / 2;
      const r = i % 2 === 0 ? (i % 4 === 0 ? 210 : 120) : 34;
      target.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    target.closePath();
    target.fill();
  }
  gctx.strokeStyle = 'rgba(255, 210, 120, 0.8)';
  gctx.lineWidth = 3;
  gctx.beginPath();
  gctx.arc(0, 0, 230, 0, TAU);
  gctx.stroke();
  gctx.restore();
  ctx.restore();
  rctx.fillStyle = 'rgb(130,130,130)';
  rctx.beginPath();
  rctx.arc(WORLD_HALF, WORLD_HALF, COURTYARD_R, 0, TAU);
  rctx.fill();
  rctx.restore();

  ctx.restore();
  gctx.restore();

  return { color, glow, rough };
}

function makeDetailBump() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const n = makeNoise(77);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // Tileable by sampling a torus-wrapped domain
      const v = n(x / 16, y / 16, 3) * 0.7 + n((x * 3) / 16, (y * 3) / 16, 2) * 0.3;
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
  t.repeat.set(60, 60);
  return t;
}

function buildTerrain(scene, anisotropy) {
  const { color, glow, rough } = paintTerrain();
  const map = new THREE.CanvasTexture(color);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = anisotropy;
  const emissiveMap = new THREE.CanvasTexture(glow);
  emissiveMap.colorSpace = THREE.SRGBColorSpace;
  const roughnessMap = new THREE.CanvasTexture(rough);

  const mat = new THREE.MeshStandardMaterial({
    map,
    emissiveMap,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0.75,
    roughnessMap,
    roughness: 1,
    metalness: 0,
    bumpMap: makeDetailBump(),
    bumpScale: 1.4,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE), mat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(WORLD_HALF, 0, WORLD_HALF);
  ground.receiveShadow = true;
  scene.add(ground);

  // Dark skirt beyond the walls so the world edge never shows the void
  const skirt = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD_SIZE * 4, WORLD_SIZE * 4),
    new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 1 })
  );
  skirt.rotation.x = -Math.PI / 2;
  skirt.position.set(WORLD_HALF, -0.5, WORLD_HALF);
  skirt.receiveShadow = true;
  scene.add(skirt);
  return ground;
}

// ---------- Shared materials ----------
const M = {
  // Mid-value marble: a near-white top face lit by the sun blows out under tone mapping and bloom
  marble: () => new THREE.MeshStandardMaterial({ color: 0xb9b2a4, roughness: 0.5, metalness: 0 }),
  gold: () => new THREE.MeshStandardMaterial({ color: 0xd8a842, roughness: 0.28, metalness: 1 }),
  slate: () => new THREE.MeshStandardMaterial({ color: 0x5b6169, roughness: 0.92, flatShading: true }),
  moss: () => new THREE.MeshStandardMaterial({ color: 0x4f6b35, roughness: 1, flatShading: true }),
  basalt: () => new THREE.MeshStandardMaterial({ color: 0x2f2624, roughness: 0.92, flatShading: true }),
  lava: () =>
    new THREE.MeshStandardMaterial({ color: 0x331007, emissive: 0xff5a14, emissiveIntensity: 2.4, roughness: 0.6 }),
  bark: () => new THREE.MeshStandardMaterial({ color: 0x4b3424, roughness: 1 }),
  pine: (shade) => new THREE.MeshStandardMaterial({ color: shade, roughness: 0.95, flatShading: true }),
  ice: () =>
    new THREE.MeshPhysicalMaterial({
      color: 0x9fd6ff,
      emissive: 0x1c5c96,
      emissiveIntensity: 0.55,
      roughness: 0.08,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      transparent: true,
      opacity: 0.88,
      flatShading: true,
    }),
  wood: () => new THREE.MeshStandardMaterial({ color: 0x8b6239, roughness: 0.85 }),
  straw: () => new THREE.MeshStandardMaterial({ color: 0xcfae6a, roughness: 1 }),
  wall: () => new THREE.MeshStandardMaterial({ color: 0x6c6a66, roughness: 0.95 }),
};

function mesh(geo, mat, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

function addAt(parent, child, y) {
  child.position.y = y;
  parent.add(child);
  return child;
}

function jaggedRock(radius, detail, seed, squashY = 0.7) {
  const geo = new THREE.IcosahedronGeometry(radius, detail);
  const pos = geo.attributes.position;
  const n = makeNoise(seed);
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i);
    const s = 0.78 + n(v.x * 0.06 + 10, v.y * 0.06 + v.z * 0.04, 2) * 0.5;
    v.multiplyScalar(s);
    v.y *= squashY;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

// ---------- Obstacles ----------
function buildObstacle(ob, rand) {
  const g = new THREE.Group();
  g.position.set(ob.x, 0, ob.y);
  const r = ob.r;

  if (ob.kind === 'gilded_pillar') {
    const marble = M.marble();
    const gold = M.gold();
    addAt(g, mesh(new THREE.CylinderGeometry(r * 1.05, r * 1.15, 14, 24), gold), 7);
    const shaft = mesh(new THREE.CylinderGeometry(r * 0.78, r * 0.86, 150, 20, 1), marble);
    shaft.position.y = 89;
    g.add(shaft);
    // Fluting: thin gold ribs around the shaft
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU;
      const rib = mesh(new THREE.BoxGeometry(2, 146, 2), gold, { cast: false });
      rib.position.set(Math.cos(a) * r * 0.82, 89, Math.sin(a) * r * 0.82);
      g.add(rib);
    }
    addAt(g, mesh(new THREE.CylinderGeometry(r * 1.1, r * 0.82, 16, 24), gold), 172);
    addAt(g, mesh(new THREE.CylinderGeometry(r * 1.15, r * 1.15, 8, 24), gold), 184);
    const orb = mesh(new THREE.SphereGeometry(10, 20, 14), gold);
    orb.position.y = 198;
    g.add(orb);
    g.userData.glow = { y: 198, color: '#ffcf6b', strength: 2.2 };
  } else if (ob.kind === 'ruin_pillar') {
    const slate = M.slate();
    const h = 70 + rand() * 70;
    const shaft = mesh(new THREE.CylinderGeometry(r * 0.72, r * 0.85, h, 9, 3), slate);
    // Break the top: drop random top vertices
    const pos = shaft.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > h / 2 - 1) pos.setY(i, pos.getY(i) - rand() * 26);
    }
    shaft.geometry.computeVertexNormals();
    shaft.position.y = h / 2;
    shaft.rotation.z = (rand() - 0.5) * 0.12;
    g.add(shaft);
    addAt(g, mesh(new THREE.CylinderGeometry(r * 1.05, r * 1.12, 12, 9), slate), 6);
    const moss = mesh(new THREE.CylinderGeometry(r * 0.88, r * 0.9, 10, 9), M.moss());
    moss.position.y = 14;
    g.add(moss);
    for (let i = 0; i < 4; i++) {
      const chunk = mesh(jaggedRock(6 + rand() * 7, 0, 30 + i), slate);
      const a = rand() * TAU;
      chunk.position.set(Math.cos(a) * (r + 14), 4, Math.sin(a) * (r + 14));
      chunk.rotation.set(rand() * 3, rand() * 3, rand() * 3);
      g.add(chunk);
    }
  } else if (ob.kind === 'forge_rock') {
    const rock = mesh(jaggedRock(r * 1.05, 2, Math.floor(ob.x + ob.y), 0.85), M.basalt());
    rock.position.y = r * 0.55;
    g.add(rock);
    // Lava seams: emissive shards hugging the rock
    const lava = M.lava();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + rand();
      const seam = mesh(new THREE.BoxGeometry(3, r * 0.9, 4), lava, { cast: false });
      seam.position.set(Math.cos(a) * r * 0.82, r * 0.5, Math.sin(a) * r * 0.82);
      seam.rotation.set((rand() - 0.5) * 0.8, -a, (rand() - 0.5) * 0.6);
      g.add(seam);
    }
    const pool = mesh(new THREE.CircleGeometry(r * 1.35, 28), lava, { cast: false });
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.6;
    pool.scale.set(1, 0.6, 1);
    g.add(pool);
    g.userData.glow = { y: 20, color: '#ff6a1f', strength: 3.2 };
  } else if (ob.kind === 'pine_tree') {
    const trunk = mesh(new THREE.CylinderGeometry(r * 0.22, r * 0.32, 70, 8), M.bark());
    trunk.position.y = 35;
    g.add(trunk);
    const foliage = new THREE.Group();
    const shades = [0x1f4a2c, 0x285c36, 0x2f6b3e, 0x377a46];
    for (let i = 0; i < 4; i++) {
      const tierR = r * (1.75 - i * 0.33);
      const cone = new THREE.ConeGeometry(tierR, 70 - i * 6, 9, 2);
      const pos = cone.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        if (pos.getY(v) < 0) {
          pos.setX(v, pos.getX(v) * (0.85 + rand() * 0.3));
          pos.setZ(v, pos.getZ(v) * (0.85 + rand() * 0.3));
        }
      }
      cone.computeVertexNormals();
      const tier = mesh(cone, M.pine(shades[i]));
      tier.position.y = 70 + i * 38;
      foliage.add(tier);
    }
    g.add(foliage);
    g.userData.sway = { node: foliage, phase: rand() * TAU };
  } else {
    // ice_crystal cluster
    const ice = M.ice();
    const count = 4 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i++) {
      const h = (i === 0 ? 2.6 : 1.2 + rand() * 1.1) * r;
      const w = (i === 0 ? 0.42 : 0.2 + rand() * 0.14) * r;
      const geo = new THREE.CylinderGeometry(0, w, h, 6, 1);
      geo.translate(0, h / 2, 0);
      const shard = mesh(geo, ice);
      const a = rand() * TAU;
      const off = i === 0 ? 0 : r * (0.35 + rand() * 0.45);
      shard.position.set(Math.cos(a) * off, 0, Math.sin(a) * off);
      shard.rotation.set((rand() - 0.5) * 0.6, rand() * TAU, (rand() - 0.5) * 0.6);
      g.add(shard);
    }
    g.userData.glow = { y: r * 1.2, color: '#7cc8ff', strength: 1.4 };
  }

  // Each obstacle gets its own material copies so it can fade when it hides the player
  g.traverse((o) => {
    if (o.isMesh) {
      o.material = o.material.clone();
      o.material.transparent = true;
      o.userData.baseOpacity = o.material.opacity;
    }
  });
  g.userData.fade = 1;
  return g;
}

// ---------- Shrines & practice dummies ----------
function buildShrine(sh) {
  const g = new THREE.Group();
  g.position.set(sh.x, 0, sh.y);
  const stone = new THREE.MeshStandardMaterial({ color: 0x8c8678, roughness: 0.8 });
  addAt(g, mesh(new THREE.CylinderGeometry(30, 34, 8, 8), stone), 4);
  addAt(g, mesh(new THREE.CylinderGeometry(20, 26, 22, 8), stone), 19);
  const goldRing = mesh(new THREE.TorusGeometry(24, 2, 8, 32), M.gold());
  goldRing.rotation.x = Math.PI / 2;
  goldRing.position.y = 30;
  g.add(goldRing);
  const gemMat = new THREE.MeshStandardMaterial({
    color: 0x2fae5a,
    emissive: 0x3dff84,
    emissiveIntensity: 1.6,
    roughness: 0.15,
    metalness: 0.1,
    flatShading: true,
  });
  const gem = mesh(new THREE.OctahedronGeometry(12, 0), gemMat);
  gem.scale.y = 1.5;
  gem.position.y = 58;
  g.add(gem);
  const halo = makeGlowSprite('#5dff9a', 90, 0.55);
  halo.position.y = 58;
  g.add(halo);
  g.userData = { gem, halo, gemMat };
  return g;
}

function buildDummy(t) {
  const g = new THREE.Group();
  g.position.set(t.x, 0, t.y);
  const wood = M.wood();
  const straw = M.straw();
  const body = new THREE.Group();
  addAt(body, mesh(new THREE.CylinderGeometry(4, 5, 70, 8), wood), 35);
  const torso = mesh(new THREE.CylinderGeometry(15, 13, 34, 10), straw);
  torso.position.y = 48;
  body.add(torso);
  const arm = mesh(new THREE.CylinderGeometry(3, 3, 54, 6), wood);
  arm.rotation.z = Math.PI / 2;
  arm.position.y = 56;
  body.add(arm);
  const head = mesh(new THREE.SphereGeometry(11, 12, 10), straw);
  head.position.y = 76;
  body.add(head);
  const target = mesh(new THREE.TorusGeometry(8, 2.2, 6, 16), new THREE.MeshStandardMaterial({ color: 0xc0392b }));
  target.position.set(0, 50, 15);
  body.add(target);
  g.add(body);
  addAt(g, mesh(new THREE.CylinderGeometry(16, 18, 4, 10), wood), 2);
  const mats = [];
  body.traverse((o) => o.isMesh && mats.push(o.material));
  g.userData = { body, mats, wobble: 0 };
  return g;
}

// ---------- Walls & braziers ----------
function buildWalls(scene) {
  const wallMat = M.wall();
  const trim = M.gold();
  const H = 64;
  const T = 40;
  const segs = [
    [WORLD_HALF, 18, WORLD_SIZE, T],
    [WORLD_HALF, WORLD_SIZE - 18, WORLD_SIZE, T],
    [18, WORLD_HALF, T, WORLD_SIZE],
    [WORLD_SIZE - 18, WORLD_HALF, T, WORLD_SIZE],
  ];
  for (const [x, z, w, d] of segs) {
    const wall = mesh(new THREE.BoxGeometry(w, H, d), wallMat);
    wall.position.set(x, H / 2, z);
    scene.add(wall);
    const cap = mesh(new THREE.BoxGeometry(w + (w > d ? 0 : 6), 5, d + (d > w ? 0 : 6)), trim, { cast: false });
    cap.position.set(x, H + 2.5, z);
    scene.add(cap);
  }
  // Crenellations along the walls (instanced)
  const merlonGeo = new THREE.BoxGeometry(22, 16, 22);
  const count = Math.floor(WORLD_SIZE / 60) * 4;
  const merlons = new THREE.InstancedMesh(merlonGeo, wallMat, count);
  merlons.castShadow = true;
  const m4 = new THREE.Matrix4();
  let i = 0;
  for (let p = 30; p < WORLD_SIZE - 20 && i < count - 3; p += 60) {
    for (const [x, z] of [
      [p, 18],
      [p, WORLD_SIZE - 18],
      [18, p],
      [WORLD_SIZE - 18, p],
    ]) {
      m4.makeTranslation(x, H + 12, z);
      merlons.setMatrixAt(i++, m4);
    }
  }
  merlons.count = i;
  scene.add(merlons);
  // Corner towers
  for (const [x, z] of [
    [18, 18],
    [WORLD_SIZE - 18, 18],
    [18, WORLD_SIZE - 18],
    [WORLD_SIZE - 18, WORLD_SIZE - 18],
  ]) {
    const tower = mesh(new THREE.CylinderGeometry(52, 58, 120, 12), wallMat);
    tower.position.set(x, 60, z);
    scene.add(tower);
    const roof = mesh(new THREE.ConeGeometry(62, 60, 12), new THREE.MeshStandardMaterial({ color: 0x3b2f5c, roughness: 0.6 }));
    roof.position.set(x, 150, z);
    scene.add(roof);
  }
}

function buildBraziers(scene) {
  const list = [];
  const gold = M.gold();
  const stone = new THREE.MeshStandardMaterial({ color: 0x5b554c, roughness: 0.9 });
  const coal = new THREE.MeshStandardMaterial({ color: 0x220a03, emissive: 0xff5a10, emissiveIntensity: 2.5 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + Math.PI / 8;
    const x = WORLD_HALF + Math.cos(a) * (COURTYARD_R - 34);
    const z = WORLD_HALF + Math.sin(a) * (COURTYARD_R - 34);
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    addAt(g, mesh(new THREE.CylinderGeometry(5, 8, 46, 8), stone), 23);
    const bowl = mesh(new THREE.CylinderGeometry(16, 7, 12, 14, 1, true), gold);
    bowl.position.y = 52;
    g.add(bowl);
    const coals = mesh(new THREE.CircleGeometry(14, 14), coal, { cast: false });
    coals.rotation.x = -Math.PI / 2;
    coals.position.y = 55;
    g.add(coals);
    const flame = makeGlowSprite('#ff9a3c', 70, 0.9);
    flame.position.y = 68;
    g.add(flame);
    scene.add(g);
    list.push({ x, z, flame, phase: i * 1.7 });
  }
  return list;
}

// ---------- Instanced decoration ----------
function grassBladeGeometry() {
  // A tuft of 5 thin tapered blades
  const verts = [];
  for (let b = 0; b < 5; b++) {
    const a = (b / 5) * TAU;
    const lean = 0.35;
    const h = 1;
    const w = 0.09;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    const px = -cz * w;
    const pz = cx * w;
    verts.push(px, 0, pz, -px, 0, -pz, cx * lean, h, cz * lean);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  return geo;
}

function windMaterial(base, timeUniform) {
  base.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 wPos = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float sway = sin(uTime * 1.8 + wPos.x * 0.02 + wPos.z * 0.015) * 0.18 + sin(uTime * 3.1 + wPos.x * 0.07) * 0.05;
        transformed.x += sway * position.y;
        transformed.z += sway * 0.6 * position.y;`
      );
  };
  return base;
}

function placeOk(x, z, pad) {
  if (x < 70 || z < 70 || x > WORLD_SIZE - 70 || z > WORLD_SIZE - 70) return false;
  for (const ob of OBSTACLES) if (Math.hypot(ob.x - x, ob.y - z) < ob.r + pad) return false;
  for (const sh of SHRINE_SPOTS) if (Math.hypot(sh.x - x, sh.y - z) < 50 + pad) return false;
  return Math.hypot(x - WORLD_HALF, z - WORLD_HALF) > COURTYARD_R + 10;
}

function buildDecor(scene, timeUniform) {
  const rand = seededRandom(4242);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const col = new THREE.Color();

  // Grass tufts (meadow dense, ruins sparse) with GPU wind sway
  const grassMat = windMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide }), timeUniform);
  const GRASS = 5200;
  const grass = new THREE.InstancedMesh(grassBladeGeometry(), grassMat, GRASS);
  let gi = 0;
  for (let tries = 0; tries < GRASS * 3 && gi < GRASS; tries++) {
    const x = rand() * WORLD_SIZE;
    const z = rand() * WORLD_SIZE;
    const biome = getBiomeAt(x, z);
    if (biome !== 'meadow' && !(biome === 'ruins' && rand() < 0.35)) continue;
    if (!placeOk(x, z, 6)) continue;
    const h = 9 + rand() * 12;
    p.set(x, 0, z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * TAU);
    s.set(h * 0.9, h, h * 0.9);
    grass.setMatrixAt(gi, m4.compose(p, q, s));
    col.setHSL(biome === 'meadow' ? 0.24 + rand() * 0.06 : 0.2 + rand() * 0.05, 0.45 + rand() * 0.2, 0.26 + rand() * 0.14);
    grass.setColorAt(gi, col);
    gi++;
  }
  grass.count = gi;
  grass.receiveShadow = true;
  scene.add(grass);

  // Rocks everywhere, tinted per biome
  const ROCKS = 360;
  const rocks = new THREE.InstancedMesh(
    jaggedRock(1, 1, 5),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }),
    ROCKS
  );
  let ri = 0;
  for (let tries = 0; tries < ROCKS * 4 && ri < ROCKS; tries++) {
    const x = rand() * WORLD_SIZE;
    const z = rand() * WORLD_SIZE;
    if (!placeOk(x, z, 14)) continue;
    const biome = getBiomeAt(x, z);
    const size = 3 + rand() * 9;
    p.set(x, size * 0.25, z);
    q.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3));
    s.set(size, size * (0.5 + rand() * 0.4), size);
    rocks.setMatrixAt(ri, m4.compose(p, q, s));
    const tint = { ruins: 0x7c838c, forge: 0x2d2422, meadow: 0x8a8577, sanctum: 0xc7d6e6, courtyard: 0x9a9080 }[biome];
    rocks.setColorAt(ri, col.set(tint).multiplyScalar(0.8 + rand() * 0.35));
    ri++;
  }
  rocks.count = ri;
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  scene.add(rocks);

  // Meadow flowers
  const FLOWERS = 260;
  const flowers = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }),
    FLOWERS
  );
  let fi = 0;
  // Mid-value petal colors: pure white in full sun crosses the bloom threshold and reads as sparks
  const petals = [0xd9c45a, 0xd27aa2, 0x9fb0d8, 0xd9d2c0, 0xe0844f];
  for (let tries = 0; tries < FLOWERS * 4 && fi < FLOWERS; tries++) {
    const x = rand() * WORLD_HALF;
    const z = WORLD_HALF + rand() * WORLD_HALF;
    if (getBiomeAt(x, z) !== 'meadow' || !placeOk(x, z, 6)) continue;
    const size = 1.4 + rand() * 1.2;
    p.set(x, 5 + rand() * 5, z);
    q.identity();
    s.set(size, size * 0.7, size);
    flowers.setMatrixAt(fi, m4.compose(p, q, s));
    flowers.setColorAt(fi, col.set(petals[Math.floor(rand() * petals.length)]));
    fi++;
  }
  flowers.count = fi;
  scene.add(flowers);

  // Sanctum snow mounds & ice spikes
  const MOUNDS = 110;
  const mounds = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 12, 8, 0, TAU, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xeef4fa, roughness: 0.75 }),
    MOUNDS
  );
  let mi = 0;
  for (let tries = 0; tries < MOUNDS * 5 && mi < MOUNDS; tries++) {
    const x = WORLD_HALF + rand() * WORLD_HALF;
    const z = WORLD_HALF + rand() * WORLD_HALF;
    if (getBiomeAt(x, z) !== 'sanctum' || !placeOk(x, z, 24)) continue;
    const size = 10 + rand() * 22;
    p.set(x, 0, z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * TAU);
    s.set(size * (1 + rand()), size * 0.45, size);
    mounds.setMatrixAt(mi++, m4.compose(p, q, s));
  }
  mounds.count = mi;
  mounds.receiveShadow = true;
  mounds.castShadow = true;
  scene.add(mounds);

  const SPIKES = 140;
  const spikeGeo = new THREE.ConeGeometry(1, 1, 5);
  spikeGeo.translate(0, 0.5, 0);
  const spikes = new THREE.InstancedMesh(spikeGeo, M.ice(), SPIKES);
  let si = 0;
  for (let tries = 0; tries < SPIKES * 5 && si < SPIKES; tries++) {
    const x = WORLD_HALF + rand() * WORLD_HALF;
    const z = WORLD_HALF + rand() * WORLD_HALF;
    if (getBiomeAt(x, z) !== 'sanctum' || !placeOk(x, z, 10)) continue;
    const h = 8 + rand() * 20;
    p.set(x, 0, z);
    q.setFromEuler(new THREE.Euler((rand() - 0.5) * 0.7, rand() * 3, (rand() - 0.5) * 0.7));
    s.set(h * 0.22, h, h * 0.22);
    spikes.setMatrixAt(si++, m4.compose(p, q, s));
  }
  spikes.count = si;
  spikes.castShadow = true;
  scene.add(spikes);

  // Forge obsidian shards
  const SHARDS = 120;
  const shards = new THREE.InstancedMesh(spikeGeo, new THREE.MeshStandardMaterial({ color: 0x15111a, roughness: 0.18, metalness: 0.3, flatShading: true }), SHARDS);
  let oi = 0;
  for (let tries = 0; tries < SHARDS * 5 && oi < SHARDS; tries++) {
    const x = WORLD_HALF + rand() * WORLD_HALF;
    const z = rand() * WORLD_HALF;
    if (getBiomeAt(x, z) !== 'forge' || !placeOk(x, z, 12)) continue;
    const h = 6 + rand() * 18;
    p.set(x, 0, z);
    q.setFromEuler(new THREE.Euler((rand() - 0.5) * 0.9, rand() * 3, (rand() - 0.5) * 0.9));
    s.set(h * 0.3, h, h * 0.3);
    shards.setMatrixAt(oi++, m4.compose(p, q, s));
  }
  shards.count = oi;
  shards.castShadow = true;
  scene.add(shards);

  // Meadow bushes
  const BUSHES = 90;
  const bushes = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }),
    BUSHES
  );
  let bi = 0;
  for (let tries = 0; tries < BUSHES * 5 && bi < BUSHES; tries++) {
    const x = rand() * WORLD_HALF;
    const z = WORLD_HALF + rand() * WORLD_HALF;
    if (getBiomeAt(x, z) !== 'meadow' || !placeOk(x, z, 26)) continue;
    const size = 8 + rand() * 12;
    p.set(x, size * 0.35, z);
    q.setFromEuler(new THREE.Euler(rand() * 0.4, rand() * 3, rand() * 0.4));
    s.set(size * (1.2 + rand() * 0.6), size * (0.55 + rand() * 0.25), size * (1.1 + rand() * 0.5));
    bushes.setMatrixAt(bi, m4.compose(p, q, s));
    bushes.setColorAt(bi, col.setHSL(0.26 + rand() * 0.06, 0.5, 0.1 + rand() * 0.06));
    bi++;
  }
  bushes.count = bi;
  bushes.castShadow = true;
  bushes.receiveShadow = true;
  scene.add(bushes);
}

// ---------- Ambient biome particles (dust, embers, snow, pollen, fireflies) ----------
const AMBIENT_COUNT = 520;
function buildAmbient(scene) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(AMBIENT_COUNT * 3);
  const colors = new Float32Array(AMBIENT_COUNT * 3);
  const sizes = new Float32Array(AMBIENT_COUNT);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: null }, uScale: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float size;
      attribute vec3 color;
      varying vec3 vColor;
      uniform float uScale;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * uScale / -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);
  const state = [];
  for (let i = 0; i < AMBIENT_COUNT; i++) state.push({ x: 0, y: -999, z: 0, vx: 0, vy: 0, vz: 0, life: 0, phase: Math.random() * TAU });
  return { points, geo, mat, state };
}

const AMBIENT_STYLE = {
  forge: { color: [1.0, 0.45, 0.12], size: [2.5, 5], vy: [18, 46], y: [0, 40] },
  sanctum: { color: [0.85, 0.92, 1.0], size: [2.5, 5], vy: [-30, -14], y: [60, 220] },
  meadow: { color: [0.55, 0.62, 0.22], size: [2, 3.5], vy: [-4, 6], y: [8, 60] },
  ruins: { color: [0.35, 0.5, 0.7], size: [2, 3.5], vy: [-3, 6], y: [8, 70] },
  courtyard: { color: [0.7, 0.55, 0.3], size: [2, 3], vy: [2, 10], y: [10, 90] },
};

function respawnMote(m, focusX, focusZ, rand = Math.random) {
  m.x = focusX + (rand() - 0.5) * 1900;
  m.z = focusZ + (rand() - 0.5) * 1500;
  const st = AMBIENT_STYLE[getBiomeAt(m.x, m.z)];
  m.style = st;
  m.y = st.y[0] + rand() * (st.y[1] - st.y[0]);
  m.vy = st.vy[0] + rand() * (st.vy[1] - st.vy[0]);
  m.vx = (rand() - 0.5) * 14;
  m.vz = (rand() - 0.5) * 14;
  m.size = st.size[0] + rand() * (st.size[1] - st.size[0]);
  m.maxLife = m.life = 3 + rand() * 5;
}

// ---------- Public API ----------
export function buildWorld(scene, renderer) {
  const rand = seededRandom(2024);
  const timeUniform = { value: 0 };
  buildTerrain(scene, renderer.capabilities.getMaxAnisotropy());
  buildWalls(scene);
  const braziers = buildBraziers(scene);
  buildDecor(scene, timeUniform);

  const obstacles = OBSTACLES.map((ob) => {
    const g = buildObstacle(ob, rand);
    scene.add(g);
    return { ob, group: g };
  });
  const shrines = new Map(
    SHRINE_SPOTS.map((sh) => {
      const g = buildShrine(sh);
      scene.add(g);
      return [sh.id, { spot: sh, group: g, active: true, glow: 1 }];
    })
  );
  const dummies = new Map(
    PRACTICE_TOTEM_SPOTS.map((t) => {
      const g = buildDummy(t);
      scene.add(g);
      return [t.id, { spot: t, group: g, alive: true, wasHit: false }];
    })
  );
  const ambient = buildAmbient(scene);
  for (const m of ambient.state) respawnMote(m, WORLD_HALF, WORLD_HALF);

  return {
    update(world, nowSec, dt, focusX, focusZ, lights, viewportScale) {
      timeUniform.value = nowSec;

      for (const { group } of obstacles) {
        const sway = group.userData.sway;
        if (sway) sway.node.rotation.z = Math.sin(nowSec * 0.9 + sway.phase) * 0.025;
        const glow = group.userData.glow;
        if (glow) {
          const flicker = 0.85 + Math.sin(nowSec * 7 + group.position.x) * 0.1 + Math.random() * 0.05;
          lights.request(group.position.x, glow.y, group.position.z, glow.color, glow.strength * flicker, 260);
        }
      }

      for (const b of braziers) {
        const f = 0.85 + Math.sin(nowSec * 11 + b.phase) * 0.08 + Math.random() * 0.1;
        b.flame.scale.set(60 * f, 78 * f, 1);
        lights.request(b.x, 70, b.z, '#ff9a3c', 3.2 * f, 300);
      }

      // Shrines follow the server snapshot
      if (world?.shrines) {
        for (const s of world.shrines) {
          const sh = shrines.get(s.id);
          if (sh) sh.active = s.active;
        }
      }
      for (const sh of shrines.values()) {
        sh.glow += ((sh.active ? 1 : 0) - sh.glow) * Math.min(1, dt * 5);
        const { gem, halo, gemMat } = sh.group.userData;
        gem.visible = sh.glow > 0.05;
        gem.position.y = 58 + Math.sin(nowSec * 2.4 + sh.spot.x) * 5;
        gem.rotation.y += dt * 1.4;
        gem.scale.setScalar(sh.glow).y *= 1.5;
        halo.position.y = gem.position.y;
        halo.material.opacity = 0.55 * sh.glow;
        gemMat.emissiveIntensity = 1.2 + Math.sin(nowSec * 4) * 0.4;
        if (sh.glow > 0.1) lights.request(sh.spot.x, 60, sh.spot.y, '#5dff9a', 2.6 * sh.glow, 240);
      }

      // Practice dummies: hide when broken, wobble when struck
      if (world?.totems) {
        for (const t of world.totems) {
          const d = dummies.get(t.id);
          if (!d) continue;
          d.group.visible = t.alive;
          if (t.hit && !d.wasHit) d.group.userData.wobble = 1;
          d.wasHit = t.hit;
          for (const m of d.group.userData.mats) m.emissive?.setScalar(t.hit ? 0.5 : 0);
        }
      }
      for (const d of dummies.values()) {
        const ud = d.group.userData;
        ud.wobble = Math.max(0, ud.wobble - dt * 2.5);
        ud.body.rotation.z = Math.sin(nowSec * 22) * 0.18 * ud.wobble;
      }

      // Ambient motes drift around the camera focus; recycled when they expire or leave the view box
      const pos = ambient.geo.attributes.position.array;
      const col = ambient.geo.attributes.color.array;
      const size = ambient.geo.attributes.size.array;
      ambient.mat.uniforms.uScale.value = viewportScale;
      for (let i = 0; i < AMBIENT_COUNT; i++) {
        const m = ambient.state[i];
        m.life -= dt;
        if (m.life <= 0 || Math.abs(m.x - focusX) > 1000 || Math.abs(m.z - focusZ) > 800) respawnMote(m, focusX, focusZ);
        m.x += (m.vx + Math.sin(nowSec * 0.8 + m.phase) * 8) * dt;
        m.y += m.vy * dt;
        m.z += (m.vz + Math.cos(nowSec * 0.7 + m.phase) * 8) * dt;
        const fade = Math.min(1, m.life / 0.8, (m.maxLife - m.life) / 0.8);
        const twinkle = 0.6 + Math.sin(nowSec * 3 + m.phase * 5) * 0.4;
        pos[i * 3] = m.x;
        pos[i * 3 + 1] = m.y;
        pos[i * 3 + 2] = m.z;
        col[i * 3] = m.style.color[0] * fade * twinkle;
        col[i * 3 + 1] = m.style.color[1] * fade * twinkle;
        col[i * 3 + 2] = m.style.color[2] * fade * twinkle;
        size[i] = m.size;
      }
      ambient.geo.attributes.position.needsUpdate = true;
      ambient.geo.attributes.color.needsUpdate = true;
      ambient.geo.attributes.size.needsUpdate = true;
    },

    // Fade props that stand between the camera and the local hero (camera looks north, from the south)
    updateOcclusion(selfX, selfZ, dt) {
      for (const { ob, group } of obstacles) {
        const inFront = selfX !== null && ob.y > selfZ && ob.y - selfZ < 190 && Math.abs(ob.x - selfX) < ob.r + 46;
        const target = inFront ? 0.28 : 1;
        group.userData.fade += (target - group.userData.fade) * Math.min(1, dt * 8);
        const f = group.userData.fade;
        group.traverse((o) => {
          if (o.isMesh) {
            o.material.opacity = o.userData.baseOpacity * f;
            o.material.depthWrite = f > 0.95;
          }
        });
      }
    },
  };
}
