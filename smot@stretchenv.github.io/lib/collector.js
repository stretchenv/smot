import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {readIntFile, readUintFile} from './paths.js';
import {parseCpuTimes} from './cpu.js';
import {parseMeminfo} from './memory.js';
import {gpuTempKey} from './pci.js';
import {discoverSensors, MAX_TEMP_SENSORS} from './temperature.js';
import {
    discoverNvidiaGpus,
    findNvidiaSmi,
    MAX_NVIDIA_GPUS,
    NVIDIA_SMI_TIMEOUT_MS,
    parseNvidiaSmiOutput,
} from './gpu.js';
import {discoverIntelNpus} from './npu.js';
import {
    listPhysicalDiskNames,
    normalizeDiskDevices,
    readDiskByteTotals,
} from './disk.js';
import {
    listNetworkInterfaces,
    normalizeNetworkInterfaces,
    readNetByteTotals,
} from './net.js';
import {
    parseUdisksSmartWarnings,
    SMART_DBUS_TIMEOUT_MS,
    SMART_POLL_US,
} from './smart.js';

const SENSOR_RESYNC_US = 60 * 1000 * 1000; // 60s

export class StatsCollector {
    constructor() {
        // Support up to 256 logical CPUs + aggregate without realloc each tick
        this._capacity = 257;
        this._prevIdle = new Float64Array(this._capacity);
        this._prevTotal = new Float64Array(this._capacity);
        this._curIdle = new Float64Array(this._capacity);
        this._curTotal = new Float64Array(this._capacity);
        this._coreUsage = new Float64Array(this._capacity);
        this._havePrev = false;
        this._cpuCount = 0;

        this._memory = {
            total: 0,
            available: 0,
            free: 0,
            used: 0,
            buffers: 0,
            cached: 0,
            sReclaimable: 0,
            fileCache: 0,
            shmem: 0,
            swapTotal: 0,
            swapFree: 0,
            swapUsed: 0,
            percentUsed: 0,
        };
        this._memOk = false;

        this._sensors = [];
        this._sensorsAt = 0;
        this._tempCelsius = new Float64Array(MAX_TEMP_SENSORS + MAX_NVIDIA_GPUS);
        this._tempCount = 0;

        this._nvidiaGpus = [];
        this._nvidiaAt = 0;
        this._smiPath = undefined; // undefined=unresolved, null=missing, string=path
        this._gpuStats = [];
        this._gpuQueryBusy = false;
        this._gpuQuery = null; // {proc, cancellable, timeoutId}

        this._intelNpus = [];
        this._npuAt = 0;
        this._npuPrev = new Map(); // intel key -> {busyUs, wallUs}
        this._intelNpuStats = [];
        this._npuStats = [];

        this._disposed = false;

        this._ioWantDisk = true;
        this._ioWantNet = true;
        this._wantTemp = true;
        this._wantGpu = true;
        this._wantNpu = true;
        this._diskAllow = null; // null = all physical disks; Set = subset
        this._netAllow = null; // null = all ifaces except lo; Set = subset
        this._ioPrev = null; // {atUs, diskRead, diskWrite, netRx, netTx}
        this._ioRates = {
            diskRead: null,
            diskWrite: null,
            netIn: null,
            netOut: null,
        };
        this._ioFilter = {
            disk: null, // {used, total} when subset; null = all
            net: null,
        };

        this._diskSmartWarnings = [];
        this._smartAt = 0;
        this._smartBusy = false;
        this._smartQuery = null; // {cancellable, timeoutId}

        // Stable result object reused every sample
        this._result = {
            cpu: null,
            coreCount: 0,
            coreUsage: this._coreUsage,
            memory: null,
            tempCount: 0,
            temperatures: null, // filled only when detailed
            gpus: null,
            npus: null,
            io: this._ioRates,
            ioFilter: this._ioFilter,
            diskSmart: this._diskSmartWarnings,
            _tempViews: [],
        };
    }

    /** Enable/disable disk and network rate collection (skip /proc reads when off). */
    setIoEnabled({disk = true, net = true} = {}) {
        const wantDisk = !!disk;
        const wantNet = !!net;
        if (wantDisk === this._ioWantDisk && wantNet === this._ioWantNet)
            return;
        this._ioWantDisk = wantDisk;
        this._ioWantNet = wantNet;
        // Drop previous counters so the next enabled sample starts clean.
        this._ioPrev = null;
        this._ioRates.diskRead = null;
        this._ioRates.diskWrite = null;
        this._ioRates.netIn = null;
        this._ioRates.netOut = null;
        if (!wantDisk) {
            this._diskSmartWarnings = [];
            this._result.diskSmart = this._diskSmartWarnings;
            this._abortSmartQuery();
        }
    }

    /**
     * Restrict disk I/O totals to these physical whole-disk names.
     * Empty / omitted → all physical disks.
     */
    setDiskDevices(names) {
        if (this._disposed)
            return;
        const list = normalizeDiskDevices(names);
        const next = list.length === 0 ? null : new Set(list);
        if (this._diskAllow == null && next == null)
            return;
        if (this._diskAllow && next &&
            this._diskAllow.size === next.size &&
            [...next].every(n => this._diskAllow.has(n)))
            return;
        this._diskAllow = next;
        this._ioPrev = null;
        this._ioRates.diskRead = null;
        this._ioRates.diskWrite = null;
    }

    /**
     * Restrict network I/O totals to these interface names (never lo).
     * Empty / omitted → all interfaces except loopback.
     */
    setNetworkInterfaces(names) {
        if (this._disposed)
            return;
        const list = normalizeNetworkInterfaces(names);
        const next = list.length === 0 ? null : new Set(list);
        if (this._netAllow == null && next == null)
            return;
        if (this._netAllow && next &&
            this._netAllow.size === next.size &&
            [...next].every(n => this._netAllow.has(n)))
            return;
        this._netAllow = next;
        this._ioPrev = null;
        this._ioRates.netIn = null;
        this._ioRates.netOut = null;
    }

    /** Enable popup collectors for temperature / GPU / NPU (defaults on). */
    setPopupFeatures({temp = true, gpu = true, npu = true} = {}) {
        if (this._disposed)
            return;
        this._wantTemp = !!temp;
        this._wantGpu = !!gpu;
        this._wantNpu = !!npu;
        if (!this._wantGpu) {
            this._gpuStats = [];
            this._abortExternalQuery('_gpuQuery', '_gpuQueryBusy');
        }
        if (!this._wantNpu) {
            this._npuStats = [];
            this._intelNpuStats = [];
        }
        if (!this._wantTemp)
            this._tempCount = 0;
    }

    /**
     * Cancel in-flight helpers and drop state. Safe to call more than once.
     * Indicator destroy / extension disable must call this.
     */
    dispose() {
        if (this._disposed)
            return;
        this._disposed = true;
        this._abortExternalQuery('_gpuQuery', '_gpuQueryBusy');
        this._abortSmartQuery();
        this._smiPath = null;
    }

    _abortSmartQuery() {
        const q = this._smartQuery;
        this._smartQuery = null;
        this._smartBusy = false;
        if (!q)
            return;
        if (q.timeoutId) {
            GLib.source_remove(q.timeoutId);
            q.timeoutId = 0;
        }
        try {
            q.cancellable?.cancel();
        } catch {
            // ignore
        }
    }

    _abortExternalQuery(slotName, busyName) {
        const q = this[slotName];
        this[slotName] = null;
        this[busyName] = false;
        if (!q)
            return;
        if (q.timeoutId) {
            GLib.source_remove(q.timeoutId);
            q.timeoutId = 0;
        }
        try {
            q.cancellable?.cancel();
        } catch {
            // ignore
        }
        try {
            q.proc?.force_exit();
        } catch {
            // ignore
        }
    }

    _finishExternalQuery(slotName, busyName, query) {
        if (this[slotName] !== query)
            return;
        if (query.timeoutId) {
            GLib.source_remove(query.timeoutId);
            query.timeoutId = 0;
        }
        this[slotName] = null;
        this[busyName] = false;
    }

    _armExternalTimeout(query, timeoutMs) {
        query.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            query.timeoutId = 0;
            try {
                query.cancellable.cancel();
            } catch {
                // ignore
            }
            try {
                query.proc.force_exit();
            } catch {
                // ignore
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _ensureSensors(force = false) {
        const now = GLib.get_monotonic_time();
        if (!force && this._sensors.length > 0 &&
            now - this._sensorsAt < SENSOR_RESYNC_US)
            return;

        this._sensors = discoverSensors();
        this._sensorsAt = now;

        while (this._result._tempViews.length < this._sensors.length + MAX_NVIDIA_GPUS) {
            this._result._tempViews.push({
                chip: '',
                label: '',
                display: '',
                celsius: 0,
            });
        }
    }

    _ensureNvidia(force = false) {
        const now = GLib.get_monotonic_time();
        if (!force && this._nvidiaGpus.length > 0 &&
            now - this._nvidiaAt < SENSOR_RESYNC_US)
            return;

        this._nvidiaGpus = discoverNvidiaGpus();
        this._nvidiaAt = now;
        if (this._smiPath === undefined)
            this._smiPath = findNvidiaSmi();
        if (this._nvidiaGpus.length === 0)
            this._gpuStats = [];
    }

    _kickNvidiaSmiQuery() {
        if (this._disposed || this._gpuQueryBusy)
            return;
        if (this._nvidiaGpus.length === 0)
            return;
        if (this._smiPath === undefined)
            this._smiPath = findNvidiaSmi();
        if (!this._smiPath) {
            this._gpuStats = [];
            return;
        }

        let proc;
        try {
            proc = Gio.Subprocess.new(
                [
                    this._smiPath,
                    '--query-gpu=index,pci.bus_id,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
                    '--format=csv,noheader,nounits',
                ],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
            this._smiPath = null;
            this._gpuStats = [];
            return;
        }

        const gpus = this._nvidiaGpus.slice();
        const query = {
            proc,
            cancellable: new Gio.Cancellable(),
            timeoutId: 0,
        };
        this._gpuQuery = query;
        this._gpuQueryBusy = true;
        this._armExternalTimeout(query, NVIDIA_SMI_TIMEOUT_MS);

        proc.communicate_utf8_async(null, query.cancellable, (p, res) => {
            this._finishExternalQuery('_gpuQuery', '_gpuQueryBusy', query);
            if (this._disposed)
                return;
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                this._gpuStats = parseNvidiaSmiOutput(stdout, gpus);
            } catch {
                // Timeout / kill / failure: keep last good stats
            }
        });
    }

    /** NVIDIA util / VRAM / tempC / power via nvidia-smi (async; uses last good stats). */
    _sampleGpu() {
        if (!this._wantGpu) {
            this._gpuStats = [];
            this._abortExternalQuery('_gpuQuery', '_gpuQueryBusy');
            return;
        }
        this._ensureNvidia(false);
        this._kickNvidiaSmiQuery();
    }

    /**
     * Hwmon/thermal sensors, then optional GPU °C from already-sampled _gpuStats.
     * Call after _sampleGpu() so nvidia-smi results are available to merge.
     */
    _sampleTemps() {
        if (!this._wantTemp) {
            this._tempCount = 0;
            return;
        }

        this._ensureSensors(false);

        let count = 0;
        for (let i = 0; i < this._sensors.length; i++) {
            const milli = readIntFile(this._sensors[i].inputPath);
            if (milli === null)
                continue;
            const celsius = milli / 1000;
            this._tempCelsius[count] = celsius;
            const view = this._result._tempViews[count];
            const sensor = this._sensors[i];
            view.chip = sensor.chip;
            view.label = sensor.label;
            view.display = sensor.display;
            view.celsius = celsius;
            count++;
        }

        count = this._appendGpuTemperatures(count);
        this._tempCount = count;
    }

    /** Merge GPU card temps into the temperature list when GPU monitoring is on. */
    _appendGpuTemperatures(count) {
        if (!this._wantGpu)
            return count;
        for (const gpu of this._gpuStats) {
            if (gpu.tempC == null || count >= this._result._tempViews.length)
                continue;
            const view = this._result._tempViews[count];
            const display = gpuTempKey(gpu.pciShort);
            view.chip = 'gpu';
            view.label = gpu.pciShort;
            view.display = display;
            view.celsius = gpu.tempC;
            this._tempCelsius[count] = gpu.tempC;
            count++;
        }
        return count;
    }

    _ensureNpus(force = false) {
        const now = GLib.get_monotonic_time();
        if (!force && this._intelNpus.length > 0 &&
            now - this._npuAt < SENSOR_RESYNC_US)
            return;

        this._intelNpus = discoverIntelNpus();
        this._npuAt = now;
        if (this._intelNpus.length === 0)
            this._intelNpuStats = [];
        this._mergeNpuStats();
    }

    _mergeNpuStats() {
        this._npuStats = this._intelNpuStats.concat();
    }

    _sampleIntelNpus() {
        const nowUs = GLib.get_monotonic_time();
        const stats = [];

        for (const npu of this._intelNpus) {
            const busyUs = readUintFile(npu.busyPath);
            const key = `intel:${npu.pciShort || npu.busyPath}`;
            const prev = this._npuPrev.get(key);
            let util = null;
            if (busyUs != null && prev && prev.busyUs != null && prev.wallUs != null) {
                const dBusy = busyUs - prev.busyUs;
                const dWall = nowUs - prev.wallUs;
                if (dWall > 0 && dBusy >= 0)
                    util = Math.max(0, Math.min(100, (dBusy / dWall) * 100));
            }
            if (busyUs != null)
                this._npuPrev.set(key, {busyUs, wallUs: nowUs});

            let memUsedBytes = null;
            if (npu.memPath)
                memUsedBytes = readUintFile(npu.memPath);

            stats.push({
                vendor: 'intel',
                pciShort: npu.pciShort || '',
                util,
                memUsedBytes,
                hasMem: !!npu.memPath,
            });
        }

        this._intelNpuStats = stats;
    }

    _sampleNpus() {
        this._ensureNpus(false);
        this._sampleIntelNpus();
        this._mergeNpuStats();
    }

    /**
     * @param {{detailed?: boolean}} [opts]
     * detailed=true reads GPU / temperatures / NPU (menu open). Panel path skips that I/O.
     */
    sample({detailed = false} = {}) {
        if (this._disposed)
            return this._result;

        const count = parseCpuTimes(this._curIdle, this._curTotal);

        let overall = null;
        let coreCount = 0;

        if (this._havePrev && count > 0 && count === this._cpuCount) {
            for (let i = 0; i < count; i++) {
                const totalDelta = this._curTotal[i] - this._prevTotal[i];
                const idleDelta = this._curIdle[i] - this._prevIdle[i];
                const usage = totalDelta > 0
                    ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
                    : 0;
                if (i === 0)
                    overall = usage;
                else
                    this._coreUsage[i - 1] = usage;
            }
            coreCount = Math.max(0, count - 1);
        }

        // Swap buffers (pointer swap — no per-tick copies)
        const tmpIdle = this._prevIdle;
        const tmpTotal = this._prevTotal;
        this._prevIdle = this._curIdle;
        this._prevTotal = this._curTotal;
        this._curIdle = tmpIdle;
        this._curTotal = tmpTotal;
        this._cpuCount = count;
        this._havePrev = count > 0;

        this._memOk = parseMeminfo(this._memory);
        this._sampleIoRates();
        this._ensureSmart(false);

        if (detailed) {
            if (this._wantGpu)
                this._sampleGpu();
            else {
                this._gpuStats = [];
                this._abortExternalQuery('_gpuQuery', '_gpuQueryBusy');
            }
            if (this._wantTemp)
                this._sampleTemps();
            else
                this._tempCount = 0;
            if (this._wantNpu)
                this._sampleNpus();
            else {
                this._npuStats = [];
                this._intelNpuStats = [];
            }
        } else {
            this._tempCount = 0;
        }

        const result = this._result;
        result.cpu = overall;
        result.coreCount = coreCount;
        result.coreUsage = this._coreUsage;
        result.memory = this._memOk ? this._memory : null;
        result.tempCount = detailed && this._wantTemp ? this._tempCount : 0;
        result.temperatures = detailed && this._wantTemp ? this._result._tempViews : null;
        result.gpus = detailed && this._wantGpu && this._gpuStats.length > 0
            ? this._gpuStats
            : null;
        result.npus = detailed && this._wantNpu && this._npuStats.length > 0
            ? this._npuStats
            : null;
        result.io = this._ioRates;
        result.ioFilter = this._ioFilter;
        result.diskSmart = this._diskSmartWarnings;
        return result;
    }

    _ensureSmart(force = false) {
        if (this._disposed)
            return;
        if (!this._ioWantDisk) {
            this._diskSmartWarnings = [];
            return;
        }
        const now = GLib.get_monotonic_time();
        if (!force && this._smartAt > 0 && now - this._smartAt < SMART_POLL_US)
            return;
        this._kickSmartScan();
    }

    _kickSmartScan() {
        if (this._disposed || this._smartBusy || !this._ioWantDisk)
            return;

        const cancellable = new Gio.Cancellable();
        const query = {cancellable, timeoutId: 0};
        this._smartQuery = query;
        this._smartBusy = true;
        query.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SMART_DBUS_TIMEOUT_MS, () => {
            query.timeoutId = 0;
            try {
                cancellable.cancel();
            } catch {
                // ignore
            }
            return GLib.SOURCE_REMOVE;
        });

        Gio.DBus.system.call(
            'org.freedesktop.UDisks2',
            '/org/freedesktop/UDisks2',
            'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            SMART_DBUS_TIMEOUT_MS,
            cancellable,
            (connection, res) => {
                if (this._smartQuery === query) {
                    if (query.timeoutId) {
                        GLib.source_remove(query.timeoutId);
                        query.timeoutId = 0;
                    }
                    this._smartQuery = null;
                    this._smartBusy = false;
                }
                if (this._disposed || !this._ioWantDisk)
                    return;
                try {
                    const reply = connection.call_finish(res);
                    const unpacked = reply.deep_unpack();
                    const objects = Array.isArray(unpacked) ? unpacked[0] : unpacked;
                    this._diskSmartWarnings = parseUdisksSmartWarnings(objects);
                    this._result.diskSmart = this._diskSmartWarnings;
                    this._smartAt = GLib.get_monotonic_time();
                } catch {
                    // Keep last good warnings on timeout / missing udisks
                }
            });
    }

    _sampleIoRates() {
        const rates = this._ioRates;
        const filter = this._ioFilter;
        rates.diskRead = null;
        rates.diskWrite = null;
        rates.netIn = null;
        rates.netOut = null;
        filter.disk = null;
        filter.net = null;

        const wantDisk = this._ioWantDisk;
        const wantNet = this._ioWantNet;
        if (!wantDisk && !wantNet) {
            this._ioPrev = null;
            return;
        }

        if (wantDisk && this._diskAllow) {
            const all = listPhysicalDiskNames();
            let used = 0;
            for (const name of all) {
                if (this._diskAllow.has(name))
                    used++;
            }
            filter.disk = {used, total: all.length};
        }
        if (wantNet && this._netAllow) {
            const all = listNetworkInterfaces();
            let used = 0;
            for (const name of all) {
                if (this._netAllow.has(name))
                    used++;
            }
            filter.net = {used, total: all.length};
        }

        const disk = wantDisk ? readDiskByteTotals(this._diskAllow) : null;
        const net = wantNet ? readNetByteTotals(this._netAllow) : null;
        const nowUs = GLib.get_monotonic_time();
        const prev = this._ioPrev;

        if (prev && nowUs > prev.atUs) {
            const dt = (nowUs - prev.atUs) / 1e6;
            if (dt > 0) {
                if (wantDisk && disk && prev.diskRead != null && prev.diskWrite != null) {
                    const dr = disk.readBytes - prev.diskRead;
                    const dw = disk.writeBytes - prev.diskWrite;
                    if (dr >= 0)
                        rates.diskRead = dr / dt;
                    if (dw >= 0)
                        rates.diskWrite = dw / dt;
                }
                if (wantNet && net && prev.netRx != null && prev.netTx != null) {
                    const ri = net.rxBytes - prev.netRx;
                    const ro = net.txBytes - prev.netTx;
                    if (ri >= 0)
                        rates.netIn = ri / dt;
                    if (ro >= 0)
                        rates.netOut = ro / dt;
                }
            }
        }

        this._ioPrev = {
            atUs: nowUs,
            diskRead: disk ? disk.readBytes : null,
            diskWrite: disk ? disk.writeBytes : null,
            netRx: net ? net.rxBytes : null,
            netTx: net ? net.txBytes : null,
        };
    }

    /** Force sensor rediscovery (e.g. on menu open after resume). */
    resyncSensors() {
        if (this._disposed)
            return;
        this._ensureSensors(true);
        this._ensureNvidia(true);
        this._ensureNpus(true);
        this._smiPath = undefined;
        this._ensureSmart(true);
    }
}
