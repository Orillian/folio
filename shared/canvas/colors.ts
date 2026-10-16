/**
 * JSON Canvas colours. The spec names six presets ("1" red, "2" orange, "3"
 * yellow, "4" green, "5" cyan, "6" purple) and leaves their values to the app;
 * Folio uses Obsidian's own defaults (`--canvas-color-N` = `--color-<name>`,
 * obsidian-developer-docs Reference/CSS variables/Foundations/Colors.md), so a
 * vault looks the same in both. A hex colour is used as written.
 */
export type CanvasColorScheme = 'light' | 'dark';

export const CANVAS_PRESET_COLORS: Record<CanvasColorScheme, Record<string, string>> = {
  light: { '1': '#e93147', '2': '#ec7500', '3': '#e0ac00', '4': '#08b94e', '5': '#00bfbc', '6': '#7852ee' },
  dark: { '1': '#fb464c', '2': '#e9973f', '3': '#e0de71', '4': '#44cf6e', '5': '#53dfdd', '6': '#a882ff' },
};

/** Preset names, for the outline and the conversion report. */
export const CANVAS_PRESET_NAMES: Record<string, string> = { '1': 'red', '2': 'orange', '3': 'yellow', '4': 'green', '5': 'cyan', '6': 'purple' };

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The CSS colour of a canvas `color` in this scheme; undefined = the default (no colour). */
export function resolveCanvasColor(color: string | undefined, scheme: CanvasColorScheme): string | undefined {
  if (!color) return undefined;
  const preset = CANVAS_PRESET_COLORS[scheme][color];
  if (preset) return preset;
  return HEX_RE.test(color) ? color : undefined;
}

/** `#abc` / `#aabbcc` / `#aabbccdd` -> `#aabbcc` (alpha dropped), for places that need six digits (the board conversion). */
export function normalizeHex(color: string): string | undefined {
  if (!HEX_RE.test(color)) return undefined;
  const hex = color.slice(1);
  if (hex.length === 3 || hex.length === 4) return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toLowerCase();
  return `#${hex.slice(0, 6)}`.toLowerCase();
}

/** `color` mixed with white (amount 0..1 of the colour) — a light card fill on a white board. */
export function tintHex(color: string, amount: number): string | undefined {
  const hex = normalizeHex(color);
  if (!hex) return undefined;
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
    return Math.round(255 - (255 - c) * amount)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}
