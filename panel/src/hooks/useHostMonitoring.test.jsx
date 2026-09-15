import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useHostMonitoring } from './useHostMonitoring.js';

describe('useHostMonitoring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('closes the old write lane and scans a newly active comp automatically', async () => {
    const close = vi.fn(async () => {});
    const poll = vi.fn(async () => ({ status: 'clean' }));
    const host = {
      connected: true,
      busy: false,
      suspended: false,
      evalScript: vi.fn(async (source) => {
        if (source === 'NTL_ActiveComp(1)') {
          return JSON.stringify({ ok: true, active: true, compId: 2,
            compName: 'Comp B', projectPath: 'C:/shot.aep' });
        }
        throw new Error(`unexpected host call: ${source}`);
      }),
      onSuspendChange: vi.fn(() => () => {}),
    };
    const loopRef = { current: { state: { inFlight: false, gestureDepth: 0 }, close, poll } };
    const activeCompRef = { current: { compId: 1, compName: 'Comp A' } };
    const loopEventsRef = { current: vi.fn() };
    const inspectRef = { current: vi.fn(async () => {}) };
    const setStartup = vi.fn();
    const setLink = vi.fn();

    const { unmount } = renderHook(() => useHostMonitoring({
      host,
      startup: { state: 'ready' },
      loopRef,
      activeCompRef,
      loopEventsRef,
      inspectRef,
      setLink,
      setSelected: vi.fn(),
      setContextMenu: vi.fn(),
      setStartup,
      storageRef: { current: { identity: { projectPath: 'C:/shot.aep' } } },
    }));

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(close).toHaveBeenCalledOnce();
    expect(loopRef.current).toBeNull();
    expect(activeCompRef.current).toBeNull();
    expect(setStartup).toHaveBeenCalledWith(expect.objectContaining({
      state: 'loading', detail: expect.stringContaining('Scanning the new comp'),
    }));
    expect(setLink).toHaveBeenCalledWith({ state: 'reading', detail: 'Scanning “Comp B”…' });
    expect(inspectRef.current).toHaveBeenCalledOnce();

    unmount();
  });

  it('keeps a missing comp read-only and schedules the existing recovery scan', async () => {
    const inspect = vi.fn(async () => {});
    const host = {
      connected: true, busy: false, suspended: false,
      evalScript: vi.fn(async () => JSON.stringify({ ok: true, active: false, projectPath: 'C:/shot.aep' })),
      onSuspendChange: vi.fn(() => () => {}),
    };
    const loopRef = { current: { state: { inFlight: false, gestureDepth: 0 },
      close: vi.fn(async () => {}), poll: vi.fn(async () => ({ status: 'clean' })) } };
    const setStartup = vi.fn();
    const activeCompRef = { current: { compId: 1, compName: 'Comp A' } };
    const { unmount } = renderHook(() => useHostMonitoring({
      host, startup: { state: 'ready' }, loopRef, activeCompRef,
      loopEventsRef: { current: vi.fn() }, inspectRef: { current: inspect },
      setLink: vi.fn(), setSelected: vi.fn(), setContextMenu: vi.fn(), setStartup,
      storageRef: { current: { identity: { projectPath: 'C:/shot.aep' } } },
    }));

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(setStartup).toHaveBeenCalledWith(expect.objectContaining({ state: 'no-comp' }));
    expect(inspect).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(inspect).toHaveBeenCalledOnce();

    unmount();
  });

  it('keeps the write lane while footage is active in the Project panel', async () => {
    const close = vi.fn(async () => {});
    const host = {
      connected: true, busy: false, suspended: false,
      evalScript: vi.fn(async () => JSON.stringify({
        ok: true, active: false, retainedComp: true, projectItemActive: true,
        projectPath: 'C:/shot.aep',
      })),
      onSuspendChange: vi.fn(() => () => {}),
    };
    const loop = { state: { inFlight: false, gestureDepth: 0 }, close,
      poll: vi.fn(async () => ({ status: 'clean' })) };
    const loopRef = { current: loop };
    const activeCompRef = { current: { compId: 1, compName: 'Comp A' } };
    const setStartup = vi.fn();
    const { unmount } = renderHook(() => useHostMonitoring({
      host, startup: { state: 'ready' }, loopRef, activeCompRef,
      loopEventsRef: { current: vi.fn() }, inspectRef: { current: vi.fn() },
      setLink: vi.fn(), setSelected: vi.fn(), setContextMenu: vi.fn(), setStartup,
      storageRef: { current: { identity: { projectPath: 'C:/shot.aep' } } },
    }));

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(close).not.toHaveBeenCalled();
    expect(loopRef.current).toBe(loop);
    expect(activeCompRef.current?.compId).toBe(1);
    expect(setStartup).not.toHaveBeenCalled();
    unmount();
  });
});
