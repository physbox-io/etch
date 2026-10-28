import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/App';
import { useStore } from '../src/store/useStore';
import type { EtchDocument, EtchElement } from '../src/types/etch';

window.matchMedia = ((q: string) => ({
  matches: false,
  media: q,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
})) as never;
(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> = [];

function mountApp() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(React.createElement(App));
  });
  mounted.push({ host, root });
}

describe('tool shortcuts', () => {
  beforeEach(() => {
    const doc = useStore.getState().document;
    useStore.setState({
      document: {
        ...doc,
        elements: [
          {
            id: 'r1',
            name: 'r1',
            type: 'rect',
            layerId: 'cut',
            x: 10,
            y: 10,
            w: 20,
            h: 20,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
            strokeWidth: 0.5,
            visible: true,
            locked: false,
          } as EtchElement,
        ],
      } as EtchDocument,
      activeTool: 'select',
      selectedIds: [],
    });
    mountApp();
  });

  afterEach(() => {
    while (mounted.length > 0) {
      const { host, root } = mounted.pop()!;
      act(() => root.unmount());
      host.remove();
    }
  });

  it('switches tool modes on single key presses without modifiers', () => {
    expect(useStore.getState().activeTool).toBe('select');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    });
    expect(useStore.getState().activeTool).toBe('rect');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    });
    expect(useStore.getState().activeTool).toBe('circle');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }));
    });
    expect(useStore.getState().activeTool).toBe('line');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    });
    expect(useStore.getState().activeTool).toBe('bezier');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
    });
    expect(useStore.getState().activeTool).toBe('text');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    });
    expect(useStore.getState().activeTool).toBe('erase');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    });
    expect(useStore.getState().activeTool).toBe('node-edit');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true }));
    });
    expect(useStore.getState().activeTool).toBe('select');
  });

  it('switches to select tool via V even when an element is selected if activeTool is not select', () => {
    useStore.setState({ activeTool: 'rect', selectedIds: ['r1'] });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true }));
    });
    expect(useStore.getState().activeTool).toBe('select');
  });

  it('ignores shortcuts when typing in an input element', () => {
    useStore.setState({ activeTool: 'select' });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    });
    expect(useStore.getState().activeTool).toBe('select');
    input.remove();
  });
});

