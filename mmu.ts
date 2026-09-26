// AArch64 MMU Setup and Multi-level Paging (4KB and 16KB granules)

declare const CONFIG_USE_16K: boolean;
declare function print(s: string): void;
declare function printHex64(v: u64): void;
declare function poke64(addr: bigint, val: u64): void;
declare function peek64(addr: bigint): u64;
declare function lshr64(v: u64, shift: u64): u64;
declare function shl64(v: u64, shift: u64): u64;

function isb(): void {
    inline_asm("isb", "");
}

function dsb_ish(): void {
    inline_asm("dsb ish", "");
}

function tlbi_all(): void {
    inline_asm("tlbi vmalle1is", "");
}

function tlbi_va(va_page: u64): void {
    inline_asm("tlbi vaae1is, $0", "r", va_page);
}

function write_mair_el1(val: u64): void {
    inline_asm("msr mair_el1, $0", "r", val);
}

function write_tcr_el1(val: u64): void {
    inline_asm("msr tcr_el1, $0", "r", val);
}

function write_ttbr0_el1(val: u64): void {
    inline_asm("msr ttbr0_el1, $0", "r", val);
}

function read_sctlr_el1(): u64 {
    return inline_asm<u64>("mrs $0, sctlr_el1", "=r");
}

function write_sctlr_el1(val: u64): void {
    inline_asm("msr sctlr_el1, $0", "r", val);
}

function get_kernel_end(): bigint {
    return inline_asm<u64>("adrp $0, _kernel_end\nadd $0, $0, :lo12:_kernel_end", "=r");
}

// --- Page Allocator ---

let next_free_page: bigint = 0n;

function init_allocator(): void {
    next_free_page = get_kernel_end();
    const align_mask = 16383n;
    if ((next_free_page & align_mask) != 0n) {
        next_free_page = (next_free_page + 16384n) & ~align_mask;
    }
}

function alloc_page(): bigint {
    const page = next_free_page;
    if (CONFIG_USE_16K) {
        next_free_page = next_free_page + 16384n;
        for (let i = 0n; i < 2048n; i = i + 1n) {
            poke64(page + i * 8n, 0n);
        }
    } else {
        next_free_page = next_free_page + 4096n;
        for (let i = 0n; i < 512n; i = i + 1n) {
            poke64(page + i * 8n, 0n);
        }
    }
    return page;
}

// --- Descriptor Constants ---

const ATTR_DEVICE: u64 = 0n;
const ATTR_NORMAL: u64 = 1n;

const FLAG_PAGE: u64 = 3n;
const FLAG_TABLE: u64 = 3n;
const FLAG_AF: u64 = 1n << 10n;
const FLAG_SH_INNER: u64 = 3n << 8n;
const FLAG_UXN: u64 = shl64(1n, 54n);
const FLAG_PXN: u64 = shl64(1n, 53n);

let root_table: bigint = 0n;

/**
 * Maps a virtual page to a physical frame.
 * Supports both 4KB (L1 -> L2 -> L3) and 16KB (L2 -> L3) translation schemes.
 */
function map_page(va: bigint, pa: bigint, is_device: boolean): void {
    if (CONFIG_USE_16K) {
        // 16KB Granule, 36-bit VA: Level 2 -> Level 3
        const l2_idx = lshr64(va, 25n) & 0x7ffn; // bits [35:25]
        const l3_idx = lshr64(va, 14n) & 0x7ffn; // bits [24:14]

        let l2_entry = peek64(root_table + l2_idx * 8n);
        let l3_table: bigint = 0n;
        if ((l2_entry & 1n) == 0n) {
            l3_table = alloc_page();
            poke64(root_table + l2_idx * 8n, l3_table | FLAG_TABLE);
        } else {
            l3_table = l2_entry & ~0x3fffn;
        }

        let attrs: u64 = FLAG_PAGE | FLAG_AF;
        if (is_device) {
            attrs = attrs | shl64(ATTR_DEVICE, 2n) | FLAG_UXN | FLAG_PXN;
        } else {
            attrs = attrs | shl64(ATTR_NORMAL, 2n) | FLAG_SH_INNER;
        }
        poke64(l3_table + l3_idx * 8n, (pa & ~0x3fffn) | attrs);

        // Flush TLB for this single page
        dsb_ish();
        isb();
        tlbi_va(lshr64(va, 14n));
        dsb_ish();
        isb();
    } else {
        // 4KB Granule, 39-bit VA: Level 1 -> Level 2 -> Level 3
        const l1_idx = lshr64(va, 30n) & 0x1ffn; // bits [38:30]
        const l2_idx = lshr64(va, 21n) & 0x1ffn; // bits [29:21]
        const l3_idx = lshr64(va, 12n) & 0x1ffn; // bits [20:12]

        let l1_entry = peek64(root_table + l1_idx * 8n);
        let l2_table: bigint = 0n;
        if ((l1_entry & 1n) == 0n) {
            l2_table = alloc_page();
            poke64(root_table + l1_idx * 8n, l2_table | FLAG_TABLE);
        } else {
            l2_table = l1_entry & ~0xfffn;
        }

        let l2_entry = peek64(l2_table + l2_idx * 8n);
        let l3_table: bigint = 0n;
        if ((l2_entry & 1n) == 0n) {
            l3_table = alloc_page();
            poke64(l2_table + l2_idx * 8n, l3_table | FLAG_TABLE);
        } else {
            l3_table = l2_entry & ~0xfffn;
        }

        let attrs: u64 = FLAG_PAGE | FLAG_AF;
        if (is_device) {
            attrs = attrs | shl64(ATTR_DEVICE, 2n) | FLAG_UXN | FLAG_PXN;
        } else {
            attrs = attrs | shl64(ATTR_NORMAL, 2n) | FLAG_SH_INNER;
        }
        poke64(l3_table + l3_idx * 8n, (pa & ~0xfffn) | attrs);

        // Flush TLB for this single page
        dsb_ish();
        isb();
        tlbi_va(lshr64(va, 12n));
        dsb_ish();
        isb();
    }
}

/**
 * Sets up identity mapping for MMIO and RAM, configures TCR_EL1/MAIR_EL1,
 * and activates the MMU and L1 caches.
 */
function init_mmu(): void {
    init_allocator();
    root_table = alloc_page();

    if (CONFIG_USE_16K) {
        // 16KB Granule: Root table is Level 2 (2048 entries of 32MB blocks)
        // 0..1GB (32 entries): Device MMIO (UART, GIC)
        for (let i = 0n; i < 32n; i = i + 1n) {
            const pa = i * 0x02000000n; // 32MB
            const entry = pa | FLAG_AF | FLAG_UXN | FLAG_PXN | shl64(ATTR_DEVICE, 2n) | 0x1n;
            poke64(root_table + i * 8n, entry);
        }
        // 1GB..2GB (32 entries): Normal RAM
        for (let i = 32n; i < 64n; i = i + 1n) {
            const pa = i * 0x02000000n; // 32MB
            const entry = pa | FLAG_AF | FLAG_SH_INNER | shl64(ATTR_NORMAL, 2n) | 0x1n;
            poke64(root_table + i * 8n, entry);
        }

        // TCR_EL1: T0SZ=28 (36-bit VA), TG0=2 (16KB), SH0=3 (Inner), EPD1=1, IPS=2 (40-bit PA)
        const tcr = (2n << 32n) | (1n << 23n) | (2n << 14n) | (3n << 12n) | 28n;
        write_tcr_el1(tcr);
    } else {
        // 4KB Granule: Root table is Level 1 (512 entries of 1GB blocks)
        // 0..1GB: Device MMIO
        poke64(root_table + 0n * 8n, FLAG_UXN | FLAG_PXN | FLAG_AF | shl64(ATTR_DEVICE, 2n) | 0x1n);
        // 1GB..2GB: Normal RAM
        poke64(root_table + 1n * 8n, 0x40000000n | FLAG_AF | FLAG_SH_INNER | shl64(ATTR_NORMAL, 2n) | 0x1n);

        // TCR_EL1: T0SZ=25 (39-bit VA), TG0=0 (4KB), SH0=3 (Inner), EPD1=1, IPS=2 (40-bit PA)
        const tcr = (2n << 32n) | (1n << 23n) | (0n << 14n) | (3n << 12n) | 25n;
        write_tcr_el1(tcr);
    }

    // MAIR_EL1: Attr0 = Device-nGnRnE (0x00), Attr1 = Normal Cacheable (0xFF)
    write_mair_el1(0x000000000000ff00n);

    // TTBR0_EL1 -> root table
    write_ttbr0_el1(root_table);

    // Synchronize and flush TLB
    dsb_ish();
    isb();
    tlbi_all();
    dsb_ish();
    isb();

    // Enable MMU (M=1), D-Cache (C=1), and I-Cache (I=1) in SCTLR_EL1
    let sctlr = read_sctlr_el1();
    sctlr = sctlr | 0x1n | (1n << 2n) | (1n << 12n);
    write_sctlr_el1(sctlr);
    isb();
}
