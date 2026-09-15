import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useFramePlayback } from './useFramePlayback.js';

const state = (currentFrame = 0) => JSON.stringify({
  ok: true,
  compId: 1,
  frameRate: 24,
  frameDuration: 1 / 24,
  startFrame: 0,
  endFrame: 239,
  workStartFrame: 0,
  workEndFrame: 239,
  currentFrame,
  dropFrame: false,
});

describe('useFramePlayback scrubbing', () => {
  it('shows every pointer frame locally but coalesces host requests to the latest frame', async () => {
    const requests = [];
    let hostFrame = 0;
    const host = {
      connected: true,
      busy: false,
      suspended: false,
      evalScript: vi.fn((source) => {
        if (source.startsWith('NTL_TransportState')) return Promise.resolve(state(hostFrame));
        const frame = Number(source.match(/,\s*(-?\d+)\)/)?.[1]);
        return new Promise((resolve) => requests.push({
          frame,
          resolve: () => {
            hostFrame = frame;
            resolve(state(frame));
          },
        }));
      }),
    };
    const activeCompRef = { current: { compId: 1, compName: 'Shot' } };
    const { result, unmount } = renderHook(() => useFramePlayback({
      host,
      startup: { state: 'ready' },
      activeCompRef,
      onError: vi.fn(),
    }));
    await waitFor(() => expect(result.current.transport?.currentFrame).toBe(0));

    act(() => {
      result.current.beginScrub();
      result.current.scrubFrame(10);
      result.current.scrubFrame(20);
      result.current.scrubFrame(30);
    });
    expect(result.current.transport.currentFrame).toBe(30);
    expect(requests.map((request) => request.frame)).toEqual([10]);

    await act(async () => {
      requests[0].resolve();
      await Promise.resolve();
    });
    expect(requests.map((request) => request.frame)).toEqual([10, 30]);
    expect(result.current.transport.currentFrame).toBe(30);

    await act(async () => {
      requests[1].resolve();
      result.current.endScrub();
      await Promise.resolve();
    });
    expect(result.current.transport.currentFrame).toBe(30);
    unmount();
  });
});
