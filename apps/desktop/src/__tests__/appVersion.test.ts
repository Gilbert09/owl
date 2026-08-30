import {
  appVersionFrom,
  PLACEHOLDER_VERSION,
  resolveAppVersion,
} from '../../.erb/configs/appVersion';

/**
 * The version baked into the renderer bundle. It feeds the `app_version`
 * analytics super property and the `X-Talyn-Client-Version` header, and
 * `release/app/package.json` carries a committed placeholder that only CI
 * replaces — so an unstamped build used to report itself as an ancient
 * release. Anything not stamped must read `dev`.
 */
describe('appVersionFrom', () => {
  it('passes a CI-stamped version through untouched', () => {
    expect(appVersionFrom('0.2.60')).toBe('0.2.60');
    expect(appVersionFrom('1.0.0-rc.1')).toBe('1.0.0-rc.1');
  });

  it('reports the committed placeholder as dev', () => {
    expect(appVersionFrom(PLACEHOLDER_VERSION)).toBe('dev');
  });

  it.each([undefined, null, ''])('reports %p as dev', (raw) => {
    expect(appVersionFrom(raw)).toBe('dev');
  });

  it('resolves this working tree to dev — release/app is never stamped in git', () => {
    // Guards the wiring, not just the predicate: if the placeholder in
    // release/app/package.json is ever changed without updating
    // PLACEHOLDER_VERSION, local builds start reporting a fake release again.
    expect(resolveAppVersion()).toBe('dev');
  });
});
