#!/usr/bin/env python3
"""
再投影済みの天の川テクスチャ（銀河座標の正距円筒図法）から、星表に対応の
無い明るい点光源（撮影時に写り込んだ惑星など）を探す補助スクリプト。
build_milkyway.py の PLANETS_GAL を決めるために使う。

使い方:
  python3 tools/find_unmatched_sources.py <hip_main.dat> <milkyway_4k.jpg>
"""
import sys
import numpy as np
from PIL import Image

from hip_parse import parse_hip, to_gal
from imgutil import blur

# 銀河座標→黄道座標（J2000）: ICRS→黄道 の回転と銀河→ICRS の積
EPS = np.radians(23.4392911)
AG = np.array([[-0.0548755604, -0.8734370902, -0.4838350155],
               [0.4941094279, -0.4448296300, 0.7469822445],
               [-0.8676661490, -0.1980763734, 0.4559837762]])
EQ_TO_ECL = np.array([[1, 0, 0],
                      [0, np.cos(EPS), np.sin(EPS)],
                      [0, -np.sin(EPS), np.cos(EPS)]])


def main():
    hip_path, img_path = sys.argv[1:3]
    stars = parse_hip(hip_path)
    im = np.asarray(Image.open(img_path).convert('L')).astype(np.float32)
    H, W = im.shape
    hp = im - blur(im, 4.0)
    # 局所最大
    pad = np.pad(hp, 2, mode='edge')
    is_max = np.ones_like(hp, bool)
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            if dx == 0 and dy == 0:
                continue
            is_max &= hp >= pad[2 + dy:2 + dy + H, 2 + dx:2 + dx + W]
    cand = np.argwhere(is_max & (hp > 60))
    print('candidates', len(cand))
    sel = [r for r in stars if r[3] < 7.5]
    l, b = to_gal(np.array([r[1] for r in sel]), np.array([r[2] for r in sel]))
    lr, br = np.radians(l), np.radians(b)
    sv = np.stack([np.cos(br) * np.cos(lr), np.cos(br) * np.sin(lr), np.sin(br)], -1)
    out = []
    for (y, x) in cand:
        cl = np.mod((0.5 - (x + 0.5) / W) * 360, 360)
        cb = (0.5 - (y + 0.5) / H) * 180
        v = np.array([np.cos(np.radians(cb)) * np.cos(np.radians(cl)),
                      np.cos(np.radians(cb)) * np.sin(np.radians(cl)),
                      np.sin(np.radians(cb))])
        sep = np.degrees(np.arccos(np.clip(sv @ v, -1, 1)))
        j = np.argmin(sep)
        if sep[j] < 0.25:
            continue
        eq = AG.T @ v
        ecl = EQ_TO_ECL @ eq
        beta = np.degrees(np.arcsin(ecl[2]))
        out.append((hp[y, x], cl, cb, beta, sep[j]))
    out.sort(reverse=True)
    for o in out[:40]:
        print('peak=%5.0f  l=%7.2f b=%7.2f  ecl_lat=%6.2f  nearest_star=%.2f deg' % o)


if __name__ == '__main__':
    main()
