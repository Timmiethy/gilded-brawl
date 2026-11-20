// 3D arena renderer (three.js / WebGL): golden-hour lighting with soft shadows, image-based
// reflections, bloom, procedural world, animated heroes, effects, overlay text and minimap.
import { WORLD_HALF, getBiomeAt } from '/shared/map.js';
import { EffectComposer } from '/vendor/three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '/vendor/three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '/vendor/three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '/vendor/three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from '/vendor/three/addons/environments/RoomEnvironment.js';
import { THREE, LightPool, energyMaterial } from './core.js';
import { buildWorld } from './world.js';
import { HeroModel } from './heroes.js';
import { FxSystem } from './fx.js';
import { Overlay } from './overlay.js';
import { drawMinimap } from './minimap.js';

const FOV = 38;
const PITCH = (54 * Math.PI) / 180; // camera elevation above the ground
const SUN_OFFSET = new THREE.Vector3(-430, 780, -320);
const SHADOW_HALF = 760; // half-size of the shadow camera box around the focus
const SHADOW_MAP = 2048;

const DUST = { ruins: '#8a8f96', forge: '#3b302c', meadow: '#7c6b4c', sanctum: '#e8f0f8', courtyard: '#b5a68a' };

export class ArenaRenderer {
  constructor(canvas, minimapCanvas) {
    this.canvas = canvas;
    this.minimap = minimapCanvas;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFShadowMap;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.05;
    gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl = gl;

    const scene = new THREE.Scene();
    const haze = new THREE.Color(0x9fa9b8);
    scene.background = haze;
    scene.fog = new THREE.Fog(haze, 1500, 3400);
    this.scene = scene;

    // Image-based lighting gives metal, glass and porcelain believable reflections
    const pmrem = new THREE.PMREMGenerator(gl);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.32;
    pmrem.dispose();

    scene.add(new THREE.HemisphereLight(0xc8dcff, 0x5a4630, 1.15));
    const sun = new THREE.DirectionalLight(0xffdcae, 3.1);
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    Object.assign(sun.shadow.camera, { left: -SHADOW_HALF, right: SHADOW_HALF, top: SHADOW_HALF, bottom: -SHADOW_HALF, near: 10, far: 2600 });
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.6;
    sun.shadow.radius = 3;
    scene.add(sun, sun.target);
    this.sun = sun;

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 10, 6000);
    this.camX = WORLD_HALF;
    this.camZ = WORLD_HALF;
    this.lights = new LightPool(scene, 10);
    this.world = buildWorld(scene, gl);
    this.fx = new FxSystem(scene, this.lights, { reducedMotion: this.reducedMotion });
    this.heroes = new Map();
    this.selfId = null;
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.tmp = new THREE.Vector3();

    // Aim reticle on the ground
    this.reticle = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(9, 12, 40), energyMaterial('#ffe082', 0.9));
    const dot = new THREE.Mesh(new THREE.CircleGeometry(2.5, 16), energyMaterial('#ffffff', 1));
    for (const m of [ring, dot]) {
      m.rotation.x = -Math.PI / 2;
      m.position.y = 1.5;
      this.reticle.add(m);
    }
    scene.add(this.reticle);

    this.composer = new EffectComposer(gl);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.62, 0.55, 0.86);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.className = 'overlay-canvas';
    overlayCanvas.setAttribute('aria-hidden', 'true');
    canvas.insertAdjacentElement('afterend', overlayCanvas);
    this.overlay = new Overlay(overlayCanvas);

    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.width = w;
    this.height = h;
    this.gl.setPixelRatio(dpr);
    this.gl.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Distance so the visible ground depth ≈ 0.95 × the viewport height (close enough to read heroes,
    // far enough to see a skill's range)
    this.camDist = (h * 0.95 * Math.sin(PITCH)) / (2 * Math.tan((FOV * Math.PI) / 360));
    this.camDist = Math.min(1400, Math.max(620, this.camDist));
    this.overlay.resize(w, h, dpr);
  }

  // Pointer → ground point under the cursor (aiming is on the ground plane)
  screenToWorld(sx, sy) {
    const ndc = new THREE.Vector2((sx / this.width) * 2 - 1, -(sy / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, this.tmp);
    return hit ? { x: hit.x, y: hit.z } : { x: this.camX, y: this.camZ };
  }

  pushEventFx(evt) {
    this.fx.event(evt, { selfId: this.selfId });
  }

  pointScale() {
    // Points are sized in world units: pixels per world unit at distance 1
    return (this.gl.domElement.height || this.height) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
  }

  render(world, selfId, renderPlayers, renderProjectiles, nowSec, dt, aimWorld) {
    this.selfId = selfId;
    const me = selfId ? renderPlayers.get(selfId) : null;
    const t = nowSec;

    // Camera: frame-rate independent follow, shake, and a short zoom "punch" on big hits
    const tx = me ? me.x : WORLD_HALF;
    const tz = me ? me.y : WORLD_HALF;
    const a = 1 - Math.exp(-9 * Math.min(0.05, dt || 0.016));
    this.camX += (tx - this.camX) * a;
    this.camZ += (tz - this.camZ) * a;
    const shake = this.fx.shake;
    const sx = shake ? (Math.random() - 0.5) * shake : 0;
    const sz = shake ? (Math.random() - 0.5) * shake : 0;
    const dist = this.camDist * (1 - this.fx.punch * 0.035);
    this.camera.position.set(this.camX + sx, Math.sin(PITCH) * dist, this.camZ + Math.cos(PITCH) * dist + sz);
    this.camera.lookAt(this.camX + sx, 12, this.camZ + sz);

    // Sun follows the focus; snapping to shadow texels stops shadow edges from shimmering
    const texel = (SHADOW_HALF * 2) / SHADOW_MAP;
    const fx0 = Math.round(this.camX / texel) * texel;
    const fz0 = Math.round(this.camZ / texel) * texel;
    this.sun.target.position.set(fx0, 0, fz0);
    this.sun.position.set(fx0 + SUN_OFFSET.x, SUN_OFFSET.y, fz0 + SUN_OFFSET.z);

    // Heroes
    const leaders = new Set(world?.leaderIds || []);
    for (const p of renderPlayers.values()) {
      let hero = this.heroes.get(p.id);
      if (!hero || hero.charId !== p.charId) {
        if (hero) {
          this.scene.remove(hero.root);
          hero.dispose();
        }
        hero = new HeroModel(p.charId);
        if (!p.alive) hero.deathT = 1;
        this.heroes.set(p.id, hero);
        this.scene.add(hero.root);
      }
      const visible = hero.update(p, dt, t, { isSelf: p.id === selfId, isLeader: leaders.has(p.id) });
      hero.root.visible = visible;
      if (!visible || !p.alive) continue;
      const lamp = hero.lampWorld(this.tmp);
      if (lamp) this.lights.request(lamp.x, lamp.y, lamp.z, hero.rig.lamp.color, hero.rig.lamp.strength, 220);
      // Footstep dust and haste streaks
      if (p.moving && !hero.rig.float && Math.random() < dt * 9) {
        this.fx.smoke.spawn(p.x + (Math.random() - 0.5) * 14, 2, p.y + (Math.random() - 0.5) * 10, 0, 10, 0, this.tmpColor(DUST[getBiomeAt(p.x, p.y)]), 12, 0.6, { gravity: -4, grow: 1.2, alpha: 0.35 });
      }
      if (p.haste && p.moving && Math.random() < dt * 30) {
        this.fx.glow.spawn(p.x + (Math.random() - 0.5) * 20, 10 + Math.random() * 30, p.y + (Math.random() - 0.5) * 20, 0, 0, 0, this.tmpColor('#ffcc80'), 5, 0.35, { gravity: 0 });
      }
      if (p.trail && Math.random() < dt * 6) {
        this.fx.smoke.spawn(p.x, 34, p.y, (Math.random() - 0.5) * 10, 30, (Math.random() - 0.5) * 10, this.tmpColor('#dfe6ea'), 10, 0.8, { gravity: -6, grow: 1, alpha: 0.25 });
      }
    }
    for (const [id, hero] of this.heroes) {
      if (!renderPlayers.has(id)) {
        this.scene.remove(hero.root);
        hero.dispose();
        this.heroes.delete(id);
      }
    }

    // Aim reticle
    this.reticle.visible = !!(me && me.alive && aimWorld);
    if (this.reticle.visible) {
      this.reticle.position.set(aimWorld.x, 0, aimWorld.y);
      this.reticle.rotation.y = t * 1.5;
      this.reticle.scale.setScalar(1 + Math.sin(t * 6) * 0.06);
    }

    this.world.update(world, t, dt, this.camX, this.camZ, this.lights, this.pointScale());
    this.world.updateOcclusion(me && me.alive ? me.x : null, me ? me.y : 0, dt);
    this.fx.syncProjectiles(renderProjectiles, t, dt);
    this.fx.syncZones(world?.zones, t, dt);
    this.fx.syncBlasts(world?.blasts, renderPlayers, t, dt);
    this.fx.update(dt, t, this.pointScale());
    for (const txt of this.fx.textQueue) this.overlay.addText(txt);
    this.fx.textQueue.length = 0;

    this.lights.commit(this.camX, this.camZ);
    this.composer.render(dt);
    this.overlay.draw(this.camera, renderPlayers, this.heroes, selfId, dt);
    drawMinimap(this.minimap, world, selfId, renderPlayers);
  }

  tmpColor(hex) {
    return (this._c ??= new THREE.Color()).set(hex);
  }
}
