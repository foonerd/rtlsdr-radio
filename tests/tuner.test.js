'use strict';

// Run inside a throwaway container (scripts/test-plugin.sh): real processes are
// started and killed, and one test plants a process named like a holder of the dongle.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var childProcess = require('child_process');
var Tuner = require('../plugin/lib/tuner');

function tuner(options) {
  return new Tuner(Object.assign({ settle: 150, grace: 300, killWait: 1000 }, options || {}));
}

function running(pid) {
  try {
    process.kill(pid, 0);
    var stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch (e) {
    return false;
  }
}

// The ids of the running processes with this name
function named(name) {
  return fs.readdirSync('/proc').filter(function(entry) {
    try {
      return /^\d+$/.test(entry) && fs.readFileSync('/proc/' + entry + '/comm', 'utf8').trim() === name &&
        running(parseInt(entry, 10));
    } catch (e) {
      return false;
    }
  });
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

test('a job is stopped by asking, and its processes are gone when stop resolves', async function() {
  var t = tuner();
  var job = await t.acquire('play');
  var a = job.spawn('sleep', ['30']);
  var b = job.spawn('sleep', ['30']);
  assert.strictEqual(t.busy(), 'play');
  var started = Date.now();
  await t.stop('test');
  assert.ok(!running(a.pid) && !running(b.pid));
  assert.ok(Date.now() - started < 300, 'no need to wait out the grace time');
  assert.strictEqual(t.busy(), null);
});

test('a process that ignores the request is killed after the grace time', async function() {
  var t = tuner();
  var job = await t.acquire('stubborn');
  var child = job.spawn('bash', ['-c', 'trap "" TERM; while true; do sleep 0.05; done']);
  await sleep(150);
  var started = Date.now();
  await t.stop('test');
  var took = Date.now() - started;
  assert.ok(!running(child.pid));
  assert.ok(took >= 300 && took < 1000, 'took ' + took + ' ms');
});

test('the next job starts only when the one before is gone and the dongle has settled', async function() {
  var t = tuner();
  var first = await t.acquire('first');
  var child = first.spawn('sleep', ['30']);
  var asked = Date.now();
  var second = await t.acquire('second');
  assert.ok(!running(child.pid), 'the first job is gone');
  assert.ok(Date.now() - asked >= 148, 'the settle time was kept');
  assert.strictEqual(first.finished, true);
  assert.strictEqual(t.busy(), 'second');
  await t.stop();
  assert.ok(second.finished);
});

test('of two requests made at once only the later one gets the tuner', async function() {
  var t = tuner();
  var early = t.acquire('early');
  var late = t.acquire('late');
  await assert.rejects(Promise.resolve(early), function(e) { return e.superseded === true; });
  var job = await late;
  assert.strictEqual(job.name, 'late');
  await t.stop();
});

test('a stop withdraws a request that has not had its turn', async function() {
  var t = tuner();
  var job = await t.acquire('playing');
  job.spawn('sleep', ['30']);
  var next = t.acquire('next');
  var stopped = t.stop();
  await assert.rejects(Promise.resolve(next), function(e) { return e.superseded === true; });
  await stopped;
  assert.strictEqual(t.busy(), null);
});

test('stopping twice is harmless, and an earlier stop never reaches a later job', async function() {
  var t = tuner();
  var job = await t.acquire('one');
  job.spawn('sleep', ['30']);
  var first = t.stop('first');
  var second = t.stop('second');
  var later = await t.acquire('two');
  var child = later.spawn('sleep', ['30']);
  await first;
  await second;
  await sleep(100);
  assert.ok(running(child.pid), 'the later job is untouched');
  await t.stop();
});

test('a stray process holding the dongle is removed before a job starts', async function() {
  fs.copyFileSync('/bin/sleep', '/tmp/fn-rtl_fm');
  fs.chmodSync('/tmp/fn-rtl_fm', 0o755);
  var stray = childProcess.spawn('/tmp/fn-rtl_fm', ['30'], { detached: true, stdio: 'ignore' });
  stray.unref();
  await sleep(100);
  assert.ok(running(stray.pid));
  var t = tuner();
  var job = await t.acquire('after a crash');
  assert.ok(!running(stray.pid), 'the stray is gone');
  assert.strictEqual(job.name, 'after a crash');
  await t.stop();
});

test('a process ending by itself is reported; one that is stopped is not', async function() {
  var t = tuner();
  var job = await t.acquire('short');
  var reports = [];
  job.onUnexpectedExit(function(entry) { reports.push(entry.command + ':' + entry.code); });
  job.spawn('bash', ['-c', 'exit 3']);
  job.spawn('sleep', ['30']);
  await sleep(200);
  assert.deepStrictEqual(reports, ['bash:3']);
  assert.strictEqual(job.finished, false);
  await t.stop();
  assert.deepStrictEqual(reports, ['bash:3']);
});

test('a job whose processes have all ended frees the tuner by itself', async function() {
  var t = tuner();
  var job = await t.acquire('scan');
  job.spawn('bash', ['-c', 'exit 0']);
  await sleep(200);
  assert.strictEqual(job.finished, true);
  assert.strictEqual(t.busy(), null);
});

test('a job with a time limit is stopped when it runs over', async function() {
  var t = tuner();
  var job = await t.acquire('long scan');
  var child = job.spawn('sleep', ['30']);
  job.limit(200);
  await sleep(500);
  assert.strictEqual(job.timedOut, true);
  assert.ok(!running(child.pid));
  assert.strictEqual(job.finished, true);
});

test('a program that cannot be started is reported and does not hold the job', async function() {
  var t = tuner();
  var job = await t.acquire('missing');
  var reports = [];
  job.onUnexpectedExit(function(entry) { reports.push(entry.error && entry.error.code); });
  job.spawn('/no/such/program', []);
  await sleep(200);
  assert.deepStrictEqual(reports, ['ENOENT']);
  assert.strictEqual(job.finished, true);
});

test('nothing can be started in a job that has been stopped', async function() {
  var t = tuner();
  var job = await t.acquire('ended');
  await t.stop();
  assert.throws(function() { job.spawn('sleep', ['1']); }, /has ended/);
});

test('run reports the end of a process once, after its output', async function() {
  var t = tuner();
  var job = await t.acquire('tool');
  var output = '';
  var ends = [];
  var child = job.run('bash', ['-c', 'echo one; echo two; exit 4'], { stdio: ['ignore', 'pipe', 'ignore'] }, function(entry) {
    ends.push(entry.code + ':' + output.trim().split('\n').length);
  });
  child.stdout.on('data', function(data) { output += data; });
  await sleep(300);
  assert.deepStrictEqual(ends, ['4:2']);
});

test('run reports a program that cannot be started, once', async function() {
  var t = tuner();
  var job = await t.acquire('tool');
  var ends = [];
  job.run('/no/such/program', [], {}, function(entry) { ends.push(entry.error && entry.error.code); });
  await sleep(300);
  assert.deepStrictEqual(ends, ['ENOENT']);
});

test('a job kept open runs processes one after another and ends when stopped', async function() {
  var t = tuner();
  var job = await t.acquire('antenna tool', { keepOpen: true });
  job.spawn('bash', ['-c', 'exit 0']);
  await sleep(200);
  assert.strictEqual(job.finished, false);
  assert.strictEqual(t.busy(), 'antenna tool');
  var before = Date.now();
  await job.settle();
  assert.ok(Date.now() - before < 400);
  var second = job.spawn('sleep', ['30']);
  await t.stop('done');
  assert.ok(!running(second.pid));
  assert.strictEqual(job.finished, true);
  assert.strictEqual(t.busy(), null);
});

test('settle removes what a wrapper left holding the dongle', async function() {
  fs.copyFileSync('/bin/sleep', '/tmp/fn-dab-scanner');
  fs.chmodSync('/tmp/fn-dab-scanner', 0o755);
  var t = tuner();
  var job = await t.acquire('validation', { keepOpen: true });
  // A wrapper that ends while the program it started lives on in a session of its own
  job.spawn('bash', ['-c', 'setsid /tmp/fn-dab-scanner 30 & sleep 0.1']);
  await sleep(400);
  assert.ok(named('fn-dab-scanner').length > 0, 'the scanner outlived its wrapper');
  await job.settle();
  assert.deepStrictEqual(named('fn-dab-scanner'), []);
  await t.stop();
});

test('what a process wrote to its error stream is kept for the report', async function() {
  var t = tuner();
  var job = await t.acquire('audio');
  var reports = [];
  job.onUnexpectedExit(function(entry) { reports.push(entry.code + ':' + entry.said.trim()); });
  job.spawn('bash', ['-c', 'echo "audio open error: Device or resource busy" >&2; exit 1'], { stdio: ['ignore', 'ignore', 'pipe'] });
  await sleep(300);
  assert.deepStrictEqual(reports, ['1:audio open error: Device or resource busy']);
});
