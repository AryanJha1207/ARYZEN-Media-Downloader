# Releasing a new version

Maintainer guide for ARYZEN Media Downloader. Users never need this file;
it is for whoever builds and publishes the downloads on GitHub Releases.

## Build the release ZIPs

1. Bump `"version"` in `extension/manifest.json` (for example
   `2.2.0` -> `2.2.1`), commit and push.
2. Run:
   ```
   sh install/build-release-zips.sh
   ```
   This creates `release-zips/v<version>/` with the four OS ZIPs
   (Windows, macOS-AppleSilicon, macOS-Intel, Linux) and prints a
   SHA-256 checksum for each. `release-zips/` is git-ignored on
   purpose - never commit the built ZIPs to the repo history.
3. On GitHub: **Releases -> Draft a new release** -> create a new tag
   matching the version (`v2.2.1`) -> attach the four ZIPs from
   `release-zips/v<version>/` -> **Publish release**.

## When a contributor's PR is merged (example: a Windows fix)

1. Merge the pull request on GitHub.
2. On your Mac, in Terminal:
   ```
   cd /Users/aryzen/GITHUB/amd-github-release/aryzen-media-downloader
   git pull
   ```
3. If the change should ship to users, bump the version in
   `extension/manifest.json`, commit and push.
4. Run `sh install/build-release-zips.sh` and publish the release as
   above. The script always builds all four ZIPs from the same source,
   so every OS download of a version stays identical.

One honest caveat: the ZIPs are *built* on your Mac, which works fine
for packaging - but a Windows ZIP cannot be *run* on a Mac. If a PR
changes Windows install logic, ask the contributor to confirm on the PR
that they tested it on a real Windows machine before you merge.
