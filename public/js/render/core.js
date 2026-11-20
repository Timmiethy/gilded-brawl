// Shared 3D helpers. Game space is 2D (x, y) on a 2400×2400 plane; 3D space maps it to the ground
// plane: game x → THREE x, game y → THREE z, and THREE y is height. 1 game unit = 1 THREE unit.
import * as THREE from '/vendor/three/three.module.js';

export { THREE };

export const TAU = Math.PI * 2;

export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export const ease = {
  outCubic: (t) => 1 - (1 - t) ** 3,
  inCubic: (t) => t * t * t,
  outBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
  outElastic: (t) => (t === 0 || t === 1 ? t : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
};

// Seeded PRNG (mulberry32) so procedural world decoration is identical on every client
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Soft radial glow sprite texture (shared by projectiles, motes, lights)
let glowTexture = null;
export function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.28)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glowTexture = new THREE.CanvasTexture(c);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}

export function makeGlowSprite(color, size, opacity = 1) {
  const mat = new THREE.SpriteMaterial({
    map: getGlowTexture(),
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const s = new THREE.Sprite(mat);
  s.scale.set(size, size, 1);
  return s;
}

// Additive, unlit, double-sided material for energy effects (picked up by bloom)
export function energyMaterial(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

// Fresnel "force field" shader: bright at grazing angles, clear in the middle
export function fresnelMaterial(color, { power = 2.2, intensity = 1.4, opacity = 0.9, hex = false } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uPower: { value: power },
      uIntensity: { value: intensity },
      uOpacity: { value: opacity },
      uTime: { value: 0 },
      uHex: { value: hex ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPos = position;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uPower;
      uniform float uIntensity;
      uniform float uOpacity;
      uniform float uTime;
      uniform float uHex;
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vPos;
      void main() {
        float f = pow(1.0 - abs(dot(normalize(vNormal), vView)), uPower);
        float hexLine = 0.0;
        if (uHex > 0.5) {
          vec2 p = vPos.xz * 0.09 + vec2(0.0, vPos.y * 0.09);
          vec2 g = abs(fract(p * vec2(1.0, 1.732) + vec2(uTime * 0.05, 0.0)) - 0.5);
          hexLine = smoothstep(0.42, 0.5, max(g.x, g.y)) * 0.6;
        }
        float a = clamp((f + hexLine) * uIntensity, 0.0, 1.0) * uOpacity;
        gl_FragColor = vec4(uColor * (0.6 + f * 1.6 + hexLine), a);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

// A fixed pool of point lights. The light count must stay constant (three.js recompiles every lit
// shader when it changes), so effects request a light each frame and the pool keeps the brightest
// requests nearest the camera target and dims the rest to zero.
export class LightPool {
  constructor(scene, size) {
    this.lights = [];
    for (let i = 0; i < size; i++) {
      // decay 1 (1/d falloff, cut off at `distance`) reads better at game scale than physical 1/d²
      const l = new THREE.PointLight(0xffffff, 0, 300, 1);
      l.castShadow = false;
      scene.add(l);
      this.lights.push(l);
    }
    this.requests = [];
  }

  request(x, height, z, color, intensity, distance) {
    this.requests.push({ x, height, z, color, intensity, distance });
  }

  commit(focusX, focusZ) {
    const reqs = this.requests;
    for (const r of reqs) r.score = r.intensity / (1 + Math.hypot(r.x - focusX, r.z - focusZ) / 400);
    reqs.sort((a, b) => b.score - a.score);
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const r = reqs[i];
      if (r) {
        l.position.set(r.x, r.height, r.z);
        l.color.set(r.color);
        // Requests use a 0–10 "strength"; ×60 maps it to irradiance ≈ strength at 60 units away
        l.intensity = r.intensity * 60;
        l.distance = r.distance;
      } else {
        l.intensity = 0;
      }
    }
    this.requests = [];
  }
}
