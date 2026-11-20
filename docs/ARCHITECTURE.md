# Gilded Brawl — Game & Architecture Documentation

## 1. What the Game Is

**Gilded Brawl** is a zero-login, real-time multiplayer 3D open-world PvP arena playable directly in the browser. It renders with WebGL (three.js): golden-hour sun with real-time shadows, image-based reflections, bloom, fog, procedurally painted biomes, and animated 3D heroes. The HUD keeps the gilded gothic look (`Cinzel` / `Marcellus` typography, cream-gold `#fff59d` on obsidian `#0a0c12`). Players pick a display name and one of **10 heroes — living curiosities** — each with a **normal attack** and **3 special skills**.

Players roam a seamless `2400 × 2400` open-world map divided into 4 distinct biomes (**Moonlit Ruins**, **Ember Forge**, **Whispering Meadow**, **Frost Sanctum**) surrounding a central **Gilded Courtyard**, contesting healing shrines and battling rival browser clients across continuous **90-second rounds**.

---

## 2. How It Works (End-to-End Architecture)

```text
Browser Client (60 FPS)                       One Node.js game process (RAM)
┌──────────────────────────────────┐          ┌──────────────────────────────────┐
│ WASD / Mouse / Q-E-R Input       │          │ api/game.js                      │
│  ├─ Instant 0ms local movement   │          │  ├─ Per-IP sliding rate limiter  │
│  │  (shared/physics.js)          │  POST    │  ├─ 4 KB body & schema guards    │
│  ├─ Instant 0ms skill prediction │ /api/tick│  └─ Routes /join /tick /leave    │
│  │  (VFX, SFX, local projectiles)├─────────►│                                  │
│  └─ Non-blocking action dispatch │          │ game/engine.js (Singleton RAM)   │
│                                  │◄─────────┤  ├─ globalThis.__GILDED_BRAWL__  │
│ ArenaRenderer (three.js WebGL)   │ Snapshot │  ├─ Fixed-substep physics/combat │
│  ├─ Lit 3D world, heroes, bloom  │ (JSON)   │  ├─ 90s round + 6s intermission  │
│  ├─ Particles, zones, telegraphs │          │  ├─ Cooldowns, HP, KOs, shrines  │
│  └─ 2D overlay text + minimap    │          │  └─ Wins leaderboard & event log │
└──────────────────────────────────┘          └──────────────────────────────────┘
```

### Networking & Smoothness Model
- **Client identity (session key vs. public id):** Each browser tab generates a secret `session` key (`crypto.randomUUID()`, kept in `sessionStorage`). It is a bearer credential: only the owning tab sends it, and the server never returns it. The server maps it to a public player id (`pl1`, `pl2`, …) that snapshots, events, and the leaderboard use, and returns the caller's own id as `selfId`. A tab created with *Duplicate tab* (which copies `sessionStorage`) detects the shared key over a `BroadcastChannel` and takes a fresh one, so every tab is an independent player.
- **60 FPS movement without rubber-banding:** The client moves the local hero at 60 FPS using the shared obstacle layout (`resolveLocalObstacles`) and reports `(cx, cy)` on `/api/tick`. The server checks movement with a token-bucket movement budget: travel allowance grows with real elapsed time (`speed × speedMult × elapsed`, banked up to 0.6s + 48px slack), never with the number of ticks, so faster ticks cannot move a player faster. The server forces position overrides (`fseq` / `force`) only for server-authoritative displacements (dashes, blinks, hooks, knockbacks, gravity wells, respawns, new rounds). Each tick echoes the last `fseq` the client applied; the server ignores `(cx, cy)` until that ack matches, so in-flight ticks cannot drag a player back after a forced move. Dash paths and collisions come from one shared module (`public/shared/physics.js`), so the predicted dash ends where the server's dash ends.
- **0ms skill & click responsiveness:** Clicking or pressing `Q`/`E`/`R` immediately runs `predictActionLocally()` (spawning local VFX, SFX, cooldown sweep, and predicted projectiles) and fires a non-blocking `POST /api/tick` without waiting behind background 70ms polling ticks. Monotonic `tickSeq` numbering discards stale out-of-order responses, and server events tagged with `actorId` avoid duplicating locally predicted VFX.
- **Exactly one game process:** The world lives in the memory of one long-running Node process (`server.js`, which also steps the simulation at 30 Hz). Every player must reach that same process. Serverless platforms (for example Vercel Functions) run several short-lived instances, and each one holds its own copy of the world. Players then land in different worlds, and their heroes jump between positions from different worlds on each poll. That happened in production, so the game is hosted on Render as a single always-on web service (see *Deployment*).

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

### 10 Heroes & Skill Archetypes
Every hero has 1 normal attack (`CLICK`) and 3 skills (`Q`, `E`, `R`). Moves are pure data in `public/shared/characters.js`: `type` picks an engine archetype, and optional fields tune it (see the comment at the top of that file).

| Hero | Role | CLICK | Q | E | R |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tock**, the Clockwork Wren (115 HP) | Chronomancer | Ricochet Cog (bounces once) | **Rewind** — back to where you were 2s ago, with that HP | **Stasis Bubble** — enemy shots crawl at 20% | **Time Bomb** — sticks to a foe, blows up 1.6s later |
| **Marrow**, the Lantern Ghost (105 HP) | Trickster | Wisp Flick (homing) | **Fade** — true stealth, +50% first strike | **Soul Swap** — trade places with the foe hit | **Banshee Wail** — expanding ring that silences |
| **Prickle Jo**, the Cactus Gunslinger (120 HP) | Sharpshooter | Needle Shot | **Trick Shot** — 3 ricochets, re-hits after each | Tumbleweed Roll (dash) | **High Noon** — lock on to everyone in a cone, fire 0.8s later |
| **Fold**, the Origami Ronin (110 HP) | Duelist | Paper Cut (melee) | **Crane Grapple** — zip to a wall or foe | **Shuriken Bloom** — boomerangs, hit out and back | **Thousand Folds** — blink through up to 4 foes |
| **Nell**, the Jellyfish Astronomer (110 HP) | Cosmic Mage | Star Mote (splash) | **Wormhole** — linked portals for players *and* shots | Tidal Undertow (pull zone) | **Meteor Shower** — 6 staggered meteors |
| **Brontë**, the Pocket Thundercloud (115 HP) | Storm Caller | Drizzle Bolt | Forked Lightning (chain) | **Static Dome** — destroys enemy shots | **Eye of the Storm** — 4 orbiting orbs + haste |
| **Sir Steep**, the Teacup Knight (165 HP) | Vanguard | Saucer Bash (melee) | **Scalding Spill** — sprint leaving a damage trail | Sugar Shield (shield + pulse) | Kettle Geyser (delayed blast) |
| **Morel**, the Mushroom Alchemist (125 HP) | Sporecaster | Spore Puff (3-spread) | **Sporelings** — slow homing bursts | Fairy Ring (heal + pulse) | **Mind Bloom** — silence zone |
| **Vendetta**, the Vending Golem (170 HP) | Juggernaut | Soda Lob (splash) | **Coin Spray** — 6 ricocheting coins | Snack Turret | OUT OF ORDER (cone slam) |
| **Beacon**, the Wandering Lighthouse (145 HP) | Warden | Foghorn (wide melee) | Rescue Line (hook) | Lighthouse Beam | **Riptide** — tidal ripple with huge knockback |

Engine archetypes: `projectile` and `spread_proj` (with `bounces` ricochet, `homing`, `returns` boomerang, `pierce`, `splash`, and `onHit` = `hook` / `swap` / `grapple` / `curse`), `melee`, `cone_slam`, `dash_strike`, `blink_chain`, `shield_pulse`, `heal_nova`, `orbit`, `stealth`, `rewind`, `zone` (with `pull`, `slow`, `silence`, `projSlow` stasis, `barrier`), `turret`, `portal`, `trail`, `ripple`, `delayed_blast` (with `count`/`scatter`/`stagger` showers), `deadeye`, `chain_lightning`, and `beam`.

Status effects: **slow** (also enforced by the server's movement budget), **haste**, **shield**, **silence** (no skills; the basic attack still works), and **stealth**. Stealth is real: the server leaves a stealthed player out of every other player's snapshot, so no client or cheat can draw them. Auto-aimed effects (homing, chains, turrets, lock-ons, blinks) cannot pick a stealthed player; area damage still hits them.

### Rate Limiting & Anti-Abuse Protections
- **Per-IP fixed-window rate limits:** `/api/tick` (120/s), `/api/status` (60/s), `/api/join` (10/10s), `/api/leave` (12/10s), any other path (30/s, one shared bucket so path variations cannot mint new buckets). A `429` names the limit and sends `Retry-After`. Receipts for each number are in `api/game.js`.
- **Trusted client IP:** `TRUST_PROXY_HOPS` is the number of trusted reverse proxies in front of the server (the Express "trust proxy" model). Each proxy appends to `X-Forwarded-For`, so the client address is the `TRUST_PROXY_HOPS`-th entry from the right; everything to its left is client-controlled. `0` (a bare `node server.js`) uses the socket address. The per-network limit error names the detected address, so an operator can check the setting. IPv6 clients are grouped by `/64`, because one subscriber owns the whole prefix.
- **Payload & schema guards:** `4 KB` JSON body cap counted in bytes, checked on `Content-Length` and while streaming (`413`, connection closed); JSON object bodies only; regex-validated `session` (`400`); method checks (`405`); name sanitization; HTML output escaped.
- **Security headers:** `vercel.json` is the single source; `server.js` reads and applies the same rules locally. CSP has no `'unsafe-inline'` (no inline styles or scripts), plus `object-src 'none'`, `form-action 'self'`, `frame-ancestors 'none'`.
- **Static files:** the path check requires the resolved path to be `public/` itself or inside `public/` + path separator, so `/../public_other/…` cannot reach sibling folders. Read-stream errors fail only that response.
- **Hero switch is not a heal:** re-submitting the hero dialog keeps HP ratio, life state, cooldowns, and position. Spawn points always come from the server.
- **Bounded RAM tripwires:** Max `60` active players, max `4` per IP, max `200` leaderboard entries (pruning lowest-win offline records with their sessions), `1024` projectiles, `128` zones, `128` delayed blasts, `1024` events. The entity caps are sized from the roster (receipts in `game/engine.js`) and log a warning that names the budget if reached.

---

## 4. Major Files Reference

### Server & Shared Data
- **[`server.js`](../server.js):** The zero-dependency game server: one Node process that owns the world. Serves `public/` from memory (read and Brotli/gzip-compressed once, `ETag` + revalidation), routes `/api/*` to `api/game.js`, and runs the 30 Hz `stepEngine` loop.
- **[`api/game.js`](../api/game.js):** Unified API router for `/api/join` (also switches hero), `/api/tick`, `/api/leave`, and `/api/status`. Implements per-IP rate limiting, trusted-IP resolution, 4 KB body size enforcement, JSON parsing, method checks, and `session` validation.
- **[`game/engine.js`](../game/engine.js):** Authoritative in-RAM simulation singleton (`globalThis.__GILDED_BRAWL_STATE__`). Handles player lifecycle, timeout pruning (12s), movement validation, collision resolution, every skill archetype (ricochet/homing/boomerang projectiles, portals, stasis, barriers, trails, ripples, lock-ons, rewind, stealth), shrines, practice totems, round countdown/intermission transitions, co-winner calculation, leaderboard persistence, and snapshot serialization.
- **[`public/shared/characters.js`](../public/shared/characters.js):** Shared roster definitions for all 10 champions (base HP, speed, hitbox radius, palette, normal attack, and 3 skills with damage, cooldowns, ranges, and status effects). Imported by both server and client.
- **[`public/shared/physics.js`](../public/shared/physics.js):** Shared circle-vs-obstacle collision, ricochet contact normals, and dash tracing, imported by both the server simulation and the client prediction.
- **[`public/shared/map.js`](../public/shared/map.js):** Shared `2400 × 2400` open-world geometry — biome boundaries, 28 circular obstacles, 12 spawn points, 5 healing shrines, 2 practice totems, and round/intermission durations (`90s` / `6s`).
- **[`vercel.json`](../vercel.json):** Single source of response headers (`Cache-Control: no-store` on `/api/*`; security/CSP headers on all routes), which `server.js` applies. On Vercel it also redirects the old URL to the Render host.

### Frontend Client
- **[`public/index.html`](../public/index.html):** Semantic HTML document containing the full-viewport game `<canvas>`, HUD plates (round timer, biome, Champions leaderboard, kill feed, minimap, HP/shield bar, 4-slot skill bar), center-screen callouts, round summary overlay, and native `<dialog>` onboarding/hero-select modal.
- **[`public/css/style.css`](../public/css/style.css):** Gilded gothic UI stylesheet (`Cinzel`/`Marcellus` + monospace `tabular-nums`), top-layer `<dialog>` entrance/exit transitions, `:user-invalid`/`:user-valid` name validation, cooldown sweeps, the skill-ready light sweep, silenced slots, and the round / knockout callout animations (with `prefers-reduced-motion` fallbacks).
- **[`public/js/main.js`](../public/js/main.js):** Client controller — secret session key & duplicate-tab detection, onboarding modal & accessible ARIA validation sync, physical `e.code` (`WASD` + `Q`/`E`/`R`) & pointer input handlers, 0ms local action/movement prediction, non-blocking `/api/tick` dispatch with `fseq` ack, remote player/projectile interpolation, and the 60 FPS `requestAnimationFrame` loop.
- **[`public/js/render/renderer.js`](../public/js/render/renderer.js):** The 3D renderer (`ArenaRenderer`): WebGL setup, ACES tone mapping, image-based lighting (`RoomEnvironment`), texel-snapped sun shadows that follow the camera, bloom (`UnrealBloomPass`), camera follow with shake and zoom punch, ground-plane aim picking, hero lifecycle, footstep dust, and the aim reticle.
- **[`public/js/render/world.js`](../public/js/render/world.js):** Seeded procedural world — terrain painted to a 2048² texture (biome blends, roads, flagstones, lava fissures with an emissive map, ice sheets in a roughness map, courtyard paving and compass), 3D props for every obstacle kind, walls and corner towers, braziers, shrines, practice dummies, instanced grass (GPU wind sway), rocks, flowers, bushes, snow, ice and obsidian, per-biome ambient particles, and fading of props that hide the player.
- **[`public/js/render/heroes.js`](../public/js/render/heroes.js):** The 10 hero models, built from primitives with PBR materials, and their animation rigs (walk cycles, hover, wings, spinning gears, swinging lantern, tentacles, flickering lightning legs, sweeping lighthouse beam). Shared animation states: idle breathing, attack squash-and-stretch, hit flash and recoil, death topple and fade, spawn pop-in (ease-out-back). Status visuals: fresnel shield bubble, silence glyph, slow/haste rings, leader crown, orbiting orbs. Hero portraits are rendered from the same models.
- **[`public/js/render/fx.js`](../public/js/render/fx.js):** Effects — GPU point particles (additive sparks and soft smoke), a 3D look per projectile style (cog, needle, shuriken, wisp, spore, coin, rope, bomb), live visuals for every zone (clock-face stasis bubble, hex-shield dome, whirlpool, mind-bloom mandala, portals, tea trail, snack turret), telegraphs (falling meteors, geyser, ticking bomb, High Noon crosshairs and laser sights), and an animated effect for every combat event.
- **[`public/js/render/overlay.js`](../public/js/render/overlay.js)** and **[`minimap.js`](../public/js/render/minimap.js):** 2D nameplates, HP/shield bars, pop-up damage numbers above the 3D view; the world minimap.
- **[`public/vendor/three/`](../public/vendor/three/):** three.js (pinned in `package.json`), copied from `node_modules` by `npm run vendor:three`. The script rewrites the addons' bare `'three'` imports to a path, because the strict CSP forbids an inline import map.
- **[`public/js/audio.js`](../public/js/audio.js):** Lightweight procedural Web Audio API 16-bit synthesizer for attack, skill, hit, heal, KO, and round-horn sound effects with mute toggle.
