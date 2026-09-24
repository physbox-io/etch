import { describe, it, expect } from 'vitest';
import { numberedName } from '../src/store/useStore';

const els = (...names: string[]) => names.map((name) => ({ name }));

describe('numberedName', () => {
  it('leaves the first of a kind with its bare name', () => {
    expect(numberedName('Circle', els('Rectangle'))).toBe('Circle');
  });

  it('numbers the second and later ones', () => {
    expect(numberedName('Circle', els('Circle'))).toBe('Circle 2');
    expect(numberedName('Circle', els('Circle', 'Circle 2'))).toBe('Circle 3');
  });

  it('goes past the highest number rather than filling a gap', () => {
    expect(numberedName('Circle', els('Circle', 'Circle 3'))).toBe('Circle 4');
  });

  it('is not fooled by names that merely start the same', () => {
    expect(numberedName('Circle', els('Circle Copy', 'Circles'))).toBe('Circle');
  });

  it('treats regex characters in a name literally', () => {
    expect(numberedName('a+b (1)', els('a+b (1)'))).toBe('a+b (1) 2');
  });
});
