#!/usr/bin/env python3
"""
衛星の平均軌道要素を JPL Horizons の精密暦に当てはめて求め直すスクリプト。

JPL "Planetary Satellite Mean Elements" の表は軌道の形（a, e, i, 歳差周期）は
信頼できるが、角度の基準（平均近点角や昇交点の起点）の解釈が衛星系ごとに
異なり、そのまま使うと土星・天王星・海王星の衛星の位置が大きくずれた
（Horizonsとの比較で最大155°）。そこでこのスクリプトでは
  - 基準面（JPL表のラプラス面の極、または親天体の赤道）を固定し、
  - Horizons の位置・速度ベクトル（1990〜2060年）から、軌道面の昇交点 Ω(t)、
    平均の「緯度引数」u(t)（昇交点から測った平均の公転角）を直線で当てはめ、
  - 14-solar-system.js で使う形式（Ω0, dΩ/dt, i, u0, du/dt）を出力する。
離心率と近点の向きはJPL表の値を使う（いずれの衛星も e<0.03 で影響が小さい）。

使い方:
  python3 tools/fit_satellites.py > fitted.txt
（ネットワーク経由で Horizons API https://ssd.jpl.nasa.gov/api/horizons.api を使う）
"""
import json
import math
import sys
import time
import urllib.parse
import urllib.request

import numpy as np

J2000 = 2451545.0
EPS = math.radians(23.4392911)

# 軌道共鳴による平均経度の秤動（周期[日]）。ミマスとテティスは2:1共鳴で
# 約70.8年周期・振幅約44°（ミマス）の揺れがあり、直線では表せない。
LIBRATION_PERIOD_DAYS = {'mimas': 25858.0, 'tethys': 25858.0}

# id: (Horizons ID, 親のHorizons中心ID, 基準面の極 [RA, Dec] (度), JPL表の周期P[日])
# 基準面の極: ラプラス面はJPL表の値、'equatorial'の衛星は親のIAU自転軸（J2000時点）
MOONS = {
    'phobos': ('401', '499', (317.7, 52.9), 0.3187),
    'deimos': ('402', '499', (316.6, 53.5), 1.2625),
    'io': ('501', '599', (268.1, 64.5), 1.769138),
    'europa': ('502', '599', (268.1, 64.5), 3.551181),
    'ganymede': ('503', '599', (268.2, 64.6), 7.154553),
    'callisto': ('504', '599', (268.7, 64.8), 16.689018),
    'mimas': ('601', '699', (40.6, 83.5), 0.942422),
    'enceladus': ('602', '699', (40.6, 83.5), 1.370218),
    'tethys': ('603', '699', (40.6, 83.5), 1.887802),
    'dione': ('604', '699', (40.6, 83.5), 2.736916),
    'rhea': ('605', '699', (40.6, 83.5), 4.517503),
    'titan': ('606', '699', (36.4, 84.0), 15.945448),
    'iapetus': ('608', '699', (288.7, 78.9), 79.3215),
    # 天王星はIAUの「北極」(257.311, -15.175)と公転・自転の向きが逆なので、
    # 衛星の基準面の極は反対側 (77.311, +15.175) にとる（傾斜角がほぼ0°になる）
    'miranda': ('705', '799', (77.311, 15.175), 1.413479),
    'ariel': ('701', '799', (77.311, 15.175), 2.520379),
    'umbriel': ('702', '799', (77.311, 15.175), 4.144177),
    'titania': ('703', '799', (77.311, 15.175), 8.705869),
    'oberon': ('704', '799', (77.311, 15.175), 13.463237),
    'triton': ('801', '899', (299.36, 43.46), 5.876854),
    'charon': ('901', '999', (132.993, -6.163), 6.387222),
}


def horizons_vectors(cmd, center, start, stop, step):
    q = {
        'format': 'text', 'COMMAND': f"'{cmd}'", 'OBJ_DATA': "'NO'", 'MAKE_EPHEM': "'YES'",
        'EPHEM_TYPE': "'VECTORS'", 'CENTER': f"'500@{center}'", 'START_TIME': f"'{start}'",
        'STOP_TIME': f"'{stop}'", 'STEP_SIZE': f"'{step}'", 'REF_PLANE': "'ECLIPTIC'",
        'REF_SYSTEM': "'ICRF'", 'VEC_TABLE': "'2'", 'OUT_UNITS': "'KM-S'", 'CSV_FORMAT': "'YES'",
        'TIME_TYPE': "'TT'",
    }
    url = 'https://ssd.jpl.nasa.gov/api/horizons.api?' + urllib.parse.urlencode(q, safe="'@:")
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                text = r.read().decode()
            break
        except Exception as e:  # noqa: BLE001
            print(f'  retry {attempt}: {e}', file=sys.stderr)
            time.sleep(2 ** attempt)
    else:
        raise RuntimeError('Horizons request failed')
    if '$$SOE' not in text:
        raise RuntimeError(text[:2000])
    body = text.split('$$SOE')[1].split('$$EOE')[0]
    rows = []
    for line in body.strip().splitlines():
        c = [s.strip() for s in line.split(',')]
        rows.append([float(c[0])] + [float(x) for x in c[2:8]])
    return np.array(rows)


def ref_frame_matrix(pole_ra, pole_dec):
    """基準面座標（x=基準面とICRF赤道の昇交点, z=極）→ J2000黄道座標"""
    def rz(a):
        c, s = math.cos(a), math.sin(a)
        return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])

    def rx(a):
        c, s = math.cos(a), math.sin(a)
        return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
    R = rz(math.radians(pole_ra + 90)) @ rx(math.radians(90 - pole_dec))
    return rx(-EPS) @ R


def fit_moon(key, hid, center, pole, P):
    F = ref_frame_matrix(*pole)
    Finv = F.T
    # 粗い周期推定用の密なデータ（J2000から4周期）
    step_min = max(1, int(P * 1440 / 24))
    dense = horizons_vectors(hid, center, '2000-01-01 12:00', f'2000-01-{1 + int(math.ceil(4 * P)) + 1:02d} 12:00'
                             if 4 * P < 27 else '2000-07-01', f'{step_min} m')
    # 長期データ（1990〜2060年、約60日おき＝周期とは無関係な間隔）
    sparse = horizons_vectors(hid, center, '1990-01-01', '2060-01-01', '88373 m')

    def angles(rows):
        r = rows[:, 1:4] @ Finv.T
        v = rows[:, 4:7] @ Finv.T
        h = np.cross(r, v)
        hn = h / np.linalg.norm(h, axis=1)[:, None]
        inc = np.degrees(np.arccos(np.clip(hn[:, 2], -1, 1)))
        node = np.degrees(np.arctan2(hn[:, 0], -hn[:, 1]))
        # 緯度引数 u: 昇交点方向 N と軌道面内の直交方向 h×N で測る
        nvec = np.stack([np.cos(np.radians(node)), np.sin(np.radians(node)), np.zeros(len(node))], 1)
        m = np.cross(hn, nvec)
        u = np.degrees(np.arctan2(np.sum(r * m, 1), np.sum(r * nvec, 1)))
        return rows[:, 0], inc, node, u, np.linalg.norm(r, axis=1)

    t_d, inc_d, node_d, u_d, _ = angles(dense)
    small_inc = np.median(inc_d) < 0.6
    if small_inc:
        # 傾斜がほぼ0の衛星は昇交点が定まらないので、Ω=0 として「経度」で測る
        r = dense[:, 1:4] @ Finv.T
        u_d = np.degrees(np.arctan2(r[:, 1], r[:, 0]))
    u_unw = np.degrees(np.unwrap(np.radians(u_d)))
    n0 = np.polyfit(t_d - J2000, u_unw, 1)[0]

    t, inc, node, u, rr = angles(sparse)
    if small_inc:
        r = sparse[:, 1:4] @ Finv.T
        u = np.degrees(np.arctan2(r[:, 1], r[:, 0]))
        node = np.zeros_like(u)
    # 予測位相で巻き戻しを解消しながら u0, n を推定
    dt = t - J2000
    order = np.argsort(np.abs(dt))
    n, u0 = n0, np.polyfit(t_d - J2000, u_unw, 1)[1]
    used = []
    for k in order:
        pred = u0 + n * dt[k]
        val = u[k] + 360 * np.round((pred - u[k]) / 360)
        used.append((dt[k], val))
        if len(used) >= 4:
            arr = np.array(used)
            n, u0 = np.polyfit(arr[:, 0], arr[:, 1], 1)
    arr = np.array(used)
    lib_a = lib_b = 0.0
    lib_period = LIBRATION_PERIOD_DAYS.get(key)
    if lib_period:
        w = 2 * math.pi / lib_period
        A = np.stack([np.ones(len(arr)), arr[:, 0], np.sin(w * arr[:, 0]), np.cos(w * arr[:, 0])], 1)
        c, *_ = np.linalg.lstsq(A, arr[:, 1], rcond=None)
        u0, n, lib_a, lib_b = c
        resid = arr[:, 1] - A @ c
    else:
        resid = arr[:, 1] - (u0 + n * arr[:, 0])
    # 離心率と近点: 真の緯度引数 − 平均の緯度引数 ≈ 2e·sin(u − ω) を当てはめる。
    # 近点の歳差周期はJPL表の値を使い、向き（前進/後退）は当てはまりの良い方を採る。
    papsis = PAPSIS_YEARS.get(key, 0.0)
    best = None
    for sign in (+1, -1):
        wdot = sign * (360.0 / (papsis * 365.25)) if papsis > 0 else 0.0
        ang = np.radians(arr[:, 1] - resid - wdot * arr[:, 0])
        A = np.stack([np.sin(ang), -np.cos(ang)], 1)
        c, *_ = np.linalg.lstsq(A, np.radians(resid), rcond=None)
        e_fit = math.hypot(c[0], c[1]) / 2
        w0 = math.degrees(math.atan2(c[1], c[0])) % 360
        rr2 = np.radians(resid) - A @ c
        score = float(np.sqrt(np.mean(rr2 ** 2)))
        if best is None or score < best[0]:
            best = (score, e_fit, w0, wdot)
    final_rms, e_fit, w0, wdot = best
    # 昇交点の歳差
    if small_inc:
        node0, node_rate, inc_mean = 0.0, 0.0, float(np.median(inc))
    else:
        node_unw = np.degrees(np.unwrap(np.radians(node)))
        node_rate, node0 = np.polyfit(dt, node_unw, 1)
        inc_mean = float(np.mean(inc))
    return {
        'key': key, 'i': inc_mean, 'node0': float(node0 % 360), 'nodeRate': float(node_rate),
        'u0': float(u0 % 360), 'n': float(n), 'a': float(np.mean(rr)),
        'e': float(e_fit), 'w0': float(w0), 'wRate': float(wdot),
        'libPeriod': float(lib_period or 0), 'libSin': float(lib_a), 'libCos': float(lib_b),
        'residRms': float(np.sqrt(np.mean(resid ** 2))), 'finalRmsDeg': math.degrees(final_rms),
        'smallInc': bool(small_inc),
    }


# JPL表の近点の歳差周期 [年]
PAPSIS_YEARS = {
    'phobos': 1.1, 'deimos': 0.0, 'io': 1.333, 'europa': 1.394, 'ganymede': 68.301,
    'callisto': 277.921, 'mimas': 0.493, 'enceladus': 2.916, 'tethys': 0.005, 'dione': 11.698,
    'rhea': 33.939, 'titan': 346.680, 'iapetus': 1662.900, 'miranda': 8.939, 'ariel': 28.901,
    'umbriel': 64.126, 'titania': 579.928, 'oberon': 158.604, 'triton': 675.2, 'charon': 0.0,
}


def main():
    results = []
    only = set(sys.argv[1:])
    for key, (hid, center, pole, P) in MOONS.items():
        if only and key not in only:
            continue
        print(f'fitting {key} ...', file=sys.stderr)
        res = fit_moon(key, hid, center, pole, P)
        print(f"  i={res['i']:.3f} node0={res['node0']:.3f} dnode={res['nodeRate']:.6f}/d "
              f"u0={res['u0']:.3f} n={res['n']:.7f}/d a={res['a']:.0f} rms={res['residRms']:.3f}° "
              f"e={res['e']:.4f} w0={res['w0']:.1f} final={res['finalRmsDeg']:.3f}°",
              file=sys.stderr)
        results.append(res)
    print(json.dumps(results, indent=1))


if __name__ == '__main__':
    main()
