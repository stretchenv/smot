import * as Config from 'resource:///org/gnome/shell/misc/config.js';

/** GNOME 47+ exposes -st-accent-color; 46 needs theme highlight via JS. */
export const SHELL_MAJOR = (() => {
    const n = parseInt(String(Config.PACKAGE_VERSION || '').split('.')[0], 10);
    return Number.isFinite(n) ? n : 0;
})();
export const USE_THEME_HIGHLIGHT_FILL = SHELL_MAJOR > 0 && SHELL_MAJOR < 47;

export const HIGHLIGHT_COLOR_NAMES = [
    'theme_selected_bg_color',
    'selected_bg_color',
    'accent_bg_color',
];

/** null → fixed fills use stylesheet (-st-accent-color on 47+). */
export let fixedBarFillCss = null;

export function setFixedBarFillCss(css) {
    fixedBarFillCss = css || null;
}

export function colorToBackgroundCss(color) {
    if (!color)
        return null;
    const asBytes = color.red > 1 || color.green > 1 || color.blue > 1 || color.alpha > 1;
    const to8 = v => Math.round(asBytes ? v : v * 255);
    const a = asBytes ? color.alpha / 255 : color.alpha;
    return `background-color: rgba(${to8(color.red)}, ${to8(color.green)}, ${to8(color.blue)}, ${a});`;
}

/** Theme highlight for GNOME 46 fixed bars; null on 47+ (CSS accent). */
export function resolveThemeHighlightFillCss(actor) {
    if (!USE_THEME_HIGHLIGHT_FILL || !actor)
        return null;
    try {
        const node = actor.get_theme_node();
        for (const name of HIGHLIGHT_COLOR_NAMES) {
            const [ok, color] = node.lookup_color(name, true);
            if (ok) {
                const css = colorToBackgroundCss(color);
                if (css)
                    return css;
            }
        }
    } catch {
        // Theme not ready yet
    }
    return 'background-color: #3584e4;';
}

export function fixedBarFillStyle() {
    return fixedBarFillCss;
}

export function colorToCss(fg) {
    if (!fg)
        return null;
    const asBytes = fg.red > 1 || fg.green > 1 || fg.blue > 1 || fg.alpha > 1;
    const to8 = v => Math.round(asBytes ? v : v * 255);
    const a = asBytes ? fg.alpha / 255 : fg.alpha;
    return `color: rgba(${to8(fg.red)}, ${to8(fg.green)}, ${to8(fg.blue)}, ${a});`;
}
