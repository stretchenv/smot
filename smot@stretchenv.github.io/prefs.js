import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    discoverIntelNpus,
    discoverNvidiaGpus,
    discoverTemperatureSensors,
    listNetworkInterfaceEntries,
    listPhysicalDiskEntries,
    normalizeDiskDevices,
    normalizeNetworkInterfaces,
    parseTemperatureFields,
    serializeTemperatureFields,
    temperatureKey,
} from './stats.js';
import {readTextAsync} from './lib/paths.js';

const CORE_DISPLAY_NONE = 'none';
const CORE_DISPLAY_PER_CORE = 'per-core';
const CORE_DISPLAY_HISTOGRAM = 'histogram';
const PER_CORE_MAX_CORES = 16;

const USAGE_BAR_FIXED = 'fixed';
const USAGE_BAR_GRADED = 'graded';

const MEMORY_DISPLAY_SIMPLE = 'simple';
const MEMORY_DISPLAY_DETAILED = 'detailed';

const DETAIL_VIEW_POPUP = 'popup';
const DETAIL_VIEW_DOCK = 'dock';

async function detectCoreCount() {
    const text = await readTextAsync('/proc/stat');
    if (!text)
        return 0;
    let count = 0;
    for (const line of text.split('\n')) {
        if (/^cpu\d+\s/.test(line))
            count += 1;
    }
    return count;
}

/** Style modes when core usage is shown (not including off). */
function coreStyleModes(coreCount) {
    if (coreCount > PER_CORE_MAX_CORES) {
        return [
            {id: CORE_DISPLAY_HISTOGRAM, title: _('Histogram')},
        ];
    }
    return [
        {id: CORE_DISPLAY_PER_CORE, title: _('Individual cores')},
        {id: CORE_DISPLAY_HISTOGRAM, title: _('Histogram')},
    ];
}

/**
 * Show core usage switch + style combo (Individual cores / Histogram).
 * Still writes the single `core-display` key: none | per-core | histogram.
 */
function addCoreDisplayRows(group, settings, coreCount) {
    const styles = coreStyleModes(coreCount);
    const perCoreOk = styles.some(m => m.id === CORE_DISPLAY_PER_CORE);

    let current = settings.get_string('core-display');
    if (current !== CORE_DISPLAY_NONE &&
        current !== CORE_DISPLAY_PER_CORE &&
        current !== CORE_DISPLAY_HISTOGRAM)
        current = CORE_DISPLAY_PER_CORE;
    if (current === CORE_DISPLAY_PER_CORE && !perCoreOk) {
        current = CORE_DISPLAY_HISTOGRAM;
        settings.set_string('core-display', current);
    }

    let lastStyle = current === CORE_DISPLAY_NONE
        ? (perCoreOk ? CORE_DISPLAY_PER_CORE : CORE_DISPLAY_HISTOGRAM)
        : current;
    if (!styles.some(m => m.id === lastStyle))
        lastStyle = styles[0].id;

    const showRow = new Adw.SwitchRow({
        title: _('Show core usage'),
        subtitle: _('Extra core details shown under CPU in the window'),
        active: current !== CORE_DISPLAY_NONE,
    });
    group.add(showRow);

    const model = Gtk.StringList.new(styles.map(m => m.title));
    const styleRow = new Adw.ComboRow({
        title: _('Core usage style'),
        subtitle: perCoreOk
            ? _('Individual cores or a usage histogram')
            : _('This system has more than 16 cores; only the histogram is available'),
        model,
        sensitive: current !== CORE_DISPLAY_NONE,
    });
    styleRow.set_selected(Math.max(0, styles.findIndex(m => m.id === lastStyle)));
    group.add(styleRow);

    let applying = false;

    const write = value => {
        if (settings.get_string('core-display') === value)
            return;
        applying = true;
        settings.set_string('core-display', value);
        applying = false;
    };

    const syncFromSettings = () => {
        if (applying)
            return;
        let value = settings.get_string('core-display');
        if (value !== CORE_DISPLAY_NONE &&
            value !== CORE_DISPLAY_PER_CORE &&
            value !== CORE_DISPLAY_HISTOGRAM)
            value = CORE_DISPLAY_PER_CORE;
        if (value === CORE_DISPLAY_PER_CORE && !perCoreOk)
            value = CORE_DISPLAY_HISTOGRAM;

        const show = value !== CORE_DISPLAY_NONE;
        if (showRow.get_active() !== show)
            showRow.set_active(show);
        styleRow.sensitive = show;
        if (show) {
            lastStyle = value;
            const idx = Math.max(0, styles.findIndex(m => m.id === value));
            if (styleRow.get_selected() !== idx)
                styleRow.set_selected(idx);
        }
    };

    showRow.connect('notify::active', () => {
        if (applying)
            return;
        if (showRow.get_active()) {
            styleRow.sensitive = true;
            const idx = Math.max(0, styles.findIndex(m => m.id === lastStyle));
            styleRow.set_selected(idx);
            write(styles[idx].id);
        } else {
            styleRow.sensitive = false;
            write(CORE_DISPLAY_NONE);
        }
    });

    styleRow.connect('notify::selected', () => {
        if (applying || !showRow.get_active())
            return;
        const idx = styleRow.get_selected();
        if (idx < 0 || idx >= styles.length)
            return;
        lastStyle = styles[idx].id;
        write(lastStyle);
    });

    settings.connect('changed::core-display', syncFromSettings);
}

function addComboRow(group, settings, key, modes, title) {
    let current = settings.get_string(key);
    if (!modes.some(m => m.id === current)) {
        current = modes[0].id;
        settings.set_string(key, current);
    }

    const model = Gtk.StringList.new(modes.map(m => m.title));
    const row = new Adw.ComboRow({
        title,
        model,
    });
    const initialIndex = Math.max(0, modes.findIndex(m => m.id === current));
    row.set_selected(initialIndex);
    row.connect('notify::selected', () => {
        const idx = row.get_selected();
        if (idx < 0 || idx >= modes.length)
            return;
        settings.set_string(key, modes[idx].id);
    });
    group.add(row);

    settings.connect(`changed::${key}`, () => {
        const value = settings.get_string(key);
        const idx = modes.findIndex(m => m.id === value);
        if (idx >= 0 && row.get_selected() !== idx)
            row.set_selected(idx);
    });
}

async function addTemperatureFieldsGroups(page, settings) {
    let sensors = [];
    try {
        sensors = await discoverTemperatureSensors();
    } catch (e) {
        printerr(`smot: sensor discovery failed: ${e}\n`);
    }

    let config = parseTemperatureFields(settings.get_string('temperature-fields'));
    const rows = [];

    function persist() {
        const next = {...config};
        for (const row of rows) {
            next[row.key] = {
                enabled: row.switchRow.get_active(),
                description: row.entryRow.get_text(),
            };
        }
        config = next;
        settings.set_string('temperature-fields', serializeTemperatureFields(next));
    }

    const intro = new Adw.PreferencesGroup({
        title: _('Sensors'),
        description: sensors.length === 0
            ? _('No temperature sensors were found on this system.')
            : _('Turn a sensor on to show it in the window. Optionally give it a user friendly name.'),
    });
    page.add(intro);

    if (sensors.length === 0) {
        intro.add(new Adw.ActionRow({
            title: _('No sensors detected'),
            subtitle: _('Temperature hardware may be unavailable.'),
            sensitive: false,
        }));
        return;
    }

    for (const sensor of sensors) {
        const key = temperatureKey(sensor);
        if (!key)
            continue;

        const saved = config[key];
        const enabled = saved ? saved.enabled !== false : true;
        const description = saved?.description ?? '';

        const group = new Adw.PreferencesGroup({
            title: key,
        });

        const switchRow = new Adw.SwitchRow({
            title: _('Show sensor value'),
            active: enabled,
        });
        group.add(switchRow);

        const entryRow = new Adw.EntryRow({
            title: _('Display name'),
            text: description,
            sensitive: enabled,
        });
        // Hint for empty name: keep showing the sensor key in the popup.
        entryRow.set_tooltip_text(_('Leave empty to use “%s”').format(key));
        group.add(entryRow);

        page.add(group);
        rows.push({key, switchRow, entryRow});

        switchRow.connect('notify::active', () => {
            const on = switchRow.get_active();
            entryRow.sensitive = on;
            persist();
        });
        entryRow.connect('changed', () => persist());
    }
}

/** Same nested pattern as Service Monitor: Adw.Dialog.present(prefsWindow). */
async function openTemperatureFieldsDialog(window, settings) {
    const dialog = new Adw.Dialog({
        title: _('Temperature'),
        content_width: 520,
        content_height: 520,
    });

    const toolbar = new Adw.ToolbarView();
    const header = new Adw.HeaderBar({
        show_end_title_buttons: true,
    });
    toolbar.add_top_bar(header);

    const page = new Adw.PreferencesPage();
    await addTemperatureFieldsGroups(page, settings);

    const scrolled = new Gtk.ScrolledWindow({
        vexpand: true,
        hexpand: true,
        child: page,
    });
    toolbar.set_content(scrolled);
    dialog.set_child(toolbar);

    dialog.present(window);
}

/**
 * Shared “monitor all / pick subset” dialog for disks or network ifaces.
 * Filter-off keeps the saved name list. Filter-on with an empty list matches nothing.
 * @param {object} opts
 * @param {{name: string, subtitle?: string}[]} opts.entries
 */
function openNamedDeviceDialog(window, settings, opts) {
    const {
        dialogTitle,
        modeDescription,
        allTitle,
        allSubtitle,
        listTitle,
        listDescription,
        emptyTitle,
        filterEnabledKey,
        settingKey,
        entries,
        normalize,
    } = opts;

    const names = (entries || []).map(e => e.name);
    const present = new Set(names);

    const dialog = new Adw.Dialog({
        title: dialogTitle,
        content_width: 480,
        content_height: 440,
    });

    const toolbar = new Adw.ToolbarView();
    const header = new Adw.HeaderBar({
        show_end_title_buttons: true,
    });
    toolbar.add_top_bar(header);

    const page = new Adw.PreferencesPage();
    const saved = normalize(settings.get_strv(settingKey));
    const monitorAll = !settings.get_boolean(filterEnabledKey);

    const modeGroup = new Adw.PreferencesGroup({
        title: _('Selection'),
        description: modeDescription,
    });
    page.add(modeGroup);

    const allRow = new Adw.SwitchRow({
        title: allTitle,
        subtitle: allSubtitle,
        active: monitorAll,
    });
    modeGroup.add(allRow);

    const listGroup = new Adw.PreferencesGroup({
        title: listTitle,
        description: names.length === 0
            ? emptyTitle
            : listDescription,
    });
    page.add(listGroup);

    const checkRows = [];
    if (entries.length === 0) {
        listGroup.add(new Adw.ActionRow({
            title: emptyTitle,
            sensitive: false,
        }));
    } else {
        const selected = new Set(saved);
        for (const entry of entries) {
            const row = new Adw.ActionRow({
                title: entry.name,
                subtitle: entry.subtitle || null,
                activatable: true,
            });
            const check = new Gtk.CheckButton({
                active: selected.has(entry.name),
                valign: Gtk.Align.CENTER,
            });
            row.add_prefix(check);
            row.set_activatable_widget(check);
            listGroup.add(row);
            checkRows.push({name: entry.name, check});
        }
    }

    const syncSensitive = () => {
        const all = allRow.get_active();
        for (const {check} of checkRows) {
            check.sensitive = !all;
        }
        listGroup.sensitive = !all && checkRows.length > 0;
    };
    syncSensitive();

    const persistFromChecks = () => {
        if (allRow.get_active())
            return;
        const chosen = checkRows
            .filter(({check}) => check.get_active())
            .map(({name}) => name);
        const stale = saved.filter(n => !present.has(n));
        settings.set_strv(settingKey, normalize(chosen.concat(stale)));
        settings.set_boolean(filterEnabledKey, true);
    };

    allRow.connect('notify::active', () => {
        syncSensitive();
        if (allRow.get_active()) {
            settings.set_boolean(filterEnabledKey, false);
            return;
        }
        persistFromChecks();
    });
    for (const {check} of checkRows)
        check.connect('toggled', persistFromChecks);

    const scrolled = new Gtk.ScrolledWindow({
        vexpand: true,
        hexpand: true,
        child: page,
    });
    toolbar.set_content(scrolled);
    dialog.set_child(toolbar);
    dialog.present(window);
}

async function openDiskDevicesDialog(window, settings) {
    let entries = [];
    try {
        entries = await listPhysicalDiskEntries();
    } catch {
        entries = [];
    }
    openNamedDeviceDialog(window, settings, {
        dialogTitle: _('Disks to monitor'),
        modeDescription: _('Physical whole disks only (not partitions). Turning “monitor all” off uses the ticked disks; none ticked means no disk I/O. The list is kept when monitoring all.'),
        allTitle: _('Monitor all physical disks'),
        allSubtitle: _('When off, rates use only the ticked disks'),
        listTitle: _('Disks'),
        listDescription: _('Rates in the window are the sum of the selected disks.'),
        emptyTitle: _('No physical disks were found on this system.'),
        filterEnabledKey: 'disk-filter-enabled',
        settingKey: 'disk-devices',
        entries,
        normalize: normalizeDiskDevices,
    });
}

async function openNetworkInterfacesDialog(window, settings) {
    let entries = [];
    try {
        entries = await listNetworkInterfaceEntries();
    } catch {
        entries = [];
    }
    openNamedDeviceDialog(window, settings, {
        dialogTitle: _('Interfaces to monitor'),
        modeDescription: _('Hardware network interfaces only (not bridges, virtual, or loopback). Turning “monitor all” off uses the ticked interfaces; none ticked means no network I/O. The list is kept when monitoring all.'),
        allTitle: _('Monitor all interfaces'),
        allSubtitle: _('When off, rates use only the ticked interfaces'),
        listTitle: _('Interfaces'),
        listDescription: _('Rates in the window are the sum of the selected interfaces. Subtitles show interface alias when set.'),
        emptyTitle: _('No hardware network interfaces were found on this system.'),
        filterEnabledKey: 'network-filter-enabled',
        settingKey: 'network-interfaces',
        entries,
        normalize: normalizeNetworkInterfaces,
    });
}

export default class SmotPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        this._window = window;
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(520, 560);
        window.set_title(_('System Monitor on Top Panel'));

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const updateGroup = new Adw.PreferencesGroup({
            title: _('Updates'),
            description: _('How often panel and window values refresh.'),
        });
        page.add(updateGroup);

        const intervalRow = new Adw.SpinRow({
            title: _('Refresh interval'),
            subtitle: _('Seconds'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 60,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('refresh-interval-sec'),
            }),
            digits: 0,
        });
        settings.bind(
            'refresh-interval-sec',
            intervalRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT);
        updateGroup.add(intervalRow);


        const barModes = [
            {id: USAGE_BAR_FIXED, title: _('Fixed')},
            {id: USAGE_BAR_GRADED, title: _('Graded')},
        ];
        const barGroup = new Adw.PreferencesGroup({
            title: _('Usage bar'),
            description: _('CPU, memory used, GPU usage/VRAM, and NPU bars. Fixed keeps the theme accent colour; graded goes from green at 0% through yellow at 50% to red at 100%. Memory and VRAM show absolute size on the right.'),
        });
        page.add(barGroup);
        addComboRow(barGroup, settings, 'usage-bar-appearance', barModes, _('Bar appearance'));

        const [coreCount, nvidia, intel] = await Promise.all([
            detectCoreCount(),
            discoverNvidiaGpus().catch(() => []),
            discoverIntelNpus().catch(() => []),
        ]);
        const hasGpu = nvidia.length > 0;
        const hasNpu = intel.length > 0;

        const coreGroup = new Adw.PreferencesGroup({
            title: _('CPU cores'),
            description: coreCount > PER_CORE_MAX_CORES
                ? _('This system has more than 16 cores. Individual core bars are unavailable; use the histogram or turn core usage off.')
                : _('Show how each core is used, as bars or a histogram.'),
        });
        page.add(coreGroup);
        addCoreDisplayRows(coreGroup, settings, coreCount);

        const memModes = [
            {id: MEMORY_DISPLAY_SIMPLE, title: _('Simple')},
            {id: MEMORY_DISPLAY_DETAILED, title: _('Detailed')},
        ];
        const memGroup = new Adw.PreferencesGroup({
            title: _('Memory'),
            description: _('Used is always a bar (absolute size on the right). Simple also shows Available and Swap. Detailed adds Free, Buffers, File cache, and Shared.'),
        });
        page.add(memGroup);
        addComboRow(memGroup, settings, 'memory-display', memModes, _('Memory display mode'));

        const diskGroup = new Adw.PreferencesGroup({
            title: _('Disk'),
            description: _('Physical whole-disk read/write rates in the window.'),
        });
        page.add(diskGroup);

        const diskRow = new Adw.SwitchRow({
            title: _('Show disk I/O'),
            subtitle: _('Read and write rates for physical disks'),
            active: settings.get_boolean('show-disk-io'),
        });
        settings.bind(
            'show-disk-io',
            diskRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        diskGroup.add(diskRow);

        const diskSelectRow = new Adw.ActionRow({
            title: _('Disks to monitor'),
            subtitle: _('Choose which physical disks contribute to disk I/O rates'),
            activatable: true,
        });
        const diskEditBtn = Gtk.Button.new_from_icon_name('document-edit-symbolic');
        diskEditBtn.set_valign(Gtk.Align.CENTER);
        diskEditBtn.add_css_class('flat');
        const openDisks = () => openDiskDevicesDialog(window, settings);
        diskEditBtn.connect('clicked', openDisks);
        diskSelectRow.connect('activated', openDisks);
        diskSelectRow.add_suffix(diskEditBtn);
        diskGroup.add(diskSelectRow);

        const netGroup = new Adw.PreferencesGroup({
            title: _('Network'),
            description: _('Hardware NIC RX/TX rates in the window.'),
        });
        page.add(netGroup);

        const netRow = new Adw.SwitchRow({
            title: _('Show network I/O'),
            subtitle: _('RX and TX rates for selected hardware interfaces'),
            active: settings.get_boolean('show-network-io'),
        });
        settings.bind(
            'show-network-io',
            netRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        netGroup.add(netRow);

        const netSelectRow = new Adw.ActionRow({
            title: _('Interfaces to monitor'),
            subtitle: _('Choose which interfaces contribute to network I/O rates'),
            activatable: true,
        });
        const netEditBtn = Gtk.Button.new_from_icon_name('document-edit-symbolic');
        netEditBtn.set_valign(Gtk.Align.CENTER);
        netEditBtn.add_css_class('flat');
        const openNets = () => openNetworkInterfacesDialog(window, settings);
        netEditBtn.connect('clicked', openNets);
        netSelectRow.connect('activated', openNets);
        netSelectRow.add_suffix(netEditBtn);
        netGroup.add(netSelectRow);

        const tempGroup = new Adw.PreferencesGroup({
            title: _('Temperature'),
            description: _('Temperature sensors shown in the window. Optionally give them a user friendly name.'),
        });
        page.add(tempGroup);

        const showTempRow = new Adw.SwitchRow({
            title: _('Show temperature'),
            subtitle: _('Temperature section in the window'),
            active: settings.get_boolean('show-temperature'),
        });
        settings.bind(
            'show-temperature',
            showTempRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        tempGroup.add(showTempRow);

        const customiseRow = new Adw.ActionRow({
            title: _('Select and personalize sensors'),
            subtitle: _('Choose sensors and set user friendly descriptions.'),
            activatable: true,
        });
        const editBtn = Gtk.Button.new_from_icon_name('document-edit-symbolic');
        editBtn.set_valign(Gtk.Align.CENTER);
        editBtn.set_tooltip_text(_('Customize'));
        editBtn.add_css_class('flat');
        const openTemps = () => openTemperatureFieldsDialog(window, settings);
        editBtn.connect('clicked', openTemps);
        customiseRow.add_suffix(editBtn);
        customiseRow.connect('activated', openTemps);
        const syncTempCustomise = () => {
            const on = settings.get_boolean('show-temperature');
            customiseRow.sensitive = on;
            editBtn.sensitive = on;
        };
        syncTempCustomise();
        settings.connect('changed::show-temperature', syncTempCustomise);
        tempGroup.add(customiseRow);

        if (hasGpu) {
            const gpuGroup = new Adw.PreferencesGroup({
                title: _('GPU'),
                description: _('NVIDIA GPU cards in the window.'),
            });
            page.add(gpuGroup);
            const showGpuRow = new Adw.SwitchRow({
                title: _('Show GPU'),
                subtitle: _('Usage and VRAM for detected NVIDIA GPUs'),
                active: settings.get_boolean('show-gpu'),
            });
            settings.bind(
                'show-gpu',
                showGpuRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT);
            gpuGroup.add(showGpuRow);
        }

        if (hasNpu) {
            const npuGroup = new Adw.PreferencesGroup({
                title: _('NPU'),
                description: _('Neural processing unit cards in the window.'),
            });
            page.add(npuGroup);
            const showNpuRow = new Adw.SwitchRow({
                title: _('Show NPU'),
                subtitle: _('Usage for detected Intel NPUs'),
                active: settings.get_boolean('show-npu'),
            });
            settings.bind(
                'show-npu',
                showNpuRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT);
            npuGroup.add(showNpuRow);
        }

        const detailModes = [
            {id: DETAIL_VIEW_POPUP, title: _('Popup under panel')},
            {id: DETAIL_VIEW_DOCK, title: _('Dock on the right')},
        ];
        const popupGroup = new Adw.PreferencesGroup({
            title: _('Detail view'),
            description: _('Popup closes when it loses focus. Dock overlays the right edge and stays open until you click the panel icon again.'),
        });
        page.add(popupGroup);
        addComboRow(popupGroup, settings, 'detail-view-mode', detailModes, _('View mode'));
    }
}
