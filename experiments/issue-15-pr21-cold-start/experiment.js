const params = new URLSearchParams(location.search);
const cue = params.get("cue") ?? "press";
const scheduleLeadSeconds = Number(params.get("leadMs") ?? 0) / 1000;
const trialId = params.get("trial") ?? "manual";

const NativeAudioContext = window.AudioContext;
const nativeConnect = AudioNode.prototype.connect;
const nativeBufferStart = AudioBufferSourceNode.prototype.start;
const nativeBufferStop = AudioBufferSourceNode.prototype.stop;
const nativeOscillatorStart = OscillatorNode.prototype.start;
const nativeOscillatorStop = OscillatorNode.prototype.stop;
const nativeSetValueAtTime = AudioParam.prototype.setValueAtTime;
const nativeExponentialRamp = AudioParam.prototype.exponentialRampToValueAtTime;
const nativeSetTimeout = window.setTimeout;

let context;
let captureNode;
let contextCreatedAtPerformanceTime;
let contextStateAtCreation;
const sourceStarts = [];
let adjustCleanupTimer = false;
let renderedPeak = 0;
let renderedFramesTotal = 0;
let renderedFramesWithSignal = 0;
let firstSignalAtPerformanceTime = null;

class CapturedAudioContext extends NativeAudioContext {
  constructor(...args) {
    super(...args);
    context = this;
    contextCreatedAtPerformanceTime = performance.now();
    contextStateAtCreation = this.state;
  }
}

window.AudioContext = CapturedAudioContext;

AudioNode.prototype.connect = function patchedConnect(destination, ...args) {
  if (context && destination === context.destination) {
    if (!captureNode) {
      captureNode = context.createScriptProcessor(256, 1, 1);
      captureNode.onaudioprocess = (event) => {
        renderedFramesTotal += 1;
        const samples = event.inputBuffer.getChannelData(0);
        let framePeak = 0;
        for (const sample of samples) framePeak = Math.max(framePeak, Math.abs(sample));
        renderedPeak = Math.max(renderedPeak, framePeak);
        if (framePeak > 0.0001) {
          renderedFramesWithSignal += 1;
          firstSignalAtPerformanceTime ??= performance.now();
        }
      };
      nativeConnect.call(captureNode, context.destination);
    }
    return nativeConnect.call(this, captureNode, ...args);
  }
  return nativeConnect.call(this, destination, ...args);
};

function adjustedTime(time) {
  return typeof time === "number" ? time + scheduleLeadSeconds : time;
}

AudioParam.prototype.setValueAtTime = function patchedSetValueAtTime(value, time) {
  return nativeSetValueAtTime.call(this, value, adjustedTime(time));
};

AudioParam.prototype.exponentialRampToValueAtTime = function patchedRamp(value, time) {
  return nativeExponentialRamp.call(this, value, adjustedTime(time));
};

window.setTimeout = function patchedSetTimeout(handler, timeout = 0, ...args) {
  const adjustedTimeout = adjustCleanupTimer ? timeout + scheduleLeadSeconds * 1000 : timeout;
  return nativeSetTimeout(handler, adjustedTimeout, ...args);
};

function recordStart(kind, originalWhen, adjustedWhen) {
  sourceStarts.push({
    kind,
    originalWhen,
    adjustedWhen,
    contextTimeWhenScheduled: context.currentTime,
    performanceTimeWhenScheduled: performance.now(),
  });
}

AudioBufferSourceNode.prototype.start = function patchedBufferStart(when = 0, ...args) {
  const adjustedWhen = adjustedTime(when);
  recordStart("buffer", when, adjustedWhen);
  return nativeBufferStart.call(this, adjustedWhen, ...args);
};

AudioBufferSourceNode.prototype.stop = function patchedBufferStop(when = 0) {
  return nativeBufferStop.call(this, adjustedTime(when));
};

OscillatorNode.prototype.start = function patchedOscillatorStart(when = 0) {
  const adjustedWhen = adjustedTime(when);
  recordStart("oscillator", when, adjustedWhen);
  return nativeOscillatorStart.call(this, adjustedWhen);
};

OscillatorNode.prototype.stop = function patchedOscillatorStop(when = 0) {
  return nativeOscillatorStop.call(this, adjustedTime(when));
};

const { play } = await import("/dist/index.js");
const runButton = document.querySelector("#run");
const resultElement = document.querySelector("#result");

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sampleRenderedSignal(durationMs) {
  await wait(durationMs);
  return {
    peak: renderedPeak,
    framesProcessed: renderedFramesTotal,
    framesWithSignal: renderedFramesWithSignal,
    firstSignalAtPerformanceTime,
  };
}

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  const playCalledAtPerformanceTime = performance.now();
  adjustCleanupTimer = true;
  try {
    play(cue);
  } finally {
    adjustCleanupTimer = false;
  }

  const signal = await sampleRenderedSignal(cue === "bloom" ? 800 : 1_000);
  const firstStart = sourceStarts[0] ?? null;
  const result = {
    trialId,
    cue,
    scheduleLeadMs: scheduleLeadSeconds * 1000,
    userActivationIsActive: navigator.userActivation?.isActive ?? null,
    userActivationHasBeenActive: navigator.userActivation?.hasBeenActive ?? null,
    contextStateAtCreation,
    contextFinalState: context?.state ?? null,
    baseLatencyMs: typeof context?.baseLatency === "number" ? context.baseLatency * 1000 : null,
    outputLatencyMs: typeof context?.outputLatency === "number" ? context.outputLatency * 1000 : null,
    contextCreationDelayMs: contextCreatedAtPerformanceTime - playCalledAtPerformanceTime,
    schedulingDelayMs: firstStart
      ? firstStart.performanceTimeWhenScheduled - playCalledAtPerformanceTime
      : null,
    sourceLateByMs: firstStart
      ? (firstStart.contextTimeWhenScheduled - firstStart.adjustedWhen) * 1000
      : null,
    firstSignalDelayMs: signal.firstSignalAtPerformanceTime
      ? signal.firstSignalAtPerformanceTime - playCalledAtPerformanceTime
      : null,
    peak: signal.peak,
    framesProcessed: signal.framesProcessed,
    framesWithSignal: signal.framesWithSignal,
    sourceCount: sourceStarts.length,
  };

  window.__experimentResult = result;
  resultElement.textContent = JSON.stringify(result, null, 2);
});
