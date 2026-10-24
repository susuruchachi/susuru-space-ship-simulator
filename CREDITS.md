# 出典・ライセンス

宇宙の描画（v77〜）で使っているデータ・画像の出典です。ゲーム画面左下の
「出典」からも同じ内容を確認できます。

## 画像

| 対象 | 出典 | ライセンス | 加工 |
|---|---|---|---|
| 天の川の全天写真（`textures/milkyway_*.jpg`） | ESO/S. Brunier, "The Milky Way panorama" (https://www.eso.org/public/images/eso0932a/) | CC BY 4.0 | 星表との位置合わせ（歪み補正）、明るい星・惑星の除去、天球用の投影への変換、縮小 |
| 惑星・月・太陽・土星の環（`earth_*`, `moon_*`, `mars_*`, `mercury_*`, `venus_*`, `jupiter_*`, `saturn_*`, `uranus_*`, `neptune_*`, `sun_*`, `saturn_ring.png`） | Solar System Scope (https://www.solarsystemscope.com/textures/) | CC BY 4.0 | 解像度別に縮小、環は半径方向の1次元に平均化 |
| 衛星・冥王星・カロン（`io_1k.jpg` ほか） | NASA 3D Resources (https://github.com/nasa/NASA-3D-Resources) | パブリックドメイン（NASA） | 未撮影領域の補完、縮小 |
| ケレス（`ceres_*`） | NASA/JPL-Caltech/UCLA/MPS/DLR/IDA（探査機ドーン）、USGS Astrogeology "Ceres Dawn FC Global Mosaic 400m" | 利用制限なし（出典表示） | 経度の基準合わせ、極域の補完、着色、縮小 |
| ベスタ（`vesta_1k.jpg`） | NASA/JPL-Caltech/UCLA/MPS/DLR/IDA（探査機ドーン）、USGS Astrogeology "Vesta Dawn FC HAMO Global Mosaic 60m" | 利用制限なし（出典表示） | 北極域（撮影時は極夜）の補完、着色 |
| トリトン・エリス・ハウメア・マケマケ・パラス・ヒギエア | 全球地図が無いため、平均的な色の起伏ノイズで生成 | — | — |

## データ

| 対象 | 出典 |
|---|---|
| 恒星（`data/star-catalog.js`） | ESA Hipparcos Catalogue (ESA 1997, CDS I/239)。恒星の固有名は IAU WGSN |
| 小天体の軌道要素（`data/small-bodies.js`、準惑星・小惑星・彗星） | JPL Small-Body Database (https://ssd.jpl.nasa.gov/) |
| 惑星の軌道 | E.M. Standish, "Keplerian Elements for Approximate Positions of the Major Planets" (JPL) |
| 月の軌道 | J. Meeus, "Astronomical Algorithms" 第47章 |
| 衛星の軌道 | JPL Horizons の暦に当てはめた軌道要素（`tools/fit_satellites.py`） |
| 天体の自転軸・自転 | IAU WGCCRE (Archinal et al. 2018) |
| 天体の大きさ・質量・反射率 | IAU WGCCRE, JPL, NASA Planetary Fact Sheet |
| 銀河系の渦巻腕 | Reid et al. (2019), ApJ 885, 131 |

データやテクスチャを作り直すスクリプトは `tools/` にあります。

## ライブラリ

| 対象 | 出典 | ライセンス |
|---|---|---|
| three.js r128（`lib/three/`。本体・GLTF/OBJ/MTL 読み込み・ブルーム） | https://threejs.org/ （three.js authors） | MIT |
