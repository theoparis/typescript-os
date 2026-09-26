// Virtual File System (VFS) for tsos
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
    getchar,
    udiv64,
} from "./uart.ts";
import { alloc_page } from "./mmu.ts";
import {
    ext2_init,
    ext2_lookup_path,
    ext2_read_data,
    ext2_read_inode_info,
} from "./ext2.ts";

export const MAX_FDS = 32n;

// File descriptor entry size in memory:
// +0:  used (u8, 1B)
// +1:  fs_type (u8, 1B: 1 = TTY/stdio, 2 = ext2)
// +2:  pad (2B)
// +4:  flags (u32, 4B)
// +8:  offset (u64, 8B)
// +16: size (u64, 8B)
// +24: ino (u32, 4B)
// +28: mode (u16, 2B)
// +30: pad (2B)
// +32: inode_copy (128B = inode data and block pointers)
// Total per FD: 160 bytes
const FD_ENTRY_SIZE = 160n;

let fd_table_buf: bigint = 0n;
let scratch_inode: bigint = 0n;

function get_fd_ptr(fd: u64): bigint {
    return fd_table_buf + fd * FD_ENTRY_SIZE;
}

/**
 * Initializes the VFS and standard streams (stdin, stdout, stderr).
 */
export function vfs_init(): boolean {
    print("[vfs] Initializing Virtual File System...\n");

    fd_table_buf = alloc_page();
    scratch_inode = alloc_page();

    // Zero out file descriptor table
    for (let i = 0n; i < 512n; i = i + 1n) {
        poke64(fd_table_buf + i * 8n, 0n);
    }

    // Set up FD 0 (stdin): TTY
    const fd0 = get_fd_ptr(0n);
    poke8(fd0 + 0n, 1 as u8); // used
    poke8(fd0 + 1n, 1 as u8); // TTY

    // Set up FD 1 (stdout): TTY
    const fd1 = get_fd_ptr(1n);
    poke8(fd1 + 0n, 1 as u8); // used
    poke8(fd1 + 1n, 1 as u8); // TTY

    // Set up FD 2 (stderr): TTY
    const fd2 = get_fd_ptr(2n);
    poke8(fd2 + 0n, 1 as u8); // used
    poke8(fd2 + 1n, 1 as u8); // TTY

    // Mount Ext2 root filesystem
    if (!ext2_init()) {
        print("[vfs] Warning: Failed to mount root filesystem!\n");
        return false;
    }

    print("[vfs] Root filesystem mounted at '/'\n");
    return true;
}

/**
 * Opens a file by path and returns a file descriptor number or negative error code.
 */
export function vfs_open(path: string, flags: u32, mode: u32): number {
    // Look up path in root filesystem
    if (!ext2_lookup_path(path, scratch_inode)) {
        return -2; // -ENOENT
    }

    // Find free file descriptor starting at 3
    let free_fd: u64 = 0n;
    for (let i = 3n; i < MAX_FDS; i = i + 1n) {
        const ptr = get_fd_ptr(i);
        if (peek8(ptr + 0n) === (0 as u8)) {
            free_fd = i;
            break;
        }
    }

    if (free_fd === 0n) {
        return -24; // -EMFILE
    }

    const fd_ptr = get_fd_ptr(free_fd);
    const ino = peek32(scratch_inode + 0n);
    const file_mode = peek16(scratch_inode + 4n) as u16;
    const size = peek64(scratch_inode + 8n);

    poke8(fd_ptr + 0n, 1 as u8); // used
    poke8(fd_ptr + 1n, 2 as u8); // ext2 file
    poke32(fd_ptr + 4n, flags);
    poke64(fd_ptr + 8n, 0n);     // offset = 0
    poke64(fd_ptr + 16n, size);
    poke32(fd_ptr + 24n, ino);
    poke16(fd_ptr + 28n, file_mode);

    // Copy inode data (15 block pointers etc) into FD entry
    const fd_inode = fd_ptr + 32n;
    for (let i = 0n; i < 16n; i = i + 1n) {
        poke64(fd_inode + i * 8n, peek64(scratch_inode + i * 8n));
    }

    return free_fd as number;
}

/**
 * Closes an open file descriptor.
 */
export function vfs_close(fd: number): number {
    if (fd < 0 || (fd as u64) >= MAX_FDS) {
        return -9; // -EBADF
    }

    const fd_ptr = get_fd_ptr(fd as u64);
    if (peek8(fd_ptr + 0n) === (0 as u8)) {
        return -9; // -EBADF
    }

    poke8(fd_ptr + 0n, 0 as u8); // mark unused
    return 0;
}

/**
 * Duplicates an open file descriptor to the lowest available FD number.
 */
export function vfs_dup(oldfd: number): number {
    if (oldfd < 0 || (oldfd as u64) >= MAX_FDS) {
        return -9; // -EBADF
    }
    const src_ptr = get_fd_ptr(oldfd as u64);
    if (peek8(src_ptr + 0n) === (0 as u8)) {
        return -9; // -EBADF
    }

    let free_fd: u64 = 0n;
    for (let i = 0n; i < MAX_FDS; i = i + 1n) {
        const ptr = get_fd_ptr(i);
        if (peek8(ptr + 0n) === (0 as u8)) {
            free_fd = i;
            break;
        }
    }
    if (free_fd === 0n) {
        return -24; // -EMFILE
    }

    const dst_ptr = get_fd_ptr(free_fd);
    for (let i = 0n; i < (FD_ENTRY_SIZE >> 3n); i = i + 1n) {
        poke64(dst_ptr + i * 8n, peek64(src_ptr + i * 8n));
    }
    return free_fd as number;
}

/**
 * Duplicates an open file descriptor onto a specific new FD number.
 */
export function vfs_dup2(oldfd: number, newfd: number): number {
    if (oldfd < 0 || (oldfd as u64) >= MAX_FDS || newfd < 0 || (newfd as u64) >= MAX_FDS) {
        return -9; // -EBADF
    }
    const src_ptr = get_fd_ptr(oldfd as u64);
    if (peek8(src_ptr + 0n) === (0 as u8)) {
        return -9; // -EBADF
    }
    if (oldfd === newfd) {
        return newfd;
    }
    vfs_close(newfd);
    const dst_ptr = get_fd_ptr(newfd as u64);
    for (let i = 0n; i < (FD_ENTRY_SIZE >> 3n); i = i + 1n) {
        poke64(dst_ptr + i * 8n, peek64(src_ptr + i * 8n));
    }
    return newfd;
}

/**
 * Reads from an open file descriptor at current offset, advancing offset.
 */
export function vfs_read(fd: number, dest_buf: bigint, count: u64): u64 {
    if (fd < 0 || (fd as u64) >= MAX_FDS) {
        return -9n as u64; // -EBADF
    }

    const fd_ptr = get_fd_ptr(fd as u64);
    if (peek8(fd_ptr + 0n) === (0 as u8)) {
        return -9n as u64; // -EBADF
    }

    const fs_type = peek8(fd_ptr + 1n);
    if (fs_type === (1 as u8)) {
        // TTY / stdin: read from UART
        if (count === 0n) return 0n;
        let c = getchar();
        if (c === (4 as u8)) {
            return 0n; // EOF
        }
        if (c === (13 as u8)) {
            c = 10 as u8; // \r -> \n
        }
        poke8(dest_buf, c);
        return 1n;
    }
    const offset = peek64(fd_ptr + 8n);
    const fd_inode = fd_ptr + 32n;
    const bytes_read = ext2_read_data(fd_inode, offset, count, dest_buf);
    poke64(fd_ptr + 8n, offset + bytes_read);

    return bytes_read;
}

/**
 * Reads from an open file descriptor at specified offset without advancing offset.
 */
export function vfs_pread(fd: number, dest_buf: bigint, count: u64, offset: u64): u64 {
    if (fd < 0 || (fd as u64) >= MAX_FDS) {
        return -9n as u64; // -EBADF
    }

    const fd_ptr = get_fd_ptr(fd as u64);
    if (peek8(fd_ptr + 0n) === (0 as u8)) {
        return -9n as u64; // -EBADF
    }

    const fs_type = peek8(fd_ptr + 1n);
    if (fs_type === (1 as u8)) {
        return 0n;
    }

    const fd_inode = fd_ptr + 32n;
    return ext2_read_data(fd_inode, offset, count, dest_buf);
}

/**
 * Seeks to a position in an open file descriptor.
 * whence: 0 = SEEK_SET, 1 = SEEK_CUR, 2 = SEEK_END
 */
export function vfs_lseek(fd: number, offset: u64, whence: number): u64 {
    if (fd < 0 || (fd as u64) >= MAX_FDS) {
        return -9n as u64; // -EBADF
    }

    const fd_ptr = get_fd_ptr(fd as u64);
    if (peek8(fd_ptr + 0n) === (0 as u8)) {
        return -9n as u64; // -EBADF
    }

    const fs_type = peek8(fd_ptr + 1n);
    if (fs_type === (1 as u8)) {
        return -29n as u64; // -ESPIPE
    }
    const cur_offset = peek64(fd_ptr + 8n);
    const size = peek64(fd_ptr + 16n);
    let new_offset: u64 = 0n;
    if (whence === 0) {
        new_offset = offset;
    } else if (whence === 1) {
        new_offset = cur_offset + offset;
    } else if (whence === 2) {
        new_offset = size + offset;
    } else {
        return -22n as u64; // -EINVAL
    }

    poke64(fd_ptr + 8n, new_offset);
    return new_offset;
}

/**
 * Fills Linux AArch64 struct stat (128 bytes) for an open file descriptor.
 */
export function vfs_fstat(fd: number, stat_buf: bigint): number {
    if (fd < 0 || (fd as u64) >= MAX_FDS) {
        return -9; // -EBADF
    }

    const fd_ptr = get_fd_ptr(fd as u64);
    if (peek8(fd_ptr + 0n) === (0 as u8)) {
        return -9; // -EBADF
    }

    const fs_type = peek8(fd_ptr + 1n);

    // Zero out stat buffer (128 bytes = 16 x 8B)
    for (let i = 0n; i < 16n; i = i + 1n) {
        poke64(stat_buf + i * 8n, 0n);
    }

    if (fs_type === (1 as u8)) {
        // TTY (stdin/stdout/stderr): character device S_IFCHR (0x2000) | 0620
        poke64(stat_buf + 0n, 1n);          // st_dev
        poke64(stat_buf + 8n, (fd as u64) + 1n); // st_ino
        poke32(stat_buf + 16n, 0x2190 as u32); // st_mode = S_IFCHR | 0620
        poke32(stat_buf + 20n, 1 as u32);   // st_nlink
        poke64(stat_buf + 32n, 0x8800n);    // st_rdev
        poke32(stat_buf + 56n, 1024 as u32);// st_blksize
        return 0;
    }

    const size = peek64(fd_ptr + 16n);
    const ino = peek32(fd_ptr + 24n);
    const mode = peek16(fd_ptr + 28n) as u32;

    poke64(stat_buf + 0n, 1n);               // st_dev
    poke64(stat_buf + 8n, ino as u64);       // st_ino
    poke32(stat_buf + 16n, mode);            // st_mode
    poke32(stat_buf + 20n, 1 as u32);        // st_nlink
    poke64(stat_buf + 48n, size);            // st_size (offset 0x30)
    poke32(stat_buf + 56n, 4096 as u32);     // st_blksize (offset 0x38)
    poke64(stat_buf + 64n, udiv64(size + 511n, 512n)); // st_blocks (offset 0x40)

    return 0;
}

/**
 * Fills Linux AArch64 struct stat (128 bytes) by file path.
 */
export function vfs_stat(path: string, stat_buf: bigint): number {
    if (!ext2_lookup_path(path, scratch_inode)) {
        return -2; // -ENOENT
    }

    // Zero out stat buffer (128 bytes)
    for (let i = 0n; i < 16n; i = i + 1n) {
        poke64(stat_buf + i * 8n, 0n);
    }

    const ino = peek32(scratch_inode + 0n);
    const mode = peek16(scratch_inode + 4n) as u32;
    const size = peek64(scratch_inode + 8n);

    poke64(stat_buf + 0n, 1n);               // st_dev
    poke64(stat_buf + 8n, ino as u64);       // st_ino
    poke32(stat_buf + 16n, mode);            // st_mode
    poke32(stat_buf + 20n, 1 as u32);        // st_nlink
    poke64(stat_buf + 48n, size);            // st_size
    poke32(stat_buf + 56n, 4096 as u32);     // st_blksize
    poke64(stat_buf + 64n, udiv64(size + 511n, 512n)); // st_blocks

    return 0;
}

/**
 * Reads an entire file by path into dest_buf, returning the number of bytes read.
 */
export function vfs_read_all(path: string, dest_buf: bigint, max_len: u64): u64 {
    const fd = vfs_open(path, 0 as u32, 0 as u32);
    if (fd < 0) {
        return 0n;
    }

    const bytes = vfs_read(fd, dest_buf, max_len);
    vfs_close(fd);
    return bytes;
}
