#!/bin/bash
# Gate: every ELF file under a directory must be built for the target it is shipped as.
#
#   check-elf.sh <target> <directory>
#
# For 32-bit ARM the build attributes are read (Tag_CPU_arch, Tag_THUMB_ISA_use,
# Tag_FP_arch, Tag_Advanced_SIMD_arch): they are the merge of every object linked in, so
# one ARMv7 start file or static library shows. The arm target must be ARMv6 without
# Thumb-2, with no more floating point than VFPv2 and no NEON, or it stops with an
# illegal instruction on a Pi Zero or Pi 1.
set -euo pipefail
. "$(dirname "$0")/targets.sh"

target="$1"
dir="$2"
rule="$(target_elf_rule "$target")"
fail=0
count=0

while IFS= read -r -d '' f; do
  desc="$(file -b "$f")"
  case "$desc" in ELF*) ;; *) continue ;; esac
  count=$((count + 1))
  rel="${f#"$dir"/}"
  case "$rule" in
    arm-v6|arm-v7)
      cpu="$(readelf -A "$f" | sed -n 's/^ *Tag_CPU_arch: //p')"
      thumb="$(readelf -A "$f" | sed -n 's/^ *Tag_THUMB_ISA_use: //p')"
      ok=1
      case "$desc" in *"ARM, EABI5"*) ;; *) ok=0 ;; esac
      fp="$(readelf -A "$f" | sed -n 's/^ *Tag_FP_arch: //p')"
      simd="$(readelf -A "$f" | sed -n 's/^ *Tag_Advanced_SIMD_arch: //p')"
      if [[ "$rule" == "arm-v6" ]]; then
        case "$cpu" in v6|v6K|v6KZ) ;; *) ok=0 ;; esac
        [[ "$thumb" == "Thumb-2" ]] && ok=0
        case "$fp" in ""|VFPv1|VFPv2) ;; *) ok=0 ;; esac
        [[ -n "$simd" ]] && ok=0
      else
        [[ "$cpu" == "v7" ]] || ok=0
      fi
      detail="cpu=${cpu:-?} thumb=${thumb:-none} fp=${fp:-none} simd=${simd:-none}"
      ;;
    aarch64)
      ok=1; case "$desc" in *"ARM aarch64"*) ;; *) ok=0 ;; esac
      detail="aarch64"
      ;;
    x86-64)
      ok=1; case "$desc" in *"x86-64"*) ;; *) ok=0 ;; esac
      detail="x86-64"
      ;;
  esac
  if [[ "$ok" -eq 1 ]]; then
    echo "  ok    $rel ($detail)"
  else
    echo "  WRONG $rel ($detail; $desc)"
    fail=1
  fi
done < <(find "$dir" -type f -print0 | sort -z)

if [[ "$count" -eq 0 ]]; then
  echo "error: no ELF files under $dir" >&2
  exit 1
fi
if [[ "$fail" -ne 0 ]]; then
  echo "error: binaries not built for target '$target' ($rule)" >&2
  exit 1
fi
echo "[OK] $count ELF files match target '$target' ($rule)"
