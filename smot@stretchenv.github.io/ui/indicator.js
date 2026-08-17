import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    StatsCollector,
    formatBytesFromKb,
    formatPercent,
    parseTemperatureFields,
} from '../stats.js';
import {
    CORE_DISPLAY_HISTOGRAM,
    CORE_DISPLAY_PER_CORE,
    MEM_ROW_ORDER,
    UPDATE_INTERVAL_SEC_DEFAULT,
    UPDATE_INTERVAL_SEC_MAX,
    UPDATE_INTERVAL_SEC_MIN,
    histogramCounts,
    normalizeDetailViewMode,
    normalizeUsageBarAppearance,
} from './constants.js';
import {IndicatorCards} from './indicator-cards.js';
import {IndicatorDismiss} from './indicator-dismiss.js';
import {IndicatorDock} from './indicator-dock.js';
import {IndicatorLayout} from './indicator-layout.js';
import {IndicatorTheme} from './indicator-theme.js';
import {
    DetailSection,
    HistogramChart,
    KeyValueRow,
    MeterRow,
    loadExtensionIcon,
    makeIoRateRow,
    setBoxVertical,
} from './widgets.js';

const SmotIndicator = GObject.registerClass(
class SmotIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'System Monitor on Top Panel', false);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._collector = new StatsCollector();
        this._coreRows = [];
        this._coreColumns = [];
        this._coreGrid = null;
        this._histogramChart = null;
        this._tempRows = [];
        this._timeoutId = 0;
        this._menuOpen = false;
        this._dockOpen = false;
        this._dock = null;
        this._dockBody = null;
        this._detailWidthClass = '';
        this._lastCpuText = '';
        this._lastMemText = '';
        this._coresReady = false;
        this._layoutPerCol = 0;
        this._alive = true;
        this._coreDisplay = this._settings.get_string('core-display');
        this._usageBarAppearance = normalizeUsageBarAppearance(
            this._settings.get_string('usage-bar-appearance'));
        this._memoryDisplay = this._settings.get_string('memory-display');
        this._detailViewMode = normalizeDetailViewMode(
            this._settings.get_string('detail-view-mode'));
        this._tempConfig = parseTemperatureFields(
            this._settings.get_string('temperature-fields'));
        this._refreshIntervalSec = this._clampRefreshInterval(
            this._settings.get_int('refresh-interval-sec'));
        this._scrollSyncId = 0;
        this._sessionGuardIds = [];
        this._showDiskIo = this._settings.get_boolean('show-disk-io');
        this._showNetworkIo = this._settings.get_boolean('show-network-io');
        this._showTemperature = this._settings.get_boolean('show-temperature');
        this._showGpu = this._settings.get_boolean('show-gpu');
        this._showNpu = this._settings.get_boolean('show-npu');
        this._collector.setIoEnabled({
            disk: this._showDiskIo,
            net: this._showNetworkIo,
        });
        this._applyDiskFilter();
        this._applyNetworkFilter();
        this._collector.setPopupFeatures({
            temp: this._showTemperature,
            gpu: this._showGpu,
            npu: this._showNpu,
        });

        const box = new St.BoxLayout({
            style_class: 'smot-panel',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(box);

        this.menu.box.add_style_class_name('smot-menu');
        this._installMenuRouting();
        this._installSessionGuards();

        const cpuBox = new St.BoxLayout({
            style_class: 'smot-stat',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._cpuIcon = new St.Icon({
            style_class: 'system-status-icon smot-icon',
            gicon: loadExtensionIcon(extension, 'icons/processor-symbolic.svg'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._cpuLabel = new St.Label({
            text: '—',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'smot-label',
        });
        cpuBox.add_child(this._cpuIcon);
        cpuBox.add_child(this._cpuLabel);
        box.add_child(cpuBox);

        const memBox = new St.BoxLayout({
            style_class: 'smot-stat',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._memIcon = new St.Icon({
            style_class: 'system-status-icon smot-icon',
            gicon: loadExtensionIcon(extension, 'icons/memory-symbolic.svg'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._memLabel = new St.Label({
            text: '—',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'smot-label',
        });
        memBox.add_child(this._memIcon);
        memBox.add_child(this._memLabel);
        box.add_child(memBox);

        // Cards in a ScrollView (same approach as Service Monitor) so tall
        // per-core lists / many sensors stay within the work area.
        this._scrollSection = new PopupMenu.PopupMenuSection();
        this._scrollSection.box.y_expand = true;
        this.menu.addMenuItem(this._scrollSection);

        this._cardsBox = new St.BoxLayout({
            style_class: 'smot-cards',
            x_expand: true,
            y_expand: false,
        });
        setBoxVertical(this._cardsBox, true);
        this._scrollView = new St.ScrollView({
            style_class: 'smot-scroll vfade',
            overlay_scrollbars: false,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
            child: this._cardsBox,
        });
        this._scrollSection.box.add_child(this._scrollView);

        this._cpuSection = new DetailSection('CPU');
        this._cardsBox.add_child(this._cpuSection);

        this._memSection = new DetailSection('Memory');
        this._cardsBox.add_child(this._memSection);

        this._diskSection = new DetailSection('Disk');
        const diskRates = makeIoRateRow('Read bytes/sec', 'Write bytes/sec');
        this._diskSection.addActor(diskRates.row);
        this._diskReadLabel = diskRates.primary;
        this._diskWriteLabel = diskRates.secondary;
        this._diskWarnList = new St.BoxLayout({
            style_class: 'smot-disk-warn-list',
            x_expand: true,
            visible: false,
        });
        setBoxVertical(this._diskWarnList, true);
        this._diskSection.addActor(this._diskWarnList);
        this._diskWarnRows = [];
        this._cardsBox.add_child(this._diskSection);

        this._netSection = new DetailSection('Network');
        const netRates = makeIoRateRow('RX bytes/sec', 'TX bytes/sec');
        this._netSection.addActor(netRates.row);
        this._netInLabel = netRates.primary;
        this._netOutLabel = netRates.secondary;
        this._cardsBox.add_child(this._netSection);

        this._gpuCards = [];
        this._npuCards = [];

        this._tempSection = new DetailSection('Temperature');
        this._cardsBox.add_child(this._tempSection);

        this._applyIoVisibility();

        this._overallCpuRow = new MeterRow('Total');
        this._overallCpuRow.setAppearance(this._usageBarAppearance);
        this._cpuSection.addActor(this._overallCpuRow);

        this._coreUsageHeader = new St.Label({
            text: 'Core usage',
            style_class: 'smot-subsection-title',
            visible: false,
        });
        this._cpuSection.addActor(this._coreUsageHeader);

        this._coreGrid = new St.BoxLayout({
            style_class: 'smot-core-grid',
            x_expand: true,
            visible: false,
        });
        this._cpuSection.addActor(this._coreGrid);

        this._histogramChart = new HistogramChart();
        this._histogramChart.setAppearance(this._usageBarAppearance);
        this._histogramChart.visible = false;
        this._cpuSection.addActor(this._histogramChart);

        this._memUsedRow = new MeterRow('Used', {valueProbe: '999.9G'});
        this._memUsedRow.setAppearance(this._usageBarAppearance);
        this._memSection.addActor(this._memUsedRow);
        this._memRows = {};
        for (let i = 0; i < MEM_ROW_ORDER.length; i++) {
            const [key, label] = MEM_ROW_ORDER[i];
            this._memRows[key] = new KeyValueRow(label, {alt: i % 2 === 1});
            this._memSection.addActor(this._memRows[key]);
        }
        this._applyMemoryMode();

        // Hidden until at least one enabled/available sensor is present.
        this._tempSection.visible = false;

        this._applyDetailHost();
        this._collector.sample({detailed: false});

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (!this._alive)
                return;
            if (key === 'core-display') {
                this._coreDisplay = this._settings.get_string('core-display');
            } else if (key === 'usage-bar-appearance') {
                this._usageBarAppearance = normalizeUsageBarAppearance(
                    this._settings.get_string('usage-bar-appearance'));
                this._syncFixedBarFill();
                this._applyUsageBarAppearance();
            } else if (key === 'memory-display') {
                this._memoryDisplay = this._settings.get_string('memory-display');
            } else if (key === 'show-disk-io' || key === 'show-network-io') {
                this._showDiskIo = this._settings.get_boolean('show-disk-io');
                this._showNetworkIo = this._settings.get_boolean('show-network-io');
                this._collector.setIoEnabled({
                    disk: this._showDiskIo,
                    net: this._showNetworkIo,
                });
                this._applyIoVisibility();
            } else if (key === 'show-temperature' ||
                       key === 'show-gpu' ||
                       key === 'show-npu') {
                this._showTemperature = this._settings.get_boolean('show-temperature');
                this._showGpu = this._settings.get_boolean('show-gpu');
                this._showNpu = this._settings.get_boolean('show-npu');
                this._collector.setPopupFeatures({
                    temp: this._showTemperature,
                    gpu: this._showGpu,
                    npu: this._showNpu,
                });
                if (!this._showGpu)
                    this._hideGpuCards();
                if (!this._showNpu)
                    this._hideNpuCards();
                if (!this._showTemperature && this._tempSection)
                    this._tempSection.visible = false;
            } else if (key === 'disk-devices' || key === 'disk-filter-enabled') {
                this._applyDiskFilter();
            } else if (key === 'network-interfaces' ||
                       key === 'network-filter-enabled') {
                this._applyNetworkFilter();
            } else if (key === 'detail-view-mode') {
                this._onDetailViewModeChanged();
                return;
            } else if (key === 'refresh-interval-sec') {
                this._refreshIntervalSec = this._clampRefreshInterval(
                    this._settings.get_int('refresh-interval-sec'));
                this._restartTimer();
                return;
            } else if (key === 'temperature-fields') {
                this._tempConfig = parseTemperatureFields(
                    this._settings.get_string('temperature-fields'));
            } else {
                return;
            }
            if (this._isDetailsOpen())
                this._refresh();
        });

        this._menuSignalId = this.menu.connect('open-state-changed', (_menu, open) => {
            if (!this._alive)
                return;
            this._menuOpen = open;
            if (open) {
                if (this._isDockMode()) {
                    // Routed through menu.open override; should not happen.
                    try {
                        this.menu.close();
                    } catch (_e) {
                        // ignore
                    }
                    return;
                }
                this._syncPopupFg();
                this._syncFixedBarFill();
                this._collector.resyncSensors();
                this._refresh();
                this._queueScrollSync();
            }
        });
        this._menuStyleId = this.menu.box.connect('style-changed', () => {
            if (this._alive && this._menuOpen) {
                this._syncPopupFg();
                this._syncFixedBarFill();
                this._queueScrollSync();
            }
        });

        // Use destroy signal (not an overridden destroy()) so cleanup always runs
        // whether Shell or disable() tears the actor down.
        this.connect('destroy', () => this._onDestroy());

        this._syncFixedBarFill();
        this._restartTimer();
        this._refresh();
    }

    _applyDiskFilter() {
        this._collector.setDiskFilter({
            enabled: this._settings.get_boolean('disk-filter-enabled'),
            names: this._settings.get_strv('disk-devices'),
        });
    }

    _applyNetworkFilter() {
        this._collector.setNetworkFilter({
            enabled: this._settings.get_boolean('network-filter-enabled'),
            names: this._settings.get_strv('network-interfaces'),
        });
    }

    _clampRefreshInterval(sec) {
        const n = Math.round(Number(sec));
        if (!Number.isFinite(n))
            return UPDATE_INTERVAL_SEC_DEFAULT;
        return Math.min(UPDATE_INTERVAL_SEC_MAX,
            Math.max(UPDATE_INTERVAL_SEC_MIN, n));
    }

    _restartTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (!this._alive)
            return;
        const sec = this._refreshIntervalSec || UPDATE_INTERVAL_SEC_DEFAULT;
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW,
            sec,
            () => {
                if (!this._alive)
                    return GLib.SOURCE_REMOVE;
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _onDestroy() {
        this._alive = false;
        this._disconnectSessionGuards();
        this._destroyDockChrome();
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._scrollSyncId) {
            GLib.source_remove(this._scrollSyncId);
            this._scrollSyncId = 0;
        }
        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        // Menu is destroyed with the button; do not disconnect manually.
        this._menuSignalId = 0;
        this._menuStyleId = 0;
        try {
            this._collector?.dispose();
        } catch (_e) {
            // ignore
        }
        this._collector = null;
        this._settings = null;
        this._extension = null;
        this._loginManager = null;
    }

    _updatePanel(sample) {
        const cpuText = formatPercent(sample.cpu);
        if (cpuText !== this._lastCpuText) {
            this._lastCpuText = cpuText;
            this._cpuLabel.text = cpuText;
        }

        const memText = sample.memory
            ? formatBytesFromKb(sample.memory.used)
            : '—';
        if (memText !== this._lastMemText) {
            this._lastMemText = memText;
            this._memLabel.text = memText;
        }
    }

    _updateDetails(sample) {
        this._updateIoCards(sample);

        if (sample.cpu != null)
            this._overallCpuRow.setPercent(sample.cpu);

        const coreCount = sample.coreCount || 0;
        const mode = this._effectiveCoreMode(coreCount);
        this._applyCoreMode(mode, coreCount);

        if (mode === CORE_DISPLAY_PER_CORE) {
            this._ensureCoreRows(coreCount);
            for (let i = 0; i < coreCount; i++)
                this._coreRows[i].setPercent(sample.coreUsage[i]);
        } else if (mode === CORE_DISPLAY_HISTOGRAM) {
            const counts = histogramCounts(sample.coreUsage, coreCount);
            this._histogramChart.setCounts(counts, coreCount);
        }

        this._updateGpu(sample);
        this._updateNpu(sample);
        this._updateTemperature(sample);

        if (sample.memory) {
            const m = sample.memory;
            this._memUsedRow.setPercent(
                m.percentUsed ?? 0,
                formatBytesFromKb(m.used));
            this._applyMemoryMode();
            this._memRows.available.setValue(formatBytesFromKb(m.available));
            this._memRows.free.setValue(formatBytesFromKb(m.free));
            this._memRows.buffers.setValue(formatBytesFromKb(m.buffers));
            this._memRows.fileCache.setValue(formatBytesFromKb(m.fileCache));
            this._memRows.shmem.setValue(formatBytesFromKb(m.shmem));
            this._memRows.swap.setValue(formatBytesFromKb(m.swapUsed));
        }

        this._queueScrollSync();
    }

    _refresh() {
        if (!this._alive || !this._collector)
            return;
        const detailed = this._isDetailsOpen();
        const sample = this._collector.sample({detailed});
        this._updatePanel(sample);
        if (detailed)
            this._updateDetails(sample);
    }
});

Object.assign(
    SmotIndicator.prototype,
    IndicatorDismiss,
    IndicatorDock,
    IndicatorTheme,
    IndicatorLayout,
    IndicatorCards);

export const Indicator = SmotIndicator;
