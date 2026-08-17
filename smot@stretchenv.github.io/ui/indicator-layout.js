import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    CORES_PER_COLUMN_DEFAULT,
    CORE_DISPLAY_HISTOGRAM,
    CORE_DISPLAY_NONE,
    CORE_DISPLAY_PER_CORE,
    MEM_ROW_ORDER,
    MEM_SIMPLE_KEYS,
    MEMORY_DISPLAY_DETAILED,
    MEMORY_DISPLAY_SIMPLE,
    PER_CORE_MAX_CORES,
    WIDE_POPUP_CORE_THRESHOLD,
    coresPerColumn,
} from './constants.js';
import {MeterRow, setBoxVertical} from './widgets.js';

/** Scroll height, core grid layout, detail chrome width, memory row visibility. */
export const IndicatorLayout = {
    _queueScrollSync() {
        this._syncScrollMaxHeight();
        if (this._scrollSyncId)
            return;
        this._scrollSyncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scrollSyncId = 0;
            this._syncScrollMaxHeight();
            return GLib.SOURCE_REMOVE;
        });
    },

    _detailMonitorIndex() {
        const monitor = Main.layoutManager.findMonitorForActor(this);
        return monitor?.index ?? Main.layoutManager.primaryIndex;
    },

    _syncScrollMaxHeight() {
        if (!this._scrollView || !this._cardsBox)
            return;

        if (this._dockOpen) {
            this._layoutDock();
            return;
        }

        if (!this.menu?.actor)
            return;

        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            this._detailMonitorIndex());
        const menuActor = this.menu.actor;
        const verticalMargins = menuActor.margin_top + menuActor.margin_bottom;

        // Always pin an explicit height so the panel menu max-height does not
        // clip non-scrollable content (same fix as Service Monitor).
        const maxPx = Math.max(160, workArea.height - verticalMargins - 24);
        this._cardsBox.queue_relayout();
        const [, nat] = this._cardsBox.get_preferred_height(-1);
        const h = Math.max(48, Math.min(nat > 0 ? nat : maxPx, maxPx));
        this._scrollView.height = h;
        this._scrollView.vscrollbar_policy =
            nat > maxPx ? St.PolicyType.AUTOMATIC : St.PolicyType.EXTERNAL;
    },

    _effectiveCoreMode(coreCount) {
        let mode = this._coreDisplay || CORE_DISPLAY_PER_CORE;
        if (mode !== CORE_DISPLAY_NONE &&
            mode !== CORE_DISPLAY_PER_CORE &&
            mode !== CORE_DISPLAY_HISTOGRAM)
            mode = CORE_DISPLAY_PER_CORE;
        if (mode === CORE_DISPLAY_PER_CORE && coreCount > PER_CORE_MAX_CORES)
            return CORE_DISPLAY_HISTOGRAM;
        return mode;
    },

    _applyMemoryMode() {
        let mode = this._memoryDisplay || MEMORY_DISPLAY_DETAILED;
        if (mode !== MEMORY_DISPLAY_SIMPLE && mode !== MEMORY_DISPLAY_DETAILED)
            mode = MEMORY_DISPLAY_DETAILED;

        let visibleIndex = 0;
        for (const [key] of MEM_ROW_ORDER) {
            const row = this._memRows[key];
            if (!row)
                continue;
            const visible = mode === MEMORY_DISPLAY_DETAILED || MEM_SIMPLE_KEYS.has(key);
            row.visible = visible;
            if (visible) {
                row.setAlt(visibleIndex % 2 === 1);
                visibleIndex += 1;
            }
        }
    },

    _applyCoreMode(mode, coreCount) {
        const showPerCore = mode === CORE_DISPLAY_PER_CORE;
        const showHistogram = mode === CORE_DISPLAY_HISTOGRAM;
        this._coreUsageHeader.visible = showPerCore || showHistogram;
        this._coreGrid.visible = showPerCore;
        this._histogramChart.visible = showHistogram;
        if (showPerCore)
            this._syncPopupWidth(coreCount);
        else
            this._clearPopupWidthClasses();
    },

    _widthChromeActors() {
        const actors = [];
        if (this.menu?.box)
            actors.push(this.menu.box);
        if (this._dock)
            actors.push(this._dock);
        return actors;
    },

    _clearPopupWidthClasses() {
        this._detailWidthClass = '';
        for (const actor of this._widthChromeActors()) {
            actor.remove_style_class_name('smot-menu-wide');
            actor.remove_style_class_name('smot-menu-dual');
        }
    },

    _syncDetailWidthClasses() {
        for (const actor of this._widthChromeActors()) {
            actor.remove_style_class_name('smot-menu-wide');
            actor.remove_style_class_name('smot-menu-dual');
            if (this._detailWidthClass === 'wide')
                actor.add_style_class_name('smot-menu-wide');
            else if (this._detailWidthClass === 'dual')
                actor.add_style_class_name('smot-menu-dual');
        }
    },

    _ensureCoreRows(count) {
        const perCol = coresPerColumn(count);

        if (this._coresReady &&
            this._coreRows.length === count &&
            this._layoutPerCol === perCol) {
            this._syncPopupWidth(count);
            return;
        }

        // Column density changed — rebuild so cores land in the right columns.
        if (this._layoutPerCol && this._layoutPerCol !== perCol) {
            for (const row of this._coreRows)
                row.destroy();
            for (const column of this._coreColumns)
                column.destroy();
            this._coreRows = [];
            this._coreColumns = [];
            this._coresReady = false;
        }
        this._layoutPerCol = perCol;

        while (this._coreRows.length < count) {
            const index = this._coreRows.length;
            const colIndex = Math.floor(index / perCol);

            while (this._coreColumns.length <= colIndex) {
                const column = new St.BoxLayout({
                    style_class: 'smot-core-column',
                    x_expand: true,
                });
                setBoxVertical(column, true);
                this._coreGrid.add_child(column);
                this._coreColumns.push(column);
            }

            const row = new MeterRow(
                `Core ${String(index).padStart(2, '\u2007')}`);
            row.setAppearance(this._usageBarAppearance);
            this._coreColumns[colIndex].add_child(row);
            this._coreRows.push(row);
        }

        for (let i = 0; i < this._coreRows.length; i++)
            this._coreRows[i].visible = i < count;

        for (let c = 0; c < this._coreColumns.length; c++)
            this._coreColumns[c].visible = c * perCol < count;

        this._coresReady = count > 0;
        this._syncPopupWidth(count);
    },

    _syncPopupWidth(count) {
        if (count > WIDE_POPUP_CORE_THRESHOLD)
            this._detailWidthClass = 'wide';
        else if (count > CORES_PER_COLUMN_DEFAULT)
            this._detailWidthClass = 'dual';
        else
            this._detailWidthClass = '';
        this._syncDetailWidthClasses();
        if (this._dockOpen)
            this._layoutDock();
    },
};
