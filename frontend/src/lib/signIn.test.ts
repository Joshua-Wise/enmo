import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { returnPath, signInPath } from './signIn.ts';

describe('the sign-in redirect', () => {
  it('sends a page asked for without a session to sign-in, carrying the page and its query', () => {
    assert.equal(signInPath({ pathname: '/history/3', search: '?date=2026-10-08' }), '/sign-in?next=%2Fhistory%2F3%3Fdate%3D2026-10-08');
    assert.equal(signInPath({ pathname: '/settings', search: '' }), '/sign-in?next=%2Fsettings');
  });

  it('needs no next for the dashboard, or for the sign-in page itself', () => {
    assert.equal(signInPath({ pathname: '/', search: '' }), '/sign-in');
    assert.equal(signInPath({ pathname: '/sign-in', search: '?next=%2Fsettings' }), '/sign-in');
  });
});

describe('the return after signing in', () => {
  it('goes back to the page asked for, query included', () => {
    assert.equal(returnPath('?next=%2Fhistory%2F3%3Fdate%3D2026-10-08'), '/history/3?date=2026-10-08');
    assert.equal(returnPath(signInPath({ pathname: '/incidents', search: '?window=today' }).slice('/sign-in'.length)), '/incidents?window=today');
  });

  it('goes to the dashboard with no next', () => {
    assert.equal(returnPath(''), '/');
    assert.equal(returnPath('?next='), '/');
  });

  it('never leaves the site: a full URL, a protocol-relative one, or a backslash trick goes to the dashboard', () => {
    for (const next of ['https://evil.example/', '//evil.example/x', '/\\evil.example', '/%5Cevil.example', 'javascript:alert(1)', 'settings', '/\tevil', '/\nevil']) {
      assert.equal(returnPath(`?${new URLSearchParams({ next: decodeURIComponent(next) })}`), '/', next);
    }
  });

  it('never returns to the sign-in page itself', () => {
    assert.equal(returnPath('?next=%2Fsign-in'), '/');
    assert.equal(returnPath('?next=%2Fsign-in%3Fnext%3D%252Fsettings'), '/');
  });
});
