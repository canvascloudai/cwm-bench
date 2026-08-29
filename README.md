# cwm-bench

Versioned, reproducible **measurement program** for [Cloud World Model](https://www.cloudworldmodel.ai), a Canvas Cloud AI product by Kevin Brown (GitHub [canvascloudai](https://github.com/canvascloudai), kevin@canvascloud.ai).

The public accuracy page (`GET https://www.cloudworldmodel.ai/api/accuracy-benchmark`) **consumes this dataset. It does not get to vote on it.**

**v1 measurements do not exist yet.** `results/` is empty of runs. Burst remains a **known gap**. Do not retune coefficients to raise the public score.

Public source of this program: [github.com/canvascloudai/cwm-bench](https://github.com/canvascloudai/cwm-bench). Origin namespace: `cloudworldmodel` (name the repo `cwm-bench`).

The full tree (terraform, app, k6, schemas, calibrate stub, CI) lives on the working branch of this measurement program. Push that tree here so GitHub Actions can run.
