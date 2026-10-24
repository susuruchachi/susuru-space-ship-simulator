#!/usr/bin/env python3
"""
天の川背景テクスチャ（textures/milkyway_4k.jpg / milkyway_2k.jpg）の生成スクリプト。

入力:
  - ESO/S. Brunier "The Milky Way panorama" (eso0932a, 6000x3000, CC BY 4.0)
      https://cdn.eso.org/images/large/eso0932a.jpg
  - ヒッパルコス星表 (CDS I/239 hip_main.dat)
      https://cdsarc.cds.unistra.fr/ftp/I/239/hip_main.dat

処理:
  1. パノラマは「銀河座標の正距円筒図法」に近いが、モザイク合成由来の
     歪み（最大で数度のずれ）がある。明るい星（V<3.5）の写真上の位置と
     星表の位置を突き合わせ、経度方向フーリエ級数×緯度多項式のモデルで
     歪みをフィットする（残差 約1px=0.06°）。
  2. そのモデルで「正確な銀河座標の正距円筒図法」(中心 l=0, 左へ行くほど
     l が増える, 上が b=+90) へ再投影する。
  3. ゲーム側では星表の星を別途シャープな点として描くため、写真に写って
     いる明るい星（V<5.5）は周囲の背景で塗りつぶして二重表示を防ぐ。
     暗い星は天の川の「粒立ち」として写真のまま残す。
  4. 撮影期間中に写り込んだ惑星（木星など）を同様に除去する。

使い方:
  python3 tools/build_milkyway.py <hip_main.dat> <eso0932a_large.jpg> <出力ディレクトリ>
"""
import sys
import numpy as np
from PIL import Image

from hip_parse import parse_hip, to_gal
from imgutil import blur

Image.MAX_IMAGE_PIXELS = None


def fourier_poly_basis(l_deg, b_deg):
    """経度方向に周期的（継ぎ目なし）な基底: cos/sin(m*l) (m<=3) × b^k (k<=3)"""
    lr = np.radians(l_deg)
    br = np.radians(b_deg)
    cols = []
    for k in range(4):
        bk = br ** k
        cols.append(bk)
        for m in (1, 2, 3):
            cols.append(np.cos(m * lr) * bk)
            cols.append(np.sin(m * lr) * bk)
    return np.stack(cols, axis=-1)


def ideal_xy(l_deg, b_deg, W, H):
    lw = np.where(l_deg > 180, l_deg - 360, l_deg)
    return W / 2 - lw / 360 * W, H / 2 - b_deg / 180 * H


def fit_distortion(stars, src_gray):
    H, W = src_gray.shape
    sm = blur(src_gray, 1.5)
    sel = [r for r in stars if r[3] < 3.5]
    ra = np.array([r[1] for r in sel])
    de = np.array([r[2] for r in sel])
    vm = np.array([r[3] for r in sel])
    l, b = to_gal(ra, de)
    x0, y0 = ideal_xy(l, b, W, H)
    A = fourier_poly_basis(l, b)
    cx = np.zeros(A.shape[1])
    cy = np.zeros(A.shape[1])
    cx[0] = 50.0  # 目視で確認した初期ずれ（経度方向に約+3°）

    def centroid(xp, yp, R):
        xi, yi = int(round(xp)), int(round(yp))
        if yi - R < 0 or yi + R >= H:
            return None
        xs = np.arange(xi - R, xi + R + 1) % W
        win = sm[yi - R:yi + R + 1][:, xs]
        iy, ix = np.unravel_index(np.argmax(win), win.shape)
        py, px = yi - R + iy, xi - R + ix
        r = 3
        ys = np.arange(py - r, py + r + 1)
        xs2 = np.arange(px - r, px + r + 1) % W
        if ys.min() < 0 or ys.max() >= H:
            return None
        w = np.clip(sm[ys][:, xs2] - np.median(win), 0, None)
        if w.sum() <= 0:
            return None
        gy, gx = np.mgrid[-r:r + 1, -r:r + 1]
        return px + (w * gx).sum() / w.sum(), py + (w * gy).sum() / w.sum()

    for R, vlim in [(70, 2.0), (40, 2.5), (20, 3.0), (12, 3.5), (8, 3.5)]:
        px = x0 + A @ cx
        py = y0 + A @ cy
        obs, idx = [], []
        for i in range(len(sel)):
            if vm[i] >= vlim:
                continue
            c = centroid(px[i], py[i], R)
            if c is None:
                continue
            obs.append(c)
            idx.append(i)
        idx = np.array(idx)
        obs = np.array(obs)
        dx = (obs[:, 0] - x0[idx] + W / 2) % W - W / 2
        dy = obs[:, 1] - y0[idx]
        Ai = A[idx]
        keep = np.ones(len(idx), bool)
        for _ in range(5):
            cx, *_ = np.linalg.lstsq(Ai[keep], dx[keep], rcond=None)
            cy, *_ = np.linalg.lstsq(Ai[keep], dy[keep], rcond=None)
            rr = np.hypot(dx - Ai @ cx, dy - Ai @ cy)
            keep = rr < max(2.0, 3 * np.median(rr[keep]))
        print(f'  fit R={R:2d} V<{vlim}: matched {len(idx)}, kept {keep.sum()}, '
              f'median residual {np.median(rr[keep]):.2f}px')
    return cx, cy


def bilinear_wrap(img, x, y):
    """img: (H,W,C) float32。xは横方向に周回、yは端でクランプ。"""
    H, W, _ = img.shape
    x = np.mod(x, W)
    y = np.clip(y, 0, H - 1.001)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = (x - x0)[..., None]
    fy = (y - y0)[..., None]
    x1 = (x0 + 1) % W
    y1 = y0 + 1
    return ((img[y0, x0] * (1 - fx) + img[y0, x1] * fx) * (1 - fy)
            + (img[y1, x0] * (1 - fx) + img[y1, x1] * fx) * fy)


def reproject(src, cx, cy, Wout, Hout, ss=2):
    H, W, _ = src.shape
    out = np.zeros((Hout, Wout, 3), np.float32)
    chunk = 64
    for r0 in range(0, Hout, chunk):
        r1 = min(Hout, r0 + chunk)
        acc = np.zeros((r1 - r0, Wout, 3), np.float32)
        for sy in range(ss):
            for sx in range(ss):
                u = (np.arange(Wout) + (sx + 0.5) / ss) / Wout
                v = (np.arange(r0, r1) + (sy + 0.5) / ss) / Hout
                uu, vv = np.meshgrid(u, v)
                l = np.mod((0.5 - uu) * 360.0, 360.0)
                b = (0.5 - vv) * 180.0
                x0, y0 = ideal_xy(l, b, W, H)
                Ab = fourier_poly_basis(l, b)
                xs = x0 + Ab @ cx
                ys = y0 + Ab @ cy
                acc += bilinear_wrap(src, xs, ys)
        out[r0:r1] = acc / (ss * ss)
    return out


def gal_to_pixel(l, b, W, H):
    lw = np.where(l > 180, l - 360, l)
    return W / 2 - lw / 360 * W, H / 2 - b / 180 * H


def inpaint_discs(img, discs):
    """discs: [(x, y, r)]。円（緯度による横伸びを考慮した楕円）内を塗りつぶす。
    1) 多重解像度の正規化畳み込みで穴の外側の色を滑らかに流し込み、
    2) その上に「少し横にずらした位置の星の粒立ち（高周波成分）」を重ねる。
    大きな穴（金星の光条など）でも黒い穴やのっぺりした斑にならないようにする。"""
    H, W, _ = img.shape
    keep = np.ones((H, W), np.float32)
    boxes = []
    for x, y, r in discs:
        b = (0.5 - y / H) * 180.0
        stretch = 1.0 / max(0.15, np.cos(np.radians(b)))
        rx = r * stretch
        ys = np.arange(int(y - r - 1), int(y + r + 2))
        ys = ys[(ys >= 0) & (ys < H)]
        for yy in ys:
            dy = (yy + 0.5 - y) / r
            if abs(dy) >= 1:
                continue
            half = rx * np.sqrt(1 - dy * dy)
            cols = np.arange(int(np.floor(x - half)), int(np.ceil(x + half)) + 1) % W
            keep[yy, cols] = 0.0
        boxes.append((x, y, r, rx))
    hole = keep < 0.5

    # 1) 粗い→細かいの順に、穴の外側の色を流し込む
    filled = img.copy()
    est = None
    for sigma in (64.0, 32.0, 16.0, 8.0, 4.0):
        num = np.stack([blur(img[..., c] * keep, sigma) for c in range(3)], -1)
        den = blur(keep, sigma)
        cur = num / np.maximum(den, 1e-6)[..., None]
        if est is None:
            est = cur
        else:
            reliable = np.clip((den - 0.15) / 0.35, 0, 1)[..., None]
            est = est * (1 - reliable) + cur * reliable
    filled[hole] = est[hole]

    # 2) 星の粒立ち（高周波）を、穴から横にずらした位置から移植する
    low = np.stack([blur(filled[..., c], 2.5) for c in range(3)], -1)
    grain = filled - low
    out = filled.copy()
    for i, (x, y, r, rx) in enumerate(boxes):
        shift = int(np.ceil(2.4 * rx + 6)) * (1 if i % 2 == 0 else -1)
        y0 = max(0, int(y - r - 2))
        y1 = min(H, int(y + r + 3))
        cols = np.arange(int(np.floor(x - rx - 2)), int(np.ceil(x + rx + 3))) % W
        src_cols = (cols + shift) % W
        sub_hole = hole[y0:y1][:, cols]
        patch = low[y0:y1][:, cols] + grain[y0:y1][:, src_cols]
        region = out[y0:y1][:, cols]
        region[sub_hole] = patch[sub_hole]
        out[y0:y1, cols] = region

    # 3) 穴の縁をなじませる
    edge = blur(hole.astype(np.float32), 1.2)
    w = (np.clip(edge * 2.0, 0, 1) * (1 - hole))[..., None]
    soft = np.stack([blur(out[..., c], 0.8) for c in range(3)], -1)
    return out * (1 - w) + soft * w


# 撮影時に写り込んでいた惑星（星表に無い明るい点光源）の銀河座標と半径(度)。
# tools/find_unmatched_sources.py で検出し目視確認した値。
PLANETS_GAL = [
    (17.01, -18.06, 0.80),  # 木星（2008年、いて座。RA 19h30m / Dec -22°）
    (75.01, -57.88, 2.70),  # 金星（2009年1月、みずがめ座。光条が大きいため広めに除去）
    (15.86, 69.30, 0.25),   # アークトゥルスのレンズゴースト
]


def star_radius_px(vmag, px_per_deg):
    # 写真上のにじみ半径（実測ベースの経験式）。明るい星ほど大きく、
    # 回折スパイクも含めて覆えるよう少し大きめにとる。
    deg = np.clip(0.035 + 0.045 * (5.5 - vmag), 0.035, 0.32)
    # 1等より明るい星は写真上のハロー（にじみ）も大きいので広めに覆う
    deg = np.where(vmag < 1.0, np.maximum(deg, 0.3 + 0.22 * (1.0 - vmag)), deg)
    return deg * px_per_deg


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    hip_path, pano_path, out_dir = sys.argv[1:4]
    stars = parse_hip(hip_path)
    src_img = Image.open(pano_path).convert('RGB')
    src = np.asarray(src_img).astype(np.float32) / 255.0
    gray = np.asarray(src_img.convert('L')).astype(np.float32)
    print('fitting panorama distortion ...')
    cx, cy = fit_distortion(stars, gray)

    Wout, Hout = 4096, 2048
    print('reprojecting to exact galactic plate carree ...')
    out = reproject(src, cx, cy, Wout, Hout)

    print('removing bright catalog stars ...')
    bright = [r for r in stars if r[3] < 5.5]
    ra = np.array([r[1] for r in bright])
    de = np.array([r[2] for r in bright])
    vm = np.array([r[3] for r in bright])
    l, b = to_gal(ra, de)
    xs, ys = gal_to_pixel(l, b, Wout, Hout)
    px_per_deg = Wout / 360.0
    discs = [(x, y, star_radius_px(v, px_per_deg)) for x, y, v in zip(xs, ys, vm)]

    # 撮影時に写り込んでいた惑星（星表に無い明るい点光源）。
    # 位置は再投影後の画像から検出・目視確認した銀河座標。
    planets_gal = PLANETS_GAL
    for pl, pb, prad in planets_gal:
        x, y = gal_to_pixel(np.array([pl]), np.array([pb]), Wout, Hout)
        discs.append((float(x[0]), float(y[0]), prad * px_per_deg))

    out = inpaint_discs(out, discs)
    out = np.clip(out, 0, 1)
    img4k = Image.fromarray((out * 255 + 0.5).astype(np.uint8))
    img4k.save(f'{out_dir}/milkyway_4k.jpg', quality=90, optimize=True, progressive=True)
    img4k.resize((2048, 1024), Image.LANCZOS).save(
        f'{out_dir}/milkyway_2k.jpg', quality=90, optimize=True, progressive=True)
    print('done')


if __name__ == '__main__':
    main()
