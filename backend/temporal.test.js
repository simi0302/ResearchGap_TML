// Temporal factor: topic growth vs the whole SDN/NFV/slicing field on a log scale (added
// 2026-10-10 after every scenario-test paper got the maximum 1.0 on absolute growth).
const test = require("node:test");
const assert = require("node:assert/strict");
const { temporalFactor } = require("./scoring");

const years = (a, b) => ({ 2016: a, 2017: a, 2018: a, 2019: a, 2020: b });
const close = (x, y) => assert.ok(Math.abs(x - y) < 0.01, `${x} vs ${y}`);

test("growing as fast as the field scores ~0.5", () => {
  const t = temporalFactor(years(100, 200), [], 2020, "en", years(1000, 2000));
  close(t.value, 0.5);
  assert.equal(t.is_fallback, false);
});

test("four times the field's growth multiple scores 1.0, a quarter scores 0", () => {
  close(temporalFactor(years(100, 800), [], 2020, "en", years(1000, 2000)).value, 1);
  close(temporalFactor(years(400, 200), [], 2020, "en", years(1000, 2000)).value, 0);
});

test("two topics that both doubled are no longer tied when the field grew differently", () => {
  const a = temporalFactor(years(100, 200), [], 2020, "en", years(1000, 1200)).value;
  const b = temporalFactor(years(100, 200), [], 2020, "en", years(1000, 3000)).value;
  assert.ok(a > b);
});

test("a topic starting from zero is smoothed, not treated as infinite growth", () => {
  const t = temporalFactor({ 2011: 0, 2012: 3, 2013: 5, 2014: 8, 2015: 12 }, [], 2015, "en", { 2011: 97, 2015: 2908 });
  assert.ok(t.value < 0.5, `topic grew slower than an exploding field, got ${t.value}`);
});

test("fewer than 20 publications in the window is too thin: neutral 0.5, flagged", () => {
  const t = temporalFactor({ 2013: 0, 2017: 1 }, [], 2017, "en", { 2013: 949, 2017: 4811 });
  assert.equal(t.value, 0.5);
  assert.equal(t.is_fallback, true);
  assert.match(t.note, /too few/);
});

test("without a field baseline it falls back to absolute growth and says so", () => {
  const t = temporalFactor(years(100, 200), [], 2020, "en", {});
  assert.equal(t.value, 1);
  assert.equal(t.field_growth, null);
  assert.match(t.note, /baseline unavailable/);
});
