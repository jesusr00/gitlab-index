# GitLab Technology Index

A local CLI that inventories the GitLab projects you belong to and searches their declared technologies and versions. It scans the default branch of each project, including archived projects, and stores evidence in SQLite for offline queries.

## Install from npm

Once published:

```bash
npm install --global gitlab-index
gitlab-index config set-host gitlab.example.com
glab auth login --hostname gitlab.example.com
gitlab-index sync
```

Requires Node.js 24.12 or later and `glab`. No GitLab instance is configured by default.

## Setup from source

Requirements: Node.js **24.12 or later**, npm, and the GitLab CLI (`glab`). The SQLite initialization notice is suppressed; other Node warnings remain enabled.

```bash
npm ci
npm run build

# Authenticate if this host is not already configured.
glab auth login --hostname gitlab.example.com

# Run directly, or use npm link to install the gitlab-index command.
node dist/cli.js --help
npm link

# Save the instance in .env in the current directory.
gitlab-index config set-host gitlab.example.com
```

Use a GitLab credential with read API access to your projects and repository files (normally `read_api`). `glab` owns authentication, including its configured credential storage; this application never extracts, stores, or logs the authentication token. Requests are read-only. Repository code, package scripts, Gradle and other build tools are never executed.

## Usage

```bash
gitlab-index sync
gitlab-index sync --force
gitlab-index projects
gitlab-index search --technology node
gitlab-index search --project frontend
gitlab-index search --project team/frontend --technology node --major 24
gitlab-index search --technology node --major 24
gitlab-index search --technology node --activity inactive
gitlab-index search --technology node --activity all
gitlab-index search --technology node --active-since 2026-01-01
gitlab-index search --technology node --compatible-with 24.0.0
gitlab-index search --technology react --version 19.0.0
gitlab-index search --technology node --major 24 --format json
gitlab-index show 123
```

Without `npm link`, replace `gitlab-index` with `node dist/cli.js`, or use `npm start -- <arguments>` during development.

Global options go before the command:

```bash
gitlab-index --host gitlab.example.com --database /tmp/example-index.sqlite sync
gitlab-index --database /tmp/example-index.sqlite search --technology node --format json
```

- Set the GitLab instance with `gitlab-index config set-host gitlab.example.com`. This creates or updates `GITLAB_INDEX_HOST` in `.env` in the current directory and preserves other settings. `.env` is ignored by Git; `.env.example` provides a template. Run the command again to change instances.
- Alternatively, use `export GITLAB_INDEX_HOST=gitlab.example.com` in your shell; add that line to your shell profile to use the setting from any directory. Precedence is `--host`, then the shell environment, then the current directory's `.env`. A hostname and optional port are accepted; omit `https://` and paths. There is no default instance. If no instance is configured (including an empty `.env` value), inventory commands fail with exit code 1 and explain how to set one before opening the database. Connections use authentication managed by `glab`; configure credentials separately for each instance. Inventories remain partitioned by host.
- `--database` defaults to the user's application data directory: `~/Library/Application Support/gitlab-index/inventory.sqlite` on macOS, `$XDG_DATA_HOME/gitlab-index/inventory.sqlite` (or `~/.local/share/...`) on Linux, and `%LOCALAPPDATA%/gitlab-index/inventory.sqlite` on Windows.
- `sync --concurrency 4` sets the number of concurrent projects (1–256). Files within each project are read sequentially. Synchronizations sharing a database are serialized by a process lock.
- `--format json` is available on every command. Synchronization progress and errors go to stderr, leaving stdout parseable.
- `projects` and `search` accept `--include-non-members` to include projects absent from the last completed membership refresh. `--include-inactive` remains a legacy alias for that membership option; use `--activity` for commit activity. `show` can inspect any indexed project directly.
- Technology names are case-insensitive; use manifest dependency names, for example `@nestjs/core`, `org.springframework.boot:spring-boot-starter`, `newtonsoft.json` or `laravel/framework`. Python names normalize `.`, `_` and `-` to `-`.

Use `--project <text>` to match a literal substring of the project path, including its namespace, without case sensitivity. For example, `--project frontend` matches `team/frontend-app`, and `--project team/frontend` narrows by namespace. It works alone to list all technology findings for matching projects, or alongside technology/version filters. At least one of `--technology` or `--project` is required. The filter uses the offline inventory and requires no new sync. Projects without technology findings do not appear in search; use `projects` to list the inventory.

Search defaults to `--activity active`: projects whose last **default-branch commit** is dated on or after six calendar months ago, starting at midnight UTC. Month ends are clamped to the last valid day. For example, on October 27, 2026, the default cutoff is April 27, 2026. `--activity inactive` selects older commits; `--activity all` removes the activity filter. Override the cutoff with `--active-since YYYY-MM-DD`, for example `--activity inactive --active-since 2026-01-01` to find projects whose last commit precedes January 1. The cutoff is inclusive for active projects and exclusive for inactive projects. Repository activity timestamps, issue updates and commits on other branches are not used.

Existing inventories migrate automatically while retaining findings and membership. Run a normal `sync` once to populate commit dates; unchanged projects update this metadata without downloading manifests again, so `--force` is unnecessary. Unknown commit dates are excluded from both active and inactive searches and produce a stderr reminder; `--activity all` keeps their findings accessible. Empty repositories are inactive and have no technology findings. JSON separates `member` (membership), `active` (true/false, or null when unknown) and `lastCommitAt` (ISO timestamp). Activity uses the latest saved commit date and the current cutoff, so it can change as time passes even without another sync. Run `sync` to discover newer commits.

Search output groups findings by project, printing its numeric ID, project URL and last commit date once. The compact table contains technology, version, matching file count, scan date (`DD/MM/YYYY`, local timezone) and exceptional state. Identical technology/version/date/state declarations across components are combined; `Files` counts distinct evidence paths. A dash in `State` indicates a resolved, current declaration in an active, non-archived project. Long values are shortened with an ellipsis to fit the terminal. Use `show <project-id>` for full versions, component paths, source files and diagnostics in a vertical layout, or `--format json` for the original ungrouped findings, complete timestamps and source URLs. Presentation changes do not require synchronization.

The first synchronization can take substantial time across large accounts. All membership pages and repository tree pages are fetched. Subsequent runs check each default branch and skip file reads when the previously successful commit and CI configuration are unchanged. Use `--force` after upgrading detectors to refresh existing findings.

During a scan, stderr identifies the project and reports tree-listing progress after the first page and approximately every 1,000 entries, followed by the manifest count, periodic file-read progress and additional CI files. Tree listing currently includes generated directory entries; exclusions apply when selecting manifests to download, so large committed dependency trees can take time even when few manifests are relevant.

Before the repository total is known, an animated loading indicator appears while discovering GitLab memberships. Redirected stderr receives one plain discovery message without animation. The indicator clears when percentage progress starts, or if discovery fails or is interrupted.

Every scan progress line starts with the global repository percentage and count, for example `[75.0% 3/4] unchanged team/app`. The total becomes available after membership discovery. Scanned, unchanged, empty and failed projects each count once as processed; interrupted projects do not count as completed. `100.0%` means every repository was processed, not that every scan succeeded. Percentages measure repositories rather than time or files, so the last few large repositories may take longer. Progress stays on stderr with `--format json`.

## Evidence and version matching

Each finding contains the project, component directory, technology, original version declaration, ecosystem, source category, file, immutable commit SHA, source URL and scan timestamp. A separate selector records a supported normalized value such as `24` from the Docker tag `24-alpine` or `9.0` from `net9.0`. Conflicting declarations remain separate findings.

| Query | Meaning |
| --- | --- |
| `--technology node` | Every detected Node declaration, including unknown and unresolved versions |
| `--major 24` | A supported selection confined to major 24, such as `24`, `24.2.0`, `^24.0.0`, or Docker `24-alpine` |
| `--version 19.0.0` | An explicit exact declaration, not a range that merely permits 19.0.0 |
| `--compatible-with 24.0.0` | A supported constraint that accepts that concrete version, including `>=20` |

Only one version filter may be specified. Version-filtered searches exclude unknown and unresolved findings. npm uses SemVer; Python uses PEP 440; Composer supports stable numeric SemVer-style constraints with Composer's tilde behavior; Maven and NuGet support the documented numeric subset below. Unsupported expressions remain visible in unfiltered searches with a reason, rather than being guessed.

`current` means the last synchronization checked or scanned the repository successfully. It does **not** mean the repository is continuously monitored or that its configuration is deployed. Always inspect `scannedAt`, the project's `checkedAt`, and `scanStatus` when using an older inventory.

## Initial detector coverage

| Ecosystem | Files and declarations |
| --- | --- |
| Node / JavaScript | `package.json` engines, package manager, Volta, dev engines, dependencies, dev/peer/optional dependencies; `.nvmrc`, `.node-version` |
| Python | `pyproject.toml` project dependencies, extras and dependency groups; Poetry dependencies/groups; `Pipfile`; `requirements*.txt`; `.python-version`, `runtime.txt` |
| Java | Maven `pom.xml` direct dependencies, parent, local properties and compiler versions; Gradle literal dependency coordinates, plugin versions, Java compatibility/toolchain declarations; `.java-version`, `.sdkmanrc` |
| .NET | `global.json`; project files (`.csproj`, `.fsproj`, `.vbproj`); `Directory.Build.props`, `Directory.Packages.props`; target frameworks and package references |
| Go | `go.mod` language/toolchain versions and direct requirements; `.go-version` |
| PHP | `composer.json` require/require-dev and PHP constraint; `.php-version` |
| Shared | Supported entries in `.tool-versions`; recognized runtime/build images in Dockerfiles, Docker Compose services and GitLab CI images/services |

Manifests inside monorepos are scanned recursively and retain their component directory. Dependency installations and generated directories are excluded: `node_modules`, `vendor`, `.git`, `.venv`, `venv`, `__pycache__`, `dist`, `build`, `target`, `bin`, `obj`, `coverage`, `.next`, `.nuxt`, `.output`, `.gradle`, `.yarn`. Symlinks are not dereferenced.

Explicit CI configuration paths and local includes resolve against the complete repository tree, including excluded directories such as `.cicd/build/`. This exception fetches referenced CI files without scanning unrelated generated manifests in those directories.

GitLab CI starts at the project's configured local CI file, or `.gitlab-ci.yml`. Local includes, including glob patterns and nested includes, are followed at the same commit. External includes, dynamic include paths, variable-based images and child pipeline includes remain explicit unresolved evidence. Variables and rules are not evaluated; declarations in conditional jobs are still inventory evidence.

CI files may contain a `spec:` header followed by `---` and the job configuration. The header is validated separately; input defaults are not treated as runtime declarations or interpolated into jobs. Unrelated multi-document YAML is rejected rather than silently dropping declarations. YAML errors report a diagnostic code, line and column without exposing source content.

Docker Compose detection covers `compose.yml`, `compose.yaml`, `docker-compose.yml`, `docker-compose.yaml`, and dot-separated variants such as `compose.prod.yaml`, `docker-compose.dev.yml` and `compose.test.local.yaml`, including nested directories. Recognized runtime images under `services.*.image` produce evidence with source `docker`. YAML anchors and merge keys are supported; extension blocks alone do not create runtime findings. Variables, including `${NODE_VERSION:-24}`, remain unresolved without reading `.env` files or expanding defaults. Files are indexed separately; Compose overrides, `include`, `extends` and build-only services are not evaluated. To include these new findings in an existing inventory whose commits have not changed, run `sync --force`.

### Deliberate limits

- This is a declaration inventory, not a deployment scanner, SBOM, vulnerability audit or transitive dependency resolver. Lockfiles and installed packages are not analyzed.
- A package manifest can establish a runtime's presence without specifying its version. That produces an `unknown` finding, not a guessed runtime version.
- Java properties resolve within the same POM; parent inheritance, dependency management, Gradle execution and version catalogs are not resolved. Catalog/computed declarations are marked unresolved where recognized; unsupported Gradle DSL cannot be exhaustively interpreted statically.
- .NET properties resolve within the same XML file; cross-file MSBuild imports/central versions are not evaluated. Only modern `netX.Y` and `netcoreappX.Y` target frameworks are normalized. Other target frameworks remain unresolved.
- Maven and NuGet comparison initially supports numeric releases, singleton `[x.y.z]` and a single interval such as `[1.0,2.0)`. NuGet bare numeric versions are minimum bounds; exact NuGet versions use `[x.y.z]`. Qualifiers, disjoint intervals and floating NuGet versions remain unresolved.
- Poetry-specific constraints such as caret expressions remain unresolved unless also valid PEP 440 expressions. PEP 508 markers are not evaluated; conditional requirements are retained as declarations.
- Images using variables, digests without a known version, `latest`, or unsupported tags remain unknown/unresolved. Multi-stage Docker aliases do not create a second runtime finding.
- A relevant file larger than 2 MiB fails that project scan explicitly. Malformed JSON, TOML, XML or CI YAML also fails the scan, preserving its last good snapshot.
- GitLab submodules and external repositories are not traversed. GitLab instances hosted under an API URL subpath are not supported in the initial version.

## Synchronization and recovery

Membership refresh completes before database membership changes. Missing projects become non-members only after a successful complete refresh. Membership and commit activity are independent. Archived projects remain searchable and carry `archived: true`.

Each scan pins the default branch to a commit before reading files. A successful project scan replaces its findings in one SQLite transaction; deleted manifests therefore remove old evidence. Failure leaves the previous findings intact with `freshness: stale` and a project error. Other projects continue, and the command exits with status 1 if any project failed.

`Ctrl+C`/termination cancels in-flight requests and prevents partial project snapshots from replacing good data. Projects pending or scanning after an interruption are visibly stale; run `sync` again to recover. A hard-killed process's lock is reclaimed when its PID no longer exists. Queries can still read the last saved inventory without `glab` or network access.

HTTP 429 and server errors retry up to three times, respecting `Retry-After` or rate-limit reset headers with exponential backoff. Other HTTP errors fail immediately. Individual `glab` requests time out after 60 seconds. Exhausted retries and authentication/transport failures are reported without response bodies or credential output.

## Development and verification

```bash
npm run check
npm test
npm run build
npm run smoke
```

Tests use temporary SQLite databases and fake GitLab responses; they do not require authentication. They cover calendar cutoffs, activity filters, schema migration, unchanged-commit date backfill, detector fixtures across all six ecosystems, version semantics, pagination, retries, failure preservation, deletion, membership, archived/empty repositories, local CI includes, concurrency, interruption recovery and the offline CLI.

`npm run smoke` uses the configured `glab` credentials to enumerate memberships and read a nonempty project's default branch, tree and one file. It makes no GitLab changes and does not create an inventory. It resolves the host from `GITLAB_INDEX_HOST` or the current directory's `.env`, like the CLI. A successful smoke test establishes basic API access, not read permission on every repository.

## Architecture

`src/gitlab` owns read-only API access and pagination/retries. `src/detection` owns stateless file parsing and version matching. `src/inventory` owns persistence, query behavior and synchronization. The CLI wires these public interfaces together. This keeps domain rules together and lets additional detectors or another repository adapter reuse the inventory without introducing a server or a generic technical-layer hierarchy.

GitLab API references: [project membership](https://docs.gitlab.com/api/projects/), [default branch commits](https://docs.gitlab.com/api/branches/), [repository trees](https://docs.gitlab.com/api/repositories/), [repository files](https://docs.gitlab.com/api/repository_files/).

## Releases

See [Publishing](docs/publishing.md) for GitHub and npm setup, first publication, version tags, prereleases and recovery. CI validates pull requests and branches. Pushing `vX.Y.Z` validates the source and package, publishes to npm, then creates a GitHub release containing the same tarball. Publishing uses npm trusted publishing (OIDC).

## License

[MIT](LICENSE).
