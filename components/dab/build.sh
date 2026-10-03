#!/bin/bash
# Build the DAB/DAB+ decoder (fn-dab) and the DAB scanner (fn-dab-scanner).
# Runs in the build container, after libfn-rtlsdr0 and libfn-rtlsdr-dev are installed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

pkg-config --exists libfn-rtlsdr || { echo "error: libfn-rtlsdr is not installed" >&2; exit 1; }
echo "[+] dab: against libfn-rtlsdr $(pkg-config --modversion libfn-rtlsdr)"

common=(
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_SYSTEM_NAME=Linux
  -DCMAKE_SYSTEM_PROCESSOR="$TARGET_MACHINE"
  -DCMAKE_C_COMPILER=/usr/bin/gcc
  -DCMAKE_CXX_COMPILER=/usr/bin/g++
  -DRTLSDR=ON
)

# On 64-bit ARM the project's find modules miss the multiarch directory.
lib=/usr/lib/aarch64-linux-gnu
# Only the names the find modules read are given: CMake says so when it is handed one
# that nothing reads, and the build stops on a warning nobody has reviewed.
explicit_decoder=(
  -DFFTW3F_LIBRARIES=$lib/libfftw3f.so
  -DFAAD_INCLUDE_DIR=/usr/include -DFAAD_LIBRARY=$lib/libfaad.so
  -DLIBSAMPLERATE_INCLUDE_DIR=/usr/include -DLIBSAMPLERATE_LIBRARY=$lib/libsamplerate.so
  -DPORTAUDIO_LIBRARIES=$lib/libportaudio.so
  -DLIBRTLSDR_INCLUDE_DIR=/usr/include -DLIBRTLSDR_LIBRARIES=$lib/libfn-rtlsdr.so
  -DLIBSNDFILE_INCLUDE_DIR=/usr/include -DLIBSNDFILE_LIBRARY=$lib/libsndfile.so
  -DZLIB_INCLUDE_DIR=/usr/include -DZLIB_LIBRARY=$lib/libz.so
)
explicit_scanner=(
  -DFFTW3F_LIBRARIES=$lib/libfftw3f.so
  -DFAAD_INCLUDE_DIR=/usr/include -DFAAD_LIBRARY=$lib/libfaad.so
  -DLIBRTLSDR_INCLUDE_DIR=/usr/include -DLIBRTLSDR_LIBRARIES=$lib/libfn-rtlsdr.so
  -DLIBSNDFILE_INCLUDE_DIR=/usr/include -DLIBSNDFILE_LIBRARY=$lib/libsndfile.so
  -DZLIB_INCLUDE_DIR=/usr/include -DZLIB_LIBRARY=$lib/libz.so
)

build_one() {  # <source dir> <cmake output name> <shipped name> <explicit args...>
  local src="$1" built="$2" shipped="$3"; shift 3
  local dir="$WORK/dab/$shipped"
  rm -rf "$dir"; mkdir -p "$dir"; cd "$dir"
  if [ "$TARGET" = "armv8" ]; then
    cmake "$src" "${common[@]}" "$@"
  else
    cmake "$src" "${common[@]}" -DCMAKE_C_FLAGS="$TARGET_CFLAGS" -DCMAKE_CXX_FLAGS="$TARGET_CFLAGS"
  fi
  make -j"$(nproc)"
  strip "$built"
  cp "$built" "$OUT/bin/$shipped"
  echo "[OK] dab: $shipped $(stat -c %s "$OUT/bin/$shipped") bytes"
}

build_one "$here/src/foonerd-dab"         dab-rtlsdr-3       fn-dab         "${explicit_decoder[@]}"
build_one "$here/src/foonerd-dab-scanner" dab-scanner-rtlsdr fn-dab-scanner "${explicit_scanner[@]}"
