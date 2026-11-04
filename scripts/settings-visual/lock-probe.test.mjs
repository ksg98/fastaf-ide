import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {lockProbeFailure} from './lock-probe.mjs';

const unlocked = readFileSync(new URL('./fixtures/console-unlocked.xml', import.meta.url), 'utf8');

test('recorded unlocked console does not falsely block screenshot capture', () => {
  assert.equal(lockProbeFailure({status: 0, stdout: unlocked}), null);
});

test('locked, conflicting, failed and missing probes never permit capture', () => {
  const locked = unlocked.replace('<false/>', '<true/>');
  for (const probe of [
    {status: 0, stdout: locked},
    {status: 0, stdout: locked + '<key>CGSSessionScreenIsLocked</key><false/>'},
    {status: 0, stdout: unlocked + '<key>CGSSessionScreenIsLocked</key><true/>'},
    {status: 1, stdout: unlocked},
    {status: 0, stdout: unlocked, error: new Error('probe timeout')},
    {status: 0, stdout: '<plist><dict/></plist>'},
  ]) assert.ok(lockProbeFailure(probe), JSON.stringify(probe));
});
