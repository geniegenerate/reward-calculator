/**
 * ots.js — check an OpenTimestamps proof of the Thai public record against
 * Bitcoin, in the browser, with no server of ours.
 *
 * The Thai deployment holds no coin, so its record is not a contract call: each
 * distribution's statement (date, input and result roots, algorithm id) is
 * hashed with SHA-256 and stamped with OpenTimestamps. The proof is a short
 * chain of hash operations from that hash to the merkle root of a Bitcoin
 * block. This file walks that chain and asks two independent public Bitcoin
 * explorers for the block's merkle root. If they match, the statement existed
 * when that block was mined, and nobody (us included) could have changed it
 * after.
 *
 * Format: https://github.com/opentimestamps/python-opentimestamps (detached
 * timestamp file). Only the operations a calendar uses are evaluated here:
 * append, prepend, sha256, reverse, hexlify; anything else is refused.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.rewardOts = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAGIC = hexToBytes('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294');
  const TAG_BITCOIN = '0588960d73d71901';
  const TAG_PENDING = '83dfe30d2ef90c8e';
  const MAX_DEPTH = 256;
  const MAX_MSG = 4096;
  // Two explorers run by different operators; the first that answers wins.
  const EXPLORERS = ['https://blockstream.info/api', 'https://mempool.space/api'];

  function hexToBytes(h) {
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  function toHex(b) {
    let s = '';
    for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
  }
  function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  // ---- SHA-256 (FIPS 180-4), synchronous so the proof walks in one pass ----
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  function sha256(msg) {
    const bitLen = msg.length * 8;
    const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
    padded.set(msg);
    padded[msg.length] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
    dv.setUint32(padded.length - 4, bitLen >>> 0);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
    return out;
  }

  // ---- reader ---------------------------------------------------------------
  function reader(bytes) {
    let pos = 0;
    const need = (n) => {
      if (pos + n > bytes.length) throw new Error('malformed proof: truncated');
    };
    return {
      byte() { need(1); return bytes[pos++]; },
      bytes(n) { need(n); const b = bytes.subarray(pos, pos + n); pos += n; return b; },
      varuint() {
        let v = 0, shift = 0;
        for (;;) {
          const b = this.byte();
          v += (b & 0x7f) * Math.pow(2, shift);
          if (!(b & 0x80)) return v;
          shift += 7;
          if (shift > 49) throw new Error('malformed proof: varuint too long');
        }
      },
      varbytes(max) {
        const n = this.varuint();
        if (n > max) throw new Error('malformed proof: field too long');
        return this.bytes(n);
      },
      done() { return pos === bytes.length; },
    };
  }

  function applyOp(tag, arg, msg) {
    let out;
    switch (tag) {
      case 0xf0: out = concat(msg, arg); break; // append
      case 0xf1: out = concat(arg, msg); break; // prepend
      case 0x08: out = sha256(msg); break;
      case 0xf2: out = msg.slice().reverse(); break;
      case 0xf3: out = new TextEncoder().encode(toHex(msg)); break;
      default: throw new Error('unsupported operation 0x' + tag.toString(16) + ' in proof');
    }
    if (out.length > MAX_MSG) throw new Error('malformed proof: message too long');
    return out;
  }

  function readAttestation(r, msg, out) {
    const tag = toHex(r.bytes(8));
    const payload = r.varbytes(8192);
    const p = reader(payload);
    if (tag === TAG_BITCOIN) {
      out.push({ kind: 'bitcoin', height: p.varuint(), message: toHex(msg) });
    } else if (tag === TAG_PENDING) {
      out.push({ kind: 'pending', uri: new TextDecoder().decode(p.varbytes(1000)), message: toHex(msg) });
    } else {
      out.push({ kind: 'unknown', tag: tag, message: toHex(msg) });
    }
  }

  function readTimestamp(r, msg, depth, out) {
    if (depth > MAX_DEPTH) throw new Error('malformed proof: too deep');
    for (;;) {
      let tag = r.byte();
      const more = tag === 0xff;
      if (more) tag = r.byte();
      if (tag === 0x00) {
        readAttestation(r, msg, out);
      } else {
        const arg = tag === 0xf0 || tag === 0xf1 ? r.varbytes(MAX_MSG) : null;
        readTimestamp(r, applyOp(tag, arg, msg), depth + 1, out);
      }
      if (!more) return;
    }
  }

  /** Parse a detached .ots proof: the stamped SHA-256 and every attestation. */
  function parse(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length < MAGIC.length || toHex(b.subarray(0, MAGIC.length)) !== toHex(MAGIC)) {
      throw new Error('not an OpenTimestamps proof');
    }
    const r = reader(b.subarray(MAGIC.length));
    if (r.varuint() !== 1) throw new Error('unsupported proof version');
    if (r.byte() !== 0x08) throw new Error('unsupported proof: the file hash is not SHA-256');
    const digest = r.bytes(32);
    const attestations = [];
    readTimestamp(r, digest, 0, attestations);
    if (!r.done()) throw new Error('malformed proof: trailing bytes');
    return { digest: toHex(digest), attestations: attestations };
  }

  /** The statement the backend stamps for a day (REWARD_SYSTEM v3.73). */
  function distributionStatement(date, inputRoot, resultRoot, algorithmId) {
    return 'reward distribution\n' +
      'challenge_date: ' + date + '\n' +
      'input_root: ' + inputRoot + '\n' +
      'result_root: ' + resultRoot + '\n' +
      'algorithm_id: ' + algorithmId + '\n';
  }

  async function blockAt(height, fetchFn) {
    let lastErr = null;
    for (const base of EXPLORERS) {
      try {
        const h = await fetchFn(base + '/block-height/' + height);
        if (!h.ok) throw new Error(base + ' HTTP ' + h.status);
        const hash = (await h.text()).trim();
        const blk = await fetchFn(base + '/block/' + hash);
        if (!blk.ok) throw new Error(base + ' HTTP ' + blk.status);
        const j = await blk.json();
        return { merkleRoot: String(j.merkle_root).toLowerCase(), time: j.timestamp, explorer: base };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error('no Bitcoin explorer answered (' + (lastErr && lastErr.message) + ')');
  }

  /**
   * Check the proof's Bitcoin attestations against the block headers.
   * status: attested | mismatch | pending (receipts only) | unreachable | none
   */
  async function verifyBitcoin(info, fetchFn) {
    const btc = info.attestations.filter((a) => a.kind === 'bitcoin');
    const calendars = info.attestations.filter((a) => a.kind === 'pending').map((a) => a.uri);
    if (!btc.length) return { status: calendars.length ? 'pending' : 'none', calendars: calendars };
    let unreachable = null;
    let mismatch = null;
    for (const a of btc.sort((x, y) => x.height - y.height)) {
      try {
        const blk = await blockAt(a.height, fetchFn);
        const expected = toHex(hexToBytes(a.message).reverse());
        if (blk.merkleRoot === expected) {
          return { status: 'attested', height: a.height, time: blk.time, explorer: blk.explorer, calendars: calendars };
        }
        mismatch = { status: 'mismatch', height: a.height, expected: expected, found: blk.merkleRoot };
      } catch (e) {
        unreachable = { status: 'unreachable', height: a.height, error: e.message };
      }
    }
    return mismatch || unreachable;
  }

  return { parse, sha256, distributionStatement, verifyBitcoin, toHex, hexToBytes };
});
