'use strict';

function poolSizePerWorker(poolSize, workers) {
  const size = Number(poolSize);
  const count = Number(workers);
  if (!Number.isInteger(size) || size < 1) {
    throw new Error('pool size must be a positive integer');
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('worker count must be a positive integer');
  }
  return Math.floor(size / count);
}

function handleWorkerExit(state, fork) {
  if (state.shuttingDown) return state.restarts;
  state.restarts += 1;
  fork();
  return state.restarts;
}

module.exports = {
  poolSizePerWorker,
  handleWorkerExit,
};
