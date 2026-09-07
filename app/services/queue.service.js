const renderQueue = [];

function addToQueue(job) {
  renderQueue.push(job);
  return job;
}

function getNextJob() {
  return renderQueue.shift();
}

function getQueue() {
  return renderQueue;
}

function getQueueLength() {
  return renderQueue.length;
}

// Get queue status
function getQueueStatus() {
  return {
    length: renderQueue.length,
    jobs: renderQueue
  };
}

module.exports = {
  addToQueue,
  getNextJob,
  getQueue,
  getQueueLength,
  getQueueStatus
};