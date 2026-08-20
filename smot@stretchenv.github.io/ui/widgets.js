import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import {formatPercent, formatRateBytes} from '../stats.js';
import {
    HIST_TRACK_HEIGHT,
    HISTOGRAM_BUCKETS,
    USAGE_BAR_FIXED,
    USAGE_BAR_GRADED,
    gradedUsageCss,
    normalizeUsageBarAppearance,
} from './constants.js';
import {ensureFixedBarFillCss, fixedBarFillStyle} from './theme.js';

const SHELL_MAJOR = Number.parseInt(Config.PACKAGE_VERSION, 10);

/**
 * St.BoxLayout: GNOME 46–47 expose `vertical`; 48+ use `orientation`.
 * Do not pass either in the constructor — 46 throws on `orientation`.
 */
/** True when actor is on stage and Clutter has assigned an allocation box. */
export function actorHasAllocation(actor) {
    if (!actor?.get_stage?.())
        return false;
    return !!actor.get_allocation_box?.();
}

/** True when actor is on stage with a non-zero allocation box. */
export function actorHasNonZeroAllocation(actor) {
    if (!actorHasAllocation(actor))
        return false;
    const box = actor.get_allocation_box();
    return box.get_width() > 0 && box.get_height() > 0;
}

export function setBoxVertical(box, vertical) {
    if (!box)
        return;
    if (SHELL_MAJOR >= 48) {
        box.orientation = vertical
            ? Clutter.Orientation.VERTICAL
            : Clutter.Orientation.HORIZONTAL;
    } else {
        box.vertical = !!vertical;
    }
}

export function loadExtensionIcon(extension, relativePath) {
    const file = extension.dir.resolve_relative_path(relativePath);
    return new Gio.FileIcon({file});
}

/** One IO metric tile: rate centered above caption. */
export function makeIoRateColumn(caption) {
    const tile = new St.BoxLayout({
        style_class: 'smot-io-tile',
        x_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.CENTER,
    });
    setBoxVertical(tile, true);

    const rate = new St.Label({
        text: formatRateBytes(null),
        style_class: 'smot-io-rate',
        x_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.CENTER,
    });
    rate.clutter_text.x_align = Clutter.ActorAlign.CENTER;
    rate.clutter_text.ellipsize = Pango.EllipsizeMode.END;

    const label = new St.Label({
        text: caption,
        style_class: 'smot-io-caption',
        x_expand: true,
        x_align: Clutter.ActorAlign.FILL,
    });
    label.clutter_text.x_align = Clutter.ActorAlign.CENTER;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

    tile.add_child(rate);
    tile.add_child(label);

    return {col: tile, rate, label};
}

/** Two equal metric tiles for a Disk/Network card. */
export function makeIoRateRow(captionA, captionB) {
    const row = new St.BoxLayout({
        style_class: 'smot-io-row',
        x_expand: true,
    });
    const a = makeIoRateColumn(captionA);
    const b = makeIoRateColumn(captionB);
    row.add_child(a.col);
    row.add_child(b.col);
    return {
        row,
        primary: a.rate,
        secondary: b.rate,
    };
}

export function setIoRateLabel(rateLabel, bytesPerSec) {
    const text = formatRateBytes(bytesPerSec);
    if (rateLabel.text !== text)
        rateLabel.text = text;
}

/** "2 of 3" when a proper subset is monitored; empty when all (or none present). */
export function formatIoFilterBadge(info) {
    if (!info || info.total == null || info.used == null)
        return '';
    const used = Math.max(0, Math.round(Number(info.used) || 0));
    const total = Math.max(0, Math.round(Number(info.total) || 0));
    if (total <= 0 || used >= total)
        return '';
    return `${used} of ${total}`;
}

/** Nested SMART warning tile inside the Disk card. */
export function makeSmartWarningCard() {
    const box = new St.BoxLayout({
        style_class: 'smot-disk-warn',
        x_expand: true,
        visible: false,
    });
    // St often ignores CSS border-left; paint a strip instead.
    const accent = new St.Widget({
        style_class: 'smot-disk-warn-accent',
        y_expand: true,
        x_expand: false,
    });
    const body = new St.BoxLayout({
        style_class: 'smot-disk-warn-body',
        x_expand: true,
        y_expand: true,
    });
    setBoxVertical(body, true);
    const title = new St.BoxLayout({
        style_class: 'smot-disk-warn-title',
        x_expand: true,
    });
    const icon = new St.Icon({
        icon_name: 'dialog-warning-symbolic',
        style_class: 'smot-disk-warn-icon',
        y_align: Clutter.ActorAlign.CENTER,
    });
    const device = new St.Label({
        text: '',
        style_class: 'smot-disk-warn-device',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    device.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    title.add_child(icon);
    title.add_child(device);
    const message = new St.Label({
        text: '',
        style_class: 'smot-disk-warn-msg',
        x_expand: true,
    });
    message.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    message.clutter_text.line_wrap = true;
    body.add_child(title);
    body.add_child(message);
    box.add_child(accent);
    box.add_child(body);
    return {box, device, message, warningId: ''};
}

/**
 * Bar track whose preferred width ignores the fill child.
 * Otherwise fill.width (== usage) inflates MeterRow preferred width and dual
 * columns reflow whenever core values differ/change — even 3%→7%.
 */
export const MeterBarTrack = GObject.registerClass(
class SmotMeterBarTrack extends St.Widget {
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }
});

export const MeterRow = GObject.registerClass(
class SmotMeterRow extends St.BoxLayout {
    /**
     * @param {string} labelText
     * @param {{valueProbe?: string, labelProbe?: string}} [params]
     *   valueProbe sizes the right-hand slot (default '100%'). Use a wider
     *   probe for absolute values (e.g. FORMAT_BYTES_VALUE_PROBE). labelProbe locks the left
     *   label to that width so stacked bars (Usage / VRAM) share one length.
     */
    _init(labelText, params = {}) {
        super._init({
            style_class: 'smot-row',
            x_expand: true,
            reactive: false,
        });

        this._valueProbe = params.valueProbe || '100%';
        this._labelProbe = params.labelProbe || '';
        this._lastValueText = null;

        this._label = new St.Label({
            text: labelText,
            style_class: 'smot-row-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: false,
        });
        this.add_child(this._label);

        this._track = new MeterBarTrack({
            style_class: 'smot-bar-track',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: false,
        });
        this._fill = new St.Widget({
            style_class: 'smot-bar-fill',
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            width: 0,
        });
        this._track.add_child(this._fill);
        this.add_child(this._track);

        // Value lives in a width-locked box. St.BoxLayout ignores actor.width for
        // preferred-size when label text changes (5% vs 100%), which reflows
        // dual core columns — lock via inline min/width px instead.
        this._value = new St.Label({
            text: this._valueProbe,
            style_class: 'smot-row-value',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._value.clutter_text.x_align = Clutter.ActorAlign.END;
        this._value.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._valueBox = new St.Widget({
            style_class: 'smot-row-value-box',
            layout_manager: new Clutter.BinLayout(),
            x_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._valueBox.add_child(this._value);
        this.add_child(this._valueBox);

        this._valueSlotWidth = 0;
        this._labelSlotWidth = 0;
        this._percent = -1;
        this._shownPct = -1;
        this._lastWidth = -1;
        this._trackWidth = -1;
        this._appearance = USAGE_BAR_FIXED;
        this._colorKey = '';
        this._fillBgCss = '';
        this._fillStyleKey = '';

        this._allocId = this._track.connect(
            'notify::allocation', () => this._syncFillWidth());
        this._valueAllocId = this._valueBox.connect(
            'notify::allocation', () => this._ensureValueSlotWidth());
        this._labelAllocId = this._labelProbe
            ? this._label.connect(
                'notify::allocation', () => this._ensureLabelSlotWidth())
            : 0;
        this.connect('destroy', () => {
            if (this._allocId) {
                this._track.disconnect(this._allocId);
                this._allocId = 0;
            }
            if (this._valueAllocId) {
                this._valueBox.disconnect(this._valueAllocId);
                this._valueAllocId = 0;
            }
            if (this._labelAllocId) {
                this._label.disconnect(this._labelAllocId);
                this._labelAllocId = 0;
            }
        });
        // Measure after map: get_preferred_width → get_theme_node, which 46
        // logs (and can warn) when the actor is not on the stage.
    }

    _ensureLabelSlotWidth() {
        if (!this._labelProbe || this._labelSlotWidth > 0)
            return;
        if (!actorHasAllocation(this._label))
            return;
        const prev = this._label.text;
        this._label.text = this._labelProbe;
        const [, nat] = this._label.get_preferred_width(-1);
        this._label.text = prev;
        if (nat <= 1)
            return;
        this._labelSlotWidth = Math.ceil(nat);
        const css = `width: ${this._labelSlotWidth}px; min-width: ${this._labelSlotWidth}px;`;
        this._label.set_style(css);
    }

    _ensureValueSlotWidth() {
        if (this._valueSlotWidth > 0)
            return;
        if (!actorHasAllocation(this._valueBox))
            return;
        const prev = this._value.text;
        this._value.text = this._valueProbe;
        const [, nat] = this._value.get_preferred_width(-1);
        if (nat <= 1) {
            this._value.text = prev;
            return;
        }
        this._valueSlotWidth = Math.ceil(nat);
        this._applyValueSlotWidth();
        this._value.text = this._lastValueText != null
            ? this._lastValueText
            : '—';
    }

    _applyValueSlotWidth() {
        if (this._valueSlotWidth <= 0 || !actorHasAllocation(this._valueBox))
            return;
        // Inline style preferred-size is what BoxLayout honors; set_width alone
        // is not enough when the label text gets shorter/longer.
        const css = `width: ${this._valueSlotWidth}px; min-width: ${this._valueSlotWidth}px;`;
        this._valueBox.set_style(css);
        this._value.set_style(`${css} text-align: right;`);
    }

    setAppearance(mode) {
        const next = normalizeUsageBarAppearance(mode);
        if (next === this._appearance)
            return;
        this._appearance = next;
        this._colorKey = '';
        if (this._percent >= 0)
            this._applyFillStyle(this._percent);
    }

    _applyFillStyle(pct) {
        if (this._appearance === USAGE_BAR_GRADED) {
            const key = `g:${Math.round(pct)}`;
            if (key !== this._colorKey) {
                this._colorKey = key;
                this._fill.style_class = 'smot-bar-fill';
                this._fillBgCss = gradedUsageCss(pct);
            }
            this._paintFill();
            return;
        }
        const fixedCss = ensureFixedBarFillCss(this) || fixedBarFillStyle();
        const key = fixedCss ? `fixed:${fixedCss}` : 'fixed';
        if (key !== this._colorKey) {
            this._colorKey = key;
            this._fill.style_class = 'smot-bar-fill';
            this._fillBgCss = fixedCss || '';
        }
        this._paintFill();
    }

    _trackAllocated() {
        const alloc = this._track?.allocation;
        return !!(alloc && alloc.get_width() > 0);
    }

    /**
     * Keep pill ends round at low %. St clips border-radius when fill width
     * is under 2× the CSS radius (~4px), which looks square at ~2–3%.
     */
    _paintFill() {
        if (!this.get_stage() || !this._trackAllocated())
            return;
        const fill = Math.max(0, this._lastWidth);
        const radius = fill <= 0 ? 0 : Math.min(4, Math.floor(fill / 2));
        const style = `${this._fillBgCss || ''}border-radius: ${radius}px;`;
        if (style === this._fillStyleKey)
            return;
        this._fillStyleKey = style;
        this._fill.set_style(style);
    }

    /** Re-resolve fixed/graded fill after theme or appearance CSS cache changes. */
    refreshFillStyle() {
        this._colorKey = '';
        this._fillStyleKey = '';
        this._applyFillStyle(this._percent >= 0 ? this._percent : 0);
    }

    /**
     * @param {number|null} percent Bar fill 0–100.
     * @param {string|null} [valueText] Right-hand label; omit/null → percent text.
     */
    setPercent(percent, valueText = null) {
        const pct = Math.max(0, Math.min(100, percent ?? 0));
        const shown = Math.round(pct);
        const text = valueText != null ? String(valueText) : formatPercent(pct);
        const custom = valueText != null;

        if (this._percent >= 0 &&
            this._lastValueText === text &&
            (custom || shown === this._shownPct)) {
            this._percent = pct;
            if (this._appearance === USAGE_BAR_GRADED)
                this._applyFillStyle(pct);
            if (custom && this._trackAllocated())
                this._syncFillWidth();
            return;
        }

        this._percent = pct;
        this._shownPct = shown;
        this._lastValueText = text;
        this._ensureValueSlotWidth();
        this._value.text = text;
        this._applyValueSlotWidth();
        this._applyFillStyle(pct);
        if (this._trackAllocated())
            this._syncFillWidth();
    }

    setKey(text) {
        if (text === this._label.text)
            return;
        this._label.text = text;
    }

    _syncFillWidth() {
        const width = this._track.allocation
            ? this._track.allocation.get_width()
            : this._track.width;
        if (width <= 0 || this._percent < 0)
            return;
        const fill = Math.round((width * this._percent) / 100);
        if (fill === this._lastWidth && width === this._trackWidth) {
            this._paintFill();
            return;
        }
        this._lastWidth = fill;
        this._trackWidth = width;
        // Keep actor mapped; only the width changes (avoids show/hide relayout).
        this._fill.width = fill;
        this._paintFill();
    }
});

export const HistogramChart = GObject.registerClass(
class SmotHistogramChart extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'smot-histogram',
            x_expand: true,
            y_align: Clutter.ActorAlign.END,
        });

        this._columns = [];
        for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
            const bucket = HISTOGRAM_BUCKETS[i];
            const col = new St.BoxLayout({
                style_class: 'smot-hist-col',
                x_expand: true,
                y_align: Clutter.ActorAlign.END,
            });
            setBoxVertical(col, true);

            const countLabel = new St.Label({
                text: '0',
                style_class: 'smot-hist-count',
                x_align: Clutter.ActorAlign.CENTER,
            });
            countLabel.clutter_text.x_align = Clutter.ActorAlign.CENTER;

            const track = new St.BoxLayout({
                style_class: 'smot-hist-track',
                x_expand: true,
            });
            setBoxVertical(track, true);
            const spacer = new St.Widget({
                x_expand: true,
                y_expand: true,
            });
            const fill = new St.Widget({
                style_class: 'smot-hist-fill',
                x_expand: true,
                height: 0,
            });
            track.add_child(spacer);
            track.add_child(fill);

            const rangeLabel = new St.Label({
                text: bucket.label,
                style_class: 'smot-hist-label',
                x_align: Clutter.ActorAlign.CENTER,
            });
            rangeLabel.clutter_text.x_align = Clutter.ActorAlign.CENTER;

            col.add_child(countLabel);
            col.add_child(track);
            col.add_child(rangeLabel);
            this.add_child(col);
            this._columns.push({countLabel, fill, lastCount: -1, lastTotal: -1});
        }
        this._appearance = USAGE_BAR_FIXED;
        this._applyFillStyles();
    }

    setAppearance(mode) {
        const next = normalizeUsageBarAppearance(mode);
        if (next === this._appearance)
            return;
        this._appearance = next;
        this._applyFillStyles();
    }

    _applyFillStyles() {
        for (let i = 0; i < this._columns.length; i++) {
            const fill = this._columns[i].fill;
            fill.style_class = 'smot-hist-fill';
            if (this._appearance === USAGE_BAR_GRADED) {
                const bucket = HISTOGRAM_BUCKETS[i];
                const mid = (bucket.min + bucket.max) / 2;
                fill.set_style(gradedUsageCss(mid));
            } else {
                fill.set_style(
                    ensureFixedBarFillCss(this) || fixedBarFillStyle());
            }
        }
    }

    refreshFillStyle() {
        this._applyFillStyles();
    }

    setCounts(counts, total) {
        const t = Math.max(0, Math.round(total ?? 0));
        const scale = Math.max(t, 1);
        for (let i = 0; i < this._columns.length; i++) {
            const col = this._columns[i];
            const n = Math.max(0, Math.round(counts[i] ?? 0));
            if (n === col.lastCount && t === col.lastTotal)
                continue;
            col.lastCount = n;
            col.lastTotal = t;
            col.countLabel.text = String(n);
            const h = Math.round((n / scale) * HIST_TRACK_HEIGHT);
            col.fill.height = n > 0 ? Math.max(3, h) : 0;
            col.fill.visible = n > 0;
        }
    }
});

export const KeyValueRow = GObject.registerClass(
class SmotKeyValueRow extends St.BoxLayout {
    _init(key, {alt = false} = {}) {
        super._init({
            style_class: 'smot-kv-row',
            x_expand: true,
        });

        this._key = new St.Label({
            text: key,
            style_class: 'smot-row-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._value = new St.Label({
            text: '—',
            style_class: 'smot-kv-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._value.clutter_text.x_align = Clutter.ActorAlign.END;
        this._value.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.add_child(this._key);
        this.add_child(this._value);
        this._lastKey = key;
        this._lastValue = '—';
        this._alt = null;
        this.setAlt(alt);
    }

    setAlt(alt) {
        alt = !!alt;
        if (alt === this._alt)
            return;
        this._alt = alt;
        if (alt)
            this.add_style_class_name('smot-kv-row-alt');
        else
            this.remove_style_class_name('smot-kv-row-alt');
    }

    setValue(text) {
        if (text === this._lastValue)
            return;
        this._lastValue = text;
        this._value.text = text;
    }

    setKey(text) {
        if (text === this._lastKey)
            return;
        this._lastKey = text;
        this._key.text = text;
    }
});

export const DetailSection = GObject.registerClass(
class SmotDetailSection extends St.BoxLayout {
    _init(title) {
        super._init({
            x_expand: true,
            y_expand: false,
            style_class: 'smot-card',
        });
        setBoxVertical(this, true);

        this._header = new St.BoxLayout({
            style_class: 'smot-section-header',
            x_expand: true,
        });
        this._title = new St.Label({
            text: title,
            style_class: 'smot-section-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._badge = new St.Label({
            text: '',
            style_class: 'smot-section-badge',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._badge.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._header.add_child(this._title);
        this._header.add_child(this._badge);
        this.add_child(this._header);
        this._badgeText = '';

        this._content = new St.BoxLayout({
            x_expand: true,
            style_class: 'smot-card-body',
        });
        setBoxVertical(this._content, true);
        this.add_child(this._content);
    }

    addActor(actor) {
        this._content.add_child(actor);
    }

    setTitle(text) {
        if (text === this._title.text)
            return;
        this._title.text = text;
    }

    /** Right-side header cue, e.g. "2 of 3". Empty/null hides it. */
    setBadge(text) {
        const next = text ? String(text) : '';
        if (next === this._badgeText)
            return;
        this._badgeText = next;
        this._badge.text = next;
        this._badge.visible = next.length > 0;
    }

    applyFg(css) {
        if (!css)
            return;
        for (const actor of [this, this._title, this._badge, this._content]) {
            if (actorHasAllocation(actor))
                actor.set_style(css);
        }
    }
});
