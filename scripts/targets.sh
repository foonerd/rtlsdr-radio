# Target table, sourced by build.sh and by the scripts that run in the container.
#
# A target is one of Volumio's architecture names (VOLUMIO_ARCH in /etc/os-release),
# which are also the directory names the plugin installs from.
#
#   arm    Raspberry Pi universal image: ARMv6 hard-float userland (Pi Zero and Pi 1 upward)
#   armv7  32-bit ARMv7 boards, NEON
#   armv8  64-bit ARM
#   x64    x86-64

TARGETS="arm armv7 armv8 x64"

target_platform() {
  case "$1" in
    arm)   echo "linux/arm/v6" ;;
    armv7) echo "linux/arm/v7" ;;
    armv8) echo "linux/arm64" ;;
    x64)   echo "linux/amd64" ;;
    *)     return 1 ;;
  esac
}

# The arm target is built in a Raspbian root (docker/Dockerfile.raspbian); see there for why.
target_base() {
  case "$1" in
    arm) echo "rtlsdr-radio/raspbian:bookworm" ;;
    *)   echo "debian:bookworm" ;;
  esac
}

target_cflags() {
  case "$1" in
    arm)   echo "-march=armv6 -mfpu=vfp -mfloat-abi=hard -marm" ;;
    armv7) echo "-march=armv7-a -mfpu=neon-vfpv4 -mfloat-abi=hard" ;;
    armv8) echo "-march=armv8-a" ;;
    x64)   echo "" ;;
    *)     return 1 ;;
  esac
}

# The machine the build tools are told they build for. They would otherwise ask the
# kernel, whose answer depends on where the build runs: a 32-bit ARM container says
# "armv7l" under emulation and "aarch64" on a 64-bit ARM machine that runs it natively.
target_machine() {
  case "$1" in
    arm|armv7) echo "armv7l" ;;
    armv8)     echo "aarch64" ;;
    x64)       echo "x86_64" ;;
    *)         return 1 ;;
  esac
}

# The same for configure scripts, which want a triplet; empty where their own guess is right.
target_triplet() {
  case "$1" in
    arm|armv7) echo "armv7l-unknown-linux-gnueabihf" ;;
    *)         echo "" ;;
  esac
}

# What `readelf -A` (32-bit ARM) or `file` must report for a binary of this target.
target_elf_rule() {
  case "$1" in
    arm)   echo "arm-v6" ;;
    armv7) echo "arm-v7" ;;
    armv8) echo "aarch64" ;;
    x64)   echo "x86-64" ;;
    *)     return 1 ;;
  esac
}
