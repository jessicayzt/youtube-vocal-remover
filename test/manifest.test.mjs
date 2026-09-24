// The helper's first stage lives on YouTube's cookieless embed domain; the scripts must reach it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const content = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
const HOSTS = ['https://www.youtube.com/*', 'https://www.youtube-nocookie.com/*'];

test('both YouTube hosts are permitted and get every content script', () => {
  for (const host of HOSTS) {
    assert.ok(manifest.host_permissions.includes(host), host + ' in host_permissions');
    for (const cs of manifest.content_scripts) assert.ok(cs.matches.includes(host), host + ' in ' + cs.js.join(','));
  }
  assert.equal(manifest.name, 'YouTube Vocal Remover');
});

// The session for the video being left ends the moment a navigation begins: within the same
// second YouTube may start the next video in the same element, and a session still attached would
// take its clock from the new video and play the old one's audio over it.
test('the controller ends the session as soon as a navigation starts', () => {
  assert.match(content, /addEventListener\('yt-navigate-start'[^\n]*stopSession\(\)/);
  assert.match(content, /const mainVideo = \(\) => document\.querySelector\('#movie_player video\.html5-main-video'\)/, 'the marked main element is preferred, not document order');
});

// When every kind of helper has failed, wanting one still restarted the ladder on the next
// heartbeat, opening and closing a background tab every couple of minutes.
test('the controller stops asking for a helper once every kind has failed, and retries much later', () => {
  const fail = content.slice(content.indexOf('function failHelper('), content.indexOf('function removeHelper('));
  assert.match(fail, /S\.helperWanted = false; S\.helperRetryAt = Date\.now\(\) \+ HELPER_RETRY_MS;/);
  assert.match(content, /HELPER_RETRY_MS = 5 \* 60 \* 1000/);
  assert.match(content, /Date\.now\(\) >= S\.helperRetryAt[^\n]*wantHelper\(\)/, 'and the heartbeat retries once the wait is over');
});

test('connecting to the engine cannot hang forever', () => {
  const fn = content.slice(content.indexOf('async function connectEngine('), content.indexOf('// Timer-free task scheduling'));
  assert.match(fn, /Promise\.race\(/);
  assert.match(fn, /CONNECT_TIMEOUT_MS/);
});

test('the watched page guards its quality preference against the helper and repairs an old 144p one', () => {
  assert.match(content, /window\.addEventListener\('storage'/, 'watches same-origin writes to the preference');
  assert.match(content, /QUALITY_KEY = 'yt-player-quality'/);
  assert.match(content, /async function repairQualityPreference\(\)/);
  assert.match(content, /repairQualityPreference\(\);/, 'and runs the one-time repair at start');
  // the detector matches the stored shape, which is JSON inside JSON (escaped quotes)
  const re = /quality\\?":\s*\\?"?144\b/;
  assert.ok(re.test('{"data":"{\\"quality\\":144,\\"previousQuality\\":1080}","expiration":1}'), 'escaped form');
  assert.ok(re.test('{"quality":144}'), 'plain form');
  assert.ok(!re.test('{"data":"{\\"quality\\":1440}"}'), 'not 1440p');
  assert.ok(!re.test('{"data":"{\\"quality\\":1080,\\"previousQuality\\":144}"}'), 'not a previous quality of 144');
});

test('the helper tries the cookieless embed before anything signed in', () => {
  assert.match(content, /HELPER_STAGES = \['embed-nocookie', 'embed-iframe', 'watch-iframe', 'watch-tab'\]/);
  assert.match(content, /www\.youtube-nocookie\.com/);
});
