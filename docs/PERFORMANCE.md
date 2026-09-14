# M4.7 performance record

Measured 2026-09-14 using `npm run benchmark`, Node v24.14.1, Windows x64.
Five warmups and 30 samples per measurement. Values below are median / p95 ms.
The same fixtures use 50, 200 and 1,000 managed solid nodes with an opacity property.
Connected-view fixtures add N−1 expression edges. Read/patch execute the actual
JSX in the fake-AE VM. Patch applies N property writes; setup is outside timing.

| Nodes | Read + parse (VM) | Clean diff | View preparation | Connected view | Patch (VM) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 1.351 / 1.779 | 0.075 / 0.212 | 0.044 / 0.212 | 0.039 / 0.087 | 0.406 / 0.606 |
| 200 | 4.859 / 6.114 | 0.270 / 0.392 | 0.121 / 0.189 | 0.160 / 0.234 | 1.652 / 1.918 |
| 1,000 | 24.752 / 27.029 | 1.002 / 1.391 | 0.618 / 0.693 | 0.863 / 1.335 | 7.551 / 7.787 |

These are offline CPU measurements, not AE or CEP acceptance results. The clean
diff is below 16 ms in this Node runtime; this does not certify that budget in CEP.
No before/after speedup ratio is claimed. The 200-node minimap cutoff is provisional.

## Host acceptance still required

Record AE version, CEP engine, hardware, panel dimensions and project fixture.
For each size, separately capture host read and patch receipts, CEP round-trip
latency, React commit/paint duration, and command-to-visible-feedback latency.
Measure pointer frames while dragging/panning for 10 seconds and stable-revision
idle CPU for 60 seconds. Include effect chains and mixed unmanaged/parented layers.

- DOM render/paint: **not measured**.
- Pointer latency / 60 fps: **not measured**.
- Command feedback under 50 ms: **not measured**.
- Live host read/patch and idle CPU: **not measured**.

The scale acceptance gate remains open until these measurements are recorded.
