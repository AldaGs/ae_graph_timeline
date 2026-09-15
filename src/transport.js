// Frame-based transport calls shared by the CEP panel and the offline tests.
//
// After Effects stores the CTI in seconds, but the panel never exposes or
// accumulates those seconds.  Every public value here is an integer frame and
// the host converts it through the active comp's own frameDuration.

const STATE_FN = 'NTL_TransportState';
const SET_FRAME_FN = 'NTL_SetCurrentFrame';

export class TransportError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'TransportError';
    this.detail = detail ?? null;
  }
}

export const transportStateCall = (compId) => `${STATE_FN}(${compId ?? 'null'})`;

export const setCurrentFrameCall = (compId, frame) =>
  `${SET_FRAME_FN}(${compId ?? 'null'}, ${Math.round(Number(frame))})`;

export function parseTransportState(jsonText) {
  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    throw new TransportError(`transport did not return JSON: "${String(jsonText).slice(0, 120)}"`);
  }
  if (payload?.ok !== true) {
    throw new TransportError(payload?.message || 'transport returned an invalid result', payload);
  }

  const numeric = ['compId', 'frameRate', 'frameDuration', 'startFrame', 'endFrame',
    'workStartFrame', 'workEndFrame', 'currentFrame'];
  if (numeric.some((key) => !Number.isFinite(payload[key]))) {
    throw new TransportError('transport returned incomplete frame settings', payload);
  }
  if (payload.frameRate <= 0 || payload.frameDuration <= 0
      || payload.endFrame < payload.startFrame
      || payload.workEndFrame < payload.workStartFrame) {
    throw new TransportError('transport returned invalid frame settings', payload);
  }

  return {
    compId: payload.compId,
    frameRate: payload.frameRate,
    frameDuration: payload.frameDuration,
    startFrame: Math.round(payload.startFrame),
    endFrame: Math.round(payload.endFrame),
    workStartFrame: Math.round(payload.workStartFrame),
    workEndFrame: Math.round(payload.workEndFrame),
    currentFrame: Math.round(payload.currentFrame),
    dropFrame: payload.dropFrame === true,
  };
}

export const clampFrame = (frame, transport) => Math.min(transport.workEndFrame,
  Math.max(transport.workStartFrame, Math.round(Number(frame))));

export const clampCompFrame = (frame, transport) => Math.min(transport.endFrame,
  Math.max(transport.startFrame, Math.round(Number(frame))));
