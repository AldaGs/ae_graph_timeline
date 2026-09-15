import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PlaybackBar from './PlaybackBar.jsx';

afterEach(cleanup);

const makePlayback = (over = {}) => ({
  transport: {
    compId: 1,
    currentFrame: 12,
    startFrame: 0,
    endFrame: 239,
    workStartFrame: 4,
    workEndFrame: 120,
    frameRate: 23.976,
    dropFrame: false,
  },
  enabled: true,
  playing: false,
  loop: true,
  togglePlaying: vi.fn(),
  toggleLoop: vi.fn(),
  seek: vi.fn(),
  scrubFrame: vi.fn(),
  beginScrub: vi.fn(),
  endScrub: vi.fn(),
  first: vi.fn(),
  previous: vi.fn(),
  next: vi.fn(),
  last: vi.fn(),
  ...over,
});

describe('PlaybackBar', () => {
  it('uses Space for play/pause without stealing it from a frame field', () => {
    const playback = makePlayback();
    render(<PlaybackBar playback={playback} />);

    fireEvent.keyDown(window, { code: 'Space' });
    expect(playback.togglePlaying).toHaveBeenCalledOnce();

    fireEvent.keyDown(screen.getByLabelText('Current frame'), { code: 'Space' });
    expect(playback.togglePlaying).toHaveBeenCalledOnce();
  });

  it('shows AE work-area and rate settings and commits integer frame seeks', () => {
    const playback = makePlayback();
    render(<PlaybackBar playback={playback} />);
    expect(screen.getByText(/4–120/)).toBeTruthy();
    expect(screen.getByText('23.976 fps')).toBeTruthy();

    const field = screen.getByLabelText('Current frame');
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '42' } });
    fireEvent.blur(field);
    expect(playback.seek).toHaveBeenCalledWith(42);
  });

  it('positions the playhead from the CTI and scrubs to integer frames', () => {
    const playback = makePlayback();
    render(<PlaybackBar playback={playback} />);
    const ruler = screen.getByRole('slider', { name: 'Composition playhead' });
    expect(ruler.getAttribute('aria-valuenow')).toBe('12');
    Object.defineProperty(ruler, 'getBoundingClientRect', {
      value: () => ({ left: 10, width: 262, right: 272, top: 0, bottom: 25, height: 25 }),
    });

    // The usable track is 240 px after its two 11 px playhead insets. Halfway
    // through frames 0..239 rounds to frame 120.
    fireEvent.pointerDown(ruler, { clientX: 141, pointerId: 1 });
    expect(playback.beginScrub).toHaveBeenCalledOnce();
    expect(playback.scrubFrame).toHaveBeenCalledWith(120);
    fireEvent.pointerUp(ruler, { clientX: 141, pointerId: 1 });
    expect(playback.endScrub).toHaveBeenCalledOnce();
  });
});
