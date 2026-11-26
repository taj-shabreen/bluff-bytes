# Bluff Bytes · Netlify edition

The drag-and-drop deployment package for the Handshake Create a Multiplayer Game brief. It keeps the five-round Bluff Bytes game, its retro terminal interface, room codes, anonymous answers and votes, scoring, reconnect behavior, and winner screen.

## What is included

- `index.html`, `app.js`, and `style.css` — the browser app and its styling.
- `netlify/functions/game.ts` — the single multiplayer API at `/.netlify/functions/game`.
- `netlify/game-core.ts` — game rules and player-specific state filtering, outside the Functions folder.
- `netlify.toml`, `package.json`, and `package-lock.json` — build and deploy settings.
- `dist/` — static files produced by the production build.

## Publish with Netlify Drop

1. Sign in to Netlify, open [Netlify Drop](https://app.netlify.com/drop), and upload `netlify-ready-game.zip`.
2. Netlify runs the included build command, builds the site files, and packages the `game` Function.
3. Open the resulting `*.netlify.app` site and create a room. Share that public URL and its room code with players.

Netlify automatically provisions Blobs access for Functions on the deployed site. No site ID, API token, environment variable, GitHub repository, or separately managed database is needed. Netlify must be signed in to run a source project's build during Drop deployment; without signing in, Drop publishes the uploaded files as-is and won't build the Function.

## Local check

Netlify Dev provides a local Functions and Blobs emulator. Run `npm install`, `npm run build`, and `npm run dev`; then open `http://localhost:8888`. In another terminal, run `npm run test:game` to exercise the live Function with two players through all five rounds. This local sandbox uses separate local Blobs; it is not your deployed room store.

## Multiplayer state and consistency

Each room is stored as one JSON blob in the site-wide `bluff-bytes-rooms` store. The Function uses strongly consistent reads and conditional ETag writes (`onlyIfMatch`), retries write conflicts, and uses `onlyIfNew` for room-code reservation. A rejected stale write is reapplied to the latest room snapshot, so overlapping submissions and votes are revalidated before committing. The frontend polls the Function for state and sends a heartbeat to keep reconnect status current.

Netlify Blobs is key-value object storage rather than a transactional database. This implementation keeps each room's game transition inside one conditionally-written blob; the test suite exercises concurrent submissions. For substantially higher traffic or strict transactional guarantees beyond a small party game, move room state to a transactional database. Room blobs do not have automatic expiry in this version.

## Rules

Two to eight players join with a nickname and six-character room code. Each player submits a fake definition for each of five CS and AI terms. The server adds and shuffles the real definition anonymously. Players vote once and cannot vote for their own answer. Correct votes earn 2 points; each player fooled by a fake gives its author 1 point. The game reveals each round, shows a live leaderboard, announces the final winner, and lets the host start over.
