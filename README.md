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

Requirements: Docker with emulation for foreign architectures (qemu binfmt), git, Python 3.

```bash
./build.sh              # all targets
./build.sh arm x64      # the named ones
```

For each target this

1. fetches the upstream sources at the commits named in `components/*/*.lock`,
2. builds the library packages, then the DAB decoder against them, then the RDS decoder,
3. checks every binary: it must be built for the target's architecture (for `arm`: ARMv6, no Thumb-2) and must start,
4. writes `out/<target>/` with `bin/`, `packages/` and a `manifest.json` naming the sources and the checksum of every file.

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

## Licences

| Part | Licence |
| --- | --- |
| `plugin/` | GPL-3.0 |
| `components/dab/src/` | GPL-2.0, as dab-cmdline |
| RTL-SDR library and tools (built, not kept here) | GPL-2.0-or-later, as rtl-sdr |
| redsea and liquid-dsp (built, not kept here) | MIT |
