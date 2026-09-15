import { useCallback, useEffect, useRef, useState } from 'react';

import {
  clampCompFrame, parseTransportState, setCurrentFrameCall, transportStateCall,
} from '../../../src/transport.js';

const BROWSER_TRANSPORT = {
  compId: 0,
  frameRate: 24,
  frameDuration: 1 / 24,
  startFrame: 0,
  endFrame: 239,
  workStartFrame: 0,
  workEndFrame: 239,
  currentFrame: 0,
  dropFrame: false,
};

const TRANSPORT_FIELDS = Object.keys(BROWSER_TRANSPORT);

export function useFramePlayback({ host, startup, activeCompRef, onError }) {
  const [transport, setTransport] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);
  const scrubbingRef = useRef(false);
  const transportRef = useRef(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;

  const adopt = useCallback((next) => {
    const previous = transportRef.current;
    if (previous && next
        && TRANSPORT_FIELDS.every((key) => previous[key] === next[key])) return previous;
    transportRef.current = next;
    setTransport(next);
    return next;
  }, []);

  useEffect(() => {
    if (startup.state !== 'ready') {
      setPlaying(false);
      adopt(null);
      return;
    }
    if (!host.connected) adopt(BROWSER_TRANSPORT);
  }, [host.connected, startup.state, adopt]);

  const read = useCallback(async () => {
    if (startup.state !== 'ready' || host.busy) return null;
    if (!host.connected) return transportRef.current || adopt(BROWSER_TRANSPORT);
    const compId = activeCompRef.current?.compId;
    if (compId === null || compId === undefined) return null;
    const next = parseTransportState(await host.evalScript(transportStateCall(compId)));
    // A queued reply from the previous active comp must not replace the new
    // transport state during a comp switch.
    if (activeCompRef.current?.compId !== next.compId || scrubbingRef.current) return null;
    return adopt(next);
  }, [host, startup.state, activeCompRef, adopt]);

  // When stopped, follow CTI changes made directly in After Effects. Playback
  // already receives a frame receipt on every tick, so a second poll then would
  // only add traffic to CEP's serialized host lane.
  useEffect(() => {
    if (startup.state !== 'ready' || playing || scrubbing) return undefined;
    let cancelled = false;
    const inspect = async () => {
      try { if (!cancelled) await read(); }
      catch (e) { if (!cancelled && !host.suspended) errorRef.current?.(e.message); }
    };
    void inspect();
    const handle = window.setInterval(() => void inspect(), 250);
    return () => { cancelled = true; window.clearInterval(handle); };
  }, [host, startup.state, playing, scrubbing, read]);

  const seek = useCallback(async (frame) => {
    const current = transportRef.current;
    if (!current) return null;
    const target = clampCompFrame(frame, current);
    if (!host.connected) return adopt({ ...current, currentFrame: target });
    if (host.busy) return null;
    const compId = activeCompRef.current?.compId;
    if (compId === null || compId === undefined) return null;
    const next = parseTransportState(
      await host.evalScript(setCurrentFrameCall(compId, target)),
    );
    if (activeCompRef.current?.compId !== next.compId) return null;
    return adopt(next);
  }, [host, activeCompRef, adopt]);

  // Pointer moves can arrive much faster than evalScript replies. Reflect the
  // newest integer frame locally at pointer speed, while sending at most one
  // host request at a time and replacing any queued intermediate frame with
  // the latest one. The final pointer position is therefore never lost.
  const scrubQueueRef = useRef({ running: false, pending: null });
  const scrubFrame = useCallback((frame) => {
    const current = transportRef.current;
    if (!current || host.busy) return;
    setPlaying(false);
    const target = clampCompFrame(frame, current);
    adopt({ ...current, currentFrame: target });
    if (!host.connected) return;

    const queue = scrubQueueRef.current;
    queue.pending = target;
    if (queue.running) return;
    queue.running = true;
    void (async () => {
      try {
        while (queue.pending !== null) {
          const nextFrame = queue.pending;
          queue.pending = null;
          const compId = activeCompRef.current?.compId;
          if (compId === null || compId === undefined) break;
          const receipt = parseTransportState(
            await host.evalScript(setCurrentFrameCall(compId, nextFrame)),
          );
          if (activeCompRef.current?.compId !== receipt.compId) break;
          // Do not let an old receipt pull the visible playhead backwards while
          // a newer pointer position is waiting to be sent.
          if (queue.pending === null) adopt(receipt);
        }
      } catch (e) {
        errorRef.current?.(e.message);
      } finally {
        queue.running = false;
      }
    })();
  }, [host, activeCompRef, adopt]);

  useEffect(() => {
    if (!playing || !transport) return undefined;
    let cancelled = false;
    let timer = null;
    const rangeLength = transport.workEndFrame - transport.workStartFrame + 1;
    const frameMs = 1000 / transport.frameRate;
    const originFrame = transport.currentFrame >= transport.workEndFrame
      ? transport.workStartFrame - 1 : transport.currentFrame;
    const epoch = performance.now();

    const tick = async () => {
      if (cancelled) return;
      const elapsedFrames = Math.max(1, Math.floor((performance.now() - epoch) / frameMs));
      const ordinal = originFrame - transport.workStartFrame + elapsedFrames;
      let target = transport.workStartFrame + ordinal;
      if (target > transport.workEndFrame) {
        if (!loop) {
          try { await seek(transport.workEndFrame); }
          catch (e) { errorRef.current?.(e.message); }
          if (!cancelled) setPlaying(false);
          return;
        }
        target = transport.workStartFrame + (((ordinal % rangeLength) + rangeLength) % rangeLength);
      }
      try {
        await seek(target);
      } catch (e) {
        errorRef.current?.(e.message);
        if (!cancelled) setPlaying(false);
        return;
      }
      if (cancelled) return;
      const elapsed = performance.now() - epoch;
      const delay = Math.max(1, frameMs - (elapsed % frameMs));
      timer = window.setTimeout(() => void tick(), delay);
    };

    timer = window.setTimeout(() => void tick(), frameMs);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [playing, transport?.compId, transport?.frameRate, transport?.workStartFrame,
      transport?.workEndFrame, loop, seek]);

  const stopAndSeek = useCallback((frame) => {
    setPlaying(false);
    return seek(frame).catch((e) => errorRef.current?.(e.message));
  }, [seek]);

  const togglePlaying = useCallback(() => setPlaying((value) => !value), []);
  const toggleLoop = useCallback(() => setLoop((value) => !value), []);
  const beginScrub = useCallback(() => {
    scrubbingRef.current = true;
    setScrubbing(true);
    setPlaying(false);
  }, []);
  const endScrub = useCallback(() => {
    scrubbingRef.current = false;
    setScrubbing(false);
  }, []);

  return {
    transport,
    playing,
    loop,
    enabled: startup.state === 'ready' && Boolean(transport) && !host.busy,
    togglePlaying,
    toggleLoop,
    seek: stopAndSeek,
    scrubFrame,
    beginScrub,
    endScrub,
    first: () => stopAndSeek(transportRef.current?.workStartFrame),
    previous: () => stopAndSeek((transportRef.current?.currentFrame ?? 0) - 1),
    next: () => stopAndSeek((transportRef.current?.currentFrame ?? 0) + 1),
    last: () => stopAndSeek(transportRef.current?.workEndFrame),
  };
}
