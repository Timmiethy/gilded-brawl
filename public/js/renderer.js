// 60 FPS 2.5D Gilded Pixel Arena Canvas Renderer + Minimap
import { WORLD_SIZE, WORLD_HALF, OBSTACLES } from '/shared/map.js';
import { CHARACTER_MAP } from '/shared/characters.js';
import { getHeroSprites } from './sprites.js';

export class ArenaRenderer {
  constructor(canvas, minimapCanvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.minimap = minimapCanvas;
    this.mctx = minimapCanvas.getContext('2d');

    this.camX = WORLD_HALF;
    this.camY = WORLD_HALF;
    this.shake = 0;

    // Transient visual effects
    this.particles = [];
    this.floatTexts = [];
    this.slashes = [];
    this.novas = [];
    this.beams = [];
    this.lightnings = [];
    this.dashes = [];

    this.tilePattern = null;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
  }

  screenToWorld(sx, sy) {
    return {
      x: this.camX - this.width / 2 + sx,
      y: this.camY - this.height / 2 + sy,
    };
  }

  addShake(amount) {
    this.shake = Math.min(18, Math.max(this.shake, amount));
  }

  spawnParticles(x, y, color, count = 10, speed = 130) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.35 + Math.random() * 0.85) * speed;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        size: 2 + Math.random() * 4,
        color,
        life: 0.25 + Math.random() * 0.35,
        maxLife: 0.6,
      });
    }
  }

  addFloatText(x, y, text, color = '#fff59d', big = false) {
    this.floatTexts.push({
      x: x + (Math.random() - 0.5) * 14,
      y,
      vy: -58,
      text,
      color,
      big,
      life: 0.85,
      maxLife: 0.85,
    });
  }

  pushEventFx(evt) {
    switch (evt.type) {
      case 'hit':
        this.addFloatText(evt.x, evt.y, `-${evt.dmg}`, evt.color || '#ff8a80', evt.dmg >= 24);
        this.spawnParticles(evt.x, evt.y + 12, evt.color || '#ff8a80', 7, 130);
        if (evt.dmg >= 22) this.addShake(7);
        break;
      case 'heal':
        this.addFloatText(evt.x, evt.y, `+${evt.amount}`, '#81c784', false);
        this.spawnParticles(evt.x, evt.y + 12, '#81c784', 8, 90);
        break;
      case 'slash':
        this.slashes.push({
          x: evt.x,
          y: evt.y,
          angle: evt.angle,
          range: evt.range,
          arc: evt.arc,
          color: evt.color,
          heavy: !!evt.heavy,
          life: evt.heavy ? 0.3 : 0.24,
          maxLife: evt.heavy ? 0.3 : 0.24,
        });
        this.spawnParticles(
          evt.x + Math.cos(evt.angle) * evt.range * 0.65,
          evt.y + Math.sin(evt.angle) * evt.range * 0.65,
          evt.color,
          evt.heavy ? 16 : 7,
          evt.heavy ? 180 : 110
        );
        if (evt.heavy) this.addShake(9);
        break;
      case 'nova':
      case 'blast':
        this.novas.push({
          x: evt.x,
          y: evt.y,
          r: evt.r,
          color: evt.color,
          life: 0.42,
          maxLife: 0.42,
        });
        this.spawnParticles(evt.x, evt.y, evt.color, 20, 200);
        this.addShake(8);
        break;
      case 'dash':
        this.dashes.push({
          x1: evt.x1,
          y1: evt.y1,
          x2: evt.x2,
          y2: evt.y2,
          color: evt.color,
          life: 0.34,
          maxLife: 0.34,
        });
        this.novas.push({
          x: evt.x2,
          y: evt.y2,
          r: 44,
          color: evt.color,
          life: 0.26,
          maxLife: 0.26,
        });
        this.spawnParticles(evt.x2, evt.y2, evt.color, 12, 140);
        break;
      case 'beam':
        this.beams.push({
          x1: evt.x1,
          y1: evt.y1,
          x2: evt.x2,
          y2: evt.y2,
          width: evt.width,
          color: evt.color,
          life: 0.42,
          maxLife: 0.42,
        });
        this.spawnParticles(evt.x2, evt.y2, evt.color, 16, 170);
        this.addShake(10);
        break;
      case 'lightning':
        this.lightnings.push({
          segments: evt.segments,
          color: evt.color,
          life: 0.34,
          maxLife: 0.34,
        });
        for (const seg of evt.segments) {
          this.spawnParticles(seg.x2, seg.y2, evt.color, 8, 130);
        }
        this.addShake(6);
        break;
      case 'ko':
        this.spawnParticles(evt.x, evt.y, evt.color || '#ffd54f', 24, 220);
        this.addFloatText(evt.x, evt.y - 24, 'KO!', '#ffd54f', true);
        this.addShake(10);
        break;
      case 'shrine':
        this.novas.push({ x: evt.x, y: evt.y, r: 58, color: '#81c784', life: 0.4, maxLife: 0.4 });
        break;
    }
  }

  updateFx(dt) {
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 28);

    this.particles = this.particles.filter((p) => {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;
      return p.life > 0;
    });
    this.floatTexts = this.floatTexts.filter((f) => {
      f.life -= dt;
      f.y += f.vy * dt;
      f.vy *= 0.92;
      return f.life > 0;
    });
    for (const arrName of ['slashes', 'novas', 'beams', 'lightnings', 'dashes']) {
      this[arrName] = this[arrName].filter((item) => {
        item.life -= dt;
        return item.life > 0;
      });
    }
  }

  render(world, selfId, renderPlayers, renderProjectiles, nowSec, dt, aimWorld) {
    const ctx = this.ctx;
    const me = renderPlayers.get(selfId);

    // Frame-rate independent smooth camera follow (silky on 60Hz & 120Hz ProMotion)
    const targetCamX = me ? me.x : WORLD_HALF;
    const targetCamY = me ? me.y : WORLD_HALF;
    const camAlpha = 1 - Math.exp(-11 * Math.min(0.05, dt || 0.016));
    this.camX += (targetCamX - this.camX) * camAlpha;
    this.camY += (targetCamY - this.camY) * camAlpha;

    const shakeX = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
    const shakeY = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;

    ctx.fillStyle = '#090b12';
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.save();
    ctx.translate(
      this.width / 2 - this.camX + shakeX,
      this.height / 2 - this.camY + shakeY
    );

    this.drawGround(ctx, nowSec);
    this.drawZonesAndTelegraphs(ctx, world, nowSec);
    this.drawDashes(ctx);

    // Y-sorted 2.5D entities (obstacles, shrines, totems, players)
    const drawList = [];

    for (const ob of OBSTACLES) {
      if (this.inView(ob.x, ob.y, 120)) {
        drawList.push({ y: ob.y, draw: () => this.drawObstacle(ctx, ob, nowSec) });
      }
    }

    if (world?.shrines) {
      for (const sh of world.shrines) {
        if (this.inView(sh.x, sh.y, 90)) {
          drawList.push({ y: sh.y, draw: () => this.drawShrine(ctx, sh, nowSec) });
        }
      }
    }

    if (world?.totems) {
      for (const t of world.totems) {
        if (t.alive && this.inView(t.x, t.y, 90)) {
          drawList.push({ y: t.y, draw: () => this.drawTotem(ctx, t) });
        }
      }
    }

    for (const p of renderPlayers.values()) {
      if (!p.alive) continue;
      if (this.inView(p.x, p.y, 120)) {
        drawList.push({
          y: p.y,
          draw: () => this.drawPlayer(ctx, p, p.id === selfId, p.id === world?.leaderId, nowSec),
        });
      }
    }

    drawList.sort((a, b) => a.y - b.y);
    for (const item of drawList) item.draw();

    // Projectiles & VFX on top
    this.drawProjectiles(ctx, renderProjectiles);
    this.drawSlashes(ctx);
    this.drawNovas(ctx);
    this.drawBeams(ctx);
    this.drawLightnings(ctx);
    this.drawParticles(ctx);
    this.drawFloatTexts(ctx);

    // Aim reticle for self
    if (me && me.alive && aimWorld) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 224, 130, 0.65)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(aimWorld.x, aimWorld.y, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(aimWorld.x - 15, aimWorld.y);
      ctx.lineTo(aimWorld.x - 6, aimWorld.y);
      ctx.moveTo(aimWorld.x + 6, aimWorld.y);
      ctx.lineTo(aimWorld.x + 15, aimWorld.y);
      ctx.moveTo(aimWorld.x, aimWorld.y - 15);
      ctx.lineTo(aimWorld.x, aimWorld.y - 6);
      ctx.moveTo(aimWorld.x, aimWorld.y + 6);
      ctx.lineTo(aimWorld.x, aimWorld.y + 15);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();

    this.drawMinimap(world, selfId, renderPlayers);
  }

  inView(x, y, pad = 100) {
    return (
      Math.abs(x - this.camX) <= this.width / 2 + pad &&
      Math.abs(y - this.camY) <= this.height / 2 + pad
    );
  }

  drawGround(ctx, nowSec) {
    // 4 Open-World Biome Quadrants
    // NW: Moonlit Ruins
    ctx.fillStyle = '#151926';
    ctx.fillRect(0, 0, WORLD_HALF, WORLD_HALF);
    // NE: Ember Forge
    ctx.fillStyle = '#201518';
    ctx.fillRect(WORLD_HALF, 0, WORLD_HALF, WORLD_HALF);
    // SW: Whispering Meadow
    ctx.fillStyle = '#132019';
    ctx.fillRect(0, WORLD_HALF, WORLD_HALF, WORLD_HALF);
    // SE: Frost Sanctum
    ctx.fillStyle = '#131d29';
    ctx.fillRect(WORLD_HALF, WORLD_HALF, WORLD_HALF, WORLD_HALF);

    // Subtle cobblestone / pixel tile grid in visible viewport only
    const tile = 64;
    const minX = Math.max(0, Math.floor((this.camX - this.width / 2) / tile) * tile);
    const maxX = Math.min(WORLD_SIZE, Math.ceil((this.camX + this.width / 2) / tile) * tile);
    const minY = Math.max(0, Math.floor((this.camY - this.height / 2) / tile) * tile);
    const maxY = Math.min(WORLD_SIZE, Math.ceil((this.camY + this.height / 2) / tile) * tile);

    ctx.strokeStyle = 'rgba(255, 224, 130, 0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = minX; x <= maxX; x += tile) {
      ctx.moveTo(x, minY);
      ctx.lineTo(x, maxY);
    }
    for (let y = minY; y <= maxY; y += tile) {
      ctx.moveTo(minX, y);
      ctx.lineTo(maxX, y);
    }
    ctx.stroke();

    // Decorative biome flecks (deterministic hash so zero flicker)
    for (let x = minX; x < maxX; x += tile) {
      for (let y = minY; y < maxY; y += tile) {
        const h = ((x * 73856093) ^ (y * 19349663)) & 255;
        if (h < 32) {
          const bx = x + (h % 48) + 8;
          const by = y + ((h * 7) % 48) + 8;
          if (x < WORLD_HALF && y < WORLD_HALF) ctx.fillStyle = 'rgba(186, 104, 200, 0.12)';
          else if (x >= WORLD_HALF && y < WORLD_HALF) ctx.fillStyle = 'rgba(255, 112, 67, 0.14)';
          else if (x < WORLD_HALF && y >= WORLD_HALF) ctx.fillStyle = 'rgba(129, 199, 132, 0.13)';
          else ctx.fillStyle = 'rgba(100, 181, 246, 0.13)';
          ctx.fillRect(bx, by, 6, 4);
        }
      }
    }

    // Central Gilded Courtyard Plaza
    ctx.save();
    ctx.beginPath();
    ctx.arc(WORLD_HALF, WORLD_HALF, 420, 0, Math.PI * 2);
    ctx.fillStyle = '#1b1d28';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(216, 178, 90, 0.45)';
    ctx.stroke();

    // Inner gilded compass ring
    ctx.beginPath();
    ctx.arc(WORLD_HALF, WORLD_HALF, 230, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 224, 130, 0.25)';
    ctx.stroke();

    // Subtle pulsing center sigil
    const pulse = 0.14 + Math.sin(nowSec * 2) * 0.04;
    ctx.beginPath();
    ctx.arc(WORLD_HALF, WORLD_HALF, 72, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 224, 130, ${pulse})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // World gilded border wall
    ctx.strokeStyle = '#d8b25a';
    ctx.lineWidth = 6;
    ctx.strokeRect(36, 36, WORLD_SIZE - 72, WORLD_SIZE - 72);
    ctx.strokeStyle = 'rgba(255, 224, 130, 0.25)';
    ctx.lineWidth = 2;
    ctx.strokeRect(46, 46, WORLD_SIZE - 92, WORLD_SIZE - 92);
  }

  drawObstacle(ctx, ob, nowSec) {
    // 2.5D soft oval shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.beginPath();
    ctx.ellipse(ob.x, ob.y + ob.r * 0.55, ob.r * 1.15, ob.r * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();

    if (ob.kind === 'gilded_pillar' || ob.kind === 'ruin_pillar') {
      const h = ob.kind === 'gilded_pillar' ? 54 : 44;
      const isGold = ob.kind === 'gilded_pillar';
      ctx.fillStyle = isGold ? '#2b2f3f' : '#252a3a';
      ctx.fillRect(ob.x - ob.r * 0.78, ob.y - h, ob.r * 1.56, h + ob.r * 0.35);
      ctx.fillStyle = isGold ? '#d8b25a' : '#4a556e';
      ctx.fillRect(ob.x - ob.r * 0.9, ob.y - h - 8, ob.r * 1.8, 10);
      ctx.fillRect(ob.x - ob.r * 0.88, ob.y + ob.r * 0.2, ob.r * 1.76, 8);
      ctx.strokeStyle = '#0e1017';
      ctx.lineWidth = 2;
      ctx.strokeRect(ob.x - ob.r * 0.78, ob.y - h, ob.r * 1.56, h + ob.r * 0.35);
    } else if (ob.kind === 'pine_tree') {
      // Trunk
      ctx.fillStyle = '#4e342e';
      ctx.fillRect(ob.x - 8, ob.y - 16, 16, 26);
      // 3 stacked pixel pine tiers
      const colors = ['#1b4332', '#2d6a4f', '#40916c'];
      for (let i = 0; i < 3; i++) {
        const w = ob.r * (1.2 - i * 0.25);
        const topY = ob.y - 36 - i * 20;
        ctx.fillStyle = colors[i];
        ctx.beginPath();
        ctx.moveTo(ob.x, topY - 22);
        ctx.lineTo(ob.x - w, topY + 18);
        ctx.lineTo(ob.x + w, topY + 18);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#0d1b14';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    } else if (ob.kind === 'forge_rock') {
      ctx.fillStyle = '#2d1c1e';
      ctx.beginPath();
      ctx.arc(ob.x, ob.y - 8, ob.r * 0.92, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#120a0b';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      // Glowing ember fissure
      const glow = 0.55 + Math.sin(nowSec * 3 + ob.x) * 0.25;
      ctx.strokeStyle = `rgba(255, 112, 67, ${glow})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(ob.x - ob.r * 0.4, ob.y - 16);
      ctx.lineTo(ob.x, ob.y - 6);
      ctx.lineTo(ob.x + ob.r * 0.35, ob.y - 14);
      ctx.stroke();
    } else {
      // Ice crystal monolith
      ctx.fillStyle = '#3b6d96';
      ctx.beginPath();
      ctx.moveTo(ob.x, ob.y - ob.r * 1.7);
      ctx.lineTo(ob.x - ob.r * 0.85, ob.y + 4);
      ctx.lineTo(ob.x, ob.y + ob.r * 0.4);
      ctx.lineTo(ob.x + ob.r * 0.85, ob.y + 4);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(179, 229, 252, 0.45)';
      ctx.beginPath();
      ctx.moveTo(ob.x, ob.y - ob.r * 1.7);
      ctx.lineTo(ob.x - ob.r * 0.35, ob.y + 4);
      ctx.lineTo(ob.x, ob.y + ob.r * 0.35);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#0d1a26';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  drawShrine(ctx, sh, nowSec) {
    // Stone pedestal
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(sh.x, sh.y + 10, 26, 13, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#2b2f3a';
    ctx.strokeStyle = sh.active ? '#ffe082' : '#4a5060';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(sh.x, sh.y + 4, 22, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (sh.active) {
      const bob = Math.sin(nowSec * 3.5 + sh.x) * 5;
      // Glowing emerald-gold heart relic
      ctx.save();
      ctx.shadowColor = '#81c784';
      ctx.shadowBlur = 14;
      ctx.fillStyle = '#81c784';
      ctx.beginPath();
      ctx.arc(sh.x, sh.y - 16 + bob, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff59d';
      ctx.fillRect(sh.x - 2, sh.y - 21 + bob, 4, 10);
      ctx.fillRect(sh.x - 5, sh.y - 18 + bob, 10, 4);
      ctx.restore();
    }
  }

  drawTotem(ctx, t) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(t.x, t.y + 12, 22, 11, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = t.hit ? '#ffffff' : '#5d4037';
    ctx.strokeStyle = '#141118';
    ctx.lineWidth = 2;
    ctx.fillRect(t.x - 14, t.y - 34, 28, 44);
    ctx.strokeRect(t.x - 14, t.y - 34, 28, 44);

    // Painted target eyes
    ctx.fillStyle = t.hit ? '#ff5252' : '#ffe082';
    ctx.fillRect(t.x - 8, t.y - 24, 5, 5);
    ctx.fillRect(t.x + 3, t.y - 24, 5, 5);
    ctx.fillRect(t.x - 6, t.y - 12, 12, 4);

    // HP bar
    const bw = 40;
    ctx.fillStyle = '#0a0c12';
    ctx.fillRect(t.x - bw / 2, t.y - 46, bw, 6);
    ctx.fillStyle = '#ffb74d';
    ctx.fillRect(t.x - bw / 2 + 1, t.y - 45, (bw - 2) * (t.hp / t.maxHp), 4);
  }

  drawPlayer(ctx, p, isSelf, isLeader, nowSec) {
    const sprites = getHeroSprites(p.charId);
    const charDef = CHARACTER_MAP[p.charId];

    // 2.5D elliptical ground shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + 14, 19, 9, 0, 0, Math.PI * 2);
    ctx.fill();

    // Selection ring + directional aim chevron for self
    if (isSelf) {
      ctx.strokeStyle = 'rgba(255, 224, 130, 0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + 14, 23, 11, 0, 0, Math.PI * 2);
      ctx.stroke();

      // Crisp directional aim arrow around hero
      const ax = p.x + Math.cos(p.aim) * 32;
      const ay = p.y + Math.sin(p.aim) * 32;
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(p.aim);
      ctx.fillStyle = '#fff59d';
      ctx.beginPath();
      ctx.moveTo(7, 0);
      ctx.lineTo(-4, -5);
      ctx.lineTo(-4, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Orbiting spectral hounds (Tibo)
    if (p.orbit !== null && p.orbit !== undefined) {
      for (let i = 0; i < 2; i++) {
        const a = p.orbit + i * Math.PI;
        const hx = p.x + Math.cos(a) * 72;
        const hy = p.y + Math.sin(a) * 72;
        ctx.save();
        ctx.fillStyle = '#fff59d';
        ctx.shadowColor = '#ffd54f';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(hx, hy, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#141118';
        ctx.fillRect(hx - 4, hy - 2, 2, 3);
        ctx.fillRect(hx + 2, hy - 2, 2, 3);
        ctx.restore();
      }
    }

    // Sprite frame + facing flip
    let img = sprites.idle;
    if (p.hit) img = sprites.flash;
    else if (p.moving) img = Math.floor(nowSec * 9) % 2 === 0 ? sprites.walkA : sprites.walkB;

    const facingLeft = Math.cos(p.aim) < 0;
    const lunge = p.atk ? 4 : 0;
    const drawX = p.x + Math.cos(p.aim) * lunge;
    const drawY = p.y + Math.sin(p.aim) * lunge - 10;

    ctx.save();
    ctx.translate(drawX, drawY);
    if (facingLeft) ctx.scale(-1, 1);
    ctx.drawImage(img, -24, -24, 48, 48);
    ctx.restore();

    // Status overlays (shield, slow, haste)
    if (p.shield > 0) {
      ctx.strokeStyle = '#ffe082';
      ctx.fillStyle = 'rgba(255, 224, 130, 0.14)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y - 6, 28, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (p.slow) {
      ctx.strokeStyle = '#64b5f6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + 14, 24, 12, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (p.haste) {
      ctx.strokeStyle = '#ff9800';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y - 6, 25 + Math.sin(nowSec * 14) * 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Overhead HP bar + Name + Leader Crown
    const barW = 54;
    const barY = p.y - 44;
    ctx.fillStyle = 'rgba(10, 12, 18, 0.88)';
    ctx.fillRect(p.x - barW / 2 - 1, barY - 1, barW + 2, 8);
    const ratio = Math.max(0, Math.min(1, p.hp / p.maxHp));
    ctx.fillStyle = isSelf ? '#81c784' : '#ef5350';
    ctx.fillRect(p.x - barW / 2, barY, barW * ratio, 6);
    if (p.shield > 0) {
      const sRatio = Math.min(1, p.shield / p.maxHp);
      ctx.fillStyle = '#ffe082';
      ctx.fillRect(p.x - barW / 2, barY, barW * sRatio, 3);
    }

    // Nameplate
    ctx.font = '700 12px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    const label = `${isLeader ? '👑 ' : ''}${p.name}`;
    ctx.fillStyle = '#0a0c12';
    ctx.fillText(label, p.x + 1, barY - 6 + 1);
    ctx.fillStyle = isSelf ? '#fff59d' : charDef?.color || '#ffffff';
    ctx.fillText(label, p.x, barY - 6);
  }

  drawZonesAndTelegraphs(ctx, world, nowSec) {
    if (world?.zones) {
      for (const z of world.zones) {
        ctx.save();
        if (z.kind === 'turret') {
          ctx.strokeStyle = `${z.c}55`;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 6]);
          ctx.beginPath();
          ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          // Tesla pylon tower
          ctx.fillStyle = '#263238';
          ctx.fillRect(z.x - 6, z.y - 24, 12, 26);
          ctx.fillStyle = z.c;
          ctx.shadowColor = z.c;
          ctx.shadowBlur = 12;
          ctx.beginPath();
          ctx.arc(z.x, z.y - 26, 8 + Math.sin(nowSec * 12) * 1.5, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = `${z.c}30`;
          ctx.strokeStyle = `${z.c}aa`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          // Swirling inner ring
          ctx.beginPath();
          ctx.arc(z.x, z.y, z.r * (0.45 + 0.15 * Math.sin(nowSec * 6)), nowSec * 3, nowSec * 3 + Math.PI * 1.3);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    if (world?.blasts) {
      for (const b of world.blasts) {
        ctx.save();
        ctx.strokeStyle = b.c;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = `${b.c}44`;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r * Math.max(0.08, b.p), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  drawProjectiles(ctx, renderProjectiles) {
    if (!renderProjectiles) return;
    for (const pr of renderProjectiles.values()) {
      ctx.save();
      // Iron chain line for Sir Reginald's Chain Hook
      if (pr.k === 'hook' && pr.ox !== undefined && pr.oy !== undefined) {
        ctx.strokeStyle = '#cfd8dc';
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(pr.ox, pr.oy);
        ctx.lineTo(pr.x, pr.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // Velocity trail
      const vLen = Math.hypot(pr.vx, pr.vy) || 1;
      const tx = pr.x - (pr.vx / vLen) * Math.min(24, pr.r * 2.6);
      const ty = pr.y - (pr.vy / vLen) * Math.min(24, pr.r * 2.6);
      ctx.strokeStyle = `${pr.c}88`;
      ctx.lineWidth = pr.r * 1.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(pr.x, pr.y);
      ctx.stroke();

      ctx.shadowColor = pr.c;
      ctx.shadowBlur = 12;
      ctx.fillStyle = pr.c;
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, pr.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, pr.r * 0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  drawSlashes(ctx) {
    for (const s of this.slashes) {
      const alpha = s.life / s.maxLife;
      ctx.save();
      // Luminous cleave wedge fill
      ctx.globalAlpha = alpha * 0.38;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.arc(s.x, s.y, s.range, s.angle - s.arc / 2, s.angle + s.arc / 2);
      ctx.closePath();
      ctx.fill();

      // Bright leading edge arc
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = s.color;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = s.heavy ? 16 : 8;
      ctx.lineWidth = (s.heavy ? 14 : 9) * alpha + 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.range * 0.9, s.angle - s.arc / 2, s.angle + s.arc / 2);
      ctx.stroke();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3 * alpha;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.range * 0.92, s.angle - s.arc / 2.4, s.angle + s.arc / 2.4);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawNovas(ctx) {
    for (const n of this.novas) {
      const p = 1 - n.life / n.maxLife;
      const rad = n.r * (0.25 + p * 0.78);
      ctx.save();
      ctx.globalAlpha = 1 - p;
      ctx.strokeStyle = n.color;
      ctx.fillStyle = `${n.color}36`;
      ctx.shadowColor = n.color;
      ctx.shadowBlur = 14;
      ctx.lineWidth = 7 * (1 - p) + 2;
      ctx.beginPath();
      ctx.arc(n.x, n.y, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Inner shockwave ring
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5 * (1 - p);
      ctx.beginPath();
      ctx.arc(n.x, n.y, rad * 0.72, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawDashes(ctx) {
    for (const d of this.dashes) {
      ctx.save();
      ctx.globalAlpha = d.life / d.maxLife;
      ctx.strokeStyle = d.color;
      ctx.lineWidth = 14 * (d.life / d.maxLife);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(d.x1, d.y1);
      ctx.lineTo(d.x2, d.y2);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawBeams(ctx) {
    for (const b of this.beams) {
      const alpha = b.life / b.maxLife;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = b.color;
      ctx.shadowColor = b.color;
      ctx.shadowBlur = 18;
      ctx.lineWidth = b.width * alpha;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(b.x1, b.y1);
      ctx.lineTo(b.x2, b.y2);
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = b.width * 0.38 * alpha;
      ctx.stroke();
      ctx.restore();
    }
  }

  drawLightnings(ctx) {
    for (const l of this.lightnings) {
      const alpha = l.life / l.maxLife;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = l.color;
      ctx.shadowColor = l.color;
      ctx.shadowBlur = 16;
      ctx.lineWidth = 5 * alpha + 1.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const seg of l.segments) {
        const dx = seg.x2 - seg.x1;
        const dy = seg.y2 - seg.y1;
        const p1x = seg.x1 + dx * 0.33 + (Math.random() - 0.5) * 22;
        const p1y = seg.y1 + dy * 0.33 + (Math.random() - 0.5) * 22;
        const p2x = seg.x1 + dx * 0.66 + (Math.random() - 0.5) * 22;
        const p2y = seg.y1 + dy * 0.66 + (Math.random() - 0.5) * 22;

        ctx.beginPath();
        ctx.moveTo(seg.x1, seg.y1);
        ctx.lineTo(p1x, p1y);
        ctx.lineTo(p2x, p2y);
        ctx.lineTo(seg.x2, seg.y2);
        ctx.stroke();

        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2 * alpha;
        ctx.stroke();
        ctx.strokeStyle = l.color;
        ctx.lineWidth = 5 * alpha + 1.5;
      }
      ctx.restore();
    }
  }

  drawParticles(ctx) {
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  drawFloatTexts(ctx) {
    ctx.textAlign = 'center';
    for (const f of this.floatTexts) {
      ctx.globalAlpha = Math.max(0, f.life / f.maxLife);
      ctx.font = f.big
        ? '700 18px ui-monospace, Menlo, Consolas, monospace'
        : '700 14px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillStyle = '#0a0c12';
      ctx.fillText(f.text, f.x + 1, f.y + 1);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  drawMinimap(world, selfId, renderPlayers) {
    const m = this.mctx;
    const size = this.minimap.width;
    const scale = size / WORLD_SIZE;

    m.fillStyle = '#0a0c12';
    m.fillRect(0, 0, size, size);

    // Quadrant tints
    m.fillStyle = '#1b2033';
    m.fillRect(0, 0, size / 2, size / 2);
    m.fillStyle = '#291a1e';
    m.fillRect(size / 2, 0, size / 2, size / 2);
    m.fillStyle = '#182920';
    m.fillRect(0, size / 2, size / 2, size / 2);
    m.fillStyle = '#182534';
    m.fillRect(size / 2, size / 2, size / 2, size / 2);

    // Courtyard circle
    m.beginPath();
    m.arc(size / 2, size / 2, 420 * scale, 0, Math.PI * 2);
    m.fillStyle = '#232636';
    m.fill();
    m.strokeStyle = 'rgba(255, 224, 130, 0.35)';
    m.lineWidth = 1;
    m.stroke();

    // Active shrines
    if (world?.shrines) {
      for (const sh of world.shrines) {
        if (!sh.active) continue;
        m.fillStyle = '#81c784';
        m.fillRect(sh.x * scale - 2, sh.y * scale - 2, 4, 4);
      }
    }

    // Players
    for (const p of renderPlayers.values()) {
      if (!p.alive) continue;
      const isSelf = p.id === selfId;
      m.fillStyle = isSelf ? '#fff59d' : p.id === world?.leaderId ? '#ffd54f' : '#ff5252';
      m.beginPath();
      m.arc(p.x * scale, p.y * scale, isSelf ? 4 : 3, 0, Math.PI * 2);
      m.fill();
    }
  }
}
