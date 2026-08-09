/**
 * Minimal ambient types for opentype.js, which ships none of its own. Only the
 * handful of members textVectorizer.ts touches are declared here.
 */

declare module 'opentype.js' {
  export interface OTPath {
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
