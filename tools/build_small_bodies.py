#!/usr/bin/env python3
"""
星図に表示する小天体（小惑星帯・トロヤ群・地球近傍小惑星・ケンタウルス族・
太陽系外縁天体）の軌道要素データ data/small-bodies.js の生成スクリプト。

入力: JPL Small-Body Database Query API (https://ssd-api.jpl.nasa.gov/sbdb_query.api)
  - 番号付き小惑星のうち絶対等級 H < 14（およそ直径5km以上）
  - 地球近傍小惑星のうち H < 18（およそ直径1km以上）
  - 太陽系外縁天体（TNO）・ケンタウルス族のすべて
個別に描画している天体（ケレス・パラス・ベスタ・ヒギエア・冥王星など）は除く。

出力: 接触軌道要素を共通の元期に揃え、1天体16バイトに詰めたものをbase64で埋め込む
  a: float32 [au] / e, i, Ω, ω, M: uint16 / H: uint8 (×10) / 分類: uint8

使い方:
  python3 tools/build_small_bodies.py [キャッシュ用ディレクトリ]
"""
import base64
import json
import math
import os
import struct
import sys
import urllib.parse
import urllib.request

API = 'https://ssd-api.jpl.nasa.gov/sbdb_query.api'
FIELDS = 'spkid,a,e,i,om,w,ma,epoch,H,class'
QUERIES = {
    'numbered': {'sb-kind': 'a', 'sb-ns': 'n', 'sb-cdata': json.dumps({'AND': ['H|LT|14']})},
    'neo': {'sb-group': 'neo', 'sb-cdata': json.dumps({'AND': ['H|LT|18']})},
    'outer': {'sb-class': 'TNO,CEN'},
}
# 14-solar-system.js で個別に描画している天体（SPK-ID）
EXCLUDE = {2000001, 2000002, 2000004, 2000010, 2134340, 2136199, 2136108, 2136472, 2090377}
# 分類コード（15-universe-render.js の SMALL_BODY_GROUPS と同じ順）
GROUPS = ['main', 'hilda', 'trojan', 'neo', 'centaur', 'tno']
EPOCH = 2461200.5  # 共通の元期（2026-06-09 TT。SBDBの大半の天体の元期）
GAUSS_DEG = 0.9856076686  # ガウス引力定数 k [度/日]（n = k / a^1.5）


def fetch(name, params, cache):
    path = os.path.join(cache, f'sbdb_{name}.json')
    if not os.path.exists(path):
        q = dict(params, fields=FIELDS)
        url = API + '?' + urllib.parse.urlencode(q)
        print('fetch', url)
        with urllib.request.urlopen(url, timeout=600) as r:
            open(path, 'wb').write(r.read())
    d = json.load(open(path))
    print(f'  {name}: {d["count"]}')
    return d['fields'], d['data']


def group_of(cls, a, e, i):
    if cls in ('APO', 'ATE', 'AMO', 'IEO'):
        return 'neo'
    if cls == 'TJN':
        return 'trojan'
    if cls == 'CEN':
        return 'centaur'
    if cls == 'TNO':
        return 'tno'
    if 3.7 < a < 4.2 and e < 0.35 and i < 20:
        return 'hilda'  # 木星と3:2の平均運動共鳴にある群（クラス上は外側メインベルト）
    return 'main'


def main():
    cache = sys.argv[1] if len(sys.argv) > 1 else '.'
    os.makedirs(cache, exist_ok=True)
    rows = {}
    for name, params in QUERIES.items():
        fields, data = fetch(name, params, cache)
        idx = {f: k for k, f in enumerate(fields)}
        for r in data:
            spk = int(r[idx['spkid']])
            if spk in EXCLUDE or spk in rows:
                continue
            try:
                a, e, i = float(r[idx['a']]), float(r[idx['e']]), float(r[idx['i']])
                om, w, ma = float(r[idx['om']]), float(r[idx['w']]), float(r[idx['ma']])
                ep = float(r[idx['epoch']])
            except (TypeError, ValueError):
                continue
            if not (a > 0 and 0 <= e < 0.995):
                continue
            H = r[idx['H']]
            H = float(H) if H not in (None, '') else 12.0
            rows[spk] = (a, e, i, om, w, ma, ep, H, group_of(r[idx['class']], a, e, i))
    # 明るい（大きい）天体から順に並べる（表示数を絞るときに先頭から使えるように）
    items = sorted(rows.values(), key=lambda t: t[7])
    buf = bytearray()
    counts = {g: 0 for g in GROUPS}
    u16 = lambda x, full: int(round((x % full) / full * 65536)) & 0xFFFF
    for a, e, i, om, w, ma, ep, H, g in items:
        n = GAUSS_DEG / a ** 1.5
        M = (ma + n * (EPOCH - ep)) % 360.0
        buf += struct.pack('<fHHHHHBB', a, min(65535, int(round(e * 65535))),
                           min(65535, int(round(i / 180.0 * 65535))),
                           u16(om, 360.0), u16(w, 360.0), u16(M, 360.0),
                           max(0, min(255, int(round(H * 10)))), GROUPS.index(g))
        counts[g] += 1
    print('total', len(items), counts)
    b64 = base64.b64encode(bytes(buf)).decode('ascii')
    out = os.path.join(os.path.dirname(__file__), '..', 'data', 'small-bodies.js')
    with open(out, 'w') as f:
        f.write('// 自動生成: tools/build_small_bodies.py（出典: JPL Small-Body Database）\n')
        f.write('// 1天体16バイト: a(float32,au) e i Ω ω M(uint16) H×10(uint8) 分類(uint8)\n')
        f.write(f'const SMALL_BODY_DATA = {{ epoch: {EPOCH}, count: {len(items)}, '
                f'groups: {json.dumps(GROUPS)}, b64: "{b64}" }};\n')
    print(out, os.path.getsize(out) // 1024, 'KB')


if __name__ == '__main__':
    main()
