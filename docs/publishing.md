# Publishing

Package: `gitlab-index`. Repository: `https://github.com/jesusr00/gitlab-index`. License: MIT. Publishing is prepared locally; no repository, tag, release or npm package is created by this setup.

## Workflows

- `ci.yml`: every branch push, pull request and reusable release validation. Runs type checking, the test suite, and a clean installation of the actual npm tarball on Linux and macOS, using the minimum Node 24.12.0 and the latest Node 24 release. No GitLab credentials or instance configuration are needed.
- `publish.yml`: a pushed `v*` tag, or a manual run with a tag selected. Waits for the entire CI matrix, verifies the tag matches `package.json` and the GitHub repository matches `repository.url`, builds a fresh tarball, publishes it, then creates a GitHub release with generated notes and attaches that same tarball. Stable versions use npm's `latest` tag; prereleases use `next` and are marked as prereleases on GitHub.
- Dependabot checks npm dependencies and GitHub Actions weekly. Actions are pinned to full commit SHAs.

Only `dist/`, `README.md`, `LICENSE` and npm's mandatory `package.json` enter the package. Tests, source fixtures, `.env`, SQLite databases and workflows are excluded. `prepack` builds the CLI; consumers need no TypeScript tools. `--version` reads the package version.

## One-time GitHub setup

1. Create `jesusr00/gitlab-index` on GitHub. Use a public repository if you want npm provenance attestations.
2. Push the reviewed source and workflows. This guide does not commit or push automatically. Configure `origin` to point to this repository if it does not exist yet.
3. Enable GitHub Actions and create an environment named **`npm`**. Restrict its deployment branches/tags to release tags (`v*`); optionally configure required reviewers.
4. Protect the default branch with the four `Validate (...)` matrix checks, and restrict creation/modification of `v*` tags to maintainers.
5. Confirm CI succeeds before releasing. No GitLab token or `GITLAB_INDEX_HOST` secret should be configured for CI.

## First publication on npm

Trusted publishing is configured in an existing package's settings. Bootstrap the initial package once from your authenticated local machine. First confirm you own or can claim the package name; registry availability is not a reservation.

```bash
npm ci
npm run check
npm test
npm run test:package
npm login --registry=https://registry.npmjs.org
npm pack
npm publish ./gitlab-index-0.1.0.tgz --access public
```

Use your npm account's required 2FA/authentication flow. This publishes the initial `0.1.0` package; do not run this until the package contents and metadata have been reviewed. Create the corresponding `v0.1.0` tag and GitHub release manually if wanted. Pushing that already-published version's tag will trigger Publish and npm will reject the duplicate; do not push it before configuring the workflows, or use the manual GitHub release approach below without rerunning Publish.

On npmjs.com, open `gitlab-index` → **Settings → Trusted publishing**, add GitHub Actions, and enter:

| Setting | Value |
| --- | --- |
| Organization/user | `jesusr00` |
| Repository | `gitlab-index` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |
| Allowed actions | Enable direct publishing with `npm publish` |

This must match GitHub exactly. The workflow has `id-token: write` and uses a GitHub-hosted runner and Node 24 with a compatible npm CLI. No `NPM_TOKEN` secret is needed for subsequent releases. If npm offers staged publishing by default, explicitly enable direct `npm publish` for this workflow. Newly configured publishers must complete their first successful publication within npm's stated expiry window; configure this shortly before your next release.

## Subsequent releases

From a clean, reviewed default branch:

```bash
npm version patch --no-git-tag-version
npm run check
npm test
npm run test:package
```

Review and commit `package.json` and `package-lock.json` using your normal process. Once that commit is pushed and CI succeeds, create and push a matching tag, for example:

```bash
git tag v0.1.1
git push origin v0.1.1
```

The package version and tag must agree exactly. Versions cannot be overwritten on npm. Use `npm version minor --no-git-tag-version` or `major` for other version increments. For a prerelease, use a version such as `0.2.0-beta.1` and tag `v0.2.0-beta.1`; Publish selects `next` automatically. Consumers can install prereleases with `npm install --global gitlab-index@next`.

`workflow_dispatch` is available for recovery, but select a **tag**, not a branch. Changing branches does not authorize a release and the identity check rejects branch runs. Workflows do not bump versions, commit, create tags, or push source changes.

## Failure recovery

- Validation, package installation or identity failure: fix the source and create a new version tag after validation. Do not move a tag whose version has been published.
- npm authentication failure: verify the trusted publisher's repository, filename, environment and direct-publish permission, then rerun the failed job. No package is published before the publish step succeeds.
- npm version already exists: check the existing package before doing anything else. Never assume that an existing version has the expected contents. To publish different contents, increment the version.
- npm succeeds but GitHub release creation fails: **do not rerun the publish job**, because npm rejects duplicate versions. Recover the exact tarball from npm, verify it, and create the GitHub release manually:

```bash
npm pack gitlab-index@0.1.1 --registry=https://registry.npmjs.org
gh release create v0.1.1 ./gitlab-index-0.1.1.tgz \
  --repo jesusr00/gitlab-index --verify-tag --generate-notes --title v0.1.1
```

For prereleases, add `--prerelease`. If the release already exists, inspect its assets and use `gh release upload` for a missing tarball instead of creating a duplicate release.

## Local verification

```bash
npm run check
npm test
npm run test:package
actionlint
```

`test:package` builds and packs the project, validates the tarball's file list, installs it with only production dependencies in a temporary directory, checks help/version, and opens a fresh offline SQLite inventory. It requires registry access or cached production dependencies and never reads real GitLab credentials or the user's inventory. `actionlint` is optional locally and is not an npm dependency.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [setup-node](https://github.com/actions/setup-node), [GitHub releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).
