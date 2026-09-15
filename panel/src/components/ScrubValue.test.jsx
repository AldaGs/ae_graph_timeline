import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ScrubValue from './ScrubValue.jsx';

describe('ScrubValue pointer preview', () => {
  it('previews locally and commits exactly once on release', () => {
    const begin = vi.fn();
    const end = vi.fn();
    const commit = vi.fn();
    render(<ScrubValue value={10} spec={{ step: 1, precision: 0 }} label="Position X"
      onScrubStart={begin} onScrubEnd={end} onCommit={commit} />);

    const input = screen.getByLabelText('Position X');
    fireEvent.pointerDown(input, { button: 0, pointerId: 1, clientX: 20 });
    fireEvent.pointerMove(input, { pointerId: 1, clientX: 25 });
    expect(input.value).toBe('15');
    expect(begin).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();

    fireEvent.pointerMove(input, { pointerId: 1, clientX: 30 });
    fireEvent.pointerUp(input, { pointerId: 1, clientX: 30 });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(20);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
