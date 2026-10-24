#!/usr/bin/env python3
"""
惑星・衛星テクスチャ（textures/*.jpg, *.png）の生成スクリプト。

入力（すべて正距円筒図法、経度0°が画像中央、東経が右方向）:
  - Solar System Scope (https://www.solarsystemscope.com/textures/, CC BY 4.0)
      8k_earth_daymap.jpg, 8k_earth_nightmap.jpg, 8k_earth_clouds.jpg,
      8k_earth_specular_map.tif, 8k_moon.jpg, 8k_mars.jpg, 8k_mercury.jpg,
      8k_jupiter.jpg, 8k_saturn.jpg, 8k_saturn_ring_alpha.png,
      4k_venus_atmosphere.jpg, 2k_uranus.jpg, 2k_neptune.jpg, 8k_sun.jpg
  - NASA 3D Resources (https://github.com/nasa/NASA-3D-Resources, パブリックドメイン)
      "Images and Textures/<天体名>/<天体名>.jpg"（各衛星・冥王星・カロン）
  - USGS Astrogeology（探査機ドーンの全球モザイク。NASA/JPL-Caltech/UCLA/MPS/DLR/IDA）
      Ceres_Dawn_FC_DLR_global_20ppd_Oct2015.tif（経度0°が左端の0〜360°表記）
      vesta_dawn_fc_hamo_mosaic_global_1024.jpg（Claudia Double Prime 経度系）

出力: 解像度ごとの段階テクスチャ（*_4k / *_2k / *_1k）。ゲーム側は
画面上での見かけの大きさに応じて必要な段階だけを読み込む。

使い方:
  python3 tools/build_textures.py <SSSダウンロード先> <NASA3D "Images and Textures" ディレクトリ> <出力ディレクトリ> [--usgs <USGSダウンロード先>] [--moons-only]
  --usgs を省略した場合、ケレスとベスタも平均色の起伏ノイズで代用する。
"""
import os
import sys
import numpy as np
from PIL import Image

from imgutil import blur

Image.MAX_IMAGE_PIXELS = None

LEVELS = {'4k': (4096, 2048), '2k': (2048, 1024), '1k': (1024, 512)}


def save_levels(img, out_dir, name, levels, quality=85, mode=None):
    if mode:
        img = img.convert(mode)
    for lv in levels:
        w, h = LEVELS[lv]
        if img.size[0] < w:
            continue  # 元画像より大きくはしない
        im = img if img.size == (w, h) else img.resize((w, h), Image.LANCZOS)
        path = os.path.join(out_dir, f'{name}_{lv}.jpg')
        im.save(path, quality=quality, optimize=True, progressive=True)
        print(f'  {path} {os.path.getsize(path) // 1024} KB')


def fill_missing(img, mask_fn, dilate_px=8):
    """探査機が撮影していない領域（単色で塗られた部分）を、撮影済み領域の
    色を外挿した滑らかな値＋弱い起伏ノイズで埋める。
    mask_fn(g, lv) -> bool配列（g: 輝度, lv: 局所分散）で欠損判定する。"""
    a = np.asarray(img.convert('RGB')).astype(np.float32)
    g = a.mean(axis=2)
    lv = blur((g - blur(g, 2.0)) ** 2, 3.0)
    missing = mask_fn(g, lv)
    # 欠損境界に残る縁取り（黒い線など）も含めるよう膨張させる
    m = blur(missing.astype(np.float32), dilate_px / 2.0) > 0.08
    keep = (~m).astype(np.float32)
    mean = (a * keep[..., None]).sum(axis=(0, 1)) / max(1.0, keep.sum())
    est = None
    for sigma in (96.0, 48.0, 24.0, 12.0, 6.0):
        num = np.stack([blur(a[..., c] * keep, sigma) for c in range(3)], -1)
        den = blur(keep, sigma)
        cur = num / np.maximum(den, 1e-6)[..., None]
        if est is None:
            w0 = np.clip(den / 0.3, 0, 1)[..., None]
            est = mean * (1 - w0) + cur * w0
        else:
            rel = np.clip((den - 0.15) / 0.35, 0, 1)[..., None]
            est = est * (1 - rel) + cur * rel
    rng = np.random.default_rng(42)
    noise = blur(rng.standard_normal(g.shape).astype(np.float32), 2.5)
    noise = noise / (noise.std() + 1e-6) * 5.0
    est = est + noise[..., None]
    mm = blur(m.astype(np.float32), 2.0)[..., None]
    out = a * (1 - mm) + est * mm
    print(f'    filled missing area: {m.mean() * 100:.1f}%')
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def procedural_body(mean_rgb, seed, w=1024, h=512, contrast=10.0):
    """表面の地図が存在しない（または一部しか無い）天体用の、平均色＋起伏ノイズ。"""
    rng = np.random.default_rng(seed)
    acc = np.zeros((h, w), np.float32)
    for sigma, amp in ((24.0, 1.0), (8.0, 0.6), (2.5, 0.35)):
        n = blur(rng.standard_normal((h, w)).astype(np.float32), sigma)
        acc += amp * n / (n.std() + 1e-6)
    acc = acc / (acc.std() + 1e-6) * contrast
    out = np.array(mean_rgb, np.float32)[None, None, :] + acc[..., None]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def build_ring(src_path, out_dir):
    """土星の環: 8192x500 RGBA の帯状画像（左=内縁、右=外縁）を
    半径方向1次元の 2048x4 PNG（色+透明度）に縮める。"""
    im = Image.open(src_path).convert('RGBA')
    a = np.asarray(im).astype(np.float32)
    prof = a.mean(axis=0, keepdims=True)  # 縦方向は同じ模様の繰り返しなので平均
    prof_img = Image.fromarray(np.clip(prof, 0, 255).astype(np.uint8))
    prof_img = prof_img.resize((2048, 1), Image.LANCZOS).resize((2048, 4), Image.NEAREST)
    path = os.path.join(out_dir, 'saturn_ring.png')
    prof_img.save(path, optimize=True)
    print(f'  {path} {os.path.getsize(path) // 1024} KB')


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    sss, nasa, out = sys.argv[1:4]
    only_moons = '--moons-only' in sys.argv
    usgs = sys.argv[sys.argv.index('--usgs') + 1] if '--usgs' in sys.argv else None
    os.makedirs(out, exist_ok=True)
    S = lambda f: os.path.join(sss, f)
    if not only_moons:
        build_planets(S, out)
    build_moons(nasa, out)
    build_small_bodies(out, usgs)


def build_planets(S, out):

    print('Earth')
    save_levels(Image.open(S('8k_earth_daymap.jpg')), out, 'earth_day', ['4k', '2k', '1k'])
    save_levels(Image.open(S('8k_earth_nightmap.jpg')), out, 'earth_night', ['4k', '2k', '1k'])
    save_levels(Image.open(S('8k_earth_clouds.jpg')), out, 'earth_clouds', ['4k', '2k', '1k'], mode='L')
    save_levels(Image.open(S('8k_earth_specular_map.tif')), out, 'earth_ocean', ['2k', '1k'], mode='L')

    for src, name, levels in [
        ('8k_moon.jpg', 'moon', ['4k', '2k', '1k']),
        ('8k_mars.jpg', 'mars', ['4k', '2k', '1k']),
        ('8k_mercury.jpg', 'mercury', ['4k', '2k', '1k']),
        ('8k_jupiter.jpg', 'jupiter', ['4k', '2k', '1k']),
        ('8k_saturn.jpg', 'saturn', ['4k', '2k', '1k']),
        ('4k_venus_atmosphere.jpg', 'venus', ['2k', '1k']),
        ('2k_uranus.jpg', 'uranus', ['2k', '1k']),
        ('2k_neptune.jpg', 'neptune', ['2k', '1k']),
        ('8k_sun.jpg', 'sun', ['2k', '1k']),
    ]:
        print(name)
        save_levels(Image.open(S(src)), out, name, levels)

    print('Saturn ring')
    build_ring(S('8k_saturn_ring_alpha.png'), out)


def build_moons(nasa, out):
    moons = {
        'io': 'Jupiter - Io (A)', 'europa': 'Jupiter - Europa', 'ganymede': 'Jupiter - Ganymede',
        'callisto': 'Jupiter - Callisto', 'phobos': 'Mars - Phobos', 'deimos': 'Mars - Deimos',
        'triton': 'Neptune - Triton', 'pluto': 'Pluto', 'charon': 'Pluto - Charon',
        'mimas': 'Saturn - Mimas', 'enceladus': 'Saturn - Enceladus', 'tethys': 'Saturn - Tethys',
        'dione': 'Saturn - Dione', 'rhea': 'Saturn - Rhea', 'titan': 'Saturn - Titan',
        'iapetus': 'Saturn - Iapetus', 'miranda': 'Uranus - Miranda', 'ariel': 'Uranus - Ariel',
        'umbriel': 'Uranus - Umbriel', 'titania': 'Uranus - Titania', 'oberon': 'Uranus - Oberon',
    }
    # 撮影されていない領域が単色で塗られている天体の欠損判定（天体ごとに調整）
    dark_fill = lambda g, lv: blur(g, 1.5) < 25
    fills = {
        'callisto': lambda g, lv: blur(g, 6.0) > 185,
        'mimas': lambda g, lv: (blur(g, 4.0) > 228) & (blur(lv, 4.0) < 9),
        'dione': lambda g, lv: (blur(g, 4.0) > 212) & (blur(lv, 4.0) < 12),
        'enceladus': lambda g, lv: (blur(g, 4.0) > 235) & (blur(lv, 4.0) < 9),
        'tethys': lambda g, lv: (blur(g, 4.0) > 235) & (blur(lv, 4.0) < 9),
        'iapetus': lambda g, lv: (blur(g, 4.0) > 240) & (blur(lv, 4.0) < 6),
        'rhea': lambda g, lv: (blur(g, 6.0) > 222) & (blur(lv, 4.0) < 12),
        'io': lambda g, lv: blur(g, 1.5) < 14,
        'miranda': dark_fill, 'ariel': dark_fill, 'umbriel': dark_fill,
        'titania': dark_fill, 'oberon': dark_fill,
    }
    for key, folder in moons.items():
        print(key)
        if key == 'triton':
            # ボイジャー2号の画像は南半球の一部のみで、正距円筒図として
            # 不完全なため、平均色（淡いピンクがかった白）の起伏ノイズで表す
            im = procedural_body((205, 190, 180), seed=7)
        else:
            im = Image.open(os.path.join(nasa, folder, folder + '.jpg')).convert('RGB')
            if key in fills:
                im = fill_missing(im, fills[key], dilate_px=(16 if fills[key] is dark_fill else 8))
        im = im.resize((1024, 512), Image.LANCZOS)
        path = os.path.join(out, f'{key}_1k.jpg')
        im.save(path, quality=85, optimize=True, progressive=True)
        print(f'  {path} {os.path.getsize(path) // 1024} KB')


def dawn_map(gray, tint, target_mean, missing_fn):
    """ドーンの白黒モザイクを、欠損（極夜・未撮影）を補完したうえで
    平均輝度をそろえ、天体の色味を付けたRGB画像にする。"""
    im = fill_missing(gray.convert('RGB'), missing_fn, dilate_px=10)
    a = np.asarray(im).astype(np.float32).mean(axis=2)
    a = a * (target_mean / max(1.0, float(np.median(a))))
    out = a[..., None] * np.array(tint, np.float32)[None, None, :]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def build_small_bodies(out, usgs):
    procedural = [('eris', (225, 222, 218), 12), ('haumea', (215, 212, 208), 13),
                  ('makemake', (205, 170, 140), 14), ('pallas', (128, 127, 124), 15),
                  ('hygiea', (104, 102, 99), 16)]
    if usgs:
        rows = lambda g: np.arange(g.shape[0])[:, None] / g.shape[0]
        print('ceres (Dawn FC, DLR)')
        src = Image.open(os.path.join(usgs, 'Ceres_Dawn_FC_DLR_global_20ppd_Oct2015.tif')).convert('L')
        # 元画像は左端が経度0°（中央が180°）なので、半周ずらして経度0°を中央にする
        src = Image.fromarray(np.roll(np.asarray(src), src.size[0] // 2, axis=1))
        src = src.resize((2048, 1024), Image.LANCZOS)
        # 両極付近の未撮影域・影で真っ黒な部分
        miss = lambda g, lv: (((blur(g, 2.0) < 30) & ((rows(g) > 0.85) | (rows(g) < 0.06)))
                              | (rows(g) > 0.94) | (rows(g) < 0.025))
        save_levels(dawn_map(src, (1.0, 0.985, 0.955), 112, miss), out, 'ceres', ['2k', '1k'])
        print('vesta (Dawn FC HAMO, DLR)')
        src = Image.open(os.path.join(usgs, 'vesta_dawn_fc_hamo_mosaic_global_1024.jpg')).convert('L')
        # 撮影時に極夜だった北極域
        miss = lambda g, lv: (((blur(g, 3.0) < 22) & (rows(g) < 0.22))
                              | (rows(g) < 0.115) | (rows(g) > 0.985))
        save_levels(dawn_map(src, (1.0, 0.965, 0.91), 128, miss), out, 'vesta', ['1k'])
    else:
        procedural += [('ceres', (120, 118, 112), 11), ('vesta', (150, 145, 136), 17)]
    # 探査機による全球地図が無い天体（平均的な色の起伏ノイズ）
    for key, rgb, seed in procedural:
        print(key)
        im = procedural_body(rgb, seed)
        path = os.path.join(out, f'{key}_1k.jpg')
        im.save(path, quality=85, optimize=True, progressive=True)
        print(f'  {path} {os.path.getsize(path) // 1024} KB')


if __name__ == '__main__':
    main()
