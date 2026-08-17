/**
 * Barrel re-exports for prefs.js and extension.js.
 * Implementation lives under ./lib/ (GLib/Gio only — prefs-safe).
 */

export {StatsCollector} from './lib/collector.js';

export {
    temperatureKey,
    parseTemperatureFields,
    serializeTemperatureFields,
    resolveTemperatureRow,
    discoverTemperatureSensors,
} from './lib/temperature.js';

export {normalizePciShort, gpuTempKey, nvidiaGpuCardTitle} from './lib/pci.js';

export {
    discoverNvidiaGpus,
    formatPciSlotLabel,
    resolvePciSlotLabel,
} from './lib/gpu.js';

export {discoverIntelNpus} from './lib/npu.js';

export {
    formatBytesFromKb,
    formatRateParts,
    formatRateBytes,
    formatPercent,
} from './lib/format.js';

export {parseUdisksSmartWarnings} from './lib/smart.js';

export {
    isPhysicalDiskName,
    normalizeDiskDevices,
    listPhysicalDiskNames,
    listPhysicalDiskEntries,
} from './lib/disk.js';

export {
    isCountedNetIface,
    isHardwareNetIface,
    normalizeNetworkInterfaces,
    listNetworkInterfaces,
    listNetworkInterfaceEntries,
} from './lib/net.js';
