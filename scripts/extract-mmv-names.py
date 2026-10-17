"""Builds public/data/mmv-names.json: names for relic/effect ids that the More Map Variations
mod adds on top of the base game data, read from the mod's item text (msg/engus/item_dlc01.msgbnd.dcx).

  python -I scripts/extract-mmv-names.py [path/to/MMV/mod] [path/to/oo2core_9_win64.dll]

Defaults: the first ~/Games/MMV/*/mod folder, and the Oodle DLL shipped in the Steam game folder
(needed to decompress the KRAK-compressed text). Only reads the mod and game files; only writes
public/data/mmv-names.json. Re-run after updating MMV or after `npm run update-data`.
"""
import ctypes
import glob
import json
import os
import re
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GAME_DATA = os.path.join(HERE, "..", "public", "data", "game-data.json")
OUT = os.path.join(HERE, "..", "public", "data", "mmv-names.json")
STEAM_DLL = r"C:\Program Files (x86)\Steam\steamapps\common\ELDEN RING NIGHTREIGN\Game\oo2core_9_win64.dll"


def find_mod():
    hits = sorted(glob.glob(os.path.join(os.path.expanduser("~"), "Games", "MMV", "*", "mod")))
    if not hits:
        sys.exit("MMV mod folder not found; pass it as the first argument")
    return hits[0]


def decompress_dcx(path, dll_path):
    raw = open(path, "rb").read()
    if raw[:4] != b"DCX\0" or raw[0x28:0x2C] != b"KRAK":
        sys.exit(f"{path}: not a KRAK DCX file")
    usize, csize = struct.unpack(">II", raw[0x1C:0x24])
    data_off = struct.unpack(">I", raw[0x14:0x18])[0]
    oodle = ctypes.WinDLL(dll_path)
    dec = oodle.OodleLZ_Decompress
    dec.restype = ctypes.c_ssize_t
    dec.argtypes = [ctypes.c_void_p, ctypes.c_ssize_t, ctypes.c_void_p, ctypes.c_ssize_t] + [ctypes.c_int] * 3 + \
        [ctypes.c_void_p, ctypes.c_ssize_t, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ssize_t, ctypes.c_int]
    buf = ctypes.create_string_buffer(usize)
    n = dec(raw[data_off:data_off + csize], csize, buf, usize, 1, 0, 0, None, 0, None, None, None, 0, 3)
    if n != usize:
        sys.exit(f"{path}: Oodle decompression failed ({n} of {usize} bytes)")
    return buf.raw


def utf16z(b, off):
    end = off
    while b[end:end + 2] != b"\0\0":
        end += 2
    return b[off:end].decode("utf-16-le")


def read_fmg(b):
    """FMG v2 (Elden Ring / Nightreign): {text id: string}."""
    groups = struct.unpack_from("<i", b, 0x0C)[0]
    string_offsets = struct.unpack_from("<q", b, 0x18)[0]
    out = {}
    for g in range(groups):
        index, first, last, _ = struct.unpack_from("<iiii", b, 0x28 + g * 16)
        for k in range(last - first + 1):
            off = struct.unpack_from("<q", b, string_offsets + (index + k) * 8)[0]
            if off:
                out[first + k] = utf16z(b, off)
    return out


def read_msgbnd(bnd):
    """BND4 with 0x24-byte file headers (unicode names) -> {fmg file name: {id: text}}."""
    if bnd[:4] != b"BND4" or struct.unpack_from("<q", bnd, 0x20)[0] != 0x24 or not bnd[0x30]:
        sys.exit("unexpected msgbnd layout")
    out = {}
    for i in range(struct.unpack_from("<i", bnd, 0x0C)[0]):
        size, _, data, _, name = struct.unpack_from("<qqIiI", bnd, 0x40 + i * 0x24 + 8)
        out[utf16z(bnd, name).replace("\\", "/").rsplit("/", 1)[-1]] = read_fmg(bnd[data:data + size])
    return out


def clean(s):
    return re.sub(r"\s+", " ", s).strip()


def main():
    mod = sys.argv[1] if len(sys.argv) > 1 else find_mod()
    dll = sys.argv[2] if len(sys.argv) > 2 else STEAM_DLL
    fmgs = read_msgbnd(decompress_dcx(os.path.join(mod, "msg", "engus", "item_dlc01.msgbnd.dcx"), dll))
    gd = json.load(open(GAME_DATA, encoding="utf-8"))

    def merged(*names):
        d = {}
        for n in names:
            d.update(fmgs.get(n, {}))
        return {k: clean(v) for k, v in d.items() if v and clean(v) and not clean(v).startswith("[ERROR]")}

    effects = merged("AttachEffectName.fmg", "AttachEffectName_dlc01.fmg")
    relics = merged("AntiqueName.fmg", "AntiqueName_dlc01.fmg")
    result = {
        "source": f"More Map Variations ({os.path.basename(os.path.dirname(mod))})",
        "effects": {str(k): v for k, v in sorted(effects.items()) if str(k) not in gd["effectIdToKey"]},
        "items": {str(k): v for k, v in sorted(relics.items()) if str(k) not in gd["items"]},
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=0)
    print(f"{len(result['effects'])} effect names and {len(result['items'])} relic names not in game-data.json -> {OUT}")


main()
