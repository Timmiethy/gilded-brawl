# Gilded Brawl

A 2.5D gilded pixel open-world PvP multiplayer browser arena inspired by [`tibo.dog`](https://tibo.dog/). Zero login — enter a name, pick from 10 unique champions, and jump straight into 90-second open-world PvP rounds.

- **Live Game:** https://agile-krypton-nuen60z-timmiethys-projects.vercel.app
- **Full Technical & Architecture Docs:** [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)

## Quick Start

```bash
npm start
# Open http://localhost:3000 (open multiple browser tabs to test PvP)
```

## Controls

| Input | Action |
| :--- | :--- |
| `W` `A` `S` `D` (or Arrow keys) | Move (uses physical `e.code`, works across all keyboard layouts/IMEs) |
| Mouse Move | Aim |
| Left Click | Normal Attack (hold to auto-fire) |
| `J` / `K` / `L` | Special Skills 1 / 2 / 3 |

## Round Rules

- Each round lasts **1 minute 30 seconds (90s)**, followed by a **6-second intermission** before the next round starts automatically.
- **Win Condition:** The player with the **most kills (KOs)** wins the round. If kills are tied, the player with **more remaining HP** wins. If both kills and HP are equal, **all tied players win together** and each receives `+1` win on the live Champions leaderboard.
- All game state lives in server RAM (`globalThis.__GILDED_BRAWL_STATE__`). Each browser tab counts as an independent player.
