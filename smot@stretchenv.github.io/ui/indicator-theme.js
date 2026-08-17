import {
    USE_THEME_HIGHLIGHT_FILL,
    colorToCss,
    ensureFixedBarFillCss,
    fixedBarFillCss,
    setFixedBarFillCss,
} from './theme.js';
import {USAGE_BAR_FIXED} from './constants.js';

/** Popup foreground + fixed usage-bar accent sync. */
export const IndicatorTheme = {
    _syncPopupFg() {
        let fg = null;
        const chrome = (this._dockOpen && this._dock) ? this._dock : this.menu?.box;
        try {
            if (!chrome?.get_stage?.())
                return;
            fg = chrome.get_theme_node().get_foreground_color();
        } catch (_e) {
            try {
                if (!this.menu?.actor?.get_stage?.())
                    return;
                fg = this.menu.actor.get_theme_node().get_foreground_color();
            } catch (_e2) {
                return;
            }
        }
        const css = colorToCss(fg);
        if (!css)
            return;
        this._cpuSection?.applyFg(css);
        this._memSection?.applyFg(css);
        this._diskSection?.applyFg(css);
        this._netSection?.applyFg(css);
        for (const row of this._diskWarnRows || []) {
            row.device?.set_style(css);
            row.message?.set_style(css);
        }
        for (const card of this._gpuCards || [])
            card.section?.applyFg(css);
        for (const card of this._npuCards || [])
            card.section?.applyFg(css);
        this._tempSection?.applyFg(css);
    },

    /**
     * GNOME 46: paint fixed usage fills from theme highlight.
     * GNOME 47+: leave fills unstyled so -st-accent-color applies.
     */
    _syncFixedBarFill() {
        if (!USE_THEME_HIGHLIGHT_FILL) {
            if (fixedBarFillCss === null)
                return;
            setFixedBarFillCss(null);
            this._refreshFixedBarFills();
            return;
        }
        const source = (this._dockOpen && this._dock)
            ? this._dock
            : this.menu?.box;
        if (!source?.get_stage?.())
            return;
        const prev = fixedBarFillCss;
        ensureFixedBarFillCss(source);
        if (fixedBarFillCss === prev)
            return;
        this._refreshFixedBarFills();
    },

    _refreshFixedBarFills() {
        if (this._usageBarAppearance !== USAGE_BAR_FIXED)
            return;
        this._overallCpuRow?.refreshFillStyle?.();
        this._memUsedRow?.refreshFillStyle?.();
        this._histogramChart?.refreshFillStyle?.();
        for (const row of this._coreRows || [])
            row.refreshFillStyle?.();
        for (const card of this._gpuCards || []) {
            card.util?.refreshFillStyle?.();
            card.vram?.refreshFillStyle?.();
        }
        for (const card of this._npuCards || [])
            card.util?.refreshFillStyle?.();
    },

    _applyUsageBarAppearance() {
        const mode = this._usageBarAppearance;
        this._overallCpuRow?.setAppearance(mode);
        this._memUsedRow?.setAppearance(mode);
        this._histogramChart?.setAppearance(mode);
        for (const row of this._coreRows || [])
            row.setAppearance(mode);
        for (const card of this._gpuCards || []) {
            card.util?.setAppearance(mode);
            card.vram?.setAppearance(mode);
        }
        for (const card of this._npuCards || [])
            card.util?.setAppearance(mode);
    },
};
