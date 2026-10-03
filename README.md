# rtlsdr-radio

FM and DAB/DAB+ radio for [Volumio](https://volumio.com) through RTL-SDR USB tuners: the plugin, and the builds of every binary it ships.

The plugin appears in Volumio as **FM/DAB Radio** (`rtlsdr_radio`). This repository is where it is developed and where its components are built; released versions are published through the Volumio plugin store.

## Layout

| Path | Holds |
| --- | --- |
| `plugin/` | The Volumio plugin: controller, Station Manager, settings, translations, installer. No binaries. |
| `components/rtlsdr/` | The RTL-SDR library and tools, packaged as `libfn-rtlsdr0` and `foonerd-rtlsdr` (`fn-rtl_fm`, `fn-rtl_power`, ...). Built from [osmocom/rtl-sdr](https://github.com/osmocom/rtl-sdr). |
| `components/dab/` | The DAB/DAB+ decoder `fn-dab` and the scanner `fn-dab-scanner`. Source in `src/`, derived from [dab-cmdline](https://github.com/JvanKatwijk/dab-cmdline). |
| `components/redsea/` | The RDS decoder `fn-redsea`. Built from [redsea](https://github.com/windytan/redsea) with [liquid-dsp](https://github.com/jgaeddert/liquid-dsp) linked in. |
| `components/gain/` | The tool `fn-rtl-gain`, which measures the gain a dongle should be set to at a frequency and surveys the FM band for stations. Source in `src/`. |
| `docker/` | The build environments. |
| `scripts/` | Fetching sources, building a target, checking the result, assembling the plugin. |

Everything the plugin runs carries an `fn-` prefix, and the library is named `libfn-rtlsdr`, so that nothing collides with packages of the same origin in the distribution.

## Targets

A target is one of Volumio's architecture names, which is also the directory the plugin installs from.

| Target | Runs on | Built in |
| --- | --- | --- |
| `arm` | Raspberry Pi universal image: every Pi from the Zero and Pi 1 up (ARMv6 hard-float userland) | a Raspbian bookworm root |
| `armv7` | 32-bit ARMv7 boards with NEON | Debian bookworm |
| `armv8` | 64-bit ARM | Debian bookworm |
| `x64` | x86-64 | Debian bookworm |

The `arm` target is built inside a Raspbian root because Volumio's Pi image takes its userland from Raspbian, which is ARMv6. Debian's own `armhf` is ARMv7, and anything linked against its start files and libraries cannot run on an ARMv6 processor whatever flags the compiler is given.

## Building

Requirements: Docker, git, Python 3, and a machine that can run the targets' programs: an x86-64 one with emulation for the ARM targets (qemu binfmt), or a 64-bit ARM one, which runs the three ARM targets natively.

```bash
./build.sh              # all targets
./build.sh arm x64      # the named ones
```

For each target this

1. makes the target's build image if it is not there yet: the build tools, and the upstream sources at the commits named in `components/*/*.lock`,
2. in that image, with no network, builds the library packages, then the DAB decoder against them, then the RDS decoder and the gain tool,
3. checks every binary: it must be built for the target's architecture (for `arm`: ARMv6, no Thumb-2) and must start; `fn-rtl-gain` also runs its measurements on a signal it makes up and must get them right,
4. checks the build's output for warnings nobody has reviewed (`components/warnings-reviewed.txt`),
5. writes `out/<target>/` with `bin/`, `packages/`, the build's output in `build.log`, and a `manifest.json` naming the sources and the checksum of every file.

### Sources

Upstream sources are not kept in this repository. Each is named by a lock file:

```
URL=https://github.com/osmocom/rtl-sdr.git
COMMIT=<full commit id>
REF=<tag or description, for readers>
```

To move a component to a newer upstream, change `COMMIT` (and `REF`) and build.

## Assembling the plugin

```bash
scripts/assemble-plugin.sh
```

writes `dist/rtlsdr_radio/`: the plugin with `bin/<target>/` and `packages/<target>/` filled from `out/`, and a `components.json` recording what the binaries were built from. That folder is what is installed on a player.

```bash
scripts/package-plugin.sh
```

assembles the folder, installs its node modules with the Node version Volumio ships, adds `build.json` (version, commit, time) and writes `dist/rtlsdr_radio-<version>.zip`, the zip a player installs.

## Builds on GitHub

| Workflow | Runs on | Does |
| --- | --- | --- |
| `ci` | every push to `main`, every pull request | checks the plugin's JavaScript and runs its tests |
| `components` | a change of anything the components are built from | builds the components for each target and keeps them in the registry |
| `release` | a tag `v<version>` | tests, fetches the components, packs the zip, publishes it as a pre-release |

**Nothing is downloaded from third parties while a build runs.** What a build needs is put into an image once, when what the image is made of changes, and kept in the project's registry (`ghcr.io/foonerd/rtlsdr-radio-builder`) under a key made of its inputs (`scripts/builder-key.sh`):

| Image | Holds | Made again when |
| --- | --- | --- |
| `<target>-<key>` | the build tools for the target and the upstream sources at their locked commits | `docker/Dockerfile.build`, `docker/Dockerfile.raspbian` or a lock file changes |
| `node-<key>` | Node as Volumio ships it, with the plugin's node modules | `plugin/package-lock.json` changes |

The component builds and the tests run in these images with the network switched off. Nothing is emulated either: the three ARM targets are built on an ARM runner, whose processor runs 32-bit ARM programs as well.

The compiled components themselves are kept the same way, in `ghcr.io/foonerd/rtlsdr-radio-components` under `scripts/components-key.sh`, a key made of everything they are built from. The `components` workflow skips a target whose key is already there, so a release only fetches them:

```bash
scripts/fetch-components.sh      # out/<target>/ from the registry, for the sources as checked out
```

Every build keeps its output in `out/<target>/build.log` and checks it against `components/warnings-reviewed.txt`: a compiler or tool warning that is not listed there, with the reason it is harmless, fails the build.

A release is made by setting the version in `plugin/package.json`, writing its notes under "Version History" in `plugin/README.md`, and pushing the tag `v<version>`. The tag must name the version the plugin carries. The release's text is that version's notes (`scripts/release-notes.sh <version>`). Run by hand, the `release` workflow builds the zip and publishes nothing.

```bash
scripts/set-version.sh 1.3.11 "v1.3.11 - what this version brings, in one line"
```

sets the version wherever the plugin states it.

A release is published as a pre-release: a preview, tried from GitHub before it is submitted to the Volumio plugin store. The plugin's own updater offers pre-releases on its Preview channel only. When a version becomes the stable one in the store, its release here is marked as released, and from then on stands for the stable version:

```bash
gh release edit v<version> --prerelease=false --latest
```

## Licences

| Part | Licence |
| --- | --- |
| `plugin/` | GPL-3.0 |
| `components/dab/src/` | GPL-2.0, as dab-cmdline |
| `components/gain/src/` | GPL-2.0-or-later |
| RTL-SDR library and tools (built, not kept here) | GPL-2.0-or-later, as rtl-sdr |
| redsea and liquid-dsp (built, not kept here) | MIT |
