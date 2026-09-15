import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PanelVisibilityControls from './PanelVisibilityControls.jsx';

afterEach(cleanup);

describe('PanelVisibilityControls', () => {
  it('toggles inspector with T and outliner with N', () => {
    const inspector = vi.fn();
    const outliner = vi.fn();
    render(<PanelVisibilityControls inspectorVisible outlinerVisible
      onToggleInspector={inspector} onToggleOutliner={outliner} />);

    fireEvent.keyDown(window, { key: 't' });
    fireEvent.keyDown(window, { key: 'N' });
    expect(inspector).toHaveBeenCalledOnce();
    expect(outliner).toHaveBeenCalledOnce();
  });

  it('does not steal letters while the user is editing', () => {
    const inspector = vi.fn();
    const outliner = vi.fn();
    render(<><input aria-label="Editor" /><PanelVisibilityControls
      inspectorVisible outlinerVisible onToggleInspector={inspector}
      onToggleOutliner={outliner} /></>);

    fireEvent.keyDown(screen.getByLabelText('Editor'), { key: 't' });
    fireEvent.keyDown(screen.getByLabelText('Editor'), { key: 'n' });
    expect(inspector).not.toHaveBeenCalled();
    expect(outliner).not.toHaveBeenCalled();
  });

  it('also exposes small side buttons', () => {
    const inspector = vi.fn();
    const outliner = vi.fn();
    render(<PanelVisibilityControls inspectorVisible={false} outlinerVisible
      onToggleInspector={inspector} onToggleOutliner={outliner} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show inspector (T)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide outliner (N)' }));
    expect(inspector).toHaveBeenCalledOnce();
    expect(outliner).toHaveBeenCalledOnce();
  });
});
