# Gilded Brawl

A 3D open-world PvP multiplayer browser arena (three.js / WebGL). Zero login — enter a name, pick one of 10 heroes (a clockwork wren, a lantern ghost, a cactus gunslinger, an origami ronin, a jellyfish astronomer, a pocket thundercloud, a teacup knight, a mushroom alchemist, a vending-machine golem, and a wandering lighthouse), and jump into 90-second PvP rounds.

- **Live Game:** https://gilded-brawl.onrender.com (free plan: after 15 minutes with no visitors the server sleeps, and the next visit waits about a minute while it wakes)
- **Full Technical & Architecture Docs:** [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)

## Quick Start

```bash
npm start
# Open http://localhost:3000 (open multiple browser tabs to test PvP)
```

Run `npm test` for the engine checks: every move of every hero, each mechanic (rewind, stealth, portals, ricochet, boomerang, homing, time bomb, stasis, barrier, trail, silence), and the anti-cheat regressions.

three.js is vendored into `public/vendor/three/`. After you change its pinned version in `package.json`, run `npm install && npm run vendor:three`.

## Controls

| Input | Action |
| :--- | :--- |
| `W` `A` `S` `D` (or Arrow keys) | Move (uses physical `e.code`, works across all keyboard layouts/IMEs) |
| Mouse Move | Aim |
| Left Click | Normal Attack (hold to auto-fire) |
| `Q` / `E` / `R` | Special Skills 1 / 2 / 3 |

## Round Rules

- Each round lasts **1 minute 30 seconds (90s)**, followed by a **6-second intermission** before the next round starts automatically.
- **Win Condition:** The player with the **most kills (KOs)** wins the round. If kills are tied, the player with **more remaining HP** wins. If both kills and HP are equal, **all tied players win together** and each receives `+1` win on the live Champions leaderboard.
- All game state lives in server RAM (`globalThis.__GILDED_BRAWL_STATE__`). Each browser tab counts as an independent player.
