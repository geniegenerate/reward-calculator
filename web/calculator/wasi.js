/**
 * wasi.js — minimal WASI preview1 shim, just enough to run the published Go
 * (GOOS=wasip1) calculator.wasm as a pure stdin → stdout filter in a browser.
 *
 * No filesystem, no network, no preopened directories: fd 0 is the snapshot
 * bytes you supply, fd 1/2 are captured to buffers. Every other capability
 * reports "not supported", so the binary cannot do anything except compute.
 * The full import list of calculator.wasm is exactly the functions below —
 * enumerate them yourself with WebAssembly.Module.imports() to confirm.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WasiRunner = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ERRNO_SUCCESS = 0;
  const ERRNO_BADF = 8;
  const FILETYPE_CHARACTER_DEVICE = 2;

  class ProcExit {
    constructor(code) { this.code = code; }
  }

  /**
   * Run a wasip1 module: runWasi(wasmModule, stdinBytes) →
   * { exitCode, stdout: Uint8Array, stderr: Uint8Array }.
   */
  async function runWasi(wasmModule, stdinBytes) {
    let memory = null;
    let stdinPos = 0;
    const stdout = [];
    const stderr = [];
    const args = ['calculator'];

    const view = () => new DataView(memory.buffer);
    const bytes = () => new Uint8Array(memory.buffer);

    function readIovs(iovsPtr, iovsLen) {
      const dv = view();
      const out = [];
      for (let i = 0; i < iovsLen; i++) {
        const base = iovsPtr + i * 8;
        out.push({ buf: dv.getUint32(base, true), len: dv.getUint32(base + 4, true) });
      }
      return out;
    }

    const wasi = {
      args_sizes_get(argcPtr, argvBufSizePtr) {
        const dv = view();
        dv.setUint32(argcPtr, args.length, true);
        dv.setUint32(argvBufSizePtr, args.reduce((n, a) => n + a.length + 1, 0), true);
        return ERRNO_SUCCESS;
      },
      args_get(argvPtr, argvBufPtr) {
        const dv = view();
        const mem = bytes();
        let bufAt = argvBufPtr;
        for (let i = 0; i < args.length; i++) {
          dv.setUint32(argvPtr + i * 4, bufAt, true);
          for (const c of args[i]) mem[bufAt++] = c.charCodeAt(0);
          mem[bufAt++] = 0;
        }
        return ERRNO_SUCCESS;
      },
      environ_sizes_get(envcPtr, envBufSizePtr) {
        const dv = view();
        dv.setUint32(envcPtr, 0, true);
        dv.setUint32(envBufSizePtr, 0, true);
        return ERRNO_SUCCESS;
      },
      environ_get() { return ERRNO_SUCCESS; },
      clock_time_get(_id, _precision, timePtr) {
        view().setBigUint64(timePtr, BigInt(Date.now()) * 1000000n, true);
        return ERRNO_SUCCESS;
      },
      fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
        if (fd !== 0) return ERRNO_BADF;
        const mem = bytes();
        let nread = 0;
        for (const iov of readIovs(iovsPtr, iovsLen)) {
          const n = Math.min(iov.len, stdinBytes.length - stdinPos);
          mem.set(stdinBytes.subarray(stdinPos, stdinPos + n), iov.buf);
          stdinPos += n;
          nread += n;
          if (n < iov.len) break; // EOF
        }
        view().setUint32(nreadPtr, nread, true);
        return ERRNO_SUCCESS;
      },
      fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
        if (fd !== 1 && fd !== 2) return ERRNO_BADF;
        const mem = bytes();
        const sink = fd === 1 ? stdout : stderr;
        let nwritten = 0;
        for (const iov of readIovs(iovsPtr, iovsLen)) {
          sink.push(mem.slice(iov.buf, iov.buf + iov.len));
          nwritten += iov.len;
        }
        view().setUint32(nwrittenPtr, nwritten, true);
        return ERRNO_SUCCESS;
      },
      fd_close() { return ERRNO_SUCCESS; },
      fd_fdstat_get(fd, statPtr) {
        if (fd > 2) return ERRNO_BADF;
        const mem = bytes();
        mem.fill(0, statPtr, statPtr + 24);
        mem[statPtr] = FILETYPE_CHARACTER_DEVICE;
        return ERRNO_SUCCESS;
      },
      fd_fdstat_set_flags() { return ERRNO_SUCCESS; },
      // No preopened directories: BADF here is how Go learns there is no fs.
      fd_prestat_get() { return ERRNO_BADF; },
      fd_prestat_dir_name() { return ERRNO_BADF; },
      random_get(bufPtr, bufLen) {
        const buf = bytes().subarray(bufPtr, bufPtr + bufLen);
        (globalThis.crypto || require('node:crypto').webcrypto).getRandomValues(buf);
        return ERRNO_SUCCESS;
      },
      // Report every subscription (Go runtime timers) as immediately fired.
      // rewardcalc is pure compute; an early timer wakeup is harmless.
      poll_oneoff(inPtr, outPtr, nsubs, neventsPtr) {
        const dv = view();
        for (let i = 0; i < nsubs; i++) {
          const sub = inPtr + i * 48;
          const evt = outPtr + i * 32;
          const userdata = dv.getBigUint64(sub, true);
          const tag = dv.getUint8(sub + 8);
          dv.setBigUint64(evt, userdata, true);
          dv.setUint16(evt + 8, ERRNO_SUCCESS, true);
          dv.setUint8(evt + 10, tag, true);
          dv.setBigUint64(evt + 16, 0n, true); // fd_readwrite.nbytes
          dv.setUint16(evt + 24, 0, true); // fd_readwrite.flags
        }
        dv.setUint32(neventsPtr, nsubs, true);
        return ERRNO_SUCCESS;
      },
      sched_yield() { return ERRNO_SUCCESS; },
      proc_exit(code) { throw new ProcExit(code); },
    };

    const instance = await WebAssembly.instantiate(wasmModule, {
      wasi_snapshot_preview1: wasi,
    });
    memory = instance.exports.memory;

    let exitCode = 0;
    try {
      instance.exports._start();
    } catch (e) {
      if (e instanceof ProcExit) {
        exitCode = e.code;
      } else {
        throw e;
      }
    }

    const join = (chunks) => {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) { out.set(c, at); at += c.length; }
      return out;
    };
    return { exitCode, stdout: join(stdout), stderr: join(stderr) };
  }

  return { runWasi };
});
