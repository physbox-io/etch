/**
 * Minimal ambient types for opentype.js, which ships none of its own. Only the
 * handful of members textVectorizer.ts touches are declared here.
 */

declare module 'opentype.js' {
  /**
   * One drawing command of a glyph outline. opentype.js emits the SVG path
   * commands, and the coordinates a command carries depend on which it is —
   * hence the optional numbers rather than six required ones.
   */
  export interface OTPathCommand {
    type: 'M' | 'L' | 'C' | 'Q' | 'Z' | 'z';
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }
  export interface OTPath {
    commands: OTPathCommand[];
    toPathData(decimals?: number): string;
  }
  export interface OTGlyph {
    advanceWidth: number;
    getPath(x: number, y: number, fontSize: number): OTPath;
  }
  export interface OTFont {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    getPath(text: string, x: number, y: number, fontSize: number, options?: object): OTPath;
    getAdvanceWidth(text: string, fontSize: number, options?: object): number;
    charToGlyph(char: string): OTGlyph;
    getKerningValue?(left: OTGlyph, right: OTGlyph): number;
  }
  export function parse(buffer: ArrayBuffer): OTFont;
}
