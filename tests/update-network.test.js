'use strict';

// The updater's own network code against a server on this machine that behaves as
// GitHub does: a list of releases, and a zip reached through a redirect. Nothing here
// is canned inside the updater; what is stood in for is the far end.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs-extra');
var http = require('http');
var crypto = require('crypto');
var Updater = require('../plugin/lib/update');

// Large enough to arrive in several pieces
var ZIP = crypto.createHash('sha512').update('rtlsdr_radio').digest();
while (ZIP.length < 300000) {
  ZIP = Buffer.concat([ZIP, crypto.createHash('sha512').update(ZIP).digest()]);
}
var SHA = crypto.createHash('sha256').update(ZIP).digest('hex');

var far = { digest: SHA, breaks: 0, asked: [] };
var server = http.createServer(function(req, res) {
  far.asked.push(req.url);
  var base = 'http://127.0.0.1:' + server.address().port;
  if (req.url === '/releases') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{
      tag_name: 'v1.4.0', html_url: base + '/page', body: 'Notes', published_at: '2026-10-03T10:00:00Z', prerelease: true, draft: false,
      assets: [{ name: 'rtlsdr_radio-1.4.0.zip', size: ZIP.length, digest: 'sha256:' + far.digest, browser_download_url: base + '/download/zip' }]
    }]));
  } else if (req.url === '/download/zip') {
    // As GitHub does: the asset's address answers with the place the file is kept at
    res.writeHead(302, { location: '/storage/zip' });
    res.end();
  } else if (req.url === '/storage/zip') {
    if (far.breaks > 0) {
      far.breaks--;
      res.writeHead(200, { 'content-length': ZIP.length });
      res.write(ZIP.slice(0, 100000));
      setTimeout(function() { res.destroy(); }, 20);
      return;
    }
    res.writeHead(200, { 'content-length': ZIP.length, 'content-type': 'application/octet-stream' });
    res.end(ZIP);
  } else if (req.url === '/text') {
    res.end('Service temporarily unavailable');
  } else if (req.url === '/round') {
    res.writeHead(302, { location: '/round' });
    res.end();
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

function url(path) {
  return 'http://127.0.0.1:' + server.address().port + path;
}

function folder() {
  var dir = '/tmp/update-net-' + Math.random().toString(36).slice(2);
  fs.ensureDirSync(dir);
  return dir;
}

test.before(function() {
  return new Promise(function(resolve) { server.listen(0, '127.0.0.1', resolve); });
});

test.after(function() {
  return new Promise(function(resolve) { server.close(resolve); });
});

test('a list of releases is fetched and read', async function() {
  var list = await Updater.network.json(url('/releases'));
  assert.strictEqual(list[0].tag_name, 'v1.4.0');
  assert.strictEqual(Updater.newestReleases(list).preview.version, '1.4.0');
});

test('an answer that is no list of releases is an error, not a crash', async function() {
  await assert.rejects(Updater.network.json(url('/nothing')), function(e) { return e.status === 404; });
  await assert.rejects(Updater.network.json(url('/text')), function(e) { return e.code === 'bad-answer'; });
});

test('a file is fetched through a redirect, counted and hashed as it arrives', async function() {
  var dir = folder();
  var seen = [];
  var got = await Updater.network.download(url('/download/zip'), dir + '/a.zip', ZIP.length, function(done) { seen.push(done); });
  assert.deepStrictEqual(got, { bytes: ZIP.length, sha256: SHA });
  assert.ok(fs.readFileSync(dir + '/a.zip').equals(ZIP));
  assert.strictEqual(seen[seen.length - 1], ZIP.length, 'progress is told up to the last byte');
  assert.ok(seen.length > 1, 'in more than one step');
});

test('no more is taken than was announced', async function() {
  var dir = folder();
  await assert.rejects(Updater.network.download(url('/download/zip'), dir + '/b.zip', 1000), /more than the 1000 bytes expected/);
});

test('a connection that breaks, a file that is not there and a redirect that goes round are errors', async function() {
  var dir = folder();
  far.breaks = 1;
  await assert.rejects(Updater.network.download(url('/storage/zip'), dir + '/c.zip', ZIP.length));
  await assert.rejects(Updater.network.download(url('/nothing'), dir + '/d.zip', 10), function(e) { return e.status === 404; });
  await assert.rejects(Updater.network.download(url('/round'), dir + '/e.zip', 10));
});

function updater(dir, did) {
  return new Updater({
    dir: dir + '/kept',
    version: '1.3.12',
    pluginPath: dir + '/plugin',
    stagingDir: dir + '/staging',
    releasesUrl: url('/releases'),
    waits: [10, 10],
    channel: function() { return 'preview'; },
    zip: function(from, file) { fs.writeFileSync(file, 'kept'); return Promise.resolve(); },
    plugin: {
      storeVersions: function() { return Promise.resolve([]); },
      testMode: function() { return true; },
      backup: function() {},
      apply: function(address) { did.push('apply ' + address); return Promise.resolve(); },
      restart: function() { did.push('restart'); }
    }
  });
}

async function settled(u) {
  for (var i = 0; i < 600; i++) {
    if (u.job && (u.job.state === 'restarting' || u.job.state === 'failed')) {
      return u.job;
    }
    await new Promise(function(resolve) { setTimeout(resolve, 5); });
  }
  assert.fail('the update never came to an end: ' + JSON.stringify(u.job));
}

test('a release is found, fetched, checked and handed on, over the real network code', async function() {
  var dir = folder();
  var did = [];
  var u = updater(dir, did);
  far.digest = SHA;
  var view = await u.check(true);
  assert.strictEqual(view.offer.version, '1.4.0');
  assert.strictEqual(view.offer.source, 'github');
  assert.strictEqual(view.available, true);

  await u.install();
  assert.strictEqual((await settled(u)).state, 'restarting');
  assert.deepStrictEqual(did, ['apply http://127.0.0.1:3000/plugin-serve/rtlsdr_radio-1.4.0.zip', 'restart']);
  assert.ok(fs.readFileSync(dir + '/staging/rtlsdr_radio-1.4.0.zip').equals(ZIP));
});

test('a download that breaks twice is made a third time and then installed', async function() {
  var dir = folder();
  var did = [];
  var u = updater(dir, did);
  await u.check(true);
  far.breaks = 2;
  far.asked.length = 0;
  await u.install();
  assert.strictEqual((await settled(u)).state, 'restarting');
  assert.strictEqual(far.asked.filter(function(a) { return a === '/storage/zip'; }).length, 3);
  assert.ok(fs.readFileSync(dir + '/staging/rtlsdr_radio-1.4.0.zip').equals(ZIP));
});

test('a zip that is not the one the release names is not handed on', async function() {
  var dir = folder();
  var did = [];
  var u = updater(dir, did);
  // The release states the digest of another file
  far.digest = crypto.createHash('sha256').update('something else').digest('hex');
  await u.check(true);
  await u.install();
  var job = await settled(u);
  far.digest = SHA;
  assert.strictEqual(job.state, 'failed');
  assert.strictEqual(job.error.code, 'checksum');
  assert.deepStrictEqual(did, []);
  assert.deepStrictEqual(fs.readdirSync(dir + '/staging'), []);
});
