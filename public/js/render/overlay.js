// 2D overlay drawn above the WebGL view: nameplates, HP/shield bars, and pop-up combat text.
// Text stays crisp at any zoom, and costs one canvas instead of a DOM node per player.
import { THREE, ease } from './core.js';

const v3 = new THREE.Vector3();

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.texts = [];
    this.width = 1;
    this.height = 1;
  }

  resize(w, h, dpr) {
    this.width = w;
    this.height = h;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  project(camera, x, y, z) {
    v3.set(x, y, z).project(camera);
    if (v3.z > 1) return null;
    return { sx: (v3.x * 0.5 + 0.5) * this.width, sy: (-v3.y * 0.5 + 0.5) * this.height };
  }

  addText(t) {
    this.texts.push({ ...t, life: 0, max: t.ko ? 1.2 : 0.9, dx: (Math.random() - 0.5) * 18 });
  }

  draw(camera, players, heroes, selfId, dt) {
    const g = this.ctx;
    g.clearRect(0, 0, this.width, this.height);
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';

    for (const p of players.values()) {
      const hero = heroes.get(p.id);
      if (!p.alive || !hero) continue;
      const pt = this.project(camera, p.x, hero.height + 16, p.y);
      if (!pt || pt.sx < -80 || pt.sx > this.width + 80 || pt.sy < -40 || pt.sy > this.height + 40) continue;
      const isSelf = p.id === selfId;
      const alpha = p.stealth ? 0.55 : 1;
      g.globalAlpha = alpha;
      const w = 58;
      const x0 = pt.sx - w / 2;
      const y0 = pt.sy;
      g.fillStyle = 'rgba(8, 10, 16, 0.82)';
      g.fillRect(x0 - 2, y0 - 2, w + 4, 9);
      const ratio = Math.max(0, Math.min(1, p.hp / p.maxHp));
      const grad = g.createLinearGradient(x0, 0, x0 + w, 0);
      if (isSelf) {
        grad.addColorStop(0, '#2e7d32');
        grad.addColorStop(1, '#9ccc65');
      } else {
        grad.addColorStop(0, '#b71c1c');
        grad.addColorStop(1, '#ff7043');
      }
      g.fillStyle = grad;
      g.fillRect(x0, y0, w * ratio, 5);
      if (p.shield > 0) {
        g.fillStyle = '#ffe082';
        g.fillRect(x0, y0 - 1, w * Math.min(1, p.shield / p.maxHp), 2);
      }
      g.font = '700 12px Marcellus, Georgia, serif';
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(5, 6, 10, 0.9)';
      g.strokeText(p.name, pt.sx, y0 - 6);
      g.fillStyle = isSelf ? '#fff59d' : '#f5f5f5';
      g.fillText(p.name, pt.sx, y0 - 6);
    }
    g.globalAlpha = 1;

    // Pop-up numbers: overshoot pop (easeOutBack), rise, fade
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.life += dt;
      const k = t.life / t.max;
      if (k >= 1) {
        this.texts.splice(i, 1);
        continue;
      }
      const pt = this.project(camera, t.x, t.y + k * (t.ko ? 50 : 34), t.z);
      if (!pt) continue;
      const pop = ease.outBack(Math.min(1, k * 4));
      const size = (t.ko ? 30 : t.big ? 21 : 15) * pop;
      g.globalAlpha = Math.min(1, (1 - k) * 2.5);
      g.font = `900 ${size}px Cinzel, Georgia, serif`;
      g.lineWidth = t.ko ? 5 : 3.5;
      g.strokeStyle = 'rgba(5, 6, 10, 0.95)';
      g.strokeText(t.text, pt.sx + t.dx, pt.sy);
      g.fillStyle = t.color;
      g.fillText(t.text, pt.sx + t.dx, pt.sy);
    }
    g.globalAlpha = 1;
  }
}
