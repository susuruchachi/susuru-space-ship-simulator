import numpy as np
def gauss_kernel(sigma):
    r = max(1, int(3*sigma))
    x = np.arange(-r, r+1)
    k = np.exp(-0.5*(x/sigma)**2); return k/k.sum()
def blur(a, sigma, wrap_x=True):
    k = gauss_kernel(sigma); r = len(k)//2
    # x direction (wrap)
    p = np.pad(a, ((0,0),(r,r)), mode='wrap' if wrap_x else 'edge')
    out = np.zeros_like(a)
    for i, kv in enumerate(k):
        out += kv * p[:, i:i+a.shape[1]]
    p = np.pad(out, ((r,r),(0,0)), mode='edge')
    out2 = np.zeros_like(a)
    for i, kv in enumerate(k):
        out2 += kv * p[i:i+a.shape[0], :]
    return out2
