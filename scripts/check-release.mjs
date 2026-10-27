import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import semver from 'semver';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.ok(semver.valid(pkg.version), 'package.json version must be valid SemVer');
assert.equal(process.env.GITHUB_REF_TYPE, 'tag', 'Select a version tag when running Publish manually');
assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`, 'Tag must equal v followed by the package.json version');
assert.equal(pkg.name, 'gitlab-index', 'Review publication configuration before changing the package name');
assert.equal(pkg.private, undefined, 'The package must be publishable');
assert.equal(pkg.repository?.url, `git+https://github.com/${process.env.GITHUB_REPOSITORY}.git`, 'package.json repository must match this GitHub repository');
console.log(`Release identity verified: ${pkg.name}@${pkg.version}`);
