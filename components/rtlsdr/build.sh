#!/bin/bash
# Build the RTL-SDR library and tools as Debian packages:
#   libfn-rtlsdr0, libfn-rtlsdr-dev, foonerd-rtlsdr (fn-rtl_fm, fn-rtl_power, ...).
# Runs in the build container. The library is renamed so that it never collides
# with the distribution's librtlsdr.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

work="$WORK/rtlsdr"
rm -rf "$work"
mkdir -p "$work"
cp -a "$SRC_CACHE/rtl-sdr" "$work/source"
rm -rf "$work/source/.git"
cd "$work/source"

echo "[+] rtlsdr: renaming the library to fn-rtlsdr"
sed -i 's/\brtlsdr_static\b/fn-rtlsdr_static/g' src/CMakeLists.txt
sed -i 's/\brtlsdr\b/fn-rtlsdr/g' src/CMakeLists.txt
sed -i 's/Name: librtlsdr/Name: libfn-rtlsdr/g' librtlsdr.pc.in
sed -i 's/Libs: -L\${libdir} -lrtlsdr/Libs: -L\${libdir} -lfn-rtlsdr/g' librtlsdr.pc.in
grep -q 'fn-rtlsdr' src/CMakeLists.txt
grep -q 'lfn-rtlsdr' librtlsdr.pc.in

echo "[+] rtlsdr: packaging"
cp "$here"/debian/control "$here"/debian/rules "$here"/debian/changelog "$here"/debian/*.install debian/
if [ -f debian/librtlsdr0.maintscript ]; then
  mv debian/librtlsdr0.maintscript debian/libfn-rtlsdr0.maintscript
fi

export DEB_BUILD_MAINT_OPTIONS='hardening=+all optimize=-lto'
if [ "$TARGET" = "arm" ]; then
  export DEB_CFLAGS_APPEND="$TARGET_CFLAGS"
  export DEB_CXXFLAGS_APPEND="$TARGET_CFLAGS"
fi
dpkg-buildpackage -us -uc -b

# Name the packages by target, as the plugin's installer expects them.
deb_arch="$(dpkg --print-architecture)"
for f in "$work"/*_"$deb_arch".deb; do
  cp "$f" "$work/$(basename "${f%_"$deb_arch".deb}")_${TARGET}.deb"
done
cp "$work"/libfn-rtlsdr0_*_"$TARGET".deb "$work"/foonerd-rtlsdr_*_"$TARGET".deb "$OUT/packages/"
echo "[OK] rtlsdr: $(ls "$OUT/packages" | tr '\n' ' ')"
