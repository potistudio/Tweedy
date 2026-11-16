"""extension/icons/*.png を生成する。外部ライブラリを使わず zlib で PNG を書き出す。"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
SIZES = (16, 32, 48, 128)
SS = 4  # アンチエイリアス用のスーパーサンプリング倍率

BG = (29, 155, 240)
FG = (255, 255, 255)


def rounded_rect(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def sample(u, v):
    """u, v は 0..1 の正規化座標。(r, g, b, a) を返す。"""
    if not rounded_rect(u, v, 0, 0, 1, 1, 0.22):
        return (0, 0, 0, 0)
    lid = rounded_rect(u, v, 0.18, 0.2, 0.82, 0.38, 0.04)
    body = rounded_rect(u, v, 0.24, 0.43, 0.76, 0.8, 0.05)
    slot = rounded_rect(u, v, 0.41, 0.53, 0.59, 0.59, 0.03)
    if (lid or body) and not slot:
        return (*FG, 255)
    return (*BG, 255)


def render(size):
    rows = []
    n = size * SS
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    r, g, b, a = sample((px * SS + sx + 0.5) / n, (py * SS + sy + 0.5) / n)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            total = SS * SS
            alpha = acc[3] / total
            if acc[3]:
                row += bytes((round(acc[0] / acc[3]), round(acc[1] / acc[3]), round(acc[2] / acc[3]), round(alpha)))
            else:
                row += bytes((0, 0, 0, 0))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for s in SIZES:
        (OUT / f"icon{s}.png").write_bytes(render(s))
        print(f"icon{s}.png")


if __name__ == "__main__":
    main()
