// Tests for web/th/ots.js — the OpenTimestamps check of the Thai public
// record. Run: node --test test/
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const ots = require('../web/th/ots.js');

const sha = (b) => new Uint8Array(crypto.createHash('sha256').update(b).digest());
const hex = (b) => Buffer.from(b).toString('hex');
const cat = (...parts) => new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
const MAGIC = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex');
const varbytes = (b) => cat([b.length], b);
const BTC = Buffer.from('0588960d73d71901', 'hex');
const PENDING = Buffer.from('83dfe30d2ef90c8e', 'hex');

// A detached proof for `digest`: append(nonce) → sha256 → fork into
//   prepend(p) → sha256 → Bitcoin attestation at `height`
//   pending attestation at `uri`
function buildProof(digest, height, uri) {
  const nonce = Buffer.alloc(16, 7);
  const prefix = Buffer.alloc(32, 9);
  const heightBytes = Buffer.from([height & 0x7f | 0x80, (height >> 7) & 0x7f | 0x80, height >> 14]);
  const btcItem = cat([0x00], BTC, varbytes(heightBytes));
  const pendingItem = cat([0x00], PENDING, varbytes(varbytes(Buffer.from(uri))));
  const branchBtc = cat([0xf1], varbytes(prefix), [0x08], btcItem);
  const tree = cat([0xf0], varbytes(nonce), [0x08], [0xff], pendingItem, branchBtc);
  const proof = cat(MAGIC, [0x01, 0x08], digest, tree);
  const leaf = sha(cat(prefix, sha(cat(digest, nonce))));
  return { proof, leaf };
}

test('parses a proof and evaluates each attestation message', () => {
  const digest = sha(Buffer.from('reward distribution\n'));
  const { proof, leaf } = buildProof(digest, 925001, 'https://alice.btc.calendar.opentimestamps.org');
  const info = ots.parse(proof);
  assert.strictEqual(info.digest, hex(digest));
  const btc = info.attestations.find((a) => a.kind === 'bitcoin');
  assert.strictEqual(btc.height, 925001);
  assert.strictEqual(btc.message, hex(leaf));
  const pending = info.attestations.find((a) => a.kind === 'pending');
  assert.strictEqual(pending.uri, 'https://alice.btc.calendar.opentimestamps.org');
});

test('refuses what is not an OpenTimestamps proof', () => {
  assert.throws(() => ots.parse(new Uint8Array([1, 2, 3])), /not an OpenTimestamps proof/);
  const bad = cat(MAGIC, [0x01, 0x08], Buffer.alloc(32), [0xf0]); // truncated op
  assert.throws(() => ots.parse(bad), /truncated|malformed/);
});

test('sha256 matches node crypto', () => {
  for (const s of ['', 'abc', 'x'.repeat(1000)]) {
    assert.strictEqual(hex(ots.sha256(new TextEncoder().encode(s))), hex(sha(Buffer.from(s))));
  }
});

test('the statement is rebuilt exactly as the backend stamps it', () => {
  const s = ots.distributionStatement('2026-11-27', '0x' + '11'.repeat(32), '0x' + '22'.repeat(32), '0x' + 'cd'.repeat(32));
  assert.strictEqual(s,
    'reward distribution\nchallenge_date: 2026-11-27\ninput_root: 0x' + '11'.repeat(32) +
    '\nresult_root: 0x' + '22'.repeat(32) + '\nalgorithm_id: 0x' + 'cd'.repeat(32) + '\n');
});

// Bitcoin stores the block's merkle root little-endian; explorers print it
// reversed. The attested message must equal the reversed printed root.
function fakeExplorer(height, merkleRootDisplay, { failFirst = false } = {}) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (failFirst && url.startsWith('https://blockstream.info')) return { ok: false, status: 503 };
    if (url.endsWith('/block-height/' + height)) return { ok: true, text: async () => 'blockhash' + height };
    if (url.endsWith('/block/blockhash' + height)) return { ok: true, json: async () => ({ merkle_root: merkleRootDisplay, timestamp: 1764200000 }) };
    return { ok: false, status: 404 };
  };
  return { fetchFn, calls };
}

test('a Bitcoin attestation is checked against the block header', async () => {
  const digest = sha(Buffer.from('s'));
  const { proof, leaf } = buildProof(digest, 925001, 'https://a.example');
  const display = hex(Buffer.from(leaf).reverse());
  const { fetchFn } = fakeExplorer(925001, display);
  const v = await ots.verifyBitcoin(ots.parse(proof), fetchFn);
  assert.strictEqual(v.status, 'attested');
  assert.strictEqual(v.height, 925001);
  assert.strictEqual(v.time, 1764200000);
});

test('a second explorer answers when the first is down', async () => {
  const digest = sha(Buffer.from('s'));
  const { proof, leaf } = buildProof(digest, 925001, 'https://a.example');
  const { fetchFn, calls } = fakeExplorer(925001, hex(Buffer.from(leaf).reverse()), { failFirst: true });
  const v = await ots.verifyBitcoin(ots.parse(proof), fetchFn);
  assert.strictEqual(v.status, 'attested');
  assert.ok(calls.some((u) => u.startsWith('https://mempool.space')));
});

test('a block whose merkle root differs is a mismatch, never attested', async () => {
  const digest = sha(Buffer.from('s'));
  const { proof } = buildProof(digest, 925001, 'https://a.example');
  const { fetchFn } = fakeExplorer(925001, 'ab'.repeat(32));
  const v = await ots.verifyBitcoin(ots.parse(proof), fetchFn);
  assert.strictEqual(v.status, 'mismatch');
});

test('a proof with only calendar receipts is pending', async () => {
  const digest = sha(Buffer.from('s'));
  const nonce = Buffer.alloc(16, 1);
  const pendingItem = cat([0x00], PENDING, varbytes(varbytes(Buffer.from('https://b.example'))));
  const proof = cat(MAGIC, [0x01, 0x08], digest, [0xf0], varbytes(nonce), [0x08], pendingItem);
  const v = await ots.verifyBitcoin(ots.parse(proof), async () => { throw new Error('no network expected'); });
  assert.strictEqual(v.status, 'pending');
  assert.deepStrictEqual(v.calendars, ['https://b.example']);
});

test('explorers unreachable is reported as such, not as a mismatch', async () => {
  const digest = sha(Buffer.from('s'));
  const { proof } = buildProof(digest, 925001, 'https://a.example');
  const v = await ots.verifyBitcoin(ots.parse(proof), async () => ({ ok: false, status: 503 }));
  assert.strictEqual(v.status, 'unreachable');
});
