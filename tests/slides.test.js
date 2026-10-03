'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs-extra');
var Slides = require('../plugin/lib/slides');

function folder() {
  var dir = '/tmp/slides-test-' + Math.random().toString(36).slice(2);
  fs.ensureDirSync(dir + '/dab');
  fs.ensureDirSync(dir + '/plugin');
  return dir;
}

function plain(icon) {
  return icon.replace(/&v=[0-9a-z]+$/, '');
}

test('no picture while the station has sent none', function() {
  var dir = folder();
  var slides = new Slides({ dir: dir + '/dab', link: null });
  assert.strictEqual(slides.newest(), null);
  // The decoder's other files are not pictures
  fs.writeFileSync(dir + '/dab/DABlabel.txt', 'label=Now playing');
  assert.strictEqual(slides.newest(), null);
  // Nor is a folder that is not there yet
  assert.strictEqual(new Slides({ dir: dir + '/nowhere', link: null }).newest(), null);
});

test('the newest picture is the one shown, under an address Volumio can serve', function() {
  var dir = folder();
  var slides = new Slides({ dir: dir + '/dab', link: null });
  fs.writeFileSync(dir + '/dab/slide_0000.jpg', 'first');
  var first = slides.newest();
  assert.strictEqual(first.file, 'slide_0000.jpg');
  assert.strictEqual(plain(first.icon), 'music_service/rtlsdr_radio/slides/slide_0000.jpg');
  assert.match(first.icon, /&v=[0-9a-z]+$/, 'the address carries the time the picture was written');

  fs.writeFileSync(dir + '/dab/slide_0001.png', 'second');
  fs.writeFileSync(dir + '/dab/slide_0010.jpg', 'eleventh');
  assert.strictEqual(slides.newest().file, 'slide_0010.jpg', 'by its number, not by the order of the folder');
});

test('nothing but the decoder\'s own names is taken for a picture', function() {
  var dir = folder();
  var slides = new Slides({ dir: dir + '/dab', link: null });
  ['logo.jpg', 'slide_0001.jpg.part', 'slide_x.jpg', 'slide_0002.gif', '..slide_0003.jpg', 'slide_0004.jpg.exe'].forEach(function(name) {
    fs.writeFileSync(dir + '/dab/' + name, 'x');
  });
  assert.strictEqual(slides.newest(), null);
  // A picture being written is not shown: the decoder moves a whole one into place
  fs.writeFileSync(dir + '/dab/slide_0005.jpg', '');
  assert.strictEqual(slides.newest(), null, 'an empty file is no picture');
});

test('the same file name written again is another address', async function() {
  // The decoder's numbers start again with every station played, and a screen keeps a
  // picture for as long as Volumio tells it to
  var dir = folder();
  var slides = new Slides({ dir: dir + '/dab', link: null });
  fs.writeFileSync(dir + '/dab/slide_0000.jpg', 'a station');
  var one = slides.newest().icon;
  await new Promise(function(resolve) { setTimeout(resolve, 30); });
  fs.writeFileSync(dir + '/dab/slide_0000.jpg', 'another station');
  var two = slides.newest().icon;
  assert.strictEqual(plain(one), plain(two));
  assert.notStrictEqual(one, two);
});

test('old pictures are cleared away: the folder is in memory', function() {
  var dir = folder();
  var slides = new Slides({ dir: dir + '/dab', link: null });
  for (var i = 0; i < 8; i++) {
    fs.writeFileSync(dir + '/dab/slide_000' + i + '.jpg', 'picture ' + i);
  }
  fs.writeFileSync(dir + '/dab/DABlabel.txt', 'label=x');
  assert.strictEqual(slides.newest().file, 'slide_0007.jpg');
  assert.deepStrictEqual(fs.readdirSync(dir + '/dab').sort(), ['DABlabel.txt', 'slide_0005.jpg', 'slide_0006.jpg', 'slide_0007.jpg']);
});

test('screens reach the pictures through a link in the plugin folder, made again when it is gone', function() {
  var dir = folder();
  var slides = new Slides({ dir: dir + '/dab', link: dir + '/plugin/slides' });
  slides.prepare();
  fs.writeFileSync(dir + '/dab/slide_0000.png', 'picture');
  assert.ok(fs.lstatSync(dir + '/plugin/slides').isSymbolicLink());
  assert.strictEqual(fs.readFileSync(dir + '/plugin/slides/slide_0000.png', 'utf8'), 'picture');

  // An update replaces the plugin folder
  fs.removeSync(dir + '/plugin');
  fs.ensureDirSync(dir + '/plugin');
  slides.prepare();
  assert.strictEqual(fs.readFileSync(dir + '/plugin/slides/slide_0000.png', 'utf8'), 'picture');

  // Something else in the link's place is replaced; the decoder's folder may not exist yet
  fs.removeSync(dir + '/plugin/slides');
  fs.ensureDirSync(dir + '/plugin/slides');
  var early = new Slides({ dir: dir + '/not-yet', link: dir + '/plugin/slides' });
  early.prepare();
  assert.strictEqual(fs.readlinkSync(dir + '/plugin/slides'), dir + '/not-yet');
});
