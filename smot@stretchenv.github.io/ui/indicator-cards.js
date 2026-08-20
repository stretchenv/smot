import {
    FORMAT_BYTES_VALUE_PROBE,
    formatBytesFromKb,
    resolveTemperatureRow,
} from '../stats.js';
import {
    DetailSection,
    KeyValueRow,
    MeterRow,
    formatIoFilterBadge,
    makeSmartWarningCard,
    setIoRateLabel,
} from './widgets.js';

/** Disk/net IO, SMART warnings, GPU/NPU cards, temperature rows. */
export const IndicatorCards = {
    _applyIoVisibility() {
        if (this._diskSection)
            this._diskSection.visible = !!this._showDiskIo;
        if (this._netSection)
            this._netSection.visible = !!this._showNetworkIo;
    },

    _updateIoCards(sample) {
        const io = sample?.io || {};
        const filter = sample?.ioFilter || {};
        if (this._showDiskIo) {
            setIoRateLabel(this._diskReadLabel, io.diskRead);
            setIoRateLabel(this._diskWriteLabel, io.diskWrite);
            this._diskSection?.setBadge(formatIoFilterBadge(filter.disk));
            this._updateDiskSmartWarnings(sample?.diskSmart || []);
        } else if (this._diskWarnList) {
            this._diskWarnList.visible = false;
            this._diskSection?.setBadge('');
        }
        if (this._showNetworkIo) {
            setIoRateLabel(this._netInLabel, io.netIn);
            setIoRateLabel(this._netOutLabel, io.netOut);
            this._netSection?.setBadge(formatIoFilterBadge(filter.net));
        } else {
            this._netSection?.setBadge('');
        }
    },

    _ensureDiskWarnRows(count) {
        while (this._diskWarnRows.length < count) {
            const row = makeSmartWarningCard();
            this._diskWarnList.add_child(row.box);
            this._diskWarnRows.push(row);
        }
        for (let i = 0; i < this._diskWarnRows.length; i++)
            this._diskWarnRows[i].box.visible = i < count;
        if (this._diskWarnList)
            this._diskWarnList.visible = count > 0;
    },

    _updateDiskSmartWarnings(warnings) {
        const list = Array.isArray(warnings) ? warnings : [];
        this._ensureDiskWarnRows(list.length);
        for (let i = 0; i < list.length; i++) {
            const w = list[i];
            const row = this._diskWarnRows[i];
            const device = w?.device || 'Drive';
            const message = w?.message || w?.code || 'SMART warning';
            if (row.warningId !== w?.id) {
                row.warningId = w?.id || '';
                row.device.text = device;
                row.message.text = message;
            } else {
                if (row.device.text !== device)
                    row.device.text = device;
                if (row.message.text !== message)
                    row.message.text = message;
            }
        }
    },

    _ensureGpuCards(gpus) {
        while (this._gpuCards.length < gpus.length) {
            const section = new DetailSection('NVIDIA GPU');
            const gpuMeter = {
                valueProbe: FORMAT_BYTES_VALUE_PROBE,
                labelProbe: 'VRAM in use',
            };
            const util = new MeterRow('Usage', gpuMeter);
            util.setAppearance(this._usageBarAppearance);
            const vram = new MeterRow('VRAM in use', gpuMeter);
            vram.setAppearance(this._usageBarAppearance);
            const vramAvail = new KeyValueRow('VRAM Avail', {alt: false});
            const power = new KeyValueRow('Power draw', {alt: true});
            section.addActor(util);
            section.addActor(vram);
            section.addActor(vramAvail);
            section.addActor(power);
            // Keep GPU cards just above Temperature.
            this._cardsBox.insert_child_below(section, this._tempSection);
            this._gpuCards.push({
                section,
                util,
                vram,
                vramAvail,
                power,
                title: '',
            });
            if (this._menuOpen)
                this._runWhenDetailAllocated(() => this._syncPopupFg());
        }
        for (let i = 0; i < this._gpuCards.length; i++)
            this._gpuCards[i].section.visible = i < gpus.length;
    },

    _hideGpuCards() {
        for (const card of this._gpuCards || [])
            card.section.visible = false;
    },

    _hideNpuCards() {
        for (const card of this._npuCards || [])
            card.section.visible = false;
    },

    _updateGpu(sample) {
        if (!this._showGpu) {
            this._hideGpuCards();
            return;
        }
        const gpus = sample.gpus || [];
        this._ensureGpuCards(gpus);
        for (let i = 0; i < gpus.length; i++) {
            const gpu = gpus[i];
            const card = this._gpuCards[i];
            const title = gpu.cardTitle || 'NVIDIA GPU';
            if (title !== card.title) {
                card.title = title;
                card.section.setTitle(title);
            }
            if (gpu.util != null)
                card.util.setPercent(gpu.util);
            else
                card.util.setPercent(0);

            const usedMiB = gpu.memUsedMiB;
            const totalMiB = gpu.memTotalMiB;
            const vramPct = usedMiB != null && totalMiB > 0
                ? (usedMiB / totalMiB) * 100
                : 0;
            const vramText = usedMiB != null
                ? formatBytesFromKb(usedMiB * 1024)
                : '—';
            card.vram.setPercent(vramPct, vramText);
            const availMiB = usedMiB != null && totalMiB != null
                ? Math.max(0, totalMiB - usedMiB)
                : null;
            card.vramAvail.setValue(
                availMiB != null
                    ? formatBytesFromKb(availMiB * 1024)
                    : '—');
            card.power.setValue(
                gpu.powerW != null
                    ? `${Math.round(gpu.powerW)} W`
                    : '—');
        }
    },

    _npuCardTitle() {
        // Intel client NPUs are a single on-SoC instance — no PCI in the title.
        return 'Intel NPU';
    },

    _ensureNpuCards(npus) {
        while (this._npuCards.length < npus.length) {
            const section = new DetailSection('NPU');
            const util = new MeterRow('Usage');
            util.setAppearance(this._usageBarAppearance);
            const mem = new KeyValueRow('Memory in use', {alt: false});
            section.addActor(util);
            section.addActor(mem);
            // After GPU cards, still above Temperature.
            this._cardsBox.insert_child_below(section, this._tempSection);
            this._npuCards.push({
                section,
                util,
                mem,
                pci: '',
                vendor: '',
            });
            if (this._menuOpen)
                this._runWhenDetailAllocated(() => this._syncPopupFg());
        }
        for (let i = 0; i < this._npuCards.length; i++)
            this._npuCards[i].section.visible = i < npus.length;
    },

    _updateNpu(sample) {
        if (!this._showNpu) {
            this._hideNpuCards();
            return;
        }
        const npus = sample.npus || [];
        this._ensureNpuCards(npus);
        for (let i = 0; i < npus.length; i++) {
            const npu = npus[i];
            const card = this._npuCards[i];
            const pci = npu.pciShort || '';
            const vendor = npu.vendor || '';
            if (pci !== card.pci || vendor !== card.vendor) {
                card.pci = pci;
                card.vendor = vendor;
                card.section.setTitle(this._npuCardTitle());
            }
            if (npu.util != null)
                card.util.setPercent(npu.util);
            else
                card.util.setPercent(0);

            card.mem.visible = !!npu.hasMem;
            if (npu.hasMem) {
                card.mem.setValue(
                    npu.memUsedBytes != null
                        ? formatBytesFromKb(npu.memUsedBytes / 1024)
                        : '—');
            }
        }
    },

    _ensureTempRows(count) {
        while (this._tempRows.length < count) {
            const index = this._tempRows.length;
            const row = new KeyValueRow('', {alt: index % 2 === 1});
            this._tempSection.addActor(row);
            this._tempRows.push(row);
        }
        for (let i = 0; i < this._tempRows.length; i++) {
            this._tempRows[i].visible = i < count;
            if (i < count)
                this._tempRows[i].setAlt(i % 2 === 1);
        }
        this._tempSection.visible = this._showTemperature && count > 0;
    },

    _updateTemperature(sample) {
        if (!this._showTemperature) {
            if (this._tempSection)
                this._tempSection.visible = false;
            return;
        }
        const tempCount = sample.tempCount;
        const temps = sample.temperatures || [];
        const visible = [];
        for (let i = 0; i < tempCount; i++) {
            const row = resolveTemperatureRow(temps[i], this._tempConfig);
            if (row)
                visible.push(row);
        }
        visible.sort((a, b) => a.label.localeCompare(b.label, undefined, {
            sensitivity: 'base',
            numeric: true,
        }));
        this._ensureTempRows(visible.length);
        for (let i = 0; i < visible.length; i++) {
            this._tempRows[i].setKey(visible[i].label);
            this._tempRows[i].setValue(`${visible[i].celsius.toFixed(0)}°C`);
        }
    },
};
