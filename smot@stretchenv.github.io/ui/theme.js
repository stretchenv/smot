import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';

/** GNOME 47+ exposes -st-accent-color; 46 uses theme highlight via JS. */
export const SHELL_MAJOR = (() => {
    const n = parseInt(String(Config.PACKAGE_VERSION || '').split('.')[0], 10);
    return Number.isFinite(n) ? n : 0;
})();
export const USE_THEME_HIGHLIGHT_FILL = SHELL_MAJOR > 0 && SHELL_MAJOR < 47;

/** null → fixed fills use stylesheet (-st-accent-color on 47+). */
export let fixedBarFillCss = null;

export function setFixedBarFillCss(css) {
    fixedBarFillCss = css || null;
}

function colorChannelsAreBytes(color) {
    return color.red > 1 || color.green > 1 || color.blue > 1 || color.alpha > 1;
}

function rgb8(color) {
    const asBytes = colorChannelsAreBytes(color);
    const to8 = v => Math.round(asBytes ? v : v * 255);
    return {
        r: to8(color.red),
        g: to8(color.green),
        b: to8(color.blue),
        a: asBytes ? color.alpha / 255 : color.alpha,
    };
}

/**
 * Theme highlight only (selected/accent fill). Rejects transparent overlays
 * and charcoal chrome (switch trough, slider fg on some themes).
 */
function highlightFillCssFromColor(color) {
    if (!color)
        return null;
    const {r, g, b, a} = rgb8(color);
    if (a < 0.35)
        return null;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 50)
        return null;
    if ((max - min) < 25 && max < 100)
        return null;
    return `background-color: rgba(${r}, ${g}, ${b}, ${a});`;
}

export function colorToBackgroundCss(color) {
    return highlightFillCssFromColor(color);
}

function lookupPropertyColorCss(node, property) {
    if (!node || !property)
        return null;
    try {
        const result = node.lookup_color(property, true);
        if (Array.isArray(result)) {
            const [ok, color] = result;
            if (ok)
                return highlightFillCssFromColor(color);
        }
    } catch {
        // Property missing, or this Shell's lookup_color binding differs.
    }
    return null;
}

function withStagedProbe(actor, widget, use) {
    actor.add_child(widget);
    try {
        widget.ensure_style?.();
        return use(widget);
    } finally {
        if (widget.get_parent())
            actor.remove_child(widget);
        widget.destroy();
    }
}

/**
 * GNOME 46 fixed bars: Shell highlight ($selected_bg_color), not accent
 * (-st-accent-color is 47+) and not generic widget chrome.
 */
export function resolveThemeHighlightFillCss(actor) {
    if (!USE_THEME_HIGHLIGHT_FILL || !actor?.get_stage?.())
        return null;

    try {
        const slider = new St.Widget({
            style_class: 'slider',
            width: 8,
            height: 8,
        });
        const css = withStagedProbe(actor, slider, probe =>
            lookupPropertyColorCss(
                probe.get_theme_node(), '-barlevel-active-background-color'));
        if (css)
            return css;
    } catch {
        // No slider metrics on this theme.
    }

    try {
        const box = new St.Widget({style_class: 'check-box'});
        box.add_style_pseudo_class('checked');
        const icon = new St.Icon({
            icon_name: 'checkbox-checked-symbolic',
            icon_size: 16,
        });
        box.add_child(icon);
        const css = withStagedProbe(actor, box, () => {
            icon.ensure_style?.();
            return highlightFillCssFromColor(
                icon.get_theme_node().get_background_color());
        });
        if (css)
            return css;
    } catch {
        // Checkbox style not present.
    }

    try {
        const entry = new St.Entry({
            can_focus: false,
            width: 1,
            height: 1,
        });
        const css = withStagedProbe(actor, entry, probe =>
            lookupPropertyColorCss(
                probe.get_theme_node(), 'selection-background-color'));
        if (css)
            return css;
    } catch {
        // St.Entry not styled yet.
    }

    return null;
}

/** Resolve and cache 46 highlight CSS; no-op on 47+ (stylesheet accent). */
export function ensureFixedBarFillCss(actor) {
    if (!USE_THEME_HIGHLIGHT_FILL)
        return null;
    if (fixedBarFillCss)
        return fixedBarFillCss;
    const css = resolveThemeHighlightFillCss(actor);
    if (css)
        setFixedBarFillCss(css);
    return css;
}

export function fixedBarFillStyle() {
    return fixedBarFillCss;
}

export function colorToCss(fg) {
    if (!fg)
        return null;
    const asBytes = colorChannelsAreBytes(fg);
    const to8 = v => Math.round(asBytes ? v : v * 255);
    const a = asBytes ? fg.alpha / 255 : fg.alpha;
    return `color: rgba(${to8(fg.red)}, ${to8(fg.green)}, ${to8(fg.blue)}, ${a});`;
}
