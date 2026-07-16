/**
 * app.js — page wiring for the GenieGenerate reward web calculator.
 *
 * Pipeline (all client-side; this page makes no request to GenieGenerate):
 *   1. You drop the input snapshot JSON exported from the app.
 *   2. The page keccak256-hashes the bundled calculator.wasm — that hash IS the
 *      algorithm_id; it must equal the snapshot's and the on-chain one.
 *   3. It recomputes the input Merkle root from the snapshot, runs the WASM on
 *      the snapshot, and recomputes the result Merkle root from its output.
 *   4. It reads the committed roots from the RewardVerifier contract over
 *      public BSC JSON-RPC and compares. Green means: the inputs you were
 *      shown and the rewards you were paid are exactly what was committed
 *      on-chain before crediting, under the published open-source algorithm.
 */
/* global keccak256, rewardMerkle, WasiRunner, rewardChain */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const state = {
    snapshot: null, // parsed input-snapshot JSON
    result: null, // parsed published result JSON (optional)
    wasmBytes: null, // Uint8Array of the calculator binary
    wasmHash: null, // 0x keccak256 of wasmBytes
  };

  // ---- tiny render helpers ---------------------------------------------------

  function setStatus(id, kind, text) {
    const el = $(id);
    el.className = 'status ' + kind;
    el.textContent = text;
    el.hidden = false;
  }

  function hashRow(label, value, ok) {
    const cls = ok === undefined ? '' : ok ? ' ok' : ' bad';
    const mark = ok === undefined ? '' : ok ? ' ✓' : ' ✗';
    return (
      '<div class="hash-row' + cls + '"><span class="hash-label">' + label + mark +
      '</span><code class="hash">' + value + '</code></div>'
    );
  }

  // ---- step 1: snapshot ---------------------------------------------------------

  function looksLikeSnapshot(doc) {
    return doc && Array.isArray(doc.participants) && doc.pool && doc.input_merkle_root;
  }
  function looksLikeResult(doc) {
    return doc && Array.isArray(doc.participants) && doc.result_merkle_root;
  }

  function acceptJSON(name, doc) {
    if (looksLikeSnapshot(doc)) {
      state.snapshot = doc;
      setStatus(
        'snapshot-status',
        'ok',
        name + ' — distribution ' + doc.challenge_date + ', ' +
          doc.participants.length.toLocaleString() + ' participant(s)'
      );
    } else if (looksLikeResult(doc)) {
      state.result = doc;
      setStatus('result-status', 'ok', name + ' — published result file loaded (optional cross-check)');
    } else {
      setStatus('snapshot-status', 'bad', name + ': not a snapshot or result file from the app');
      return;
    }
    maybeVerify();
  }

  async function onFiles(files) {
    for (const f of files) {
      if (f.name.endsWith('.wasm')) {
        const buf = new Uint8Array(await f.arrayBuffer());
        await loadWasm(buf, f.name + ' (dropped)');
        continue;
      }
      try {
        acceptJSON(f.name, JSON.parse(await f.text()));
      } catch (e) {
        setStatus('snapshot-status', 'bad', f.name + ': ' + e.message);
      }
    }
  }

  // ---- step 2: algorithm binary ---------------------------------------------------

  async function loadWasm(bytes, origin) {
    state.wasmBytes = bytes;
    state.wasmHash = '0x' + keccak256(bytes.buffer ? bytes : new Uint8Array(bytes));
    $('wasm-info').innerHTML =
      hashRow('keccak256(' + origin + ')', state.wasmHash) +
      '<p class="note">This hash IS the algorithm_id. Rebuild the binary from ' +
      '<a href="https://github.com/geniegenerate/reward-calculator" rel="noopener">source</a> to confirm it yourself.</p>';
    maybeVerify();
  }

  async function fetchBundledWasm() {
    try {
      const res = await fetch('calculator.wasm');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await loadWasm(new Uint8Array(await res.arrayBuffer()), 'calculator.wasm');
    } catch (e) {
      setStatus('wasm-status', 'bad', 'could not load bundled calculator.wasm: ' + e.message +
        ' — drop a calculator.wasm from a GitHub release instead');
    }
  }

  // ---- step 3: verify -----------------------------------------------------------

  let running = false;

  async function maybeVerify() {
    if (!state.snapshot || !state.wasmBytes || running) return;
    running = true;
    try {
      await verify();
    } catch (e) {
      setStatus('verdict', 'bad', 'verification failed: ' + e.message);
    } finally {
      running = false;
    }
  }

  async function verify() {
    const snap = state.snapshot;
    const out = $('verify-detail');
    setStatus('verdict', 'busy', 'verifying…');
    out.innerHTML = '';

    // Algorithm identity: bundled/dropped binary vs the snapshot's claim.
    const algoMatchesSnapshot = state.wasmHash === snap.algorithm_id;

    // 1. Input root, recomputed from the snapshot fields alone.
    const inputRoot = rewardMerkle.inputRootFromSnapshot(snap.participants);

    // 2. Run the algorithm on the snapshot (map the published field names onto
    // the calculator's input schema — same data, no additions).
    const calcInput = {
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
    const mod = await WebAssembly.compile(state.wasmBytes);
    const run = await WasiRunner.runWasi(mod, enc.encode(JSON.stringify(calcInput)));
    if (run.exitCode !== 0) {
      throw new Error('calculator exited ' + run.exitCode + ': ' + dec.decode(run.stderr));
    }
    const calcOut = JSON.parse(dec.decode(run.stdout));

    // 3. Result root from the calculator's own output.
    const resultRoot = calcOut.members.length
      ? rewardMerkle.resultRootFromMembers(calcOut.members)
      : '0x' + keccak256('GENIEGENERATE_EMPTY_MERKLE_ROOT');

    // 4. The on-chain commitment — the trust anchor.
    let chain = null;
    let chainErr = null;
    try {
      chain = await rewardChain.getCommitment(snap.challenge_date);
    } catch (e) {
      chainErr = e.message;
    }

    const rows = [];
    rows.push(hashRow('algorithm_id (this binary)', state.wasmHash, algoMatchesSnapshot));
    rows.push(hashRow('input Merkle root (recomputed)', inputRoot,
      chain ? inputRoot === chain.inputMerkleRoot : undefined));
    rows.push(hashRow('result Merkle root (recomputed)', resultRoot,
      chain ? resultRoot === chain.resultMerkleRoot : undefined));
    if (chain) {
      rows.push(hashRow('on-chain input root', chain.inputMerkleRoot));
      rows.push(hashRow('on-chain result root', chain.resultMerkleRoot));
      rows.push(hashRow('on-chain algorithm_id', chain.algorithmId, chain.algorithmId === state.wasmHash));
    }
    if (state.result) {
      rows.push(hashRow('published result file root', state.result.result_merkle_root,
        state.result.result_merkle_root === resultRoot));
    }
    out.innerHTML = rows.join('');

    if (chain) {
      const allGood =
        algoMatchesSnapshot &&
        inputRoot === chain.inputMerkleRoot &&
        resultRoot === chain.resultMerkleRoot &&
        chain.algorithmId === state.wasmHash;
      if (allGood) {
        setStatus('verdict', 'ok',
          'VERIFIED — recomputed on this device, matches the on-chain commitment for ' + snap.challenge_date);
      } else if (!algoMatchesSnapshot) {
        setStatus('verdict', 'warn',
          'algorithm mismatch: this binary is not the version that computed ' + snap.challenge_date +
          '. Download the matching release for ' + snap.algorithm_id.slice(0, 10) +
          '… from GitHub and drop the .wasm here.');
      } else {
        setStatus('verdict', 'bad', 'MISMATCH — recomputed values differ from the on-chain commitment');
      }
    } else {
      setStatus('verdict', 'warn',
        'computed locally, but BSC RPC unreachable (' + chainErr + '). Compare the roots above against ' +
        'getCommitment on BscScan yourself.');
    }
    $('explorer-link').hidden = false;

    renderMembers(snap, calcOut);
  }

  // ---- member table (find your pseudonym) --------------------------------------

  function renderMembers(snap, calcOut) {
    const byKey = new Map(snap.participants.map((p) => [p.ordering_key, p.pseudonym]));
    const rows = calcOut.members.map((m) => ({
      pseudonym: byKey.get(m.ordering_key) || '#' + m.ordering_key,
      credited: rewardMerkle.normalize6(m.credited_amount),
      loyalty: rewardMerkle.normalize6(m.loyalty_reward),
      newcomer: rewardMerkle.normalize6(m.newcomer_reward),
    }));
    const section = $('members-section');
    section.hidden = false;
    const render = (filter) => {
      const match = filter
        ? rows.filter((r) => r.pseudonym.toLowerCase().includes(filter.toLowerCase()))
        : rows;
      const shown = match.slice(0, 200);
      $('members-body').innerHTML = shown
        .map((r) =>
          '<tr><td>' + r.pseudonym + '</td><td class="num">' + r.loyalty +
          '</td><td class="num">' + r.newcomer + '</td><td class="num">' + r.credited + '</td></tr>')
        .join('');
      $('members-count').textContent =
        shown.length === match.length
          ? match.length + ' member(s)'
          : 'first ' + shown.length + ' of ' + match.length + ' — refine the filter';
    };
    $('members-filter').oninput = (e) => render(e.target.value.trim());
    render('');
  }

  // ---- boot ------------------------------------------------------------------------

  window.addEventListener('DOMContentLoaded', () => {
    const drop = $('dropzone');
    const picker = $('file-picker');
    drop.addEventListener('click', () => picker.click());
    drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') picker.click();
    });
    picker.addEventListener('change', () => onFiles([...picker.files]));
    ['dragover', 'dragenter'].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => onFiles([...e.dataTransfer.files]));

    $('explorer-link').href = rewardChain.EXPLORER;
    fetchBundledWasm();
  });
})();
