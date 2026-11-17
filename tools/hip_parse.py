import math, sys
import numpy as np

def parse_hip(path):
    rows = []
    with open(path, 'r', encoding='latin-1') as f:
        for line in f:
            p = line.split('|')
            try:
                hip = int(p[1])
            except ValueError:
                continue
            def fl(i):
                s = p[i].strip()
                return float(s) if s else None
            vmag = fl(5); ra = fl(8); de = fl(9); plx = fl(11)
            pmra = fl(12); pmde = fl(13); bv = fl(37); eplx = fl(16)
            sp = p[76].strip() if len(p) > 76 else ''
            if ra is None or de is None or vmag is None:
                continue
            rows.append((hip, ra, de, vmag, plx, eplx, pmra, pmde, bv, sp))
    return rows

# ICRS -> Galactic (Hipparcos vol.1 sec 1.5.3)
AG = np.array([[-0.0548755604, -0.8734370902, -0.4838350155],
               [ 0.4941094279, -0.4448296300,  0.7469822445],
               [-0.8676661490, -0.1980763734,  0.4559837762]])

def radec_to_vec(ra, de):
    ra = np.radians(ra); de = np.radians(de)
    return np.stack([np.cos(de)*np.cos(ra), np.cos(de)*np.sin(ra), np.sin(de)], axis=-1)

def to_gal(ra, de):
    v = radec_to_vec(ra, de)
    g = v @ AG.T
    l = np.degrees(np.arctan2(g[...,1], g[...,0])) % 360
    b = np.degrees(np.arcsin(np.clip(g[...,2], -1, 1)))
    return l, b

if __name__ == '__main__':
    rows = parse_hip(sys.argv[1])
    print(len(rows))
    v = np.array([r[3] for r in rows])
    for m in [2,3,4,5,6,6.5,7,7.5,8,9]:
        print(m, int((v < m).sum()))
