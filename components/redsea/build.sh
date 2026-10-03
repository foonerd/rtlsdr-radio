#!/bin/bash
# Build the RDS decoder (fn-redsea), with liquid-dsp linked in statically so that
# the binary needs nothing beyond what a Volumio image already has.
# Runs in the build container.
set -euo pipefail

work="$WORK/redsea"
prefix="$work/prefix"
rm -rf "$work"
mkdir -p "$work" "$prefix"

echo "[+] redsea: building liquid-dsp (static)"
cp -a "$SRC_CACHE/liquid-dsp" "$work/liquid-dsp"
cd "$work/liquid-dsp"
./bootstrap.sh

# liquid-dsp picks its vector code from the machine that builds it, not from the target:
# on x86-64 whatever the build host's processor offers (AVX2 on a recent one), on 32-bit ARM
# always NEON. Where the target's baseline has neither, the portable code is used instead.
# Its own FFT is used everywhere, so that nothing depends on FFTW being in the image.
liquid_options=(--enable-fftoverride)
case "$TARGET" in
  arm|x64) liquid_options+=(--enable-simdoverride) ;;
esac
CFLAGS="$TARGET_CFLAGS -fPIC" ./configure --prefix="$prefix" "${liquid_options[@]}"
make -j"$(nproc)"
make install

# liquid-dsp ships no pkg-config file; meson looks for one.
liquid_version="$(sed -n 's/^AC_INIT(\[liquid-dsp\],\[\([^]]*\)\].*/\1/p' configure.ac)"
mkdir -p "$prefix/lib/pkgconfig"
cat > "$prefix/lib/pkgconfig/liquid.pc" <<PC
prefix=$prefix
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include

Name: liquid
Description: liquid-dsp signal processing library
Version: ${liquid_version:-0}
Libs: -L\${libdir} -lliquid -lm
Cflags: -I\${includedir}
PC

echo "[+] redsea: building redsea against liquid-dsp ${liquid_version:-unknown}"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LIBRARY_PATH="$prefix/lib${LIBRARY_PATH:+:$LIBRARY_PATH}"
export LDFLAGS="-L$prefix/lib -static-libgcc -static-libstdc++"
export CFLAGS="$TARGET_CFLAGS -I$prefix/include"
export CXXFLAGS="$TARGET_CFLAGS -I$prefix/include"

meson setup --buildtype=release --prefer-static -Dbuild_tests=false \
  "$work/build" "$SRC_CACHE/redsea"
meson compile -C "$work/build"

strip "$work/build/redsea"
cp "$work/build/redsea" "$OUT/bin/fn-redsea"
echo "[OK] redsea: fn-redsea $(stat -c %s "$OUT/bin/fn-redsea") bytes"
