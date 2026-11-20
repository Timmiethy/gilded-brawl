// Lightweight procedural Web Audio 16-bit synth SFX engine (zero external audio files)

class SoundEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  unlock() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }

  play(kind) {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    const tone = (type, f1, f2, dur, vol = 0.08, delay = 0) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f1, now + delay);
      osc.frequency.exponentialRampToValueAtTime(Math.max(30, f2), now + delay + dur);
      gain.gain.setValueAtTime(vol, now + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, now + delay + dur);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now + delay);
      osc.stop(now + delay + dur + 0.02);
    };

    switch (kind) {
      case 'shoot':
        tone('triangle', 520, 220, 0.08, 0.06);
        break;
      case 'spread':
        tone('sawtooth', 420, 180, 0.12, 0.06);
        tone('triangle', 640, 260, 0.1, 0.05, 0.02);
        break;
      case 'slash':
        tone('sawtooth', 320, 95, 0.11, 0.07);
        break;
      case 'dash':
        tone('sine', 240, 680, 0.13, 0.07);
        break;
      case 'hit':
        tone('square', 180, 72, 0.07, 0.06);
        break;
      case 'nova':
      case 'blast':
        tone('sawtooth', 200, 48, 0.24, 0.09);
        tone('triangle', 480, 110, 0.2, 0.06, 0.02);
        break;
      case 'lightning':
        tone('sawtooth', 980, 260, 0.14, 0.07);
        tone('square', 720, 140, 0.12, 0.05, 0.04);
        break;
      case 'beam':
        tone('sawtooth', 620, 880, 0.22, 0.08);
        tone('triangle', 310, 440, 0.24, 0.06);
        break;
      case 'heal':
      case 'shrine':
        tone('sine', 440, 660, 0.14, 0.07);
        tone('sine', 660, 880, 0.16, 0.07, 0.08);
        break;
      case 'ko':
        tone('square', 360, 120, 0.18, 0.08);
        tone('square', 240, 80, 0.24, 0.08, 0.1);
        break;
      case 'round_end':
        tone('triangle', 440, 440, 0.12, 0.09, 0);
        tone('triangle', 554, 554, 0.12, 0.09, 0.11);
        tone('triangle', 659, 659, 0.28, 0.1, 0.22);
        break;
      case 'round_start':
        tone('triangle', 330, 440, 0.12, 0.08, 0);
        tone('triangle', 440, 660, 0.22, 0.09, 0.1);
        break;
      default:
        tone('triangle', 420, 260, 0.09, 0.05);
    }
  }
}

export const sfx = new SoundEngine();
