#!/usr/bin/env python3
"""
恒星カタログ（data/star-catalog.js）の生成スクリプト。

入力:
  - ヒッパルコス星表 (ESA 1997, CDS I/239 hip_main.dat)
  - IAU 恒星名カタログ IAU-CSN (IAU WGSN, https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt)

出力: data/star-catalog.js
  STAR_CATALOG_DATA = {
    count, b64,      // 1星あたり8バイトのバイナリ（下記）をBase64化したもの
    names: [[index, 英名, 日本語名, バイエル符号(日本語)], ...],
  }
  1星あたりのレイアウト（リトルエンディアン）:
    uint16 RA  (0..65535 → 0..360°, J2000.0 / ICRS)
    int16  Dec (-32767..32767 → -90..+90°)
    uint8  V等級 ((V + 2) * 20, 0.05等刻み, -2.0..+10.75)
    int8   B-V ((B-V) * 50, 0.02刻み)
    uint16 年周視差 (0.05 mas 単位。0 = 信頼できる値なし → 遠方扱い)
  明るい順に並べてあるので、描画側は先頭から必要数だけ使えばよい。

選定: V < 8.0 の全星（約4.1万）＋ 20pc（約65光年）以内で視差の精度が良い星
（暗い赤色矮星も、近くへワープしたときに見えるようにするため）。
ヒッパルコスに含まれない有名な近傍星（ウルフ359 など）は EXTRA_STARS で追加する。

使い方:
  python3 tools/build_star_catalog.py <hip_main.dat> <IAU-CSN.txt> <出力 .js>
"""
import base64
import json
import math
import struct
import sys

from hip_parse import parse_hip

# ---------------------------------------------------------------------------
# 88星座の日本語名（IAU略符 → 日本語）
CON_JA = {
    'And': 'アンドロメダ座', 'Ant': 'ポンプ座', 'Aps': 'ふうちょう座', 'Aqr': 'みずがめ座',
    'Aql': 'わし座', 'Ara': 'さいだん座', 'Ari': 'おひつじ座', 'Aur': 'ぎょしゃ座',
    'Boo': 'うしかい座', 'Cae': 'ちょうこくぐ座', 'Cam': 'きりん座', 'Cnc': 'かに座',
    'CVn': 'りょうけん座', 'CMa': 'おおいぬ座', 'CMi': 'こいぬ座', 'Cap': 'やぎ座',
    'Car': 'りゅうこつ座', 'Cas': 'カシオペヤ座', 'Cen': 'ケンタウルス座', 'Cep': 'ケフェウス座',
    'Cet': 'くじら座', 'Cha': 'カメレオン座', 'Cir': 'コンパス座', 'Col': 'はと座',
    'Com': 'かみのけ座', 'CrA': 'みなみのかんむり座', 'CrB': 'かんむり座', 'Crv': 'からす座',
    'Crt': 'コップ座', 'Cru': 'みなみじゅうじ座', 'Cyg': 'はくちょう座', 'Del': 'いるか座',
    'Dor': 'かじき座', 'Dra': 'りゅう座', 'Equ': 'こうま座', 'Eri': 'エリダヌス座',
    'For': 'ろ座', 'Gem': 'ふたご座', 'Gru': 'つる座', 'Her': 'ヘルクレス座',
    'Hor': 'とけい座', 'Hya': 'うみへび座', 'Hyi': 'みずへび座', 'Ind': 'インディアン座',
    'Lac': 'とかげ座', 'Leo': 'しし座', 'LMi': 'こじし座', 'Lep': 'うさぎ座',
    'Lib': 'てんびん座', 'Lup': 'おおかみ座', 'Lyn': 'やまねこ座', 'Lyr': 'こと座',
    'Men': 'テーブルさん座', 'Mic': 'けんびきょう座', 'Mon': 'いっかくじゅう座', 'Mus': 'はえ座',
    'Nor': 'じょうぎ座', 'Oct': 'はちぶんぎ座', 'Oph': 'へびつかい座', 'Ori': 'オリオン座',
    'Pav': 'くじゃく座', 'Peg': 'ペガスス座', 'Per': 'ペルセウス座', 'Phe': 'ほうおう座',
    'Pic': 'がか座', 'Psc': 'うお座', 'PsA': 'みなみのうお座', 'Pup': 'とも座',
    'Pyx': 'らしんばん座', 'Ret': 'レチクル座', 'Sge': 'や座', 'Sgr': 'いて座',
    'Sco': 'さそり座', 'Scl': 'ちょうこくしつ座', 'Sct': 'たて座', 'Ser': 'へび座',
    'Sex': 'ろくぶんぎ座', 'Tau': 'おうし座', 'Tel': 'ぼうえんきょう座', 'Tri': 'さんかく座',
    'TrA': 'みなみのさんかく座', 'Tuc': 'きょしちょう座', 'UMa': 'おおぐま座', 'UMi': 'こぐま座',
    'Vel': 'ほ座', 'Vir': 'おとめ座', 'Vol': 'とびうお座', 'Vul': 'こぎつね座',
}

# よく知られた恒星の日本語名（IAU名 → カタカナ）。ここに無い星はIAUの英名をそのまま表示する。
NAME_JA = {
    'Sirius': 'シリウス', 'Canopus': 'カノープス', 'Rigil Kentaurus': 'リギル・ケンタウルス',
    'Toliman': 'トリマン', 'Proxima Centauri': 'プロキシマ・ケンタウリ', 'Arcturus': 'アークトゥルス',
    'Vega': 'ベガ', 'Capella': 'カペラ', 'Rigel': 'リゲル', 'Procyon': 'プロキオン',
    'Achernar': 'アケルナル', 'Betelgeuse': 'ベテルギウス', 'Hadar': 'ハダル', 'Altair': 'アルタイル',
    'Acrux': 'アクルックス', 'Aldebaran': 'アルデバラン', 'Antares': 'アンタレス', 'Spica': 'スピカ',
    'Pollux': 'ポルックス', 'Fomalhaut': 'フォーマルハウト', 'Deneb': 'デネブ', 'Mimosa': 'ミモザ',
    'Regulus': 'レグルス', 'Adhara': 'アダーラ', 'Castor': 'カストル', 'Gacrux': 'ガクルックス',
    'Shaula': 'シャウラ', 'Bellatrix': 'ベラトリックス', 'Elnath': 'エルナト',
    'Miaplacidus': 'ミアプラキドゥス', 'Alnilam': 'アルニラム', 'Alnair': 'アルナイル',
    'Alnitak': 'アルニタク', 'Alioth': 'アリオト', 'Dubhe': 'ドゥーベ', 'Mirfak': 'ミルファク',
    'Wezen': 'ウェズン', 'Sargas': 'サルガス', 'Kaus Australis': 'カウス・アウストラリス',
    'Avior': 'アヴィオール', 'Alkaid': 'アルカイド', 'Menkalinan': 'メンカリナン', 'Atria': 'アトリア',
    'Alhena': 'アルヘナ', 'Peacock': 'ピーコック', 'Alsephina': 'アルセフィナ', 'Mirzam': 'ミルザム',
    'Alphard': 'アルファルド', 'Polaris': 'ポラリス（北極星）', 'Hamal': 'ハマル', 'Algieba': 'アルギエバ',
    'Diphda': 'ディフダ', 'Nunki': 'ヌンキ', 'Menkent': 'メンケント', 'Mirach': 'ミラク',
    'Alpheratz': 'アルフェラッツ', 'Rasalhague': 'ラス・アルハゲ', 'Kochab': 'コカブ', 'Saiph': 'サイフ',
    'Denebola': 'デネボラ', 'Algol': 'アルゴル', 'Tiaki': 'ティアキ', 'Muhlifain': 'ムリファイン',
    'Aspidiske': 'アスピディスケ', 'Suhail': 'スハイル', 'Alphecca': 'アルフェッカ',
    'Mintaka': 'ミンタカ', 'Sadr': 'サドル', 'Eltanin': 'エルタニン', 'Schedar': 'シェダル',
    'Naos': 'ナオス', 'Almach': 'アルマク', 'Caph': 'カフ', 'Izar': 'イザール', 'Dschubba': 'ジュバ',
    'Larawag': 'ララワグ', 'Merak': 'メラク', 'Ankaa': 'アンカア', 'Girtab': 'ギルタブ', 'Enif': 'エニフ',
    'Scheat': 'シェアト', 'Sabik': 'サビク', 'Phecda': 'フェクダ', 'Aludra': 'アルドラ',
    'Markeb': 'マルケブ', 'Markab': 'マルカブ', 'Aljanah': 'アルジャナー', 'Acrab': 'アクラブ',
    'Alcyone': 'アルキオネ（すばる）', 'Albireo': 'アルビレオ', 'Mizar': 'ミザール', 'Alcor': 'アルコル',
    'Thuban': 'トゥバン', 'Vindemiatrix': 'ビンデミアトリックス', 'Zubenelgenubi': 'ズベン・エル・ゲヌビ',
    'Zubeneschamali': 'ズベン・エス・カマリ', 'Unukalhai': 'ウヌカルハイ', 'Rasalgethi': 'ラス・アルゲティ',
    'Sheratan': 'シェラタン', 'Alderamin': 'アルデラミン', 'Menkar': 'メンカル', 'Mira': 'ミラ',
    'Ran': 'ラン', "Barnard's Star": 'バーナード星', 'Cor Caroli': 'コル・カロリ', 'Algorab': 'アルゴラブ',
    'Gienah': 'ギェナー', 'Kraz': 'クラズ', 'Porrima': 'ポリマ', 'Zosma': 'ゾスマ', 'Chertan': 'シェルタン',
    'Tarazed': 'タラゼド', 'Alshain': 'アルシャイン', 'Sualocin': 'スアロキン', 'Rotanev': 'ロタネフ',
    'Sadalsuud': 'サダルスウド', 'Sadalmelik': 'サダルメリク', 'Skat': 'スカト',
    'Deneb Algedi': 'デネブ・アルゲディ', 'Dabih': 'ダビー', 'Ascella': 'アスケラ',
    'Kaus Media': 'カウス・メディア', 'Kaus Borealis': 'カウス・ボレアリス', 'Albaldah': 'アルバルダー',
    'Arneb': 'アルネブ', 'Nihal': 'ニハル', 'Phact': 'ファクト', 'Wazn': 'ワズン', 'Tejat': 'テジャト',
    'Propus': 'プロプス', 'Mebsuta': 'メブスタ', 'Mekbuda': 'メクブダ', 'Wasat': 'ワサト',
    'Alzirr': 'アルジル', 'Furud': 'フルド', 'Gomeisa': 'ゴメイサ', 'Alnasl': 'アルナスル',
    'Lesath': 'レサト', 'Fang': 'ファング', 'Jabbah': 'ジャバー', 'Pherkad': 'フェルカド',
    'Yildun': 'イルドゥン', 'Errai': 'エライ', 'Alfirk': 'アルフィルク', 'Ruchbah': 'ルクバー',
    'Segin': 'セギン', 'Achird': 'アキルド', 'Alrescha': 'アルレシャ', 'Botein': 'ボテイン',
    'Atik': 'アティク', 'Menkib': 'メンキブ', 'Zaurak': 'ザウラク', 'Cursa': 'クルサ',
    'Acamar': 'アカマル', 'Azha': 'アザー', 'Rana': 'ラナ', 'Hassaleh': 'ハッサレー',
    'Haedus': 'ハエドゥス', 'Saclateni': 'サクラテニ', 'Mahasim': 'マハシム', 'Chara': 'カラ',
    'Muscida': 'ムシダ', 'Talitha': 'タリタ', 'Tania Borealis': 'タニア・ボレアリス',
    'Tania Australis': 'タニア・アウストラリス', 'Alula Borealis': 'アルラ・ボレアリス',
    'Alula Australis': 'アルラ・アウストラリス', 'Megrez': 'メグレズ', 'Seginus': 'セギヌス',
    'Nekkar': 'ネッカル', 'Muphrid': 'ムフリッド', 'Alkalurops': 'アルカルロプス', 'Nusakan': 'ヌサカン',
    'Kornephoros': 'コルネフォロス', 'Sarin': 'サリン', 'Maasym': 'マアシム', 'Cebalrai': 'ケバルライ',
    'Marfik': 'マルフィク', 'Yed Prior': 'イェド・プリオル', 'Yed Posterior': 'イェド・ポステリオル',
    'Sheliak': 'シェリアク', 'Sulafat': 'スラファト', 'Aladfar': 'アラドファル', 'Fawaris': 'ファワリス',
    'Azelfafage': 'アゼルファファゲ', 'Sadachbia': 'サダクビア', 'Ancha': 'アンカ', 'Situla': 'シトゥラ',
    'Biham': 'ビハム', 'Homam': 'ホマム', 'Matar': 'マタル', 'Sadalbari': 'サダルバリ', 'Salm': 'サルム',
    'Alpherg': 'アルフェルグ', 'Baten Kaitos': 'バテン・カイトス', 'Kaffaljidhma': 'カッファルジドマ',
    'Mesarthim': 'メサルティム', 'Bharani': 'バラニ', 'Algenib': 'アルゲニブ', 'Electra': 'エレクトラ',
    'Taygeta': 'タイゲタ', 'Maia': 'マイア', 'Merope': 'メローペ', 'Atlas': 'アトラス',
    'Pleione': 'プレイオネ', 'Asterope': 'アステロペ', 'Celaeno': 'ケラエノ', 'Ain': 'アイン',
    'Chamukuy': 'チャムクイ', 'Prima Hyadum': 'プリマ・ヒアドゥム', 'Secunda Hyadum': 'セクンダ・ヒアドゥム',
    'Tabit': 'タビト', 'Meissa': 'メイサ', 'Hatysa': 'ハティサ', 'Muliphein': 'ムリフェイン',
    'Unurgunite': 'ウヌルグニテ', 'Tureis': 'トゥレイス', 'Imai': 'イマイ', 'Ginan': 'ギナン',
    'Alchiba': 'アルキバ', 'Minkar': 'ミンカル', 'Alkes': 'アルケス', 'Zavijava': 'ザヴィヤヴァ',
    'Heze': 'ヘゼ', 'Syrma': 'シルマ', 'Zaniah': 'ザニア', 'Khambalia': 'カンバリア',
    'Brachium': 'ブラキウム', 'Zubenelhakrabi': 'ズベン・エル・ハクラビ', 'Paikauhale': 'パイカウハレ',
    'Alniyat': 'アルニヤト', 'Pipirima': 'ピピリマ', 'Xamidimura': 'ハミディムラ', 'Fuyue': 'フユエ',
    'Han': 'ハン', 'Polis': 'ポリス', 'Rukbat': 'ルクバト', 'Arkab Prior': 'アルカブ・プリオル',
    'Arkab Posterior': 'アルカブ・ポステリオル', 'Terebellum': 'テレベルム', 'Ainalrami': 'アイナルラミ',
    'Algedi': 'アルゲディ', 'Nashira': 'ナシラ', 'Albali': 'アルバリ', 'Adhil': 'アディル',
    'Mothallah': 'モサラー', 'Misam': 'ミサム', 'Almaaz': 'アルマーズ', 'Acubens': 'アクベンス',
    'Tarf': 'タルフ', 'Asellus Borealis': 'アセルス・ボレアリス', 'Asellus Australis': 'アセルス・アウストラリス',
    'Adhafera': 'アダフェラ', 'Rasalas': 'ラサラス', 'Subra': 'スブラ', 'Alterf': 'アルテルフ',
    'Taiyangshou': 'タイヤンショウ', 'Rastaban': 'ラスタバン', 'Edasich': 'エダシク',
    'Aldhibah': 'アルディバ', 'Altais': 'アルタイス', 'Grumium': 'グルミウム', 'Alsafi': 'アルサフィ',
    'Giausar': 'ギアウサル', 'Kurhah': 'クルハー', 'Castula': 'カストゥラ', 'Fulu': 'フル',
    'Okab': 'オカブ', 'Aldulfin': 'アルドゥルフィン', 'Sham': 'シャム', 'Anser': 'アンサー',
    'Kitalpha': 'キタルファ', 'Diadem': 'ディアデム', 'Alya': 'アルヤ', 'Beid': 'ベイド', 'Keid': 'ケイド',
    'Aldhanab': 'アルダナブ', 'Alrakis': 'アルラキス', 'Kraz ': 'クラズ',
}

GREEK_JA = {
    'alf': 'α', 'bet': 'β', 'gam': 'γ', 'del': 'δ', 'eps': 'ε', 'zet': 'ζ', 'eta': 'η', 'tet': 'θ',
    'iot': 'ι', 'kap': 'κ', 'lam': 'λ', 'mu.': 'μ', 'mu': 'μ', 'nu.': 'ν', 'nu': 'ν', 'ksi': 'ξ',
    'omi': 'ο', 'pi.': 'π', 'pi': 'π', 'rho': 'ρ', 'sig': 'σ', 'tau': 'τ', 'ups': 'υ', 'phi': 'φ',
    'chi': 'χ', 'psi': 'ψ', 'ome': 'ω',
}

# ヒッパルコスに含まれない有名な近傍星（RA/Dec は J2000 [度]、距離 [光年]）。
# 値は SIMBAD / RECONS 等の公表値を丸めたもの。
EXTRA_STARS = [
    # (英名, 日本語名, RA, Dec, 距離ly, V, B-V)
    ('Wolf 359', 'ウルフ359', 164.1205, 7.0147, 7.86, 13.51, 2.03),
    ('Luyten 726-8 A', 'ルイテン726-8 A（くじら座BL星）', 24.7563, -17.9503, 8.73, 12.54, 1.85),
    ('Luyten 726-8 B', 'ルイテン726-8 B（くじら座UV星）', 24.7565, -17.9506, 8.73, 12.99, 1.85),
    ('Ross 248', 'ロス248', 355.4793, 44.1780, 10.30, 12.29, 1.91),
    ("Teegarden's Star", 'ティーガーデン星', 43.2537, 16.8814, 12.50, 15.13, 2.10),
    ('TRAPPIST-1', 'トラピスト1', 346.6224, -5.0414, 40.66, 18.80, 2.40),
]

# ヒッパルコスにはあるがIAU-CSNに名前が無い有名な近傍星（HIP → 英名, 日本語名）
NEARBY_NAMES = {
    54035: ('Lalande 21185', 'ラランド21185'),
    92403: ('Ross 154', 'ロス154'),
    114046: ('Lacaille 9352', 'ラカーユ9352'),
    57548: ('Ross 128', 'ロス128'),
    104214: ('61 Cygni A', 'はくちょう座61番星A'),
    104217: ('61 Cygni B', 'はくちょう座61番星B'),
    91768: ('Struve 2398 A', 'ストルーベ2398 A'),
    91772: ('Struve 2398 B', 'ストルーベ2398 B'),
    1475: ('Groombridge 34', 'グルームブリッジ34'),
    108870: ('Epsilon Indi', 'インディアン座ε星'),
    8102: ('Tau Ceti', 'くじら座τ星'),
    5643: ('YZ Ceti', 'くじら座YZ星'),
    36208: ("Luyten's Star", 'ルイテン星'),
    24186: ("Kapteyn's Star", 'カプタイン星'),
    105090: ('Lacaille 8760', 'ラカーユ8760'),
    110893: ('Kruger 60', 'クリューガー60'),
    30920: ('Ross 614', 'ロス614'),
    80824: ('Wolf 1061', 'ウルフ1061'),
    439: ('Gliese 1', 'グリーゼ1'),
    3829: ("van Maanen's Star", 'ファン・マーネン星'),
    86162: ('Gliese 687', 'グリーゼ687'),
    85523: ('Gliese 674', 'グリーゼ674'),
}


def parse_iau_csn(path):
    out = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            if line.startswith('#') or line.startswith('$') or not line.strip():
                continue
            name = line[0:18].strip()
            t = line[36:].split()
            if t and t[-1] == '*':
                t = t[:-1]
            if len(t) < 13:
                continue
            hip = t[-5]
            con = t[-10]
            id1 = t[-12]
            id2 = t[-11]
            if hip == '_':
                continue
            out.append((int(hip), name, id1, id2, con))
    return out


def bayer_ja(id1, id2, con):
    con_ja = CON_JA.get(con)
    if not con_ja or id1 == '_':
        return ''
    if id2 != '_' and id2[0] in 'αβγδεζηθικλμνξοπρστυφχψω':
        return f'{con_ja}{id2}星'
    if id1.isdigit():
        return f'{con_ja}{int(id1)}番星'
    return ''


def main():
    hip_path, csn_path, out_path = sys.argv[1:4]
    rows = parse_hip(hip_path)
    dt = 2000.0 - 1991.25
    stars = []
    for hip, ra, de, v, plx, eplx, pmra, pmde, bv, sp in rows:
        reliable = plx is not None and plx > 0 and eplx is not None and eplx / plx < 0.25
        near = reliable and plx >= 50.0 and eplx / plx < 0.2
        if not (v < 8.0 or near):
            continue
        # 固有運動で J2000.0 へ（pmRA は cos(dec) 込み）
        if pmra is not None and pmde is not None:
            de2 = de + pmde * dt / 3.6e6
            ra2 = ra + pmra * dt / 3.6e6 / max(1e-6, math.cos(math.radians(de)))
        else:
            ra2, de2 = ra, de
        stars.append({
            'hip': hip, 'ra': ra2 % 360.0, 'de': max(-90.0, min(90.0, de2)), 'v': v,
            'bv': bv if bv is not None else 0.6,
            'plx': plx if reliable else 0.0,
        })
    for en, ja, ra, de, ly, v, bv in EXTRA_STARS:
        stars.append({'hip': None, 'extra': (en, ja), 'ra': ra, 'de': de, 'v': v, 'bv': bv,
                      'plx': 1000.0 * 3.26156 / ly})
    stars.sort(key=lambda s: s['v'])

    buf = bytearray()
    for s in stars:
        ra_q = int(round(s['ra'] / 360.0 * 65536)) % 65536
        de_q = int(round(s['de'] / 90.0 * 32767))
        v_q = max(0, min(255, int(round((s['v'] + 2.0) * 20))))
        bv_q = max(-127, min(127, int(round(s['bv'] * 50))))
        plx_q = max(0, min(65535, int(round(s['plx'] / 0.05))))
        buf += struct.pack('<HhBbH', ra_q, de_q, v_q, bv_q, plx_q)

    index_by_hip = {s['hip']: i for i, s in enumerate(stars) if s['hip'] is not None}
    names = []
    seen = set()
    for hip, name, id1, id2, con in parse_iau_csn(csn_path):
        i = index_by_hip.get(hip)
        if i is None or i in seen:
            continue
        seen.add(i)
        names.append([i, name, NAME_JA.get(name, ''), bayer_ja(id1, id2, con)])
    for hip, (en, ja) in NEARBY_NAMES.items():
        i = index_by_hip.get(hip)
        if i is not None and i not in seen:
            seen.add(i)
            names.append([i, en, ja, ''])
    for i, s in enumerate(stars):
        if 'extra' in s:
            names.append([i, s['extra'][0], s['extra'][1], ''])
    names.sort(key=lambda n: n[0])

    b64 = base64.b64encode(bytes(buf)).decode('ascii')
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write('// =============================================================\n')
        f.write('// data/star-catalog.js（自動生成: tools/build_star_catalog.py。手で編集しないこと）\n')
        f.write('// 出典: ヒッパルコス星表 (ESA 1997, CDS I/239)、恒星名: IAU WGSN (IAU-CSN)\n')
        f.write('// 形式は tools/build_star_catalog.py 冒頭のコメントを参照。\n')
        f.write('// =============================================================\n')
        f.write('const STAR_CATALOG_DATA = {\n')
        f.write(f'  count: {len(stars)},\n')
        f.write(f'  b64: "{b64}",\n')
        f.write('  names: ' + json.dumps(names, ensure_ascii=False, separators=(',', ':')) + ',\n')
        f.write('};\n')
    print(f'stars: {len(stars)}, names: {len(names)}, bytes: {len(buf)}, js: {len(b64) // 1024} KB')


if __name__ == '__main__':
    main()
