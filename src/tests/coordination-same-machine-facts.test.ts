import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  collectNativeSameMachineFacts, parseNativeBootSessionUuid, parseNativeBootTime,
  parseUtcPsStart, sameNativeMachineFacts, validateNativePidList, validatePreBootRecordTimes,
  type NativeSameMachineFacts,
} from "../resources/extensions/gsd/coordination-same-machine-facts.ts";

const boot = {
  currentHost: "fixture.invalid", bootSessionHash: "a".repeat(64),
  bootLowerBoundMs: Date.parse("2026-01-02T00:00:00Z"),
  bootUpperBoundMs: Date.parse("2026-01-02T00:00:00Z") + 1,
  observedAtMs: Date.parse("2026-01-03T00:00:00Z"),
};
const times = {
  startedAt: "2026-01-01T10:00:00.000Z", lastHeartbeatAt: "2026-01-01T12:00:00.000Z",
  acquiredAt: "2026-01-01T10:30:00.000Z", expiresAt: "2026-01-01T11:00:00.000Z",
};

test("preboot ordering permits heartbeat after expiry and preserves strings", () => {
  const original = JSON.stringify(times);
  assert.equal(validatePreBootRecordTimes(times, boot), true);
  assert.equal(validatePreBootRecordTimes({ startedAt: times.startedAt, lastHeartbeatAt: times.lastHeartbeatAt }, boot), true);
  assert.equal(validatePreBootRecordTimes({ ...times, lastHeartbeatAt: times.startedAt }, boot), true);
  assert.equal(validatePreBootRecordTimes({ ...times, startedAt: "2026-01-01T13:00:00Z" }, boot), false);
  assert.equal(validatePreBootRecordTimes({ ...times, acquiredAt: times.expiresAt, expiresAt: times.acquiredAt }, boot), false);
  assert.equal(JSON.stringify(times), original);
});

test("explicit calendar, zone and precision validation fails closed", () => {
  for (const bad of ["", "2026-01-01", "2026-01-01T10:00:00", "2026-01-01 10:00:00Z",
    "2026-02-29T10:00:00Z", "2024-02-30T10:00:00Z", "2026-04-31T10:00:00Z",
    "2026-00-01T10:00:00Z", "2026-13-01T10:00:00Z", "2026-01-00T10:00:00Z",
    "2026-01-01T24:00:00Z", "2026-01-01T10:60:00Z", "2026-01-01T10:00:60Z",
    "2026-01-01T10:00:00-00:00", "2026-01-01T10:00:00+24:00", "2026-01-01T10:00:00+01:60",
    "2026-01-01T10:00:00+0100", "2026-01-01T10:00:00.1234567890Z", "2026-01-01T10:00:00.Z",
    " 2026-01-01T10:00:00Z", "2026-01-01T10:00:00Z\n"]) {
    assert.equal(validatePreBootRecordTimes({ ...times, startedAt: bad }, boot), false, bad);
  }
  assert.equal(validatePreBootRecordTimes({ ...times, startedAt: "2024-02-29T10:00:00+02:00" }, boot), true);
  assert.equal(validatePreBootRecordTimes({ ...times, startedAt: "2026-01-01T09:00:00-01:00" }, boot), true);
  assert.equal(validatePreBootRecordTimes({ ...times, startedAt: "2026-01-01T10:00:00.000000002Z", lastHeartbeatAt: "2026-01-01T10:00:00.000000001Z" }, boot), false);
});

test("all selected times strictly predate conservative boot lower bound", () => {
  for (const key of Object.keys(times)) {
    for (const value of ["2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.001Z", "2026-01-01T23:59:59Z", "2026-01-01T23:59:59.999Z", "2026-01-02T01:00:00+01:00"]) {
      assert.equal(validatePreBootRecordTimes({ ...times, [key]: value }, boot), false, key + value);
    }
  }
  assert.equal(validatePreBootRecordTimes({ ...times, expiresAt: "2026-01-01T23:59:59.998Z" }, boot), true);
  for (const partial of [{ acquiredAt: undefined }, { expiresAt: undefined }, { acquiredAt: null }, { expiresAt: "" }]) {
    assert.equal(validatePreBootRecordTimes({ ...times, ...partial } as typeof times, boot), false);
  }
  for (const invalid of [{ bootLowerBoundMs: NaN }, { bootUpperBoundMs: boot.bootLowerBoundMs - 1 }, { observedAtMs: boot.bootLowerBoundMs - 1 }, { bootSessionHash: "" }, { bootSessionHash: boot.bootSessionHash + "\n" }, { currentHost: "" }]) {
    assert.equal(validatePreBootRecordTimes(times, { ...boot, ...invalid }), false);
  }
});

test("sysctl boot time and boot session UUID parsing", () => {
  assert.deepEqual(parseNativeBootTime("{ sec = 1767312000, usec = 123456 } Fri Jan  2 00:00:00 2026\n"), {
    bootLowerBoundMs: 1767312000123, bootUpperBoundMs: 1767312000124,
  });
  for (const bad of ["", "1767312000", "{ sec = -1, usec = 0 }", "{ sec = 1, usec = 1000000 }", "{ sec = 1, usec = -1 }", "{ sec = 1, usec = 0 } garbage", "{ sec = 9007199254740991, usec = 0 }", "{ sec = 1767312000, usec = 0 } Fri Jan  2 00:00:01 2026", "{ sec = 1767312000, usec = 0 }\n\n"]) {
    assert.throws(() => parseNativeBootTime(bad), { code: "invalid-boot" });
  }
  const uuid = "12345678-1234-4234-8234-123456789abc";
  assert.match(parseNativeBootSessionUuid(uuid + "\n"), /^[a-f0-9]{64}$/);
  assert.equal(parseNativeBootSessionUuid(uuid), parseNativeBootSessionUuid(uuid.toUpperCase()));
  for (const bad of ["", "00000000-0000-0000-0000-000000000000", uuid + "\nextra", uuid + "\n\n", " " + uuid, "hardware-serial", "ffffffff-ffff-ffff-ffff-ffffffffffff", "12345678-1234-0234-8234-123456789abc", "12345678-1234-4234-0234-123456789abc"]) {
    assert.throws(() => parseNativeBootSessionUuid(bad), { code: "invalid-boot" });
  }
});

test("UTC ps birth requires calendar and weekday agreement", () => {
  assert.deepEqual(parseUtcPsStart("Thu Jan  1 10:00:00 2026"), {
    startedLowerBoundMs: Date.parse(times.startedAt), startedUpperBoundMs: Date.parse(times.startedAt) + 1000,
  });
  for (const bad of ["Wed Jan  1 10:00:00 2026", "Thu Feb 30 10:00:00 2026", "Thu Jan  1 24:00:00 2026", "Thu Jan  1 10:00:60 2026", "Thu Jan  1 10:00:00 2026 UTC", "Thu Jan  1 10:00:00 2026\nextra", "Thu Jan  1 10:00:00 2026\n", "unknown"]) {
    assert.throws(() => parseUtcPsStart(bad), { code: "ambiguous-pid" });
  }
});

test("PID lists bounded to unique positive signed OS integers", () => {
  assert.deepEqual(validateNativePidList([1, 2147483647]), [1, 2147483647]);
  assert.deepEqual(validateNativePidList([]), []);
  assert.equal(validateNativePidList(Array.from({ length: 1024 }, (_, i) => i + 1)).length, 1024);
  for (const bad of [[0], [-1], [1.1], [NaN], [Infinity], [2147483648], ["1"], [1, 1], Array(1025).fill(1), null, {}, [undefined]]) {
    assert.throws(() => validateNativePidList(bad as number[]), { code: "invalid-pids" });
  }
});

const snapshot = (): NativeSameMachineFacts => ({ boot: { ...boot }, pids: [
  { pid: 1, state: "present", processIdentity: "b".repeat(64), startedLowerBoundMs: boot.bootUpperBoundMs + 1000, startedUpperBoundMs: boot.bootUpperBoundMs + 2000 },
  { pid: 2147483647, state: "absent", processIdentity: null },
] });

test("comparison ignores observedAt only, not host/boot/PID/birth states", () => {
  const a = snapshot();
  assert.equal(sameNativeMachineFacts(a, { ...snapshot(), boot: { ...boot, observedAtMs: boot.observedAtMs + 1000 } }), true);
  assert.equal(sameNativeMachineFacts(a, { ...snapshot(), pids: snapshot().pids.reverse() }), true);
  for (const change of [{ currentHost: "other.invalid" }, { bootSessionHash: "c".repeat(64) }, { bootLowerBoundMs: boot.bootLowerBoundMs - 1 }, { bootUpperBoundMs: boot.bootUpperBoundMs + 1 }]) {
    assert.equal(sameNativeMachineFacts(a, { ...snapshot(), boot: { ...boot, ...change } }), false);
  }
  for (const change of [{ pid: 2 }, { state: "absent" }, { processIdentity: "c".repeat(64) }, { startedLowerBoundMs: boot.bootUpperBoundMs + 1001 }, { startedUpperBoundMs: boot.bootUpperBoundMs + 2001 }]) {
    const b = snapshot(); Object.assign(b.pids[0], change);
    assert.equal(sameNativeMachineFacts(a, b), false);
  }
  assert.equal(sameNativeMachineFacts(a, { ...snapshot(), pids: [] }), false);
  assert.equal(sameNativeMachineFacts(a, { ...snapshot(), pids: [a.pids[0], a.pids[0]] }), false);
  for (const bad of [null, {}, { ...snapshot(), pids: [{ pid: 1, state: "unknown", processIdentity: null }] }, { ...snapshot(), pids: [{ pid: 1, state: "present", processIdentity: null }] }]) {
    assert.equal(sameNativeMachineFacts(bad as NativeSameMachineFacts, bad as NativeSameMachineFacts), false);
  }
});

test("unsupported platform explicitly refused without native commands", () => {
  const url = new URL("../resources/extensions/gsd/coordination-same-machine-facts.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { collectNativeSameMachineFacts } = await import(${JSON.stringify(url)});
    try { collectNativeSameMachineFacts([1]); process.exitCode = 1; }
    catch (error) { if (error.code !== 'unsupported-platform') throw error; }
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
});

test("read-only own-PID/impossible-PID smoke or explicit unsupported refusal", () => {
  if (process.platform !== "darwin") {
    assert.throws(() => collectNativeSameMachineFacts([process.pid]), { code: "unsupported-platform" });
    return;
  }
  const start = performance.now();
  const facts = collectNativeSameMachineFacts([process.pid, 2147483647]);
  assert.ok(performance.now() - start < 5500);
  assert.equal(facts.pids[0].state, "present");
  assert.match(facts.pids[0].processIdentity!, /^[a-f0-9]{64}$/);
  assert.ok(facts.pids[0].startedLowerBoundMs! > facts.boot.bootUpperBoundMs);
  assert.deepEqual(facts.pids[1], { pid: 2147483647, state: "absent", processIdentity: null });
  assert.equal(sameNativeMachineFacts(facts, facts), true);
});

// Fault injection lives ONLY in an isolated test subprocess's Node builtins.
// The production module exposes no observer, platform, clock or identity override.
test("native failures, races and resource bounds fail closed with bounded codes", {}, () => {
  const url = new URL("../resources/extensions/gsd/coordination-same-machine-facts.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import os from 'node:os';
    import { performance } from 'node:perf_hooks';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    let mode = '', elapsed = 0, bootReads = 0, probes = 0, hostReads = 0, calls = 0, psReads = 0;
    Object.defineProperty(performance, 'now', { value: () => elapsed });
    os.hostname = () => ++hostReads > 1 && mode === 'host-change' ? 'changed.invalid' : 'fixture.invalid';
    process.kill = (pid, signal) => {
      assert.equal(signal, 0);
      assert.equal(pid, 123);
      probes++;
      if ((mode === 'absent-then-present' && probes === 1) || mode === 'absent' || (mode === 'pid-exit' && probes > 1)) throw Object.assign(new Error('private'), { code: 'ESRCH' });
      if (mode === 'eperm') throw Object.assign(new Error('private'), { code: 'EPERM' });
      if (mode === 'unknown') throw new Error('private');
      return true;
    };
    cp.spawnSync = (path, args, options) => {
      calls++;
      assert.ok(['/usr/sbin/sysctl', '/bin/ps'].includes(path));
      assert.deepEqual(options.env, { TZ: 'UTC', LC_ALL: 'C', LANG: 'C' });
      assert.ok(options.timeout > 0 && options.timeout <= 750);
      assert.equal(options.maxBuffer, 65536);
      elapsed += 1;
      const ok = stdout => ({ stdout, stderr: '', status: 0, signal: null });
      if (mode === 'budget') { elapsed = 5001; return ok(''); }
      if (mode === 'timeout') return { ...ok(''), error: { code: 'ETIMEDOUT' } };
      if (mode === 'status') return { ...ok(''), status: 1 };
      if (mode === 'stderr') return { ...ok(''), stderr: 'private' };
      if (mode === 'oversized') return ok('x'.repeat(65537));
      if (mode === 'throw') throw new Error('private');
      if (path === '/usr/sbin/sysctl') {
        if (args[1] === 'kern.bootsessionuuid') return ok(mode === 'uuid-change' && bootReads > 1
          ? '12345678-1234-4234-8234-123456789abd' : '12345678-1234-4234-8234-123456789abc');
        bootReads++;
        if (mode === 'boot-change' && bootReads > 1) return ok('{ sec = 1767312001, usec = 0 }');
        if (mode === 'future-boot') return ok('{ sec = 9999999999, usec = 0 }');
        return ok('{ sec = 1767312000, usec = 0 }');
      }
      assert.deepEqual(args, ['-p', '123', '-o', 'pid=', '-o', 'lstart=']);
      psReads++;
      if (mode === 'birth-change' && psReads > 1) return ok(' 123 Sun Jan  4 00:00:00 2026');
      const row = ' 123 Sat Jan  3 00:00:00 2026';
      if (mode === 'missing') return ok('');
      if (mode === 'duplicate') return ok(row + String.fromCharCode(10) + row);
      if (mode === 'wrong-pid') return ok(' 124 Sat Jan  3 00:00:00 2026');
      if (mode === 'unknown-birth') return ok(' 123 ???');
      if (mode === 'preboot-birth') return ok(' 123 Thu Jan  1 00:00:00 2026');
      if (mode === 'future-birth') return ok(' 123 Fri Jan  1 00:00:00 9999');
      return ok(row);
    };
    syncBuiltinESMExports();
    const { collectNativeSameMachineFacts } = await import(${JSON.stringify(url)});
    for (const [scenario, code] of [
      ['eperm', 'unknown-pid'], ['unknown', 'unknown-pid'],
      ['missing', 'ambiguous-pid'], ['duplicate', 'ambiguous-pid'], ['wrong-pid', 'ambiguous-pid'],
      ['unknown-birth', 'ambiguous-pid'], ['pid-exit', 'ambiguous-pid'],
      ['preboot-birth', 'inconsistent-facts'], ['future-birth', 'inconsistent-facts'],
      ['boot-change', 'inconsistent-facts'], ['uuid-change', 'inconsistent-facts'],
      ['host-change', 'inconsistent-facts'], ['future-boot', 'inconsistent-facts'],
      ['absent-then-present', 'inconsistent-facts'], ['birth-change', 'inconsistent-facts'],
      ['budget', 'collection-budget'], ['timeout', 'native-command-failed'],
      ['status', 'native-command-failed'], ['stderr', 'native-command-failed'],
      ['oversized', 'native-command-failed'], ['throw', 'native-command-failed'],
    ]) {
      mode = scenario; elapsed = 0; bootReads = 0; probes = 0; hostReads = 0; psReads = 0;
      assert.throws(() => collectNativeSameMachineFacts([123]), error => {
        assert.equal(error.code, code, scenario);
        assert.equal(error.message, code, scenario);
        return true;
      });
    }
    mode = 'absent'; elapsed = 0; bootReads = 0; probes = 0; hostReads = 0; psReads = 0;
    assert.deepEqual(collectNativeSameMachineFacts([123]).pids, [{ pid: 123, state: 'absent', processIdentity: null }]);
    calls = 0;
    assert.throws(() => collectNativeSameMachineFacts([0]), { code: 'invalid-pids' });
    assert.equal(calls, 0);
  `], { encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
  assert.equal(result.status, 0, result.stderr);
});
