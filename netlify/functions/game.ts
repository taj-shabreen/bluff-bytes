import { getStore } from '@netlify/blobs';
import type { Context } from '@netlify/functions';
import { randomBytes, randomUUID } from 'node:crypto';
import { applyAction, createRoom, GameError, publicState, type Room } from '../game-core.js';

const STORE_NAME = 'bluff-bytes-rooms';
const MAX_CONFLICT_RETRIES = 14;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const randomId = () => randomUUID();
const roomCode = () => randomBytes(3).toString('hex').toUpperCase();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type RoomMutation<T> = (room: Room) => T;

async function transact<T>(store: ReturnType<typeof getStore>, code: string, mutation: RoomMutation<T>): Promise<{ room: Room; result: T }> {
  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const entry = await store.getWithMetadata(code, { type: 'json', consistency: 'strong' });
    if (!entry || entry.data === null || !entry.etag) throw new GameError(404, 'Room not found. Check the code and try again.');
    const room = structuredClone(entry.data as Room);
    const result = mutation(room);
    room.version++;
    const write = await store.setJSON(code, room, { onlyIfMatch: entry.etag });
    if (write.modified) return { room, result };
    await pause(Math.min(8 + attempt * 9, 110) + Math.floor(Math.random() * 13));
  }
  throw new GameError(409, 'The room changed at the same time. Please try that action again.');
}

async function create(body: Record<string, unknown>, store: ReturnType<typeof getStore>) {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 20) : '';
  if (name.length < 2) throw new GameError(400, 'Choose a nickname with at least 2 characters.');
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = roomCode();
    const token = randomId();
    const room = createRoom(code, name, token, randomId());
    const result = await store.setJSON(code, room, { onlyIfNew: true });
    if (result.modified) return { code, token, state: publicState(room, token) };
  }
  throw new GameError(503, 'Could not reserve a room code. Please try again.');
}

async function join(body: Record<string, unknown>, store: ReturnType<typeof getStore>) {
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 20) : '';
  if (!/^[0-9A-F]{6}$/.test(code)) throw new GameError(400, 'Enter a valid six-character room code.');
  if (name.length < 2) throw new GameError(400, 'Choose a nickname with at least 2 characters.');
  const token = randomId();
  const id = randomId();
  const now = Date.now();
  const { room } = await transact(store, code, current => {
    if (current.status !== 'lobby') throw new GameError(400, 'This game has started. Ask the host to start a new game.');
    if (current.players.length >= 8) throw new GameError(400, 'This room is full (8 players).');
    if (current.players.some(player => player.name.toLowerCase() === name.toLowerCase())) throw new GameError(400, 'That nickname is already in this room.');
    current.players.push({ id, token, name, score: 0, lastSeen: now });
    return null;
  });
  return { code, token, state: publicState(room, token, now) };
}

async function readState(body: Record<string, unknown>, store: ReturnType<typeof getStore>) {
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  const token = typeof body.token === 'string' ? body.token : '';
  if (!/^[0-9A-F]{6}$/.test(code)) throw new GameError(400, 'Enter a valid six-character room code.');
  const room = await store.get(code, { type: 'json', consistency: 'strong' }) as Room | null;
  if (!room) throw new GameError(404, 'Room not found. Check the code and try again.');
  const state = publicState(room, token);
  if (!state) throw new GameError(401, 'Your seat has expired. Rejoin with the room code.');
  return { state };
}

async function update(body: Record<string, unknown>, store: ReturnType<typeof getStore>) {
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  const token = typeof body.token === 'string' ? body.token : '';
  if (!/^[0-9A-F]{6}$/.test(code)) throw new GameError(400, 'Enter a valid six-character room code.');
  const { room, result } = await transact(store, code, current => applyAction(current, token, body));
  return { ok: true, state: result, version: room.version };
}

export async function handleGameRequest(request: Request, store: ReturnType<typeof getStore>): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Use POST for game requests.' }, 405);
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid JSON body.');
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'Send a valid JSON game request.' }, 400);
  }
  try {
    if (body.action === 'create') return json(await create(body, store));
    if (body.action === 'join') return json(await join(body, store));
    if (body.action === 'state') return json(await readState(body, store));
    return json(await update(body, store));
  } catch (error) {
    if (error instanceof GameError) return json({ error: error.message }, error.status);
    console.error('Bluff Bytes function error:', error);
    return json({ error: 'Game service temporarily unavailable. Please retry in a moment.' }, 503);
  }
}

export default async function handler(request: Request, _context: Context): Promise<Response> {
  const store = getStore({ name: STORE_NAME, consistency: 'strong' });
  return handleGameRequest(request, store);
}
