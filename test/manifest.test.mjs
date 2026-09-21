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

test('the helper tries the cookieless embed before anything signed in', () => {
  assert.match(content, /HELPER_STAGES = \['embed-nocookie', 'embed-iframe', 'watch-iframe', 'watch-tab'\]/);
  assert.match(content, /www\.youtube-nocookie\.com/);
});
