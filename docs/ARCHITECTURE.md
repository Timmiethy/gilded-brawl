# Gilded Brawl — Game & Architecture Documentation

## 1. What the Game Is

**Gilded Brawl** is a zero-login, real-time multiplayer 2.5D pixel-art open-world PvP arena playable directly in the browser. Inspired by `tibo.dog`'s gilded gothic pixel-survivors aesthetic (`Cinzel` / `Marcellus` display typography, cream-gold `#fff59d` and obsidian `#0a0c12` palettes, crisp 16×16 pixel sprites with 2.5D oval shadows), players pick a display name and choose from **10 playable champions**, each with a distinct **normal attack** and **3 special skills**.

Players roam a seamless `2400 × 2400` open-world map divided into 4 distinct biomes (**Moonlit Ruins**, **Ember Forge**, **Whispering Meadow**, **Frost Sanctum**) surrounding a central **Gilded Courtyard**, contesting healing shrines and battling rival browser clients across continuous **90-second rounds**.

---

## 2. How It Works (End-to-End Architecture)

```text
Browser Client (60 FPS)                       Node.js / Vercel Server (RAM)
┌──────────────────────────────────┐          ┌──────────────────────────────────┐
│ WASD / Mouse / Q-E-R Input       │          │ api/game.js                      │
│  ├─ Instant 0ms local movement   │          │  ├─ Per-IP sliding rate limiter  │
│  │  (resolveLocalObstacles)      │  POST    │  ├─ 4 KB body & schema guards    │
│  ├─ Instant 0ms skill prediction │ /api/tick│  └─ Routes /join /tick /leave    │
│  │  (VFX, SFX, local projectiles)├─────────►│                                  │
│  └─ Non-blocking action dispatch │          │ game/engine.js (Singleton RAM)   │
│                                  │◄─────────┤  ├─ globalThis.__GILDED_BRAWL__  │
│ ArenaRenderer (Canvas 2D)        │ Snapshot │  ├─ Fixed-substep physics/combat │
│  ├─ Y-sorted 2.5D depth drawing  │ (JSON)   │  ├─ 90s round + 6s intermission  │
│  ├─ Smooth remote interpolation  │          │  ├─ Cooldowns, HP, KOs, shrines  │
│  └─ Minimap, VFX, float numbers  │          │  └─ Wins leaderboard & event log │
└──────────────────────────────────┘          └──────────────────────────────────┘
```

### Networking & Smoothness Model
- **Client identity:** Each browser tab generates a unique `clientId` stored in `sessionStorage`, so every open tab is treated as an independent player.
- **60 FPS movement without rubber-banding:** The client moves the local hero at 60 FPS using the shared obstacle layout (`resolveLocalObstacles`) and reports `(cx, cy)` on `/api/tick`. The server validates movement against `player.speed * speedMult * dt + tolerance` and obstacle collisions, and only forces position overrides (`fseq` / `force`) for server-authoritative displacements (dashes, blinks, hooks, knockbacks, gravity wells, respawns, new rounds).
- **0ms skill & click responsiveness:** Clicking or pressing `Q`/`E`/`R` immediately runs `predictActionLocally()` (spawning local VFX, SFX, cooldown sweep, and predicted projectiles) and fires a non-blocking `POST /api/tick` without waiting behind background 70ms polling ticks. Monotonic `tickSeq` numbering discards stale out-of-order responses, and server events tagged with `actorId` avoid duplicating locally predicted VFX.
- **Vercel serverless compatibility:** Because the entire simulation advances via wall-clock delta-time inside `stepEngine(Date.now())` on every incoming request (in addition to a 30 Hz local `setInterval` in `server.js`), round timers, projectiles, DoT zones, and delayed blasts stay accurate in both local Node and Vercel Node.js runtimes.

---

## 3. Core Game Logic

### Round Lifecycle & Winning Condition
1. **Playing Phase (`90s`):** Players battle across the open world, collect respawning healing shrines (`+24` to `+28 HP`), and can warm up on 2 destructible courtyard practice totems. Knocked-out players respawn after `4.0s` at `65%` HP.
2. **Round End (`finishRound`):** When the countdown hits `0:00`:
   - Players are ranked by **most round kills (`roundKos`)** first.
   - If kills are tied, the player with **more remaining health (`hp`)** wins.
   - If **both kills and health are equal**, **all tied players win together** (`isTie: true`) and each receives `+1` win on the persistent RAM Champions leaderboard.
3. **Intermission Phase (`6s`):** Displays the winner(s), round standings, and countdown to the next round.
4. **Next Round (`startNextRound`):** Automatically resets HP, cooldowns, shrines, totems, and spawn positions while preserving the Champions wins leaderboard in RAM.

### 10 Playable Champions & Ability Archetypes
Every character has 1 normal attack (`CLICK`) and 3 skills (`Q`, `E`, `R`) built on a data-driven combat engine supporting 12 skill archetypes:
- **Tibo** (*Bruiser*, 130 HP): Potato Toss, Pack Rush (`dash_strike`), Hound Whistle (`orbit_hounds`), Gilded Slam (`nova`).
- **Poteto** (*Brawler*, 145 HP): Mallet Swing (`melee`), Rolling Cask (`explosive_proj`), Starch Nova (`nova`), Grand Hammerfall (`cone_slam`).
- **Biscuit** (*Pyromancer*, 110 HP): Cinder Bolt (`projectile`), Flame Fan (`spread_proj`), Scorch Puddle (`zone`), Solar Bark (`nova` + speed buff).
- **Sir Reginald** (*Vanguard*, 165 HP): Shield Bash (`melee`), Aegis Bulwark (`shield_pulse`), Chain Hook (`hook`), Bastion Quake (`nova`).
- **Nyx** (*Assassin*, 105 HP): Twin Fangs (`melee`), Shadowstep (`blink_strike`), Eclipse Kunai (`spread_proj`, piercing), Phantom Flurry (`nova`).
- **Mochi** (*Controller*, 115 HP): Icicle Shard (`projectile`, piercing), Glacier Wave (`spread_proj` + slow), Blizzard Ring (`zone` + slow), Absolute Bark (`nova` + slow).
- **Baron Von Bark** (*Vampire*, 135 HP): Crimson Claw (`melee` + lifesteal), Bat Swarm (`spread_proj` + lifesteal), Blood Mist (`dash_strike` + haste), Sanguine Feast (`nova` + lifesteal).
- **Sparky** (*Storm Mage*, 110 HP): Zap Bolt (`projectile`), Chain Lightning (`chain_lightning`), Tesla Pylon (`turret`), Thunderstrike (`delayed_blast`).
- **Moss** (*Druid*, 125 HP): Thorn Arrow (`projectile`), Bramble Snare (`delayed_blast` + slow), Verdant Bloom (`heal_nova`), Razor Volley (`spread_proj`, piercing).
- **Waffle** (*Artillery*, 115 HP): Starlight Orb (`explosive_proj`), Gravity Well (`zone` + pull), Comet Drop (`delayed_blast`), Supernova Beam (`beam`).

### Rate Limiting & Anti-Abuse Protections
- **Per-IP sliding-window rate limits:** `/api/tick` (55/s), `/api/status` (30/s), `/api/join` & `/api/switch` (10/10s), `/api/leave` (12/10s), returning `429` with `Retry-After`.
- **Payload & schema guards:** Strict `4 KB` JSON body cap (`413`), regex-validated `clientId` (`400`), name sanitization, and security headers (`CSP`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`).
- **Bounded RAM caps:** Max `60` active players, max `4` active players per IP, max `200` leaderboard entries (pruning lowest-win offline records), max `120` projectiles, `40` zones, and `30` delayed blasts.

---

## 4. Major Files Reference

### Server & Shared Data
- **[`server.js`](../server.js):** Zero-dependency Node.js HTTP server (and Vercel entrypoint). Serves static files from `public/`, routes `/api/*` to `api/game.js`, and runs a 30 Hz `stepEngine` loop locally.
- **[`api/game.js`](../api/game.js):** Unified API router for `/api/join`, `/api/switch`, `/api/tick`, `/api/leave`, and `/api/status`. Implements per-IP sliding-window rate limiting, 4 KB body size enforcement, JSON parsing, and `clientId` validation.
- **[`game/engine.js`](../game/engine.js):** Authoritative in-RAM simulation singleton (`globalThis.__GILDED_BRAWL_STATE__`). Handles player lifecycle, timeout pruning (12s), movement validation, collision resolution, all 12 combat skill archetypes, shrines, practice totems, round countdown/intermission transitions, co-winner calculation, leaderboard persistence, and snapshot serialization.
- **[`public/shared/characters.js`](../public/shared/characters.js):** Shared roster definitions for all 10 champions (base HP, speed, hitbox radius, palette, normal attack, and 3 skills with damage, cooldowns, ranges, and status effects). Imported by both server and client.
- **[`public/shared/map.js`](../public/shared/map.js):** Shared `2400 × 2400` open-world geometry — biome boundaries, 28 circular 2.5D obstacles, 12 spawn points, 5 healing shrines, 2 practice totems, and round/intermission durations (`90s` / `6s`).
- **[`vercel.json`](../vercel.json):** Vercel configuration setting `Cache-Control: no-store` on `/api/*` and security/CSP headers on all routes.

### Frontend Client
- **[`public/index.html`](../public/index.html):** Semantic HTML document containing the full-viewport game `<canvas>`, HUD plates (round timer, biome, Champions leaderboard, kill feed, minimap, HP/shield bar, 4-slot skill bar), round summary overlay, and native `<dialog>` onboarding/hero-select modal.
- **[`public/css/style.css`](../public/css/style.css):** Gilded gothic pixel-UI stylesheet (`Cinzel`/`Marcellus` + monospace `tabular-nums`), top-layer `<dialog>` entrance/exit transitions (`@starting-style`, `transition-behavior: allow-discrete`, staggered hero card reveals), `:user-invalid`/`:user-valid` name validation styling, and cooldown sweep animations.
- **[`public/js/main.js`](../public/js/main.js):** Client controller — `sessionStorage` player identity, onboarding modal & accessible ARIA validation sync, physical `e.code` (`WASD` + `Q`/`E`/`R`) & pointer input handlers, 0ms local action/movement prediction, non-blocking `/api/tick` dispatch, remote player/projectile interpolation, and 60 FPS `requestAnimationFrame` loop.
- **[`public/js/renderer.js`](../public/js/renderer.js):** 2.5D Canvas renderer — biome ground tiles & courtyard sigils, Y-sorted 2.5D obstacles/shrines/totems/players with elliptical ground shadows, directional aim chevron, leader crowns, melee cleave wedges, double-ring novas, chains, lightning arcs, laser beams, particles, floating damage numbers, screen shake, and minimap.
- **[`public/js/sprites.js`](../public/js/sprites.js):** Procedural 16×16 pixel-art sprite generator producing crisp offscreen canvases (idle, 2-frame walk cycle, white hit-flash, and onboarding portrait data URLs) for all 10 champions.
- **[`public/js/audio.js`](../public/js/audio.js):** Lightweight procedural Web Audio API 16-bit synthesizer for attack, skill, hit, heal, KO, and round-horn sound effects with mute toggle.
