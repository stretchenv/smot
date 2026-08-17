import Gio from 'gi://Gio';

import {isAllowedPath, readIntFile, readText} from './paths.js';
import {sanitizeInstance, sanitizeLabel} from './sanitize.js';
import {gpuTempKey} from './pci.js';
import {discoverNvidiaGpus} from './gpu.js';

export const MAX_TEMP_SENSORS = 32;
export const MAX_TEMP_DESCRIPTION_LEN = 64;
export const MAX_TEMP_KEY_LEN = 128;

export function sensorPriority(chip, label) {
    const blob = `${chip} ${label}`.toLowerCase();
    if (blob.includes('package') || blob.includes('tctl') ||
        blob.includes('tdie') || blob.includes('x86_pkg'))
        return 0;
    if (chip === 'coretemp' || blob.includes('cpu'))
        return 1;
    return 5;
}

function readHwmonDeviceAttr(hwmonBase, attr) {
    return sanitizeInstance(readText(`${hwmonBase}/device/${attr}`)?.trim());
}

/** Basename of hwmon device symlink (e.g. i2c `1-0018`, `nvme0`, `coretemp.0`). */
function readHwmonDeviceBasename(hwmonBase) {
    try {
        const file = Gio.File.new_for_path(`${hwmonBase}/device`);
        const info = file.query_info(
            'standard::symlink-target',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null);
        const target = info.get_symlink_target();
        if (!target)
            return '';
        const parts = target.split('/').filter(p => p && p !== '.' && p !== '..');
        return sanitizeInstance(parts[parts.length - 1] || '');
    } catch {
        return '';
    }
}

function isI2cClientName(name) {
    // Typical SPD/DIMM thermal chips: bus-addr like 1-0018 / 0-0050
    return /^\d{1,2}-[0-9a-f]{4}$/i.test(name);
}

/**
 * Stable instance id for settings keys — never depends on sibling count.
 * Prefer human-readable model, always bake in a device-unique suffix when known
 * (serial / PCI / i2c / nvmeN / platform basename) so adding another similar
 * device later does not rename existing keys. Avoid bare hwmonN — it renumbers.
 */
function resolveChipInstance(hwmonBase, chip, hwmonName) {
    const model = readHwmonDeviceAttr(hwmonBase, 'model');
    const serial = readHwmonDeviceAttr(hwmonBase, 'serial');
    const address = readHwmonDeviceAttr(hwmonBase, 'address');
    const devBase = readHwmonDeviceBasename(hwmonBase);
    const shortSerial = serial ? serial.replace(/\s+/g, '').slice(-6) : '';
    const shortAddress = address ? address.replace(/^0000:/, '') : '';

    // Stable unique tokens only (not hwmonN).
    const stableId = shortSerial
        || shortAddress
        || (isI2cClientName(devBase) ? devBase : '')
        || (devBase && devBase !== chip ? devBase : '');

    // Address / i2c / block-device forms already include the unique token.
    if (!model && shortAddress)
        return `${chip} ${shortAddress}`;
    if (!model && isI2cClientName(devBase))
        return `${chip} ${devBase}`;
    if (!model && (chip === 'nvme' || chip === 'drivetemp'))
        return `${chip} (${devBase || hwmonName})`;

    const head = model || chip;
    if (stableId && stableId !== head && !head.includes(stableId))
        return `${head} (${stableId})`;
    return head;
}

function packageIdFromLabel(label) {
    if (!label)
        return null;
    const m = /^Package id (\d+)$/i.exec(label);
    return m ? m[1] : null;
}

/**
 * Build a stable display / settings key.
 * - CPU: Package N for multi-socket coretemp
 * - Storage/PCI/i2c: instance already includes serial/address/dev name
 */
function formatSensorDisplay(instance, label, packageId) {
    const head = instance || 'sensor';
    if (packageId != null) {
        if (/^Package id \d+$/i.test(label))
            return `${head} · Package ${packageId}`;
        return `${head} · Package ${packageId} · ${label}`;
    }
    return label !== head ? `${head} · ${label}` : head;
}

export function makeGpuTempSensor(pciShort) {
    const display = gpuTempKey(pciShort);
    return {
        chip: 'gpu',
        instance: display,
        label: pciShort,
        packageId: null,
        inputPath: '',
        priority: 2,
        display,
        synthetic: true,
    };
}

/** Used by collector and discoverTemperatureSensors; not re-exported from barrel. */
export function discoverSensors() {
    const found = [];

    try {
        const hwmonDir = Gio.File.new_for_path('/sys/class/hwmon');
        const enumerator = hwmonDir.enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            null);

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const hwmonName = info.get_name();
            if (!/^hwmon\d{1,3}$/.test(hwmonName))
                continue;

            const base = `/sys/class/hwmon/${hwmonName}`;
            const chip = sanitizeLabel(readText(`${base}/name`)?.trim()) || hwmonName;
            const instance = resolveChipInstance(base, chip, hwmonName);

            const temps = [];
            let packageId = null;
            for (let i = 1; i <= 16; i++) {
                const inputPath = `${base}/temp${i}_input`;
                if (!isAllowedPath(inputPath))
                    continue;
                if (readIntFile(inputPath) === null)
                    continue;

                const label = sanitizeLabel(
                    readText(`${base}/temp${i}_label`)?.trim()) || `temp${i}`;
                const pkg = packageIdFromLabel(label);
                if (pkg != null)
                    packageId = pkg;
                temps.push({label, inputPath});
            }

            if (temps.length === 0)
                continue;

            for (const temp of temps) {
                found.push({
                    chip,
                    instance,
                    label: temp.label,
                    packageId,
                    inputPath: temp.inputPath,
                    priority: sensorPriority(chip, temp.label),
                    display: formatSensorDisplay(instance, temp.label, packageId),
                });
            }
        }
        enumerator.close(null);
    } catch {
        // hwmon unavailable
    }

    if (found.length === 0) {
        for (let i = 0; i < 16; i++) {
            const typePath = `/sys/class/thermal/thermal_zone${i}/type`;
            const tempPath = `/sys/class/thermal/thermal_zone${i}/temp`;
            const type = sanitizeLabel(readText(typePath)?.trim());
            if (!type || readIntFile(tempPath) === null)
                continue;
            // Include zone index so duplicate type names stay unique/stable.
            const instance = `${type} (thermal_zone${i})`;
            found.push({
                chip: 'thermal',
                instance,
                label: type,
                packageId: null,
                inputPath: tempPath,
                priority: sensorPriority('thermal', type),
                display: instance,
            });
        }
    }

    found.sort((a, b) => a.priority - b.priority || a.display.localeCompare(b.display));
    return found.slice(0, MAX_TEMP_SENSORS);
}

/** Stable UI/settings key for a sensor (device id is always embedded when known). */
export function temperatureKey(sensor) {
    if (!sensor)
        return '';
    if (sensor.display)
        return sensor.display;
    return formatSensorDisplay(
        sensor.instance || sensor.chip || '',
        sensor.label || '',
        sensor.packageId ?? null);
}

/**
 * Parse temperature-fields gsetting JSON.
 * Shape: { "<key>": { enabled: bool, description: string }, ... }
 */
export function parseTemperatureFields(raw) {
    let obj;
    try {
        obj = JSON.parse(typeof raw === 'string' && raw ? raw : '{}');
    } catch {
        return {};
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj))
        return {};

    const out = {};
    for (const [key, val] of Object.entries(obj)) {
        if (typeof key !== 'string' || !key || key.length > MAX_TEMP_KEY_LEN)
            continue;
        if (!val || typeof val !== 'object' || Array.isArray(val))
            continue;
        let description = '';
        if (typeof val.description === 'string') {
            description = sanitizeLabel(val.description).slice(0, MAX_TEMP_DESCRIPTION_LEN);
        }
        out[key] = {
            enabled: val.enabled !== false,
            description,
        };
    }
    return out;
}

export function serializeTemperatureFields(map) {
    const out = {};
    if (map && typeof map === 'object') {
        for (const [key, val] of Object.entries(map)) {
            if (typeof key !== 'string' || !key)
                continue;
            out[key] = {
                enabled: !!(val && val.enabled),
                description: typeof val?.description === 'string'
                    ? sanitizeLabel(val.description).slice(0, MAX_TEMP_DESCRIPTION_LEN)
                    : '',
            };
        }
    }
    return JSON.stringify(out);
}

/**
 * Apply saved field preferences to a sampled temperature.
 * @returns {{key: string, label: string, celsius: number}|null} null = hidden
 */
export function resolveTemperatureRow(temp, config) {
    if (!temp)
        return null;
    const key = temperatureKey(temp);
    if (!key)
        return null;
    const entry = config && config[key];
    // No saved match → always show (new/renamed sensors stay visible).
    if (entry && entry.enabled === false)
        return null;
    const custom = entry?.description?.trim();
    return {
        key,
        label: custom || key,
        celsius: temp.celsius,
    };
}

/** Discover sensors for prefs UI (same path allowlist as the panel collector). */
export function discoverTemperatureSensors() {
    const sensors = discoverSensors();
    for (const gpu of discoverNvidiaGpus()) {
        sensors.push(makeGpuTempSensor(gpu.pciShort));
    }
    return sensors;
}
