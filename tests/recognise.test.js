'use strict';

// The song recogniser against a stand-in service, with a clock of its own.

var test = require('node:test');
var assert = require('node:assert');
var Recogniser = require('../plugin/lib/recognise.js');

var BYTES = Recogniser.SAMPLE_RATE * Recogniser.CHANNELS * 2 * Recogniser.WINDOW;

function answer(artist, title, timecode, seconds) {
  return { status: 'success', result: { artist: artist, title: title, album: 'An Album', timecode: timecode, song_link: 'https://lis.tn/x',
    apple_music: { durationInMillis: seconds * 1000, artwork: { url: 'https://art.example/{w}x{h}bb.jpg' } } } };
}

function rig(options) {
  var r = { clock: 1000000, sent: [], answers: [], songs: [], lines: [] };
  r.recogniser = new Recogniser(Object.assign({
    logger: { info: function(m) { r.lines.push(m); }, error: function(m) { r.lines.push('ERROR ' + m); } },
    onSong: function(song) { r.songs.push(song ? song.artist + ' - ' + song.title : null); },
    now: function() { return r.clock; },
    tick: 3600000,
    wav: function(pcm) { return Promise.resolve(Buffer.from('wav:' + pcm.length)); },
    send: function(wav) { r.sent.push(wav.toString()); return Promise.resolve(r.answers.length ? r.answers.shift() : { status: 'success', result: null }); },
    key: 'k', when: 'missing'
  }, options || {}));
  r.fill = function() { r.recogniser.feed(Buffer.alloc(BYTES, 1)); };
  r.pass = function(ms) { r.clock += ms; };
  // one consideration, and its request answered
  r.turn = async function(ms) {
    r.pass(ms || 0);
    r.recogniser.consider();
    await new Promise(function(resolve) { setImmediate(resolve); });
    await new Promise(function(resolve) { setImmediate(resolve); });
  };
  return r;
}

test('a station is asked about after fifteen seconds, and a song told twice is trusted', async function() {
  var r = rig();
  r.recogniser.start('rtlsdr://fm/100.0');
  r.fill();
  // not yet: the station has just started
  await r.turn(5000);
  assert.strictEqual(r.sent.length, 0);
  // the first answer is a candidate, not shown
  r.answers.push(answer('Ariana Grande', 'One Last Time', '01:13', 200));
  await r.turn(11000);
  assert.strictEqual(r.sent.length, 1);
  assert.deepStrictEqual(r.songs, []);
  assert.deepStrictEqual(r.recogniser.status().candidate, { artist: 'Ariana Grande', title: 'One Last Time' });
  // the same again thirty seconds later: shown, with the cover at 600 pixels and the end of the song known
  r.answers.push(answer('Ariana Grande', 'One Last Time', '01:43', 200));
  await r.turn(20000);
  assert.strictEqual(r.sent.length, 1, 'not before thirty seconds');
  await r.turn(10000);
  assert.strictEqual(r.sent.length, 2);
  assert.deepStrictEqual(r.songs, ['Ariana Grande - One Last Time']);
  assert.strictEqual(r.recogniser.song.artwork, 'https://art.example/600x600bb.jpg');
  assert.ok(r.lines.some(function(m) { return /Song recognised: Ariana Grande - One Last Time \(1:43 into it\)/.test(m); }));
  // nothing more is asked while the song runs: 200 s long, 103 s in, so about 100 s to go
  await r.turn(60000);
  assert.strictEqual(r.sent.length, 2);
  await r.turn(50000);
  assert.strictEqual(r.sent.length, 3, 'asked again once the song is over');
});

test('an odd answer between two others is not shown; three that disagree are given up on', async function() {
  var r = rig();
  r.recogniser.start('rtlsdr://fm/105.4');
  r.fill();
  r.answers.push(answer('nxzxrt', 'call me maybe x tgif', '00:34', 180));
  await r.turn(16000);
  r.answers.push(answer('Carly Rae Jepsen', 'Call Me Maybe', '00:45', 193));
  await r.turn(30000);
  assert.deepStrictEqual(r.songs, [], 'two answers that disagree: neither is shown');
  r.answers.push(answer('Carly Rae Jepsen', 'Call Me Maybe', '01:15', 193));
  await r.turn(30000);
  assert.deepStrictEqual(r.songs, ['Carly Rae Jepsen - Call Me Maybe']);

  var q = rig();
  q.recogniser.start('rtlsdr://fm/95.8');
  q.fill();
  q.answers.push(answer('A', '1', '00:10', 100));
  await q.turn(16000);
  q.answers.push(answer('B', '2', '00:10', 100));
  await q.turn(30000);
  q.answers.push(answer('C', '3', '00:10', 100));
  await q.turn(30000);
  q.answers.push(answer('D', '4', '00:10', 100));
  await q.turn(30000);
  assert.strictEqual(q.sent.length, 4);
  assert.deepStrictEqual(q.songs, []);
  assert.ok(q.lines.some(function(m) { return /3 answers that disagree; left for now/.test(m); }));
  // and not again for a minute and a half
  await q.turn(30000);
  assert.strictEqual(q.sent.length, 4);
  await q.turn(60000);
  assert.strictEqual(q.sent.length, 5);
});

test('nothing recognised: asked again after a minute and a half; a song shown is taken down', async function() {
  var r = rig();
  r.recogniser.start('rtlsdr://dab/12B/x');
  r.fill();
  await r.turn(16000);
  assert.strictEqual(r.sent.length, 1);
  assert.strictEqual(r.lines.filter(function(m) { return /nothing recognised in the last 20 seconds of rtlsdr:\/\/dab\/12B\/x/.test(m); }).length, 1);
  await r.turn(60000);
  assert.strictEqual(r.sent.length, 1);
  await r.turn(30000);
  assert.strictEqual(r.sent.length, 2);
  assert.strictEqual(r.lines.filter(function(m) { return /nothing recognised/.test(m); }).length, 1, 'said once, not at every question');
  r.answers.push(answer('JADE', 'Backbone', '00:47', 180));
  await r.turn(90000);
  r.answers.push(answer('JADE', 'Backbone', '01:17', 180));
  await r.turn(30000);
  assert.deepStrictEqual(r.songs, ['JADE - Backbone']);
  // the song's end comes, the next answer is nothing: the song is taken down
  await r.turn(120000);
  assert.strictEqual(r.sent.length, 5);
  assert.deepStrictEqual(r.songs, ['JADE - Backbone', null]);
});

test('the station\'s text, the setting and the key decide whether anything is sent', async function() {
  var r = rig();
  r.recogniser.start('rtlsdr://fm/100.0');
  r.fill();
  r.recogniser.textNamesSong(true);
  await r.turn(16000);
  assert.strictEqual(r.sent.length, 0, 'the text names the song: nothing sent');
  r.recogniser.textNamesSong(false);
  await r.turn(1000);
  assert.strictEqual(r.sent.length, 1);
  // 'always' asks although the text names a song
  r.recogniser.configure({ key: 'k', when: 'always' });
  r.recogniser.textNamesSong(true);
  await r.turn(90000);
  assert.strictEqual(r.sent.length, 2);
  // no key: nothing, and the status says so
  r.recogniser.configure({ key: '', when: 'always' });
  await r.turn(90000);
  assert.strictEqual(r.sent.length, 2);
  assert.strictEqual(r.recogniser.enabled(), false);
  // less than twenty seconds of sound: nothing
  var q = rig();
  q.recogniser.start('rtlsdr://fm/100.0');
  q.recogniser.feed(Buffer.alloc(BYTES / 2, 1));
  await q.turn(16000);
  assert.strictEqual(q.sent.length, 0);
  q.recogniser.feed(Buffer.alloc(BYTES / 2, 1));
  await q.turn(1000);
  assert.strictEqual(q.sent.length, 1);
  // a new station: the sound of the old one is not sent for it
  q.recogniser.start('rtlsdr://fm/95.8');
  await q.turn(16000);
  assert.strictEqual(q.sent.length, 1);
});

test('a refused key stops recognition until another is entered; a failed request waits five minutes', async function() {
  var r = rig();
  r.recogniser.start('rtlsdr://fm/100.0');
  r.fill();
  r.answers.push({ status: 'error', error: { error_code: 900, error_message: 'Wrong API token' } });
  await r.turn(16000);
  assert.strictEqual(r.recogniser.enabled(), false);
  assert.ok(r.lines.some(function(m) { return /ERROR .*Song recognition is off: the service refused the key \(Wrong API token\)/.test(m); }));
  await r.turn(600000);
  assert.strictEqual(r.sent.length, 1);
  r.recogniser.configure({ key: 'another', when: 'missing' });
  assert.strictEqual(r.recogniser.enabled(), true);
  await r.turn(1000);
  assert.strictEqual(r.sent.length, 2);

  var q = rig({ send: function() { return Promise.reject(new Error('ENOTFOUND')); } });
  q.recogniser.start('rtlsdr://fm/100.0');
  q.fill();
  var sent = 0;
  q.recogniser.send = function() { sent++; return Promise.reject(new Error('ENOTFOUND')); };
  await q.turn(16000);
  assert.strictEqual(sent, 1);
  assert.ok(q.lines.some(function(m) { return /the request failed \(ENOTFOUND\); next in 5 minutes/.test(m); }));
  await q.turn(200000);
  assert.strictEqual(sent, 1);
  await q.turn(120000);
  assert.strictEqual(sent, 2);
});

test('the state in words', async function() {
  var r = rig({ key: '' });
  assert.strictEqual(r.recogniser.said(), 'off: no token');
  r.recogniser.configure({ key: 'k', when: 'missing' });
  assert.strictEqual(r.recogniser.said(), 'on, asks when the station\'s text names no song');
  r.recogniser.configure({ key: 'k', when: 'always' });
  assert.strictEqual(r.recogniser.said(), 'on, asks for every song');
  r.recogniser.start('rtlsdr://fm/100.0');
  r.fill();
  r.answers.push({ status: 'error', error: { error_code: 901, error_message: 'Limit' } });
  await r.turn(16000);
  assert.strictEqual(r.recogniser.said(), 'off: the service refused the token');
});

test('the window is the last twenty seconds, whatever the chunks', function() {
  var r = rig();
  r.recogniser.start('x');
  var chunk = Buffer.alloc(7000);
  var n = 0;
  for (var i = 0; i < Math.ceil(BYTES * 1.5 / 7000); i++) {
    for (var k = 0; k < 7000; k++) { chunk[k] = n & 255; n++; }
    r.recogniser.feed(chunk);
  }
  var w = r.recogniser.window();
  assert.strictEqual(w.length, BYTES);
  // the bytes run on without a break from the first to the last
  for (var j = 1; j < w.length; j += 4999) {
    assert.strictEqual(w[j], (w[j - 1] + 1) & 255, 'at ' + j);
  }
  assert.strictEqual(w[w.length - 1], (n - 1) & 255);
});

test('what the service says becomes a song, or nothing', function() {
  var now = 5000000;
  var song = Recogniser.songOf({ artist: ' Whitney Houston;Kygo ', title: 'Higher Love', timecode: '02:00',
    spotify: { duration_ms: 228000, album: { images: [{ url: 'https://i.scdn.co/x' }] } } }, now);
  assert.deepStrictEqual([song.artist, song.title, song.artwork, song.timecode, song.duration], ['Whitney Houston;Kygo', 'Higher Love', 'https://i.scdn.co/x', 120, 228]);
  assert.strictEqual(song.endsAt, now + 108000 + 10000);
  assert.strictEqual(Recogniser.songOf(null, now), null);
  assert.strictEqual(Recogniser.songOf({ artist: 'x' }, now), null);
  var bare = Recogniser.songOf({ artist: 'A', title: 'B' }, now);
  assert.deepStrictEqual([bare.artwork, bare.timecode, bare.duration, bare.endsAt], [null, null, null, null]);
});
