// VirtIO MMIO Block Driver for tsos
import {
    peek8,
    poke8,
    peek16,
    poke16,
    peek32,
    poke32,
    peek64,
    poke64,
    print,
    printHex64,
    shl64,
    lshr64,
} from "./uart.ts";
import { alloc_page, dsb_ish, get_page_size } from "./mmu.ts";
const VIRTIO_MMIO_MAGIC_VALUE         = 0x000n; // 0x74726976
const VIRTIO_MMIO_VERSION             = 0x004n; // 1 = legacy, 2 = modern
const VIRTIO_MMIO_DEVICE_ID           = 0x008n; // 2 = block
const VIRTIO_MMIO_VENDOR_ID           = 0x00cn;
const VIRTIO_MMIO_DEVICE_FEATURES     = 0x010n;
const VIRTIO_MMIO_DEVICE_FEATURES_SEL = 0x014n;
const VIRTIO_MMIO_DRIVER_FEATURES     = 0x020n;
const VIRTIO_MMIO_DRIVER_FEATURES_SEL = 0x024n;
const VIRTIO_MMIO_QUEUE_SEL           = 0x030n;
const VIRTIO_MMIO_QUEUE_NUM_MAX       = 0x034n;
const VIRTIO_MMIO_QUEUE_NUM           = 0x038n;
const VIRTIO_MMIO_QUEUE_READY         = 0x044n;
const VIRTIO_MMIO_QUEUE_NOTIFY        = 0x050n;
const VIRTIO_MMIO_INTERRUPT_STATUS    = 0x060n;
const VIRTIO_MMIO_INTERRUPT_ACK       = 0x064n;
const VIRTIO_MMIO_STATUS              = 0x070n;
const VIRTIO_MMIO_QUEUE_DESC_LOW      = 0x080n;
const VIRTIO_MMIO_QUEUE_DESC_HIGH     = 0x084n;
const VIRTIO_MMIO_QUEUE_DRIVER_LOW    = 0x090n;
const VIRTIO_MMIO_QUEUE_DRIVER_HIGH   = 0x094n;
const VIRTIO_MMIO_QUEUE_DEVICE_LOW    = 0x0a0n;
const VIRTIO_MMIO_QUEUE_DEVICE_HIGH   = 0x0a4n;
const VIRTIO_MMIO_CONFIG              = 0x100n;

// VirtIO Status Bits
const VIRTIO_STATUS_ACKNOWLEDGE = 1 as u32;
const VIRTIO_STATUS_DRIVER      = 2 as u32;
const VIRTIO_STATUS_DRIVER_OK   = 4 as u32;
const VIRTIO_STATUS_FEATURES_OK = 8 as u32;

// VirtIO Block Request Types
const VIRTIO_BLK_T_IN  = 0 as u32; // Read
const VIRTIO_BLK_T_OUT = 1 as u32; // Write

// VirtIO Descriptor Flags
const VIRTQ_DESC_F_NEXT  = 1 as u16;
const VIRTQ_DESC_F_WRITE = 2 as u16;

const QUEUE_SIZE: u64 = 16n;

let virtio_blk_base: bigint = 0n;
let blk_capacity_sectors: u64 = 0n;

// Memory buffers inside allocated queue page
let queue_page: bigint = 0n;
let desc_table: bigint = 0n;
let avail_ring: bigint = 0n;
let used_ring: bigint = 0n;
let req_header: bigint = 0n;
let req_status: bigint = 0n;
let bounce_buf: bigint = 0n;

let last_used_idx: u16 = 0 as u16;


/**
 * Probes the VirtIO MMIO bus (0x0a000000 .. 0x0a003e00) for a block device.
 */
export function virtio_blk_init(): boolean {
    print("[virtio-blk] Probing VirtIO MMIO transports...\n");

    let found_base: bigint = 0n;

    for (let i = 0n; i < 32n; i = i + 1n) {
        const base = 0x0a000000n + i * 0x200n;
        const magic = peek32(base + VIRTIO_MMIO_MAGIC_VALUE);
        if (magic !== (0x74726976 as u32)) {
            continue;
        }

        const dev_id = peek32(base + VIRTIO_MMIO_DEVICE_ID);
        const version = peek32(base + VIRTIO_MMIO_VERSION);

        if (dev_id === (2 as u32)) {
            print("[virtio-blk] Found VirtIO block device at MMIO 0x");
            printHex64(base);
            print(", version: 0x");
            printHex64(version as u64);
            print("\n");
            found_base = base;
            break;
        }
    }

    if (found_base === 0n) {
        print("[virtio-blk] No VirtIO block device found!\n");
        return false;
    }

    virtio_blk_base = found_base;
    const version = peek32(virtio_blk_base + VIRTIO_MMIO_VERSION);

    // Reset device
    poke32(virtio_blk_base + VIRTIO_MMIO_STATUS, 0 as u32);
    dsb_ish();

    // Acknowledge
    let status = VIRTIO_STATUS_ACKNOWLEDGE;
    poke32(virtio_blk_base + VIRTIO_MMIO_STATUS, status);

    // Driver
    status = status | VIRTIO_STATUS_DRIVER;
    poke32(virtio_blk_base + VIRTIO_MMIO_STATUS, status);

    if (version === (2 as u32)) {
        // Modern VirtIO 1.0 (v2) feature negotiation
        poke32(virtio_blk_base + VIRTIO_MMIO_DEVICE_FEATURES_SEL, 1 as u32);
        poke32(virtio_blk_base + VIRTIO_MMIO_DRIVER_FEATURES_SEL, 1 as u32);
        poke32(virtio_blk_base + VIRTIO_MMIO_DRIVER_FEATURES, 1 as u32); // VIRTIO_F_VERSION_1

        poke32(virtio_blk_base + VIRTIO_MMIO_DRIVER_FEATURES_SEL, 0 as u32);
        poke32(virtio_blk_base + VIRTIO_MMIO_DRIVER_FEATURES, 0 as u32);

        status = status | VIRTIO_STATUS_FEATURES_OK;
        poke32(virtio_blk_base + VIRTIO_MMIO_STATUS, status);
        dsb_ish();
    }

    // Configure Virtqueue 0
    poke32(virtio_blk_base + VIRTIO_MMIO_QUEUE_SEL, 0 as u32);
    const q_max = peek32(virtio_blk_base + VIRTIO_MMIO_QUEUE_NUM_MAX);
    if (q_max === (0 as u32)) {
        print("[virtio-blk] Error: Queue 0 not available!\n");
        return false;
    }

    poke32(virtio_blk_base + VIRTIO_MMIO_QUEUE_NUM, QUEUE_SIZE as u32);

    // Allocate memory for virtqueue structures
    // Page 0: Descriptors (0..255) + Avail Ring (256..293)
    // Page 1: Used Ring (4096..4231) + Req Header (4256) + Req Status (4280) + Bounce Buffer
    // The legacy layout (QueueAlign = 4096) places the used ring 4096 bytes
    // after the descriptor table, so "page 1" is a 4KB offset, not a granule.
    queue_page = alloc_page();
    if (get_page_size() === 4096n) {
        alloc_page();
    }
    const queue_page_1 = queue_page + 4096n;

    desc_table = queue_page;
    avail_ring = queue_page + 256n;
    used_ring  = queue_page_1;
    req_header = queue_page_1 + 256n;
    req_status = queue_page_1 + 288n;
    bounce_buf = queue_page_1 + 512n;

    // (alloc_page already returns zeroed memory)

    if (version === (1 as u32)) {
        // Legacy MMIO: write GuestPageSize (0x028), QueueAlign (0x03c) and QueuePFN (0x040)
        poke32(virtio_blk_base + 0x028n, 4096 as u32);
        poke32(virtio_blk_base + 0x03cn, 4096 as u32);
        const pfn = (lshr64(desc_table, 12n) & 0xffffffffn) as u32;
        poke32(virtio_blk_base + 0x040n, pfn);
    } else {
        // Modern MMIO: write Desc, Driver, Device addresses and QueueReady
        poke32(virtio_blk_base + VIRTIO_MMIO_QUEUE_DESC_LOW, (desc_table & 0xffffffffn) as u32);
        poke32(virtio_blk_base + VIRTIO_MMIO_QUEUE_DESC_HIGH, lshr64(desc_table, 32n) as u32);

        poke32(virtio_blk_base + VIRTIO_MMIO_QUEUE_DRIVER_LOW, (avail_ring & 0xffffffffn) as u32);
        poke32(virtio_blk_base + VIRTIO_MMIO_QUEUE_DRIVER_HIGH, lshr64(avail_ring, 32n) as u32);

        poke32(virtio_blk_base + VIRTIO_MMIO_QUEUE_DEVICE_LOW, (used_ring & 0xffffffffn) as u32);
        poke32(virtio_blk_base + VIRTIO_MMIO_QUEUE_DEVICE_HIGH, lshr64(used_ring, 32n) as u32);

        poke32(virtio_blk_base + VIRTIO_MMIO_QUEUE_READY, 1 as u32);
    }

    // Driver OK
    status = status | VIRTIO_STATUS_DRIVER_OK;
    poke32(virtio_blk_base + VIRTIO_MMIO_STATUS, status);
    dsb_ish();
    // Read device capacity (sectors)
    const cap_low = peek32(virtio_blk_base + VIRTIO_MMIO_CONFIG) as u64;
    const cap_high = peek32(virtio_blk_base + VIRTIO_MMIO_CONFIG + 4n) as u64;
    blk_capacity_sectors = shl64(cap_high, 32n) | cap_low;

    print("[virtio-blk] Initialized successfully! Capacity: ");
    printHex64(blk_capacity_sectors);
    print(" sectors (");
    printHex64(lshr64(blk_capacity_sectors * 512n, 20n));
    print(" MB)\n");

    return true;
}

export function virtio_blk_get_capacity(): u64 {
    return blk_capacity_sectors;
}

/**
 * Synchronously reads or writes 512-byte sectors.
 * @param sector Starting sector number
 * @param count Number of sectors (1..4 if using bounce buffer, or up to arbitrary if dest_buf is provided)
 * @param buf_pa Physical address of buffer
 * @param is_write true for write, false for read
 */
export function virtio_blk_rw(sector: u64, count: u64, buf_pa: bigint, is_write: boolean): boolean {
    if (virtio_blk_base === 0n) {
        print("[virtio-blk] Error: device not initialized\n");
        return false;
    }

    // Set request header: type (u32), reserved (u32), sector (u64)
    poke32(req_header + 0n, is_write ? VIRTIO_BLK_T_OUT : VIRTIO_BLK_T_IN);
    poke32(req_header + 4n, 0 as u32);
    poke64(req_header + 8n, sector);

    // Initialize status byte to 0xff
    poke8(req_status, 0xff as u8);

    const total_bytes = (count * 512n) as u32;

    // Desc 0: Header (device reads)
    // Descriptor format: addr (u64, 8B), len (u32, 4B), flags (u16, 2B), next (u16, 2B)
    poke64(desc_table + 0n, req_header);
    poke32(desc_table + 8n, 16 as u32);
    poke16(desc_table + 12n, VIRTQ_DESC_F_NEXT);
    poke16(desc_table + 14n, 1 as u16);

    // Desc 1: Data buffer
    const data_flags = (is_write ? (0 as u16) : VIRTQ_DESC_F_WRITE) | VIRTQ_DESC_F_NEXT;
    poke64(desc_table + 16n, buf_pa);
    poke32(desc_table + 24n, total_bytes);
    poke16(desc_table + 28n, data_flags);
    poke16(desc_table + 30n, 2 as u16);

    // Desc 2: Status (device writes 1 byte)
    poke64(desc_table + 32n, req_status);
    poke32(desc_table + 40n, 1 as u32);
    poke16(desc_table + 44n, VIRTQ_DESC_F_WRITE);
    poke16(desc_table + 46n, 0 as u16);

    dsb_ish();

    // Place Desc 0 into available ring
    // avail_ring format: flags (u16), idx (u16), ring[Q_SIZE] (u16 each)
    const avail_idx = peek16(avail_ring + 2n) as u16;
    const ring_offset = 4n + ((avail_idx as u64) & (QUEUE_SIZE - 1n)) * 2n;
    poke16(avail_ring + ring_offset, 0 as u16);

    dsb_ish();

    const next_avail_idx = (avail_idx + (1 as u16)) as u16;
    poke16(avail_ring + 2n, next_avail_idx);

    dsb_ish();

    // Notify queue 0
    poke32(virtio_blk_base + VIRTIO_MMIO_QUEUE_NOTIFY, 0 as u32);

    // Poll for completion in used ring
    // used_ring format: flags (u16), idx (u16), ring[Q_SIZE] (id: u32, len: u32)
    let spin: u64 = 0n;
    while (true) {
        dsb_ish();
        const current_used = peek16(used_ring + 2n) as u16;
        if (current_used !== last_used_idx) {
            last_used_idx = current_used;
            break;
        }
        spin = spin + 1n;
        if (spin > 10000000n) {
            print("[virtio-blk] Timeout waiting for request!\n");
            return false;
        }
    }

    const st = peek8(req_status);
    if (st !== (0 as u8)) {
        print("[virtio-blk] Request failed with status: 0x");
        printHex64(st as u64);
        print("\n");
        return false;
    }

    return true;
}

export function virtio_blk_read(sector: u64, count: u64, buf_pa: bigint): boolean {
    return virtio_blk_rw(sector, count, buf_pa, false);
}

export function virtio_blk_write(sector: u64, count: u64, buf_pa: bigint): boolean {
    return virtio_blk_rw(sector, count, buf_pa, true);
}
