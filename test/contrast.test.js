const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/contrast.js');

test('parse handles hex, short hex, alpha and rgb() syntaxes', () => {
  assert.deepEqual(C.parse('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(C.parse('#336699'), { r: 51, g: 102, b: 153, a: 1 });
  assert.equal(Math.round(C.parse('#33669980').a * 100), 50);
  assert.deepEqual(C.parse('rgb(10 20 30)'), { r: 10, g: 20, b: 30, a: 1 });
  assert.equal(C.parse('rgba(0,0,0,0.5)').a, 0.5);
  assert.equal(C.parse('not a colour'), null);
  assert.equal(C.parse(null), null);
});
test('ratio: the two WCAG anchors', () => {
  assert.equal(C.ratio('#000', '#fff'), 21);
  assert.equal(C.ratio('#fff', '#fff'), 1);
  assert.equal(C.ratio('#777', '#fff'), 4.48); // the well-known "just fails AA" grey
  assert.equal(C.ratio('#767676', '#fff'), 4.54);
});
test('ratio composites a translucent foreground over the background', () => {
  const half = C.ratio('rgba(0,0,0,0.5)', '#fff');
  assert.ok(half > 3.5 && half < 4.6, String(half));
});
test('apca: black on white is about +106, white on black about -108', () => {
  assert.ok(Math.abs(C.apca('#000', '#fff') - 106) < 1.5, String(C.apca('#000', '#fff')));
  assert.ok(Math.abs(C.apca('#fff', '#000') + 108) < 1.5, String(C.apca('#fff', '#000')));
  assert.equal(C.apca('#888', '#888'), 0);
});
test('grade applies the WCAG 2.x thresholds', () => {
  assert.deepEqual(C.grade(4.5), { aaNormal: true, aaLarge: true, aaaNormal: false, aaaLarge: true, ui: true });
  assert.equal(C.grade(2.9).aaLarge, false);
  assert.equal(C.grade(null), null);
  assert.equal(C.required(true), 3);
  assert.equal(C.required(false, 'AAA'), 7);
});
test('suggest returns a colour that reaches the target, changing as little as possible', () => {
  const s = C.suggest('#777777', '#ffffff', 4.5);
  assert.ok(s.changed);
  assert.ok(s.ratio >= 4.5);
  assert.ok(C.ratio(s.hex, '#ffffff') >= 4.5);
  const keep = C.suggest('#000000', '#ffffff', 4.5);
  assert.equal(keep.changed, false);
});
test('suggest works on a dark background by lightening', () => {
  const s = C.suggest('#444444', '#111111', 4.5);
  assert.ok(C.ratio(s.hex, '#111111') >= 4.5);
});
test('suggest gives up (null) when nothing can reach the target', () => {
  assert.equal(C.suggest('#808080', '#808080', 22), null);
});
test('simulate: achromatopsia returns grey, protanopia changes red noticeably', () => {
  const g = C.simulate('#ff0000', 'achromatopsia');
  assert.ok(Math.abs(g.r - g.g) < 1 && Math.abs(g.g - g.b) < 1);
  const p = C.simulate('#ff0000', 'protanopia');
  assert.ok(p.r < 200);
  assert.deepEqual(C.simulate('#123456', 'normal'), C.parse('#123456'));
});

test('regression: a ratio that only rounds up to 4.5 does not pass AA', () => {
  const fg = 'rgb(25,133,120)';
  assert.equal(C.ratio(fg, '#fff'), 4.5); // shown rounded
  assert.ok(C.exact(fg, '#fff') < 4.5);
  assert.equal(C.grade(C.exact(fg, '#fff')).aaNormal, false);
  assert.equal(C.grade(C.exact('#000', '#fff')).aaaNormal, true);
});

test('regression: suggest() returns a colour whose exact ratio reaches the target', () => {
  const s = C.suggest('rgb(25,133,120)', '#ffffff', 4.5);
  assert.ok(s && C.exact(s.hex, '#ffffff') >= 4.5);
});
