// Ext2 Filesystem Driver for tsos
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
    putchar,
    udiv64,
    lshr64,
    shl64,
} from "./uart.ts";
import { virtio_blk_read } from "./virtio.ts";
import { alloc_page } from "./mmu.ts";

export type Ext2Inode = {
    ino: u32;
    mode: u16;
    size: u64;
    blocks_count: u32;
    block_ptrs: bigint; // pointer to 15 x u32 (60 bytes)
};

const EXT2_MAGIC = 0xef53 as u16;

const S_IFMT  = 0xf000 as u16;
const S_IFREG = 0x8000 as u16;
const S_IFDIR = 0x4000 as u16;
const S_IFLNK = 0xa000 as u16;

let ext2_block_size: u64 = 1024n;
let ext2_sectors_per_block: u64 = 2n;
let ext2_inodes_per_group: u32 = 0 as u32;
let ext2_blocks_per_group: u32 = 0 as u32;
let ext2_first_data_block: u32 = 0 as u32;
let ext2_inode_size: u16 = 128 as u16;
let ext2_groups_count: u32 = 0 as u32;

let ext2_sb_buf: bigint = 0n;
let ext2_bgdt_buf: bigint = 0n;
let ext2_block_buf: bigint = 0n;
let ext2_indir_buf: bigint = 0n;
let ext2_dindir_buf: bigint = 0n;
let lookup_curr_inode: bigint = 0n;
let lookup_path_buf: bigint = 0n;
let lookup_sym_buf: bigint = 0n;
let lookup_new_path: bigint = 0n;
/**
 * Reads a filesystem block from disk into a buffer.
 */
function ext2_read_block(block_num: u64, dest_buf: bigint): boolean {
    const sector = block_num * ext2_sectors_per_block;
    return virtio_blk_read(sector, ext2_sectors_per_block, dest_buf);
}

/**
 * Initializes and mounts the Ext2 filesystem from the VirtIO block device.
 */
export function ext2_init(): boolean {
    print("[ext2] Mounting Ext2 filesystem from VirtIO block device...\n");

    ext2_sb_buf     = alloc_page();
    ext2_bgdt_buf   = alloc_page();
    ext2_block_buf  = alloc_page();
    ext2_indir_buf  = alloc_page();
    ext2_dindir_buf = alloc_page();
    lookup_curr_inode = alloc_page();
    lookup_path_buf   = alloc_page();
    lookup_sym_buf    = alloc_page();
    lookup_new_path   = alloc_page();

    // Read superblock: byte offset 1024 = sector 2 (read 2 sectors = 1024 bytes)
    if (!virtio_blk_read(2n, 2n, ext2_sb_buf)) {
        print("[ext2] Error: Failed to read superblock from disk!\n");
        return false;
    }

    const magic = peek16(ext2_sb_buf + 56n) as u16;
    if (magic !== EXT2_MAGIC) {
        print("[ext2] Error: Invalid Ext2 magic: 0x");
        printHex64(magic as u64);
        print("\n");
        return false;
    }

    const s_inodes_count = peek32(ext2_sb_buf + 0n);
    const s_blocks_count = peek32(ext2_sb_buf + 4n);
    ext2_first_data_block = peek32(ext2_sb_buf + 20n);
    const s_log_block_size = peek32(ext2_sb_buf + 24n);
    ext2_block_size = shl64(1024n, s_log_block_size as u64);
    ext2_sectors_per_block = udiv64(ext2_block_size, 512n);
    ext2_blocks_per_group = peek32(ext2_sb_buf + 32n);
    ext2_inodes_per_group = peek32(ext2_sb_buf + 40n);

    const s_rev_level = peek32(ext2_sb_buf + 76n);
    if (s_rev_level >= (1 as u32)) {
        ext2_inode_size = peek16(ext2_sb_buf + 88n) as u16;
    } else {
        ext2_inode_size = 128 as u16;
    }

    ext2_groups_count = udiv64(
        (s_blocks_count as u64) + (ext2_blocks_per_group as u64) - 1n,
        ext2_blocks_per_group as u64,
    ) as u32;

    print("[ext2] Superblock OK! Block size: ");
    printHex64(ext2_block_size);
    print(" bytes, Inode size: ");
    printHex64(ext2_inode_size as u64);
    print(", Groups: ");
    printHex64(ext2_groups_count as u64);
    print("\n");

    // Read Block Group Descriptor Table (at block first_data_block + 1)
    const bgdt_block = (ext2_first_data_block as u64) + 1n;
    if (!ext2_read_block(bgdt_block, ext2_bgdt_buf)) {
        print("[ext2] Error: Failed to read BGDT!\n");
        return false;
    }

    return true;
}

/**
 * Reads an inode structure by 1-based inode number.
 */
export function ext2_read_inode_info(ino: u32, out_inode: bigint): boolean {
    if (ino === (0 as u32)) return false;

    const ino_idx = (ino - (1 as u32)) as u64;
    const group = udiv64(ino_idx, ext2_inodes_per_group as u64);
    const idx_in_group = ino_idx - group * (ext2_inodes_per_group as u64);

    // Each block group descriptor is 32 bytes: bg_inode_table is at offset 8 (u32)
    const bg_desc_offset = group * 32n;
    const inode_table_block = peek32(ext2_bgdt_buf + bg_desc_offset + 8n) as u64;

    const byte_offset = idx_in_group * (ext2_inode_size as u64);
    const blk_offset = udiv64(byte_offset, ext2_block_size);
    const in_blk_offset = byte_offset - blk_offset * ext2_block_size;

    if (!ext2_read_block(inode_table_block + blk_offset, ext2_block_buf)) {
        print("[ext2] Failed to read inode table block\n");
        return false;
    }

    const raw_inode = ext2_block_buf + in_blk_offset;
    const mode = peek16(raw_inode + 0n) as u16;
    const size_low = peek32(raw_inode + 4n) as u64;
    const blocks_count = peek32(raw_inode + 28n);

    let size_high: u64 = 0n;
    if ((mode & S_IFMT) === S_IFREG) {
        size_high = (peek32(raw_inode + 108n) as u64) & 0xffffffffn;
    }
    const full_size = shl64(size_high, 32n) | (size_low & 0xffffffffn);

    // out_inode layout:
    // +0: ino (u32, 4B)
    // +4: mode (u16, 2B)
    // +6: pad (2B)
    // +8: size (u64, 8B)
    // +16: blocks_count (u32, 4B)
    // +20: pad (4B)
    // +24: block_ptrs (15 x u32 = 60B)
    poke32(out_inode + 0n, ino);
    poke16(out_inode + 4n, mode);
    poke64(out_inode + 8n, full_size);
    poke32(out_inode + 16n, blocks_count);

    for (let i = 0n; i < 15n; i = i + 1n) {
        poke32(out_inode + 24n + i * 4n, peek32(raw_inode + 40n + i * 4n));
    }

    return true;
}

/**
 * Maps a file-relative block index to physical filesystem block number.
 */
function ext2_bmap(inode_ptr: bigint, file_block: u64): u64 {
    const ptrs_per_block = udiv64(ext2_block_size, 4n);

    // Direct blocks: 0..11
    if (file_block < 12n) {
        return peek32(inode_ptr + 24n + file_block * 4n) as u64;
    }

    // Singly indirect block: 12
    const ind_block = file_block - 12n;
    if (ind_block < ptrs_per_block) {
        const ind_table = peek32(inode_ptr + 24n + 12n * 4n) as u64;
        if (ind_table === 0n) return 0n;
        ext2_read_block(ind_table, ext2_indir_buf);
        return peek32(ext2_indir_buf + ind_block * 4n) as u64;
    }

    // Doubly indirect block: 13
    const dind_block = ind_block - ptrs_per_block;
    const dind_table = peek32(inode_ptr + 24n + 13n * 4n) as u64;
    if (dind_table === 0n) return 0n;

    const d1 = udiv64(dind_block, ptrs_per_block);
    const d2 = dind_block - d1 * ptrs_per_block;

    ext2_read_block(dind_table, ext2_dindir_buf);
    const d1_table = peek32(ext2_dindir_buf + d1 * 4n) as u64;
    if (d1_table === 0n) return 0n;

    ext2_read_block(d1_table, ext2_indir_buf);
    return peek32(ext2_indir_buf + d2 * 4n) as u64;
}

/**
 * Reads data from an inode at a given offset.
 */
export function ext2_read_data(inode_ptr: bigint, offset: u64, count: u64, dest_buf: bigint): u64 {
    const file_size = peek64(inode_ptr + 8n);
    if (offset >= file_size) return 0n;

    let bytes_to_read = count;
    if (offset + bytes_to_read > file_size) {
        bytes_to_read = file_size - offset;
    }

    let bytes_read: u64 = 0n;
    let curr_offset = offset;

    while (bytes_read < bytes_to_read) {
        const file_block = udiv64(curr_offset, ext2_block_size);
        const in_block_offset = curr_offset - file_block * ext2_block_size;
        const chunk = ext2_block_size - in_block_offset;
        let to_copy = bytes_to_read - bytes_read;
        if (to_copy > chunk) {
            to_copy = chunk;
        }

        const fs_block = ext2_bmap(inode_ptr, file_block);
        if (fs_block === 0n) {
            // Sparse block hole: zero out
            for (let i = 0n; i < to_copy; i = i + 1n) {
                poke8(dest_buf + bytes_read + i, 0 as u8);
            }
        } else {
            ext2_read_block(fs_block, ext2_block_buf);
            for (let i = 0n; i < to_copy; i = i + 1n) {
                poke8(dest_buf + bytes_read + i, peek8(ext2_block_buf + in_block_offset + i));
            }
        }

        bytes_read = bytes_read + to_copy;
        curr_offset = curr_offset + to_copy;
    }

    return bytes_read;
}

function mem_equals_mem(m1: bigint, m2: bigint, len: u64): boolean {
    for (let i = 0n; i < len; i = i + 1n) {
        if (peek8(m1 + i) !== peek8(m2 + i)) {
            return false;
        }
    }
    return true;
}

/**
 * Searches directory inode for a child entry by name in memory.
 */
export function ext2_lookup_dir_mem(
    dir_inode_ptr: bigint,
    name_addr: bigint,
    name_len: u64,
): u32 {
    const dir_size = peek64(dir_inode_ptr + 8n);
    let offset: u64 = 0n;

    while (offset < dir_size) {
        const file_block = udiv64(offset, ext2_block_size);
        const in_block_offset = offset - file_block * ext2_block_size;
        const fs_block = ext2_bmap(dir_inode_ptr, file_block);

        if (fs_block === 0n) {
            offset = offset + ext2_block_size;
            continue;
        }

        ext2_read_block(fs_block, ext2_block_buf);

        let cur_in_blk = in_block_offset;
        while (cur_in_blk < ext2_block_size && offset < dir_size) {
            const entry_addr = ext2_block_buf + cur_in_blk;
            const entry_ino = peek32(entry_addr + 0n);
            const rec_len = peek16(entry_addr + 4n) as u64;
            const name_len_entry = peek8(entry_addr + 6n) as u64;

            if (rec_len === 0n) {
                return 0 as u32;
            }

            if (entry_ino !== (0 as u32) && name_len_entry === name_len) {
                if (mem_equals_mem(name_addr, entry_addr + 8n, name_len)) {
                    return entry_ino;
                }
            }

            cur_in_blk = cur_in_blk + rec_len;
            offset = offset + rec_len;
        }
    }

    return 0 as u32;
}


/**
 * Reads directory entries and formats them as linux_dirent64 structures.
 */
export function ext2_getdents(
    dir_inode_ptr: bigint,
    start_off: u64,
    out_buf: bigint,
    max_count: u64,
    new_off_ptr: bigint,
): u64 {
    const dir_size = peek64(dir_inode_ptr + 8n);
    let offset = start_off;
    let written_bytes: u64 = 0n;

    while (offset < dir_size) {
        const file_block = udiv64(offset, ext2_block_size);
        const in_block_offset = offset - file_block * ext2_block_size;
        const fs_block = ext2_bmap(dir_inode_ptr, file_block);

        if (fs_block === 0n) {
            offset = offset + ext2_block_size;
            continue;
        }

        ext2_read_block(fs_block, ext2_block_buf);

        let cur_in_blk = in_block_offset;
        while (cur_in_blk < ext2_block_size && offset < dir_size) {
            const entry_addr = ext2_block_buf + cur_in_blk;
            const entry_ino = peek32(entry_addr + 0n);
            const rec_len = peek16(entry_addr + 4n) as u64;
            const name_len = peek8(entry_addr + 6n) as u64;
            const file_type = peek8(entry_addr + 7n);

            if (rec_len === 0n) {
                poke64(new_off_ptr, offset);
                return written_bytes;
            }

            if (entry_ino !== (0 as u32)) {
                // linux_dirent64 reclen aligned to 8 bytes: 19 + name_len + 1
                const raw_len = 19n + name_len + 1n;
                const d_reclen = (raw_len + 7n) & ~7n;

                if (written_bytes + d_reclen > max_count) {
                    // Buffer full
                    poke64(new_off_ptr, offset);
                    return written_bytes;
                }

                // Map file_type to DT_*
                let d_type: u8 = 8 as u8; // DT_REG
                if (file_type === (2 as u8)) d_type = 4 as u8; // DT_DIR
                else if (file_type === (7 as u8)) d_type = 10 as u8; // DT_LNK

                const dst = out_buf + written_bytes;
                poke64(dst + 0n, entry_ino as u64);
                poke64(dst + 8n, offset + rec_len);
                poke16(dst + 16n, d_reclen as u16);
                poke8(dst + 18n, d_type);

                for (let k = 0n; k < name_len; k = k + 1n) {
                    poke8(dst + 19n + k, peek8(entry_addr + 8n + k));
                }
                poke8(dst + 19n + name_len, 0 as u8);

                // Zero padding
                for (let k = 19n + name_len + 1n; k < d_reclen; k = k + 1n) {
                    poke8(dst + k, 0 as u8);
                }

                written_bytes = written_bytes + d_reclen;
            }

            cur_in_blk = cur_in_blk + rec_len;
            offset = offset + rec_len;
        }
    }

    poke64(new_off_ptr, offset);
    return written_bytes;
}
/**
 * Resolves a path to an inode number, resolving intermediate symlinks and root inode (2).
 */
export function ext2_lookup_path(path: string, out_inode: bigint): boolean {
    const path_p = <Ref<u8>>(<Opaque>path);
    let p_len: u64 = 0n;
    while (true) {
        const ch = Deref(path_p[p_len]);
        poke8(lookup_path_buf + p_len, ch);
        if (ch === (0 as u8)) break;
        p_len = p_len + 1n;
    }

    for (let hop = 0n; hop < 8n; hop = hop + 1n) {
        // Start at root inode (ino = 2)
        if (!ext2_read_inode_info(2 as u32, lookup_curr_inode)) {
            return false;
        }

        let idx: u64 = 0n;
        while (peek8(lookup_path_buf + idx) === (47 as u8)) {
            idx = idx + 1n;
        }

        if (peek8(lookup_path_buf + idx) === (0 as u8)) {
            // Path is "/"
            for (let i = 0n; i < 16n; i = i + 1n) {
                poke64(out_inode + i * 8n, peek64(lookup_curr_inode + i * 8n));
            }
            return true;
        }

        let symlink_hit = false;

        while (peek8(lookup_path_buf + idx) !== (0 as u8)) {
            const comp_start = idx;
            while (true) {
                const ch = peek8(lookup_path_buf + idx);
                if (ch === (0 as u8) || ch === (47 as u8)) break;
                idx = idx + 1n;
            }
            const comp_len = idx - comp_start;

            let rem_start = idx;
            while (peek8(lookup_path_buf + rem_start) === (47 as u8)) {
                rem_start = rem_start + 1n;
            }

            if (comp_len === 1n && peek8(lookup_path_buf + comp_start) === (46 as u8)) {
                // "." component: ignore
            } else {
                const child_ino = ext2_lookup_dir_mem(
                    lookup_curr_inode,
                    lookup_path_buf + comp_start,
                    comp_len,
                );
                if (child_ino === (0 as u32)) {
                    return false;
                }

                if (!ext2_read_inode_info(child_ino, lookup_curr_inode)) {
                    return false;
                }

                const mode = peek16(lookup_curr_inode + 4n) as u16;
                if ((mode & S_IFMT) === S_IFLNK) {
                    // Read symlink target
                    const sym_size = peek64(lookup_curr_inode + 8n);
                    if (sym_size <= 60n) {
                        for (let i = 0n; i < sym_size; i = i + 1n) {
                            poke8(lookup_sym_buf + i, peek8(lookup_curr_inode + 24n + i));
                        }
                        poke8(lookup_sym_buf + sym_size, 0 as u8);
                    } else {
                        ext2_read_data(lookup_curr_inode, 0n, sym_size, lookup_sym_buf);
                        poke8(lookup_sym_buf + sym_size, 0 as u8);
                    }

                    // Construct expanded path in lookup_new_path
                    let new_len: u64 = 0n;
                    if (peek8(lookup_sym_buf) === (47 as u8)) {
                        // Absolute symlink
                        for (let i = 0n; i < sym_size; i = i + 1n) {
                            poke8(lookup_new_path + new_len, peek8(lookup_sym_buf + i));
                            new_len = new_len + 1n;
                        }
                    } else {
                        // Relative symlink: prepend parent directory prefix
                        if (comp_start > 0n) {
                            for (let i = 0n; i < comp_start; i = i + 1n) {
                                poke8(lookup_new_path + new_len, peek8(lookup_path_buf + i));
                                new_len = new_len + 1n;
                            }
                        }
                        if (new_len === 0n || peek8(lookup_new_path + new_len - 1n) !== (47 as u8)) {
                            poke8(lookup_new_path + new_len, 47 as u8);
                            new_len = new_len + 1n;
                        }
                        for (let i = 0n; i < sym_size; i = i + 1n) {
                            poke8(lookup_new_path + new_len, peek8(lookup_sym_buf + i));
                            new_len = new_len + 1n;
                        }
                    }

                    // Append remaining components
                    if (peek8(lookup_path_buf + rem_start) !== (0 as u8)) {
                        poke8(lookup_new_path + new_len, 47 as u8);
                        new_len = new_len + 1n;
                        let r = rem_start;
                        while (peek8(lookup_path_buf + r) !== (0 as u8)) {
                            poke8(lookup_new_path + new_len, peek8(lookup_path_buf + r));
                            new_len = new_len + 1n;
                            r = r + 1n;
                        }
                    }
                    poke8(lookup_new_path + new_len, 0 as u8);

                    // Copy new path to lookup_path_buf
                    for (let i = 0n; i <= new_len; i = i + 1n) {
                        poke8(lookup_path_buf + i, peek8(lookup_new_path + i));
                    }

                    symlink_hit = true;
                    break;
                }
            }

            idx = rem_start;
        }

        if (!symlink_hit) {
            for (let i = 0n; i < 16n; i = i + 1n) {
                poke64(out_inode + i * 8n, peek64(lookup_curr_inode + i * 8n));
            }
            return true;
        }
    }

    return false;
}
