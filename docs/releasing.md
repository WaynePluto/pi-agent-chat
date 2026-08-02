# Releasing Pi Agent Chat

This project produces two independent distribution channels from the same version tag:

- a GitHub Release containing the source tag and platform-specific VSIX files;
- the same platform-specific VSIX files, which are uploaded manually to VS Code Marketplace.

## Before the first release

1. Create or access the Marketplace publisher `waynepluto` at <https://marketplace.visualstudio.com/manage/publishers/>.
2. Check the package metadata in `package.json`, especially `publisher`, `repository`, `bugs` and `homepage`.
3. If Marketplace requires PAT verification while creating the first publisher, complete that one-time Microsoft/Azure DevOps account step. The GitHub workflow itself does not store or use a PAT.

The GitHub workflow only needs the repository's built-in `GITHUB_TOKEN` to create the GitHub Release. Marketplace upload is performed manually in the browser.

## Supported target packages

The clipboard dependency contains native binaries. The release workflow therefore
builds on matching GitHub-hosted runners and creates these target packages:

- `win32-x64`
- `linux-x64`
- `darwin-arm64`

Intel macOS (`darwin-x64`) is intentionally not packaged: the `macos-13` x64
runner is deprecated and Apple Silicon covers current macOS users. The remaining
`darwin-arm64` job runs on `macos-14`, with an architecture check that fails
rather than producing a mismatched package. Intel Mac users can build locally
with `pnpm package:vsix`.

Do not publish a package built on one operating system as an unqualified universal
VSIX. For manual installation, use the VSIX matching the user's platform.

## Changelog structure

`CHANGELOG.md` is intentionally kept as a small index so the VS Code Marketplace
can continue to discover the standard root changelog file. Detailed notes live in
one file per version under `docs/changelog/`:

```text
CHANGELOG.md
 docs/changelog/
   0.0.1.md
   0.0.1.zh-CN.md
   0.0.2.md
   0.0.2.zh-CN.md
```

For each release:

1. Add `docs/changelog/<version>.md` (English) and `docs/changelog/<version>.zh-CN.md` (Simplified Chinese).
2. Add links to both files in the root `CHANGELOG.md`.
3. Use absolute GitHub URLs in the index so the links work from Marketplace,
   where `docs/` is excluded from the VSIX.

## Local checks

Run the same checks used by the release workflow:

```powershell
pnpm typecheck
pnpm verify
pnpm exec vsce package --target win32-x64 --no-dependencies --readme-path README.md --out pi-code-agent-chat-win32-x64.vsix
```

Inspect package contents before distributing an artifact:

```powershell
pnpm exec vsce ls --no-dependencies --readme-path README.md
```

The VSIX must not contain repository-only files such as `AGENTS.md`, `.agents/`,
`.github/`, `src/` or `scripts/`.

## Version and tag

The Git tag must match the `version` field in `package.json`:

```text
package.json: 0.0.1
tag:          v0.0.1
```

Create and push a release tag only after the change is merged:

```powershell
git tag v0.0.1
git push origin v0.0.1
```

The tag workflow validates this match, builds all target VSIX files, and attaches
them to a GitHub Release. Download the target VSIX files from that Release and upload
them manually through Marketplace Publisher Management.

## Manual Marketplace upload

1. Open <https://marketplace.visualstudio.com/manage> and sign in with an account
   that owns or can manage the `waynepluto` publisher.
2. Select `waynepluto` and choose `New extension`, `Add extension` or the equivalent
   VSIX upload action.
3. Upload the first target package from the GitHub Release.
4. Upload the remaining target packages for the same extension version, using the
   Marketplace page's update/target-package action if it presents one.
5. Confirm the extension metadata, README, icon, version and target platform before
   publishing.

The target files from one release must all use the same extension version:

- `win32-x64`
- `linux-x64`
- `darwin-arm64`

Do not upload the unqualified local Windows artifact as a universal Marketplace
package. The browser upload does not require installing `vsce`; however, first-time
Publisher creation or verification may still require the Microsoft/Azure DevOps
account step required by Marketplace.

## Reproducible installs

The repository tracks `pnpm-lock.yaml` so CI and release builds use the exact
resolved dependency graph. Workflows install with:

```powershell
pnpm install --frozen-lockfile
```

Update the lockfile intentionally when dependency versions change, and include the
lockfile in the same commit as `package.json`.

## License notices

The extension itself is MIT-licensed. Bundled runtime packages have their own
licenses; see `THIRD-PARTY-NOTICES.txt`. In particular,
`@silvia-odwyer/photon-node@0.3.4` is Apache-2.0, `diff@8.0.4` is
BSD-3-Clause, and the clipboard packages used by the SDK are MIT.
