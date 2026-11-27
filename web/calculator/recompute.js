/**
 * recompute.js — the part of verification that needs no anchor: recompute a
 * distribution's input and result Merkle roots on this device from the
 * published input snapshot, by running the published calculator.wasm.
 *
 * Shared by the BSC page (calculator/app.js, which then reads the roots from
 * the RewardVerifier contract) and the Thai page (th/app.js, which checks them
 * against an OpenTimestamps proof in Bitcoin).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./sha3.js').keccak256, require('./merkle.js'), require('./wasi.js'));
  } else {
    root.rewardRecompute = factory(root.keccak256, root.rewardMerkle, root.WasiRunner);
  }
})(typeof self !== 'undefined' ? self : this, function (keccak256, rewardMerkle, WasiRunner) {
  'use strict';

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /** The calculator's input, from the snapshot's published fields only. */
  function calculatorInput(snap) {
    const input = {
      participants: snap.participants.map((p) => ({
        ordering_key: p.ordering_key,
        loyalty_score: p.loyalty_score,
        completion_rank: p.completion_rank,
        lifetime_earnings: p.lifetime_earnings_usdt,
        wallet_balance: p.wallet_balance_usdt,
        max_capacity: p.max_capacity_usdt,
      })),
      loyalty_pool: snap.pool.loyalty_pool,
      newcomer_pool: snap.pool.newcomer_pool,
    };
    // v5.0 inputs, forwarded only when the snapshot carries them: an older
    // calculator refuses fields it does not know, and its days never have them.
    if (snap.pool.newcomer_restoration !== undefined) {
      input.newcomer_restoration = snap.pool.newcomer_restoration;
    }
    if (snap.final_round !== undefined) input.final_round = snap.final_round;
    // v6.0 input: present on every v6.0 day (even when zero), because its
    // presence selects the no-deduction math.
    if (snap.pool.pool_seeds !== undefined) input.pool_seeds = snap.pool.pool_seeds;
    return input;
  }

  /** Recompute { inputRoot, resultRoot, calcOut } for a snapshot. */
  async function run(snap, wasmBytes) {
    const inputRoot = rewardMerkle.inputRootFromSnapshot(snap.participants);
    const mod = await WebAssembly.compile(wasmBytes);
    const out = await WasiRunner.runWasi(mod, enc.encode(JSON.stringify(calculatorInput(snap))));
    if (out.exitCode !== 0) {
      throw new Error('calculator exited ' + out.exitCode + ': ' + dec.decode(out.stderr));
    }
    const calcOut = JSON.parse(dec.decode(out.stdout));
    const resultRoot = calcOut.members.length
      ? rewardMerkle.resultRootFromMembers(calcOut.members)
      : '0x' + keccak256('GENIEGENERATE_EMPTY_MERKLE_ROOT');
    return { inputRoot: inputRoot, resultRoot: resultRoot, calcOut: calcOut };
  }

  return { run: run, calculatorInput: calculatorInput };
});
