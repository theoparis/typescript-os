// AArch64 MMU Setup and Paging (supporting 4KB, 16KB and 64KB granules)
import { shl64 } from "./uart.ts";
import * as config from "./config.ts";

function isb(): void {
	inline_asm("isb", "");
}

export function dsb_ish(): void {
	inline_asm("dsb ish", "");
}

function tlbi_all(): void {
	inline_asm("tlbi vmalle1is", "");
}

// TLBI VAAE1IS takes VA[55:12] regardless of the translation granule.
function tlbi_va(va: u64): void {
	inline_asm("tlbi vaae1is, $0", "r", lshr64(va, 12n));
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
	return inline_asm<u64>(
		"adrp $0, _kernel_end\nadd $0, $0, :lo12:_kernel_end",
		"=r",
	);
}

// --- Page size configuration ---
//
// config.page_size selects the translation granule: 4096, 16384 or 65536.
//
//   granule | VA bits | root level (entries, shift) | levels
//   --------+---------+-----------------------------+-------
//   4KB     | 39      | L1 (512, 30)                | L1 -> L2 -> L3
//   16KB    | 36      | L2 (2048, 25)               | L2 -> L3
//   64KB    | 36      | L2 (128, 29)                | L2 -> L3

export function get_page_size(): bigint {
	return config.page_size;
}

export function get_page_mask(): bigint {
	return config.page_size - 1n;
}
export function get_page_shift(): bigint {
	if (config.page_size === 65536n) return 16n;
	if (config.page_size === 16384n) return 14n;
	return 12n;
}

// Output-address bits of a descriptor: [47:get_page_shift()]
function addr_mask(): bigint {
	return 0x0000fffffffff000n & ~(config.page_size - 1n);
}

function root_shift(): bigint {
	if (get_page_size() === 65536n) return 29n;
	if (get_page_size() === 16384n) return 25n;
	return 30n;
}

function root_index_mask(): bigint {
	if (get_page_size() === 65536n) return 0x7fn;
	if (get_page_size() === 16384n) return 0x7ffn;
	return 0x1ffn;
}

// Number of 8-byte entries in a full table (one page)
function table_entries(): bigint {
	return get_page_size() / 8n;
}

export function is_valid_page_size(): boolean {
	return (
		config.page_size === 4096n ||
		config.page_size === 16384n ||
		config.page_size === 65536n
	);
}

// --- Page Allocator ---

let next_free_page: bigint = 0n;

function init_allocator(): void {
	next_free_page = get_kernel_end();
	if ((next_free_page & get_page_mask()) !== 0n) {
		next_free_page = (next_free_page + get_page_size()) & ~get_page_mask();
	}
}

/**
 * Allocates one zeroed, page-aligned page (get_page_size() bytes).
 */
export function alloc_page(): bigint {
	const page = next_free_page;
	next_free_page = next_free_page + get_page_size();
	const n = table_entries();
	for (let i = 0n; i < n; i = i + 1n) {
		poke64(page + i * 8n, 0n);
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
const FLAG_AP_EL0: u64 = 0x40n; // AP[1] (bit 6): accessible from EL0

export let root_table: bigint = 0n;
export let current_root_table: bigint = 0n;

// --- Page table walking ---

/**
 * Returns the table referenced by entry `idx` of `table`, allocating it if
 * `create` is set. Returns 0 if absent.
 */
function next_table(table: bigint, idx: bigint, create: boolean): bigint {
	const entry = peek64(table + idx * 8n);
	if ((entry & 1n) === 0n) {
		if (!create) {
			return 0n;
		}
		const t = alloc_page();
		poke64(table + idx * 8n, t | FLAG_TABLE);
		return t;
	}
	return entry & addr_mask();
}

/**
 * Returns the level-3 (page) table covering `va`, or 0 if absent and !create.
 */
function get_l3(root: bigint, va: bigint, create: boolean): bigint {
	if (get_page_size() === 4096n) {
		const l2 = next_table(root, lshr64(va, 30n) & 0x1ffn, create);
		if (l2 === 0n) {
			return 0n;
		}
		return next_table(l2, lshr64(va, 21n) & 0x1ffn, create);
	}
	return next_table(root, lshr64(va, root_shift()) & root_index_mask(), create);
}

function l3_index(va: bigint): bigint {
	return lshr64(va, get_page_shift()) & (table_entries() - 1n);
}

// Bytes of VA covered by one L3 table
function l3_coverage(): bigint {
	return table_entries() * get_page_size();
}

/**
 * Installs an L3 page descriptor in `root` for `va`.
 */
function map_in(root: bigint, va: bigint, pa: bigint, attrs: u64): void {
	const l3 = get_l3(root, va, true);
	poke64(l3 + l3_index(va) * 8n, (pa & addr_mask()) | attrs);

	dsb_ish();
	isb();
	tlbi_va(va);
	dsb_ish();
	isb();
}

function device_attrs(): u64 {
	return FLAG_PAGE | FLAG_AF | FLAG_UXN | FLAG_PXN | shl64(ATTR_DEVICE, 2n);
}

/**
 * Maps a single virtual page to a physical frame for kernel usage.
 */
export function map_page(va: bigint, pa: bigint, is_device: boolean): void {
	let attrs: u64 = FLAG_PAGE | FLAG_AF;
	if (is_device) {
		attrs = attrs | shl64(ATTR_DEVICE, 2n) | FLAG_UXN | FLAG_PXN;
	} else {
		attrs = attrs | shl64(ATTR_NORMAL, 2n) | FLAG_SH_INNER;
	}
	map_in(root_table, va, pa, attrs);
}

/**
 * Returns the physical page backing user `va` in the current address space,
 * or 0 if unmapped.
 */
export function lookup_user_page(va: bigint): bigint {
	const l3 = get_l3(current_root_table, va, false);
	if (l3 === 0n) {
		return 0n;
	}
	const entry = peek64(l3 + l3_index(va) * 8n);
	if ((entry & 1n) === 0n) {
		return 0n;
	}
	return entry & addr_mask();
}

/**
 * Maps a single virtual page with user (EL0) access permissions.
 * AP[2:1]: 0b01 = EL1 RW, EL0 RW (if write)
 *          0b11 = EL1 RO, EL0 RO (if read-only)
 * UXN: 0 if executable, 1 if non-executable (stack/data)
 * PXN: 1 (kernel cannot execute user pages)
 */
export function map_user_page(
	va: bigint,
	pa: bigint,
	is_write: boolean,
	is_exec: boolean,
): void {
	let ap: u64 = shl64(1n, 6n); // 0b01: EL1 RW, EL0 RW
	if (!is_write) {
		ap = shl64(3n, 6n); // 0b11: EL1 RO, EL0 RO
	}

	let attrs: u64 =
		FLAG_PAGE |
		FLAG_AF |
		FLAG_SH_INNER |
		shl64(ATTR_NORMAL, 2n) |
		ap |
		FLAG_PXN;
	if (!is_exec) {
		attrs = attrs | FLAG_UXN;
	}

	map_in(current_root_table, va, pa, attrs);
}

// --- Fixed mappings shared by every address space ---

/**
 * Maps [1GB, 2GB) of RAM as normal memory using blocks at the root level
 * (1GB for 4KB, 32MB for 16KB, 512MB for 64KB granules).
 */
function map_ram_blocks(root: bigint): void {
	const shift = root_shift();
	const block = shl64(1n, shift);
	const attrs = FLAG_AF | FLAG_SH_INNER | shl64(ATTR_NORMAL, 2n) | 0x1n;
	for (let pa = 0x40000000n; pa < 0x80000000n; pa = pa + block) {
		poke64(root + lshr64(pa, shift) * 8n, pa | attrs);
	}
}

function map_device_range(root: bigint, base: bigint, size: bigint): void {
	const start = base & ~get_page_mask();
	const end = (base + size + get_page_mask()) & ~get_page_mask();
	for (let pa = start; pa < end; pa = pa + get_page_size()) {
		map_in(root, pa, pa, device_attrs());
	}
}

/**
 * Identity-maps MMIO with individual pages so that user mappings can live
 * in the same low region regardless of granule size.
 */
function map_devices(root: bigint): void {
	map_device_range(root, 0x08000000n, 0x10000n); // GICv3 distributor
	map_device_range(root, 0x080a0000n, 0x20000n); // GICv3 redistributor (RD + SGI)
	map_device_range(root, 0x09000000n, 0x1000n); // PL011 UART
	map_device_range(root, 0x0a000000n, 0x4000n); // VirtIO MMIO (32 slots)
}

/**
 * Initializes the MMU with identity mappings and prepares user space translation.
 */
export function init_mmu(): void {
	init_allocator();
	root_table = alloc_page();
	map_ram_blocks(root_table);
	map_devices(root_table);

	// TCR_EL1: IPS=40-bit, EPD1=1, TG0, SH0=inner, ORGN0/IRGN0=WB WA, T0SZ
	let tg0: bigint = 0n; // 4KB
	let t0sz: bigint = 25n; // 39-bit VA
	if (get_page_size() === 16384n) {
		tg0 = 2n;
		t0sz = 28n; // 36-bit VA
	} else if (get_page_size() === 65536n) {
		tg0 = 1n;
		t0sz = 28n; // 36-bit VA
	}
	const tcr =
		(2n << 32n) |
		(1n << 23n) |
		(tg0 << 14n) |
		(3n << 12n) |
		(1n << 10n) |
		(1n << 8n) |
		t0sz;
	write_tcr_el1(tcr);

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
	current_root_table = root_table;
}

export function switch_user_root_table(new_root: bigint): void {
	current_root_table = new_root;
	write_ttbr0_el1(new_root);
	dsb_ish();
	isb();
	tlbi_all();
	dsb_ish();
	isb();
}

export function create_user_root_table(): bigint {
	const new_root = alloc_page();
	map_ram_blocks(new_root);
	map_devices(new_root);
	return new_root;
}

/**
 * Deep-copies every EL0-accessible page of `parent_root` into a new address
 * space. User VA space is [0, 1GB); kernel RAM and MMIO are shared mappings.
 */
export function clone_user_address_space(parent_root: bigint): bigint {
	const child_root = create_user_root_table();
	const coverage = l3_coverage();
	const entries = table_entries();
	const words = get_page_size() / 8n;

	for (let base = 0n; base < 0x40000000n; base = base + coverage) {
		const parent_l3 = get_l3(parent_root, base, false);
		if (parent_l3 === 0n) {
			continue;
		}
		for (let i = 0n; i < entries; i = i + 1n) {
			const l3_entry = peek64(parent_l3 + i * 8n);
			// Valid, EL0-accessible pages only (skips MMIO mappings)
			if ((l3_entry & 1n) === 0n || (l3_entry & FLAG_AP_EL0) === 0n) {
				continue;
			}
			const parent_pa = l3_entry & addr_mask();
			const attrs = l3_entry & ~addr_mask();
			const child_pa = alloc_page();
			for (let k = 0n; k < words; k = k + 1n) {
				poke64(child_pa + k * 8n, peek64(parent_pa + k * 8n));
			}
			map_in(child_root, base + i * get_page_size(), child_pa, attrs);
		}
	}

	return child_root;
}
