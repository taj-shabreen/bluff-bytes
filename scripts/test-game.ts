import assert from 'node:assert/strict';
import type { getStore } from '@netlify/blobs';
import { handleGameRequest } from '../netlify/functions/game.js';
import type { Room } from '../netlify/game-core.js';
import { TERMS } from '../netlify/game-core.js';

class MemoryBlobStore {
  private entries = new Map<string, { data: unknown; etag: string }>();
  private sequence = 0;

  async getWithMetadata(key: string, _options?: unknown) {
    const entry = this.entries.get(key);
    return entry ? { data: structuredClone(entry.data), etag: entry.etag, metadata: {} } : null;
  }

  async get(key: string, _options?: unknown) {
    const entry = this.entries.get(key);
    return entry ? structuredClone(entry.data) : null;
  }

  async setJSON(key: string, data: unknown, options?: { onlyIfMatch?: string; onlyIfNew?: boolean }) {
    const current = this.entries.get(key);
    if (options?.onlyIfNew && current) return { modified: false };
    if (options?.onlyIfMatch && current?.etag !== options.onlyIfMatch) return { modified: false };
    const etag = `"test-${++this.sequence}"`;
    this.entries.set(key, { data: structuredClone(data), etag });
    return { modified: true, etag };
  }

  async expirePlayer(code: string, token: string) {
    const entry = this.entries.get(code);
    assert.ok(entry);
    const room = structuredClone(entry.data as Room);
    const player = room.players.find(candidate => candidate.token === token);
    assert.ok(player);
    player.lastSeen = Date.now() - 36_000;
    const etag = `"test-${++this.sequence}"`;
    this.entries.set(code, { data: room, etag });
  }
}

const blobs = new MemoryBlobStore();
const store = blobs as unknown as ReturnType<typeof getStore>;

async function call(payload: Record<string, unknown>) {
  const request = new Request('https://example.test/.netlify/functions/game', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const response = await handleGameRequest(request, store);
  const data = await response.json() as Record<string, any>;
  return { status: response.status, ...data };
}

const created = await call({ action: 'create', name: 'TestHost' });
assert.equal(created.status, 200, JSON.stringify(created));
const host = created as { code: string; token: string; state: any };
assert.match(host.code, /^[0-9A-F]{6}$/);
const joined = await call({ action: 'join', code: host.code, name: 'TestPlayer' });
assert.equal(joined.status, 200, JSON.stringify(joined));
const guest = joined as { code: string; token: string; state: any };
assert.equal(guest.state.players.length, 2, 'the lobby should synchronize both players');

const started = await call({ action: 'start', code: host.code, token: host.token });
assert.equal(started.status, 200, JSON.stringify(started));

for (let round = 0; round < TERMS.length; round++) {
  const hostFake = `Host decoy definition ${round + 1}, designed to fool a curious player.`;
  const guestFake = `Player decoy definition ${round + 1}, designed to sound plausible.`;
  const results = await Promise.all([
    call({ action: 'submit', code: host.code, token: host.token, text: hostFake }),
    call({ action: 'submit', code: host.code, token: guest.token, text: guestFake }),
  ]);
  assert.deepEqual(results.map(item => item.status), [200, 200], 'simultaneous submissions should be serialized without lost answers');

  const hostView = await call({ action: 'state', code: host.code, token: host.token });
  const guestView = await call({ action: 'state', code: host.code, token: guest.token });
  assert.equal(hostView.state.phase, 'voting');
  assert.equal(hostView.state.answers.length, 3, 'two fakes plus the true definition should be shown');
  assert.equal(hostView.state.definition, null, 'the truth must remain hidden before reveal');
  assert.ok(hostView.state.answers.every((answer: any) => !('playerId' in answer)), 'author ids must not be sent to voters');

  const realDefinition = hostView.state.answers.find((answer: any) => answer.text === TERMS[round].definition);
  const hostSubmission = hostView.state.answers.find((answer: any) => answer.own);
  const guestViewOfHostSubmission = guestView.state.answers.find((answer: any) => answer.text === hostFake);
  assert.ok(realDefinition, 'the one correct definition should be present');
  assert.ok(hostSubmission, 'the host should be able to identify their own fake');
  assert.ok(guestViewOfHostSubmission, 'the other player should see the host fake without seeing its author');

  const selfVote = await call({ action: 'vote', code: host.code, token: host.token, answerId: hostSubmission.id });
  assert.equal(selfVote.status, 400, 'self-votes must be rejected server-side');
  const votes = await Promise.all([
    call({ action: 'vote', code: host.code, token: host.token, answerId: realDefinition.id }),
    call({ action: 'vote', code: host.code, token: guest.token, answerId: guestViewOfHostSubmission.id }),
  ]);
  assert.deepEqual(votes.map(item => item.status), [200, 200], 'simultaneous votes should not overwrite each other');

  const duplicateVote = await call({ action: 'vote', code: host.code, token: host.token, answerId: realDefinition.id });
  assert.equal(duplicateVote.status, 400, 'a player must not score twice from a duplicate vote');
  const reveal = await call({ action: 'state', code: host.code, token: host.token });
  assert.equal(reveal.state.phase, 'reveal');
  assert.equal(reveal.state.definition, TERMS[round].definition);
  const hostScore = reveal.state.scores.find((score: any) => score.name === 'TestHost').score;
  const guestScore = reveal.state.scores.find((score: any) => score.name === 'TestPlayer').score;
  assert.equal(hostScore, (round + 1) * 3, 'correct vote (+2) plus one fooled player (+1) should score 3 each round');
  assert.equal(guestScore, 0);

  if (round === 1) {
    await blobs.expirePlayer(host.code, guest.token);
    const disconnected = await call({ action: 'state', code: host.code, token: host.token });
    assert.equal(disconnected.state.players.find((player: any) => player.name === 'TestPlayer').connected, false);
    const reconnected = await call({ action: 'heartbeat', code: host.code, token: guest.token });
    assert.equal(reconnected.status, 200, 'the same player token should reconnect during an active game');
    assert.equal(reconnected.state.players.find((player: any) => player.name === 'TestPlayer').connected, true);
    assert.equal(reconnected.state.roundNumber, round + 1);
  }

  if (round < TERMS.length - 1) {
    const next = await call({ action: 'next', code: host.code, token: host.token });
    assert.equal(next.status, 200);
    assert.equal(next.state.roundNumber, round + 2);
  }
}

const finalAdvance = await call({ action: 'next', code: host.code, token: host.token });
assert.equal(finalAdvance.status, 200);
assert.equal(finalAdvance.state.status, 'finished');
assert.equal(finalAdvance.state.winner, finalAdvance.state.me.id);
assert.equal(finalAdvance.state.players.find((player: any) => player.name === 'TestHost').score, 15);
assert.equal(finalAdvance.state.players.find((player: any) => player.name === 'TestPlayer').score, 0);
console.log('PASS: function handler, room creation/join, CAS retries, anonymous answers, vote restrictions, all five rounds, +2/+1 scoring, disconnect/reconnect, and final winner.');
