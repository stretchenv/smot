export const NVIDIA_VENDOR = '0x10de';
export const INTEL_VENDOR = '0x8086';

/** Short PCI BDF: 01:00.0 (from 0000:01:00.0 or nvidia-smi 00000000:01:00.0). */
export function normalizePciShort(busId) {
    if (typeof busId !== 'string')
        return '';
    const m = /([0-9a-f]{2}:[0-9a-f]{2}\.[0-7])$/i.exec(busId.trim());
    return m ? m[1].toLowerCase() : '';
}

export function pciShortFromUevent(text) {
    if (typeof text !== 'string')
        return '';
    const m = /^PCI_SLOT_NAME=([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7])$/im.exec(text);
    return m ? normalizePciShort(m[1]) : '';
}

export function gpuTempKey(pciShort) {
    return `gpu · ${pciShort}`;
}

/** Card title: NVIDIA GPU <nvidia-smi index>, or plain name if index unknown. */
export function nvidiaGpuCardTitle(index) {
    if (!Number.isInteger(index) || index < 0 || index > 99)
        return 'NVIDIA GPU';
    return `NVIDIA GPU ${index}`;
}
