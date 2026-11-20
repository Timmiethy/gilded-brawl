// Procedural 3D hero models (built from primitives), their animation rigs, status visuals, and
// portraits rendered from the same models. Models are designed at a reference radius of 18 and
// scaled to each hero's collision radius.
import { CHARACTERS, CHARACTER_MAP } from '/shared/characters.js';
import { THREE, TAU, ease, clamp01, makeGlowSprite, fresnelMaterial, energyMaterial } from './core.js';

const REF_RADIUS = 18;
// Heroes are drawn larger than their collision circle (like the old 48px sprites on a 16px radius),
// so silhouettes read at gameplay zoom. Collision is unchanged.
const DISPLAY_SCALE = 1.55;

function std(color, o = {}) {
  const Ctor = o.physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const m = new Ctor({
    color: new THREE.Color(color),
    roughness: o.rough ?? 0.6,
    metalness: o.metal ?? 0,
    flatShading: !!o.flat,
    emissive: new THREE.Color(o.emissive ?? 0x000000),
    emissiveIntensity: o.ei ?? 1,
    transparent: !!o.transparent,
    opacity: o.opacity ?? 1,
    side: o.side ?? THREE.FrontSide,
  });
  if (o.physical) {
    m.clearcoat = o.clearcoat ?? 0.8;
    m.clearcoatRoughness = 0.1;
  }
  return m;
}

function part(parent, geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function pivot(parent, x = 0, y = 0, z = 0) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

const sphere = (r, w = 20, h = 14) => new THREE.SphereGeometry(r, w, h);
const cyl = (rt, rb, h, seg = 16) => new THREE.CylinderGeometry(rt, rb, h, seg);

function eyes(parent, y, z, spread, r = 2.2) {
  const black = std(0x0d0b10, { rough: 0.2 });
  const white = std(0xffffff, { emissive: 0xffffff, ei: 0.6 });
  for (const sx of [-1, 1]) {
    part(parent, sphere(r, 12, 10), black, sx * spread, y, z);
    part(parent, sphere(r * 0.35, 8, 6), white, sx * spread + r * 0.3, y + r * 0.35, z + r * 0.8);
  }
}

// ---------- The ten builders. Each returns a rig: named parts the animator drives. ----------
const BUILDERS = {
  tock(body, ch) {
    const brass = std(ch.coat, { metal: 0.85, rough: 0.32 });
    const copper = std(ch.secondary, { metal: 0.8, rough: 0.4 });
    const plate = std(0xf0d28a, { metal: 0.7, rough: 0.3 });
    part(body, sphere(15), brass, 0, 22, 0).scale.set(1, 0.9, 1.15);
    part(body, sphere(10), plate, 0, 20, 8).scale.set(1, 1, 0.6);
    const head = pivot(body, 0, 38, 5);
    part(head, sphere(10), brass);
    const beak = part(head, new THREE.ConeGeometry(3, 10, 10), std(ch.accent, { rough: 0.4 }), 0, -1, 11);
    beak.rotation.x = Math.PI / 2;
    eyes(head, 2, 8, 4.5);
    const wings = [];
    for (const sx of [-1, 1]) {
      const w = pivot(body, sx * 12, 28, 0);
      part(w, sphere(1), copper, sx * 3, -6, -2).scale.set(3, 9, 12);
      wings.push(w);
    }
    for (let i = -1; i <= 1; i++) {
      const f = part(body, new THREE.BoxGeometry(4, 1.2, 16), copper, i * 4, 24, -18);
      f.rotation.set(-0.5, i * 0.35, 0);
    }
    const key = pivot(body, 0, 30, -17);
    part(key, cyl(1.5, 1.5, 8), plate).rotation.x = Math.PI / 2;
    const bow = pivot(key, 0, 0, -6);
    part(bow, new THREE.TorusGeometry(5, 1.5, 8, 18), plate);
    const gear = pivot(body, 0, 21, 14.5);
    const gearMat = std(0xffe082, { metal: 0.9, rough: 0.25, emissive: 0x6b4a00, ei: 0.4 });
    part(gear, cyl(6, 6, 2, 18), gearMat).rotation.x = Math.PI / 2;
    for (let i = 0; i < 8; i++) {
      const t = part(gear, new THREE.BoxGeometry(2.4, 2.4, 2), gearMat, Math.cos((i / 8) * TAU) * 7, Math.sin((i / 8) * TAU) * 7, 0);
      t.rotation.z = (i / 8) * TAU;
    }
    const legs = [];
    const legMat = std(ch.accent, { rough: 0.5 });
    for (const sx of [-1, 1]) {
      const l = pivot(body, sx * 5, 11, 0);
      part(l, cyl(1.3, 1.3, 10, 8), legMat, 0, -5, 0);
      part(l, new THREE.BoxGeometry(4, 1.5, 6), legMat, 0, -10, 2);
      legs.push(l);
    }
    return { head, wings, legs, spin: [{ node: bow, axis: 'z', speed: 3 }, { node: gear, axis: 'z', speed: -1.6 }], height: 50 };
  },

  marrow(body, ch) {
    const pts = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const y = 48 - t * 44;
      const r = Math.sin(Math.min(1, t * 1.35) * Math.PI * 0.5) * 16 + t * 2;
      pts.push(new THREE.Vector2(Math.max(0.01, r), y));
    }
    const sheetGeo = new THREE.LatheGeometry(pts, 32);
    const pos = sheetGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) < 8) {
        const a = Math.atan2(pos.getZ(i), pos.getX(i));
        pos.setY(i, pos.getY(i) + Math.sin(a * 7) * 3);
      }
    }
    sheetGeo.computeVertexNormals();
    const sheetMat = std(ch.coat, { rough: 0.55, emissive: ch.secondary, ei: 0.35, transparent: true, opacity: 0.93, side: THREE.DoubleSide });
    part(body, sheetGeo, sheetMat);
    // Face sits where the sheet's radius is ≈13 (y 30) so the features touch the surface
    const head = pivot(body, 0, 30, 0);
    const dark = std(0x07141a, { rough: 0.3 });
    for (const sx of [-1, 1]) part(head, sphere(1), dark, sx * 5, 0, 12.6).scale.set(2.6, 4, 1.4);
    part(head, sphere(1), dark, 0, -7, 15.2).scale.set(2.2, 1.6, 1);
    const arms = [];
    for (const sx of [-1, 1]) {
      const a = pivot(body, sx * 15, 26, 3);
      part(a, sphere(4.2), sheetMat, sx * 2, -2, 0);
      arms.push(a);
    }
    const lantern = pivot(arms[1], 6, -4, 6);
    const iron = std(0x2b2b2b, { metal: 0.8, rough: 0.4 });
    part(lantern, new THREE.TorusGeometry(2.5, 0.6, 6, 12, Math.PI), iron, 0, 2, 0);
    for (const [x, z] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) part(lantern, new THREE.BoxGeometry(0.8, 9, 0.8), iron, x, -4, z);
    part(lantern, new THREE.BoxGeometry(7.5, 1.2, 7.5), iron, 0, 0.5, 0);
    part(lantern, new THREE.BoxGeometry(7.5, 1.2, 7.5), iron, 0, -8.5, 0);
    const flame = part(lantern, sphere(2.6, 12, 10), std(ch.accent, { emissive: ch.accent, ei: 4 }), 0, -4, 0);
    flame.castShadow = false;
    const halo = makeGlowSprite(ch.accent, 34, 0.75);
    halo.position.set(0, -4, 0);
    lantern.add(halo);
    return { head, arms, float: true, swing: lantern, lamp: { node: flame, color: ch.accent, strength: 2.6 }, height: 50 };
  },

  prickle(body, ch) {
    const green = std(ch.coat, { rough: 0.7 });
    const trunkGeo = cyl(11, 12, 34, 20);
    const pos = trunkGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const a = Math.atan2(pos.getZ(i), pos.getX(i));
      const ridge = 1 + Math.cos(a * 10) * 0.09;
      pos.setX(i, pos.getX(i) * ridge);
      pos.setZ(i, pos.getZ(i) * ridge);
    }
    trunkGeo.computeVertexNormals();
    part(body, trunkGeo, green, 0, 22, 0);
    part(body, new THREE.SphereGeometry(11.5, 20, 10, 0, TAU, 0, Math.PI / 2), green, 0, 39, 0);
    const spineMat = std(0xfff3c4, { rough: 0.5 });
    for (let i = 0; i < 46; i++) {
      const a = (i * 2.399) % TAU;
      const y = 10 + ((i * 7.3) % 34);
      const sp = part(body, new THREE.ConeGeometry(0.5, 3.4, 4), spineMat, Math.cos(a) * 12, y, Math.sin(a) * 12);
      sp.lookAt(new THREE.Vector3(Math.cos(a) * 40, y, Math.sin(a) * 40));
      sp.rotateX(Math.PI / 2);
      sp.castShadow = false;
    }
    const arms = [];
    for (const sx of [-1, 1]) {
      const a = pivot(body, sx * 11, 26, 0);
      part(a, cyl(3.6, 3.6, 10, 10), green, sx * 5, 0, 0).rotation.z = Math.PI / 2;
      part(a, cyl(3.6, 3.6, 11, 10), green, sx * 9.5, 5, 0);
      part(a, sphere(3.6, 10, 8), green, sx * 9.5, 10.5, 0);
      arms.push(a);
    }
    part(arms[1], new THREE.BoxGeometry(2.2, 3.5, 8), std(0x5d6670, { metal: 0.9, rough: 0.3 }), 9.5, 3, 5);
    const head = pivot(body, 0, 40, 0);
    eyes(head, 0, 10.6, 4);
    part(head, new THREE.BoxGeometry(8, 1.6, 1.4), std(0x3e2723), 0, -4, 11);
    const leather = std(ch.secondary, { rough: 0.75 });
    part(head, cyl(18, 18, 1.5, 28), leather, 0, 9, 0);
    part(head, new THREE.TorusGeometry(17.5, 1.4, 8, 28), leather, 0, 9.5, 0).rotation.x = Math.PI / 2;
    part(head, cyl(8, 9.5, 10, 20), leather, 0, 15, 0);
    part(head, cyl(9.6, 9.6, 2, 20), std(ch.accent), 0, 11.5, 0);
    part(body, new THREE.TorusGeometry(10.5, 2, 8, 20), std(ch.accent, { rough: 0.8 }), 0, 33, 0).rotation.x = Math.PI / 2;
    const legs = [];
    for (const sx of [-1, 1]) {
      const l = pivot(body, sx * 5, 7, 0);
      part(l, cyl(3, 3.4, 7, 10), leather, 0, -3.5, 0);
      part(l, new THREE.BoxGeometry(6, 2, 8), leather, 0, -7, 1.5);
      legs.push(l);
    }
    return { head, arms, legs, height: 64 };
  },

  fold(body, ch) {
    const paper = std(ch.coat, { rough: 0.85, flat: true, side: THREE.DoubleSide });
    const red = std(ch.secondary, { rough: 0.6, flat: true });
    part(body, new THREE.OctahedronGeometry(13, 0), paper, 0, 26, 0).scale.set(1, 0.85, 1.5);
    const neck = part(body, cyl(1.5, 3, 16, 4), paper, 0, 38, 9);
    neck.rotation.x = 0.5;
    const head = pivot(body, 0, 46, 13);
    part(head, new THREE.TetrahedronGeometry(5.5, 0), paper);
    const beak = part(head, new THREE.ConeGeometry(1.6, 11, 4), std(0x263238, { flat: true }), 0, 0, 8);
    beak.rotation.x = Math.PI / 2;
    eyes(head, 1.5, 2.5, 2.6, 1.3);
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, 0);
    wingShape.lineTo(24, 7);
    wingShape.lineTo(9, 18);
    wingShape.lineTo(0, 9);
    wingShape.closePath();
    const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.6, bevelEnabled: false });
    const wings = [];
    for (const sx of [-1, 1]) {
      const w = pivot(body, sx * 5, 30, -2);
      const wm = part(w, wingGeo, paper);
      wm.rotation.set(-Math.PI / 2, 0, sx > 0 ? 0 : Math.PI);
      wm.scale.set(1, 1, sx);
      wings.push(w);
    }
    const tail = part(body, new THREE.ConeGeometry(5, 16, 3), paper, 0, 28, -18);
    tail.rotation.x = -1.9;
    part(body, new THREE.TorusGeometry(10.5, 1.7, 6, 20), red, 0, 24, 0).rotation.x = Math.PI / 2;
    const sword = pivot(body, 0, 30, -8);
    sword.rotation.set(0.4, 0, 0.9);
    part(sword, new THREE.BoxGeometry(1.2, 32, 2.6), std(0xdfe6ec, { metal: 1, rough: 0.18 }), 0, 8, 0);
    part(sword, new THREE.BoxGeometry(6, 1.2, 3), std(0xd4a24c, { metal: 1, rough: 0.3 }), 0, -8, 0);
    part(sword, cyl(1.3, 1.3, 7, 6), red, 0, -12, 0);
    const legs = [];
    const legMat = std(0x263238);
    for (const sx of [-1, 1]) {
      const l = pivot(body, sx * 4, 16, 0);
      part(l, cyl(0.9, 0.9, 15, 6), legMat, 0, -7.5, 0);
      part(l, new THREE.BoxGeometry(3, 0.8, 5), legMat, 0, -15, 1.5);
      legs.push(l);
    }
    return { head, wings, legs, height: 56 };
  },

  nell(body, ch) {
    const bellMat = std(ch.coat, { physical: true, rough: 0.18, emissive: ch.secondary, ei: 0.55, transparent: true, opacity: 0.78, side: THREE.DoubleSide });
    const bell = pivot(body, 0, 30, 0);
    part(bell, new THREE.SphereGeometry(16, 32, 16, 0, TAU, 0, Math.PI / 2), bellMat).scale.y = 0.9;
    const core = part(bell, sphere(7), std(ch.accent, { emissive: ch.accent, ei: 2.2 }), 0, 4, 0);
    core.castShadow = false;
    part(bell, new THREE.TorusGeometry(15.6, 2, 8, 32), std(ch.secondary, { emissive: ch.secondary, ei: 0.5, rough: 0.4 }), 0, 0, 0).rotation.x = Math.PI / 2;
    const head = pivot(bell, 0, 6, 14.2);
    eyes(head, 0, 0, 5, 2);
    const star = pivot(bell, 0, 20, 0);
    part(star, new THREE.OctahedronGeometry(3.6, 0), std(0xffd740, { emissive: 0xffd740, ei: 2.5, metal: 0.3 }));
    const tentacles = [];
    const tMat = std(ch.secondary, { emissive: ch.accent, ei: 0.35, rough: 0.4 });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      let node = pivot(bell, Math.cos(a) * 10, -1, Math.sin(a) * 10);
      const chain = [];
      for (let sgm = 0; sgm < 4; sgm++) {
        const seg = pivot(node, 0, sgm === 0 ? 0 : -6, 0);
        part(seg, cyl(1.3 - sgm * 0.22, 1.1 - sgm * 0.22, 6, 6), tMat, 0, -3, 0);
        chain.push(seg);
        node = seg;
      }
      tentacles.push({ chain, phase: i * 0.9 });
    }
    return { head, float: true, hover: 10, tentacles, spin: [{ node: star, axis: 'y', speed: 2 }], lamp: { node: core, color: ch.accent, strength: 1.6 }, height: 58 };
  },

  bronte(body, ch) {
    const cloud = std(ch.coat, { rough: 1 });
    const under = std(ch.secondary, { rough: 1 });
    const puffs = pivot(body, 0, 0, 0);
    for (const [x, y, z, r, m] of [
      [0, 36, 0, 14, cloud], [-12, 32, 2, 10, cloud], [12, 32, 2, 10, cloud], [-6, 43, -4, 10, cloud],
      [7, 44, -3, 11, cloud], [0, 30, 8, 10, cloud], [-9, 26, -2, 9, under], [9, 26, -2, 9, under], [0, 25, 3, 10, under],
    ]) part(puffs, sphere(r, 16, 12), m, x, y, z);
    // The front-lower puff (0,30,8) r10 reaches z≈16.7 at y 35: the face sits on it
    const head = pivot(body, 0, 35, 16.4);
    eyes(head, 0, 0, 5, 2.1);
    const brow = std(0x37474f);
    for (const sx of [-1, 1]) part(head, new THREE.BoxGeometry(5, 1.2, 1), brow, sx * 5, 3.6, 0.6).rotation.z = sx * 0.4;
    const bolt = new THREE.Shape();
    bolt.moveTo(0, 0);
    bolt.lineTo(3, 0);
    bolt.lineTo(1, -6);
    bolt.lineTo(4, -6);
    bolt.lineTo(-1.5, -16);
    bolt.lineTo(0, -8);
    bolt.lineTo(-2.5, -8);
    bolt.closePath();
    const boltGeo = new THREE.ExtrudeGeometry(bolt, { depth: 1.5, bevelEnabled: false });
    const boltMat = std(ch.accent, { emissive: ch.accent, ei: 3.2 });
    const flicker = [];
    for (const sx of [-1, 1]) {
      const b = part(body, boltGeo, boltMat, sx * 5, 22, 2);
      b.castShadow = false;
      flicker.push(b);
    }
    const rain = [];
    const rainMat = std(0x90caf9, { emissive: 0x2962ff, ei: 0.6, transparent: true, opacity: 0.8 });
    for (let i = 0; i < 6; i++) {
      const d = part(body, sphere(0.8, 6, 5), rainMat, (Math.random() - 0.5) * 22, 20, (Math.random() - 0.5) * 14);
      d.scale.y = 3;
      d.castShadow = false;
      rain.push({ node: d, phase: Math.random() });
    }
    return { head, float: true, hover: 12, flicker, rain, bob: puffs, height: 58 };
  },

  steep(body, ch) {
    const porcelain = std(ch.coat, { physical: true, rough: 0.22, clearcoat: 1 });
    const gold = std(ch.accent, { metal: 1, rough: 0.3 });
    const steel = std(ch.secondary, { metal: 0.9, rough: 0.3 });
    part(body, cyl(22, 20, 2.4, 32), porcelain, 0, 1.2, 0);
    part(body, new THREE.TorusGeometry(21.5, 0.9, 6, 36), gold, 0, 2.2, 0).rotation.x = Math.PI / 2;
    const prof = [[0.01, 4], [10, 4], [14, 8], [17, 17], [18.2, 28], [17.6, 30]].map(([x, y]) => new THREE.Vector2(x, y));
    part(body, new THREE.LatheGeometry(prof, 36), std(ch.coat, { physical: true, rough: 0.22, side: THREE.DoubleSide }));
    part(body, new THREE.TorusGeometry(17.9, 1, 6, 36), std(0xf48fb1, { rough: 0.4 }), 0, 21, 0).rotation.x = Math.PI / 2;
    part(body, new THREE.TorusGeometry(17.7, 0.9, 6, 36), gold, 0, 30, 0).rotation.x = Math.PI / 2;
    const handle = part(body, new THREE.TorusGeometry(6, 1.8, 8, 16, Math.PI * 1.2), porcelain, -18.5, 19, 0);
    handle.rotation.set(0, 0, Math.PI * 0.4);
    const tea = part(body, new THREE.CircleGeometry(16.8, 28), std(0x6d3f22, { rough: 0.1, physical: true }), 0, 27.5, 0);
    tea.rotation.x = -Math.PI / 2;
    const head = pivot(body, 0, 34, 0);
    part(head, cyl(9, 9.5, 11, 20), steel, 0, 0, 0);
    part(head, new THREE.SphereGeometry(9, 20, 10, 0, TAU, 0, Math.PI / 2), steel, 0, 5.5, 0);
    part(head, new THREE.BoxGeometry(12, 1.8, 2), std(0x111111), 0, 1, 8.6);
    const plume = pivot(head, 0, 14, -2);
    const plumeMat = std(0xf06292, { rough: 0.8 });
    for (let i = 0; i < 3; i++) part(plume, sphere(3.2 - i * 0.6, 10, 8), plumeMat, 0, i * 3, -i * 3.5).scale.set(0.8, 1.4, 1.3);
    const arms = [];
    for (const sx of [-1, 1]) {
      const a = pivot(body, sx * 12, 30, 4);
      part(a, cyl(1.8, 1.8, 10, 8), steel, sx * 3, -3, 0).rotation.z = sx * 0.9;
      arms.push(a);
    }
    part(arms[0], new THREE.BoxGeometry(9, 9, 3), std(0xffffff, { rough: 0.95, flat: true }), -8, -6, 5);
    const spoon = pivot(arms[1], 8, -5, 4);
    spoon.rotation.x = Math.PI / 2.4;
    part(spoon, cyl(0.8, 0.8, 24, 6), std(0xdfe6ec, { metal: 1, rough: 0.15 }), 0, 8, 0);
    part(spoon, sphere(1), std(0xdfe6ec, { metal: 1, rough: 0.15 }), 0, 21, 0).scale.set(3, 4.5, 1.2);
    return { head, arms, slide: true, steam: { y: 31 }, height: 58 };
  },

  morel(body, ch) {
    const cream = std(ch.coat, { rough: 0.8 });
    const robe = std(ch.secondary, { rough: 0.9 });
    part(body, cyl(9, 11, 24, 16), cream, 0, 16, 0);
    part(body, new THREE.ConeGeometry(15, 20, 16, 1, true), robe, 0, 12, 0);
    const head = pivot(body, 0, 28, 0);
    eyes(head, 0, 9.8, 4);
    const cap = pivot(body, 0, 32, 0);
    const capMat = std(ch.accent, { rough: 0.45, physical: true, clearcoat: 0.6 });
    part(cap, new THREE.SphereGeometry(18, 28, 14, 0, TAU, 0, Math.PI / 2), capMat).scale.y = 0.62;
    part(cap, new THREE.ConeGeometry(17.5, 4, 28, 1, true), std(0xe8d5b0, { rough: 0.9, side: THREE.DoubleSide }), 0, -1.5, 0).rotation.x = Math.PI;
    const spot = std(0xffffff, { rough: 0.7 });
    for (let i = 0; i < 9; i++) {
      const a = i * 2.1;
      const el = 0.35 + (i % 3) * 0.32;
      const s = part(cap, sphere(2.6, 10, 6), spot, Math.cos(a) * Math.cos(el) * 17.6, Math.sin(el) * 11, Math.sin(a) * Math.cos(el) * 17.6);
      s.scale.set(1, 0.4, 1);
      s.lookAt(new THREE.Vector3(s.position.x * 3, s.position.y * 3, s.position.z * 3));
    }
    const arms = [];
    for (const sx of [-1, 1]) {
      const a = pivot(body, sx * 10, 20, 2);
      part(a, cyl(2, 2, 9, 8), robe, sx * 2.5, -3, 2).rotation.z = sx * 0.6;
      arms.push(a);
    }
    const flask = pivot(arms[1], 5, -8, 6);
    const glass = part(flask, sphere(4.6, 16, 12), std(0x69f0ae, { physical: true, rough: 0.05, emissive: 0x00e676, ei: 1.2, transparent: true, opacity: 0.8 }));
    glass.castShadow = false;
    part(flask, cyl(1.5, 1.5, 4, 8), std(0xb2dfdb, { physical: true, transparent: true, opacity: 0.6 }), 0, 5.5, 0);
    part(flask, cyl(1.7, 1.4, 2, 8), std(0x8d6e63), 0, 8, 0);
    const legs = [];
    for (const sx of [-1, 1]) {
      const l = pivot(body, sx * 5, 5, 0);
      part(l, cyl(2.6, 3, 6, 8), cream, 0, -2.5, 0);
      legs.push(l);
    }
    return { head, arms, legs, cap, lamp: { node: glass, color: '#69f0ae', strength: 1.2 }, height: 50 };
  },

  vendetta(body, ch) {
    const paint = std(ch.secondary, { metal: 0.45, rough: 0.42 });
    const trim = std(0xcfd8dc, { metal: 0.9, rough: 0.3 });
    part(body, new THREE.BoxGeometry(32, 44, 22), paint, 0, 28, 0);
    part(body, new THREE.BoxGeometry(33, 3, 23), trim, 0, 51, 0);
    const glass = part(body, new THREE.BoxGeometry(21, 30, 1), std(0xb3e5fc, { physical: true, rough: 0.05, transparent: true, opacity: 0.28, emissive: 0x80d8ff, ei: 0.25 }), -4, 28, 11.2);
    glass.castShadow = false;
    part(body, new THREE.BoxGeometry(21, 30, 0.5), std(0x0b2233, { emissive: 0x4fc3f7, ei: 0.22 }), -4, 28, 9.5);
    const snackColors = [0xff7043, 0xffd54f, 0x66bb6a, 0xef5350, 0xab47bc, 0x29b6f6];
    for (let row = 0; row < 3; row++) {
      part(body, new THREE.BoxGeometry(20, 0.8, 4), trim, -4, 17 + row * 10, 9.8);
      for (let c = 0; c < 4; c++) {
        const col = snackColors[(row * 4 + c) % snackColors.length];
        const geo = (row + c) % 2 ? cyl(1.6, 1.6, 6, 10) : new THREE.BoxGeometry(3.5, 6, 2);
        part(body, geo, std(col, { rough: 0.4, emissive: col, ei: 0.25 }), -11 + c * 4.8, 21 + row * 10, 9.6);
      }
    }
    part(body, new THREE.BoxGeometry(24, 7, 1), std(0x050a0f), 0, 46, 11.2);
    const eyeMat = std(0x18ffff, { emissive: 0x18ffff, ei: 3 });
    const head = pivot(body, 0, 46, 11.8);
    for (const sx of [-1, 1]) part(head, new THREE.BoxGeometry(5, 2.5, 0.6), eyeMat, sx * 6, 0, 0).castShadow = false;
    for (let i = 0; i < 4; i++) part(body, cyl(1.3, 1.3, 1, 10), std(snackColors[i], { emissive: snackColors[i], ei: 0.8 }), 11.5, 36 - i * 4, 11.2).rotation.x = Math.PI / 2;
    part(body, new THREE.BoxGeometry(3, 6, 1), std(ch.accent === '#ff7043' ? 0xffd54f : ch.accent, { metal: 1, rough: 0.25 }), 11.5, 17, 11.3);
    const arms = [];
    for (const sx of [-1, 1]) {
      const a = pivot(body, sx * 18, 40, 0);
      part(a, new THREE.BoxGeometry(6, 20, 7), paint, 0, -9, 0);
      part(a, new THREE.BoxGeometry(7, 5, 8), trim, 0, -20, 0);
      arms.push(a);
    }
    const legs = [];
    for (const sx of [-1, 1]) {
      const l = pivot(body, sx * 9, 7, 0);
      part(l, new THREE.BoxGeometry(9, 8, 12), trim, 0, -3, 0);
      legs.push(l);
    }
    return { head, arms, legs, heavy: true, height: 56 };
  },

  beacon(body, ch) {
    const stone = std(ch.secondary, { rough: 0.95, flat: true });
    part(body, new THREE.DodecahedronGeometry(15, 0), stone, 0, 4, 0).scale.set(1.1, 0.45, 1.1);
    const white = std(ch.coat, { rough: 0.6 });
    const red = std(ch.accent, { rough: 0.55 });
    part(body, cyl(8, 12, 34, 20), white, 0, 24, 0);
    part(body, cyl(11.1, 11.6, 5, 20), red, 0, 14, 0);
    part(body, cyl(9.3, 9.9, 5, 20), red, 0, 29, 0);
    part(body, new THREE.BoxGeometry(6, 9, 2), std(0x3e2723), 0, 11, 11.2);
    const head = pivot(body, 0, 25, 9.4);
    eyes(head, 0, 0, 3.6, 1.8);
    part(body, cyl(11, 11, 1.6, 20), std(0x263238, { metal: 0.6, rough: 0.4 }), 0, 42, 0);
    part(body, new THREE.TorusGeometry(10.8, 0.5, 6, 24), std(0x263238, { metal: 0.6 }), 0, 45, 0).rotation.x = Math.PI / 2;
    const glass = part(body, cyl(7, 7, 8, 16), std(0xfffde7, { physical: true, rough: 0.05, transparent: true, opacity: 0.35 }), 0, 47.5, 0);
    glass.castShadow = false;
    const lampCore = part(body, sphere(4, 14, 10), std(ch.color, { emissive: ch.color, ei: 4 }), 0, 47.5, 0);
    lampCore.castShadow = false;
    const halo = makeGlowSprite(ch.color, 40, 0.8);
    halo.position.set(0, 47.5, 0);
    body.add(halo);
    part(body, new THREE.ConeGeometry(9.5, 7, 16), red, 0, 55, 0);
    part(body, sphere(1.8, 10, 8), std(0xd4a24c, { metal: 1, rough: 0.3 }), 0, 59.5, 0);
    const beam = pivot(body, 0, 47.5, 0);
    const beamGeo = new THREE.ConeGeometry(14, 80, 24, 1, true);
    beamGeo.translate(0, -40, 0);
    const beamMesh = new THREE.Mesh(beamGeo, energyMaterial(ch.color, 0.07));
    beamMesh.rotation.x = Math.PI / 2 - 0.3; // sweeps outward, angled down toward the ground
    beam.add(beamMesh);
    return { head, slide: true, lamp: { node: lampCore, color: ch.color, strength: 3.4 }, spin: [{ node: beam, axis: 'y', speed: 1.4 }], height: 62 };
  },
};

// ---------- Shared status visuals ----------
let silenceTexture = null;
function getSilenceTexture() {
  if (silenceTexture) return silenceTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = '#e040fb';
  g.lineWidth = 7;
  g.beginPath();
  g.arc(32, 32, 22, 0, TAU);
  g.moveTo(16, 16);
  g.lineTo(48, 48);
  g.stroke();
  silenceTexture = new THREE.CanvasTexture(c);
  silenceTexture.colorSpace = THREE.SRGBColorSpace;
  return silenceTexture;
}

let blobTexture = null;
function getBlobShadowTexture() {
  if (blobTexture) return blobTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  blobTexture = new THREE.CanvasTexture(c);
  return blobTexture;
}

function groundRing(radius, width, color, opacity) {
  const m = new THREE.Mesh(new THREE.RingGeometry(radius - width, radius, 48), energyMaterial(color, opacity));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 1.2;
  return m;
}

function buildCrown() {
  const g = new THREE.Group();
  const gold = std(0xffd54f, { metal: 1, rough: 0.25, emissive: 0x7a5200, ei: 0.6 });
  const band = new THREE.Mesh(cyl(6, 6, 3, 16, true), gold);
  g.add(band);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(1.6, 5, 6), gold);
    spike.position.set(Math.cos(a) * 6, 3.5, Math.sin(a) * 6);
    g.add(spike);
    const gem = new THREE.Mesh(sphere(0.9, 8, 6), std(0xff1744, { emissive: 0xff1744, ei: 1.5 }));
    gem.position.set(Math.cos(a) * 6.2, 0.4, Math.sin(a) * 6.2);
    g.add(gem);
  }
  return g;
}

// ---------- Hero instance ----------
export class HeroModel {
  constructor(charId, { portrait = false } = {}) {
    const ch = CHARACTER_MAP[charId] || CHARACTERS[0];
    this.charId = ch.id;
    this.ch = ch;
    this.scale = (ch.radius / REF_RADIUS) * (portrait ? 1 : DISPLAY_SCALE);

    this.root = new THREE.Group(); // world position (never rotates)
    this.yaw = new THREE.Group(); // facing
    this.body = new THREE.Group(); // squash / stretch / bob / tumble
    this.root.add(this.yaw);
    this.yaw.add(this.body);
    this.body.scale.setScalar(this.scale);
    this.rig = BUILDERS[ch.id](this.body, ch);
    this.height = this.rig.height * this.scale;

    // Own material copies so flash / stealth / death fades never leak to other players
    this.materials = [];
    this.body.traverse((o) => {
      if (!o.isMesh && !o.isSprite) return;
      o.material = o.material.clone();
      const m = o.material;
      m.userData.baseOpacity = m.opacity;
      m.userData.baseTransparent = m.transparent;
      if (m.emissive) {
        m.userData.baseEmissive = m.emissive.clone();
        m.userData.baseEI = m.emissiveIntensity;
      }
      this.materials.push(m);
    });

    if (!portrait) this.buildStatus();

    this.walkPhase = Math.random() * TAU;
    this.faceYaw = 0;
    this.atkT = 1;
    this.hitT = 1;
    this.deathT = 0;
    this.spawnT = 1;
    this.wasAlive = true;
    this.wasAtk = false;
    this.wasHit = false;
    this.fade = 1;
  }

  buildStatus() {
    const r = this.ch.radius;
    this.status = new THREE.Group();
    this.root.add(this.status);

    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(r * 3.2, r * 3.2),
      new THREE.MeshBasicMaterial({ map: getBlobShadowTexture(), transparent: true, depthWrite: false })
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.8;
    this.status.add(blob);
    this.blob = blob;

    this.shield = new THREE.Mesh(new THREE.SphereGeometry(r * 1.7, 28, 18), fresnelMaterial('#ffe082', { power: 2.4, intensity: 1.3, hex: true }));
    this.shield.position.y = this.height * 0.5;
    this.status.add(this.shield);

    this.slowRing = groundRing(r * 1.55, 3, '#64b5f6', 0.75);
    this.status.add(this.slowRing);
    this.hasteRing = groundRing(r * 1.4, 2, '#ffab40', 0.7);
    this.status.add(this.hasteRing);

    this.silence = new THREE.Sprite(new THREE.SpriteMaterial({ map: getSilenceTexture(), transparent: true, depthWrite: false }));
    this.silence.scale.set(16, 16, 1);
    this.silence.position.y = this.height + 30;
    this.status.add(this.silence);

    this.crown = buildCrown();
    this.crown.position.y = this.height + 14;
    this.status.add(this.crown);

    this.orbit = new THREE.Group();
    this.orbit.position.y = this.height * 0.45;
    this.status.add(this.orbit);
    this.orbs = [];
  }

  attachSelfMarkers() {
    const r = this.ch.radius;
    this.selfRing = groundRing(r * 1.7, 2.5, '#ffe082', 0.85);
    this.status.add(this.selfRing);
    const chev = new THREE.Shape();
    chev.moveTo(0, 7);
    chev.lineTo(-5, -3);
    chev.lineTo(0, 0);
    chev.lineTo(5, -3);
    chev.closePath();
    const arrow = new THREE.Mesh(new THREE.ShapeGeometry(chev), energyMaterial('#fff59d', 0.95));
    arrow.rotation.x = -Math.PI / 2;
    this.arrowPivot = new THREE.Group();
    arrow.position.set(0, 1.5, 0);
    arrow.rotation.z = 0;
    const holder = new THREE.Group();
    holder.position.z = r * 2.2;
    holder.add(arrow);
    arrow.rotation.set(-Math.PI / 2, 0, Math.PI);
    this.arrowPivot.add(holder);
    this.status.add(this.arrowPivot);
  }

  setOrbs(count, color) {
    if (this.orbs.length === count && this.orbColor === color) return;
    for (const o of this.orbs) this.orbit.remove(o);
    this.orbs = [];
    this.orbColor = color;
    for (let i = 0; i < count; i++) {
      const g = new THREE.Group();
      const core = new THREE.Mesh(sphere(5, 14, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.5), toneMapped: false }));
      g.add(core);
      g.add(makeGlowSprite(color, 34, 0.9));
      this.orbit.add(g);
      this.orbs.push(g);
    }
  }

  setOpacity(f, stealthy) {
    for (const m of this.materials) {
      const base = m.userData.baseOpacity;
      const fading = f < 0.999 || stealthy;
      m.transparent = fading || m.userData.baseTransparent;
      m.opacity = base * f;
      m.depthWrite = !fading;
    }
  }

  setFlash(f, tint = null) {
    for (const m of this.materials) {
      if (!m.userData.baseEmissive) continue;
      if (f <= 0 && !tint) {
        m.emissive.copy(m.userData.baseEmissive);
        m.emissiveIntensity = m.userData.baseEI;
      } else {
        m.emissive.copy(m.userData.baseEmissive).lerp(tint || WHITE, Math.min(1, f));
        m.emissiveIntensity = Math.max(m.userData.baseEI, f * 1.4);
      }
    }
  }

  // p: interpolated player state from main.js; returns true while the model should be visible
  update(p, dt, t, { isSelf = false, isLeader = false } = {}) {
    const rig = this.rig;
    this.root.position.set(p.x, 0, p.y);

    // Life transitions → death tumble / spawn pop
    if (this.wasAlive && !p.alive) this.deathT = 0.0001;
    if (!this.wasAlive && p.alive) this.spawnT = 0;
    this.wasAlive = p.alive;
    if (!p.alive) {
      this.deathT = Math.min(1, this.deathT + dt / 0.9);
    }
    this.spawnT = Math.min(1, this.spawnT + dt / 0.55);

    // Rising edges of attack / hit flags
    if (p.atk && !this.wasAtk) this.atkT = 0;
    if (p.hit && !this.wasHit) this.hitT = 0;
    this.wasAtk = p.atk;
    this.wasHit = p.hit;
    this.atkT = Math.min(1, this.atkT + dt / 0.26);
    this.hitT = Math.min(1, this.hitT + dt / 0.22);

    // Facing: smooth shortest-arc turn toward aim
    const targetYaw = Math.atan2(Math.cos(p.aim), Math.sin(p.aim));
    let d = targetYaw - this.faceYaw;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    this.faceYaw += d * Math.min(1, dt * 16);
    this.yaw.rotation.y = this.faceYaw;

    // Body: breathe / walk / hover, attack squash-stretch, hit recoil
    const moving = p.moving && p.alive;
    this.walkPhase += dt * (moving ? (rig.heavy ? 8 : 11) : 2);
    const breathe = Math.sin(t * 2.2 + this.walkPhase * 0.1) * 0.025;
    const atk = this.atkT < 1 ? Math.sin(this.atkT * Math.PI) : 0;
    const hit = this.hitT < 1 ? 1 - ease.outCubic(this.hitT) : 0;
    let bodyY = 0;
    if (rig.float) {
      bodyY = (rig.hover || 8) + Math.sin(t * 2.6 + this.walkPhase * 0.2) * 3;
    } else if (rig.slide) {
      bodyY = moving ? Math.abs(Math.sin(this.walkPhase * 0.9)) * 3 : 0;
    } else if (moving) {
      bodyY = Math.abs(Math.sin(this.walkPhase)) * (rig.heavy ? 2 : 3.2);
    }
    const sq = 1 + breathe - atk * 0.12 + (moving ? Math.sin(this.walkPhase * 2) * 0.03 : 0);
    const st = 1 - breathe * 0.5 + atk * 0.08;
    const spawn = this.spawnT < 1 ? Math.max(0.001, ease.outBack(this.spawnT)) : 1;
    this.body.scale.set(this.scale * st * spawn, this.scale * sq * spawn, this.scale * st * spawn);
    this.body.position.set(0, bodyY, atk * 7);
    this.body.rotation.set((moving ? 0.1 : 0) - hit * 0.35 + atk * 0.12, 0, rig.slide && moving ? Math.sin(this.walkPhase * 0.9) * 0.08 : 0);

    // Death: topple backwards, sink, fade
    if (this.deathT > 0 && !p.alive) {
      const k = ease.outCubic(this.deathT);
      this.body.rotation.x = -k * 1.5;
      this.body.position.y = -k * 6;
      this.body.scale.multiplyScalar(1 - k * 0.3);
    }

    // Limbs
    const swing = moving ? Math.sin(this.walkPhase) : 0;
    if (rig.legs) rig.legs.forEach((l, i) => (l.rotation.x = swing * 0.75 * (i ? -1 : 1)));
    if (rig.arms) {
      rig.arms.forEach((a, i) => {
        a.rotation.x = -swing * 0.5 * (i ? -1 : 1) - (i === 1 ? atk * 1.6 : 0);
      });
    }
    if (rig.wings) {
      const flap = moving ? Math.sin(t * 18) * 0.5 : Math.sin(t * 3) * 0.12;
      rig.wings.forEach((w, i) => (w.rotation.z = (i ? 1 : -1) * (flap + atk * 0.6)));
    }
    if (rig.spin) for (const s of rig.spin) s.node.rotation[s.axis] += dt * s.speed;
    if (rig.swing) rig.swing.rotation.z = Math.sin(t * 3.2) * 0.35 + (moving ? Math.sin(this.walkPhase) * 0.2 : 0);
    if (rig.tentacles) {
      for (const tn of rig.tentacles) {
        tn.chain.forEach((seg, i) => {
          seg.rotation.x = Math.sin(t * 3 + tn.phase + i * 0.7) * 0.28 + (moving ? 0.35 : 0);
          seg.rotation.z = Math.cos(t * 2.4 + tn.phase + i * 0.9) * 0.2;
        });
      }
    }
    if (rig.flicker) for (const b of rig.flicker) b.visible = Math.random() > 0.12;
    if (rig.rain) {
      for (const r of rig.rain) {
        r.phase = (r.phase + dt * 1.6) % 1;
        r.node.position.y = 20 - r.phase * 20;
        r.node.material.opacity = 0.8 * (1 - r.phase);
      }
    }
    if (rig.cap) rig.cap.rotation.z = Math.sin(t * 2) * 0.04 + (moving ? Math.sin(this.walkPhase) * 0.06 : 0);
    if (rig.bob) rig.bob.position.y = Math.sin(t * 1.7) * 1.2;

    // Flash on hit (white), tint while silenced (violet)
    const silenced = p.silenced && p.alive;
    this.setFlash(Math.max(hit, silenced ? 0.22 : 0), hit < 0.05 && silenced ? VIOLET : null);

    // Opacity: stealth (self only sees self), death fade
    const deathFade = !p.alive ? 1 - clamp01((this.deathT - 0.35) / 0.65) : 1;
    const stealthFade = p.stealth ? 0.3 + Math.sin(t * 9) * 0.06 : 1;
    const f = Math.min(deathFade, stealthFade);
    if (Math.abs(f - this.fade) > 0.001 || p.stealth) this.setOpacity(f, p.stealth);
    this.fade = f;

    if (this.status) {
      const alive = p.alive;
      this.blob.visible = alive;
      this.blob.material.opacity = rig.float ? 0.6 : 1;
      this.shield.visible = alive && p.shield > 0;
      if (this.shield.visible) {
        this.shield.material.uniforms.uTime.value = t;
        this.shield.scale.setScalar(1 + Math.sin(t * 5) * 0.025);
      }
      this.slowRing.visible = alive && p.slow;
      this.hasteRing.visible = alive && p.haste;
      if (this.hasteRing.visible) this.hasteRing.scale.setScalar(1 + ((t * 2.5) % 1) * 0.5);
      this.silence.visible = alive && p.silenced;
      if (this.silence.visible) this.silence.position.y = this.height + 30 + Math.sin(t * 6) * 2;
      this.crown.visible = alive && isLeader;
      if (this.crown.visible) {
        this.crown.rotation.y += dt * 1.5;
        this.crown.position.y = this.height + 14 + Math.sin(t * 2.5) * 2;
      }
      const hasOrbit = alive && p.orbit !== null && p.orbit !== undefined;
      this.orbit.visible = hasOrbit;
      if (hasOrbit) {
        this.setOrbs(p.orbitN || 2, p.orbitC || '#ffffff');
        const R = p.orbitR || 100;
        this.orbs.forEach((o, i) => {
          const a = p.orbit + (i / this.orbs.length) * TAU;
          o.position.set(Math.cos(a) * R, Math.sin(t * 6 + i) * 4, Math.sin(a) * R);
        });
      }
      if (isSelf) {
        if (!this.selfRing) this.attachSelfMarkers();
        this.selfRing.visible = alive;
        this.arrowPivot.visible = alive;
        this.arrowPivot.rotation.y = Math.atan2(Math.cos(p.aim), Math.sin(p.aim));
      }
    }

    return p.alive || this.deathT < 1;
  }

  // World-space position of the hero's light source (lantern, lamp, flask), or null
  lampWorld(target) {
    if (!this.rig.lamp) return null;
    return this.rig.lamp.node.getWorldPosition(target);
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.isMesh) o.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
  }
}

const WHITE = new THREE.Color(0xffffff);
const VIOLET = new THREE.Color(0xb040ff);

// ---------- Portraits (rendered once from the same 3D models) ----------
const portraits = new Map();

function renderAllPortraits() {
  const SIZE = 160;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return;
  }
  renderer.setSize(SIZE, SIZE, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a2a1a, 1.4));
  const key = new THREE.DirectionalLight(0xfff0d6, 3.2);
  key.position.set(40, 80, 90);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9ab8ff, 2.2);
  rim.position.set(-60, 40, -80);
  scene.add(rim);
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 1000);
  for (const ch of CHARACTERS) {
    const hero = new HeroModel(ch.id, { portrait: true });
    hero.yaw.rotation.y = 0.45;
    hero.body.position.y = hero.rig.float ? 4 : 0;
    scene.add(hero.root);
    const h = hero.height;
    camera.position.set(0, h * 0.62, h * 2.3 + 30);
    camera.lookAt(0, h * 0.5, 0);
    renderer.render(scene, camera);
    portraits.set(ch.id, canvas.toDataURL('image/png'));
    scene.remove(hero.root);
    hero.dispose();
  }
  renderer.dispose();
  renderer.forceContextLoss();
}

export function getHeroPortrait(charId) {
  if (portraits.size === 0) renderAllPortraits();
  return portraits.get(charId) || portraits.get(CHARACTERS[0].id) || '';
}
