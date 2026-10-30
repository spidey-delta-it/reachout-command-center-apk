# Changelog

All notable changes to the ReachOut Command Center Android app will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [Semantic Versioning](https://semver.org/).

## [3.0.0] - 2026-10-30

### Changed
- Reset version baseline to 3.0.0 to establish clean separate versioning for the Android app (independent from desktop)
- Added visible app version badge in the sidebar footer so the installed version is always identifiable
- Build pipeline modernized: Node 22, JDK 21 (temurin), Android SDK packages pinned to platforms;android-34 + build-tools 34.0.0
- Release notes are now auto-generated from this changelog on each build

### Fixed
- Server credential rotation (new `reachoutmediatech.info` admin login applied to baked-in service credentials)
- `android-actions/setup-android@v3` auto-install of deprecated `tools` package

---

## Earlier history (pre-3.0.0)

This changelog starts at v3.0.0. For the earlier version lineage, see the tags on this repo (`android-v2.4.0`, `android-v2.4.1`) and the commit history.
