import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {setBoxVertical} from './widgets.js';

/** CSS min-width floors (.smot-menu / dual / wide) — dock grows above these like the popup. */
const DOCK_WIDTH_DEFAULT = 280;
const DOCK_WIDTH_DUAL = 440;
const DOCK_WIDTH_WIDE = 560;
/** Gap between dock chrome and the monitor’s right edge. */
const DOCK_SCREEN_INSET = 6;
/** Always reserve room for the non-overlay vertical scrollbar trough. */
const DOCK_SCROLLBAR_GUTTER = 14;

/** Right-edge overlay dock: true toggle, same detail cards as the popup. */
export const IndicatorDock = {
    _installMenuRouting() {
        if (this._menuOpenOrig)
            return;
        this._menuOpenOrig = this.menu.open.bind(this.menu);
        this._menuToggleOrig = this.menu.toggle.bind(this.menu);
        this.menu.open = animate => {
            if (this._alive && this._isDockMode()) {
                this._openDock();
                return;
            }
            return this._menuOpenOrig(animate);
        };
        this.menu.toggle = () => {
            if (this._alive && this._isDockMode()) {
                this._toggleDock();
                return;
            }
            return this._menuToggleOrig();
        };
    },

    _dockMinWidthPx() {
        if (this._detailWidthClass === 'wide')
            return DOCK_WIDTH_WIDE;
        if (this._detailWidthClass === 'dual')
            return DOCK_WIDTH_DUAL;
        return DOCK_WIDTH_DEFAULT;
    },

    _detachScrollView() {
        if (!this._scrollView)
            return;
        const parent = this._scrollView.get_parent();
        if (parent)
            parent.remove_child(this._scrollView);
    },

    _attachDetailToPopup() {
        this._detachScrollView();
        if (this._scrollSection?.box && this._scrollView)
            this._scrollSection.box.add_child(this._scrollView);
    },

    _attachDetailToDock() {
        this._ensureDock();
        this._detachScrollView();
        if (this._dockBody && this._scrollView)
            this._dockBody.add_child(this._scrollView);
    },

    /**
     * Keep detail cards in the (unused) menu host while the dock is closed.
     * Creating chrome early leaves an unlaid-out actor at (0,0) that can flash
     * on the left after enable.
     */
    _applyDetailHost() {
        if (this._isDockMode() && this._dockOpen) {
            this._attachDetailToDock();
            return;
        }
        if (!this._dockOpen)
            this._destroyDockChrome();
        this._attachDetailToPopup();
    },

    _onDetailViewModeChanged() {
        this._forceCloseDetails();
        this._detailViewMode = this._normalizeDetailViewMode(
            this._settings.get_string('detail-view-mode'));
        this._applyDetailHost();
    },

    _ensureDock() {
        if (this._dock)
            return;

        this._dock = new St.BoxLayout({
            // popup-menu-content: Shell/Yaru paints bg, border, fg like the panel popup.
            style_class: 'popup-menu-content smot-dock smot-menu',
            reactive: true,
            track_hover: true,
            visible: false,
            opacity: 0,
        });
        setBoxVertical(this._dock, true);
        this._dockBody = new St.BoxLayout({
            style_class: 'smot-dock-body',
            x_expand: true,
            y_expand: true,
        });
        setBoxVertical(this._dockBody, true);
        this._dock.add_child(this._dockBody);

        Main.layoutManager.addChrome(this._dock, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        this._dockMonitorsId = 0;
        this._dockWorkareasId = 0;
        this._dockWorkareasObj = null;

        const relayout = () => {
            if (this._alive && this._dockOpen)
                this._layoutDock();
        };

        try {
            this._dockMonitorsId = Main.layoutManager.connect(
                'monitors-changed', relayout);
        } catch (_e) {
            this._dockMonitorsId = 0;
        }

        // workareas-changed is on Meta.Display (global.display), not LayoutManager.
        // Used when panel/struts change without a full monitors-changed.
        try {
            this._dockWorkareasObj = global.display;
            this._dockWorkareasId = global.display.connect(
                'workareas-changed', relayout);
        } catch (_e) {
            this._dockWorkareasObj = null;
            this._dockWorkareasId = 0;
        }
    },

    _destroyDockChrome() {
        const wasOpen = this._dockOpen;
        this._dockOpen = false;
        if (this._dock) {
            this._dock.visible = false;
            this._dock.opacity = 0;
        }
        if (this._dockMonitorsId) {
            try {
                Main.layoutManager.disconnect(this._dockMonitorsId);
            } catch (_e) {
                // ignore
            }
            this._dockMonitorsId = 0;
        }
        if (this._dockWorkareasId && this._dockWorkareasObj) {
            try {
                this._dockWorkareasObj.disconnect(this._dockWorkareasId);
            } catch (_e) {
                // ignore
            }
            this._dockWorkareasId = 0;
            this._dockWorkareasObj = null;
        }
        if (this._dock) {
            this._detachScrollView();
            try {
                Main.layoutManager.removeChrome(this._dock);
            } catch (_e) {
                // ignore
            }
            this._dock.destroy();
            this._dock = null;
            this._dockBody = null;
        }
        // Always restore a parent after chrome teardown.
        this._attachDetailToPopup();
        if (wasOpen && this._alive)
            this._refresh();
    },

    _toggleDock() {
        if (this._dockOpen)
            this._closeDock();
        else
            this._openDock();
    },

    _openDock() {
        if (!this._alive || !this._isDockMode())
            return;
        if (this.menu?.isOpen) {
            try {
                this.menu.close();
            } catch (_e) {
                // ignore
            }
        }
        this._ensureDock();
        this._attachDetailToDock();
        this._syncDetailWidthClasses();
        // Position while still hidden — showing first leaves a ghost at (0,0).
        this._dock.opacity = 0;
        this._dock.visible = true;
        if (!this._layoutDock()) {
            this._dock.visible = false;
            this._dock.opacity = 0;
            this._attachDetailToPopup();
            return;
        }
        this._dock.opacity = 255;
        this._dockOpen = true;
        this._syncPopupFg();
        this._syncFixedBarFill();
        this._collector.resyncSensors();
        this._refresh();
        this._queueScrollSync();
    },

    _closeDock() {
        const wasOpen = this._dockOpen;
        this._dockOpen = false;
        if (this._dock) {
            this._dock.visible = false;
            this._dock.opacity = 0;
        }
        // Leave cards in the hidden dock chrome until destroy / mode switch.
        if (wasOpen && this._alive)
            this._refresh();
    },

    /** @returns {boolean} true if the dock was positioned on a real monitor. */
    _layoutDock() {
        if (!this._dock || !this._scrollView || !this._cardsBox)
            return false;

        const monitor = Main.layoutManager.findMonitorForActor(this) ||
            Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        if (!workArea || workArea.width <= 0 || workArea.height <= 0)
            return false;

        // Same dual/wide floors as the popup; then grow with content.
        this._syncDetailWidthClasses();
        this._cardsBox.queue_relayout();
        const [, natW] = this._cardsBox.get_preferred_width(-1);
        const minW = this._dockMinWidthPx();
        const maxW = Math.max(minW, workArea.width - DOCK_SCREEN_INSET - 48);
        const contentW = Math.min(
            maxW - DOCK_SCROLLBAR_GUTTER,
            Math.max(minW, Math.ceil(natW > 0 ? natW : minW)));
        // Always leave a trough so the bar sits beside cards (like the popup).
        const width = Math.min(maxW, contentW + DOCK_SCROLLBAR_GUTTER);

        // Measure cards — ScrollView preferred height is unreliable (stays short).
        // Cards box CSS owns equal top/bottom inset; do not add chrome pad in JS
        // (that double-counted and left a larger gap under the last card).
        const [, natH] = this._cardsBox.get_preferred_height(contentW);
        const maxPx = Math.max(160, workArea.height);
        const contentH = Math.max(48, Math.min(natH > 0 ? natH : maxPx, maxPx));

        if (contentH >= maxPx)
            this._dock.add_style_class_name('smot-dock-full');
        else
            this._dock.remove_style_class_name('smot-dock-full');

        this._scrollView.height = contentH;
        this._scrollView.vscrollbar_policy =
            natH > maxPx ? St.PolicyType.AUTOMATIC : St.PolicyType.EXTERNAL;

        this._dock.set_size(width, contentH);
        const y = contentH >= maxPx
            ? workArea.y
            : workArea.y + Math.max(0, Math.floor((workArea.height - contentH) / 2));
        this._dock.set_position(
            workArea.x + workArea.width - width - DOCK_SCREEN_INSET,
            y);
        return true;
    },
};
