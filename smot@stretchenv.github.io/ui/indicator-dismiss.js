import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DETAIL_VIEW_DOCK, normalizeDetailViewMode} from './constants.js';

/** Session lock/suspend guards and detail-view mode helpers. */
export const IndicatorDismiss = {
    _normalizeDetailViewMode(value) {
        return normalizeDetailViewMode(value);
    },

    _isDockMode() {
        return this._detailViewMode === DETAIL_VIEW_DOCK;
    },

    _isDetailsOpen() {
        return !!(this._menuOpen || this._dockOpen);
    },

    _forceCloseDetails() {
        if (!this._alive)
            return;
        this._closeDock();
        if (!this.menu?.isOpen)
            return;
        try {
            this.menu.close();
        } catch (_e) {
            // Ignore if the menu is already tearing down.
        }
    },

    /**
     * Dock (and any leftover open popup) must not remain over the lock screen
     * or after resume.
     */
    _installSessionGuards() {
        this._disconnectSessionGuards();

        const connect = (obj, signal, handler) => {
            if (!obj?.connect)
                return;
            try {
                const id = obj.connect(signal, handler);
                this._sessionGuardIds.push([obj, id]);
            } catch (_e) {
                // Signal may not exist on all Shell versions.
            }
        };

        if (Main.screenShield) {
            connect(Main.screenShield, 'lock-screen-shown', () => {
                this._forceCloseDetails();
            });
            connect(Main.screenShield, 'notify::locked', () => {
                if (Main.screenShield.locked)
                    this._forceCloseDetails();
            });
        }

        if (Main.sessionMode) {
            connect(Main.sessionMode, 'updated', () => {
                if (Main.sessionMode.isLocked ||
                    Main.sessionMode.currentMode === 'unlock-dialog')
                    this._forceCloseDetails();
            });
        }

        try {
            this._loginManager = LoginManager.getLoginManager();
            connect(this._loginManager, 'prepare-for-sleep', (_lm, aboutToSuspend) => {
                if (aboutToSuspend)
                    this._forceCloseDetails();
            });
        } catch (_e) {
            this._loginManager = null;
        }
    },

    _disconnectSessionGuards() {
        for (const [obj, id] of this._sessionGuardIds || []) {
            try {
                obj.disconnect(id);
            } catch (_e) {
                // ignore
            }
        }
        this._sessionGuardIds = [];
    },
};
