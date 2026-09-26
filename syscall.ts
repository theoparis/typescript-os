// Linux AArch64 Syscall Dispatcher for tsos
import {
    peek8,
    poke8,
    peek64,
    poke64,
    print,
    printHex64,
    putchar,
} from "./uart.ts";
import { alloc_page, map_user_page } from "./mmu.ts";
import {
    vfs_open,
    vfs_close,
    vfs_read,
    vfs_pread,
    vfs_lseek,
    vfs_fstat,
    vfs_stat,
} from "./vfs.ts";

export type TrapFrame = {
    x0: u64;
    x1: u64;
    x2: u64;
    x3: u64;
    x4: u64;
    x5: u64;
    x6: u64;
    x7: u64;
    x8: u64;
    x9: u64;
    x10: u64;
    x11: u64;
    x12: u64;
    x13: u64;
    x14: u64;
    x15: u64;
    x16: u64;
    x17: u64;
    x18: u64;
    x19: u64;
    x20: u64;
    x21: u64;
    x22: u64;
    x23: u64;
    x24: u64;
    x25: u64;
    x26: u64;
    x27: u64;
    x28: u64;
    x29: u64;
    x30: u64;
    elr: u64;
    spsr: u64;
    esr: u64;
    far: u64;
};

let user_process_exited: boolean = false;
let user_process_exit_code: u64 = 0n;

let current_brk: bigint = 0x0000000021000000n;
let next_user_mmap: bigint = 0x0000000022000000n;
let scratch_path_buf: bigint = 0n;

function copy_string_to_user(dst_addr: bigint, src_str: string): void {
    const src = <Ref<u8>>(<Opaque>src_str);
    const dst = <Ref<u8>>(<Opaque>dst_addr);
    let i = 0n;
    while (true) {
        const ch = Deref(src[i]);
        Deref(dst[i]) = ch;
        if (ch === (0 as u8)) break;
        i = i + 1n;
    }
}

/**
 * Handles an AArch64 Linux system call from userspace (EL0).
 * Registers: x8 = syscall_nr, x0..x5 = args, return in x0.
 */
export function handle_linux_syscall(frame_ptr: bigint): void {
    const frame = <Ref<TrapFrame>>(<Opaque>frame_ptr);
    const syscall_nr = frame.x8;

    if (scratch_path_buf === 0n) {
        scratch_path_buf = alloc_page();
    }

    if (syscall_nr === 64n) {
        // sys_write(int fd, const char *buf, size_t count)
        const fd = frame.x0;
        const buf = frame.x1;
        const count = frame.x2;

        if (fd === 1n || fd === 2n) {
            const src = <Ref<u8>>(<Opaque>buf);
            for (let i = 0n; i < count; i = i + 1n) {
                putchar(Deref(src[i]));
            }
        }
        frame.x0 = count;
    } else if (syscall_nr === 66n) {
        // sys_writev(int fd, const struct iovec *iov, int vlen)
        const fd = frame.x0;
        const iov = frame.x1;
        const vlen = frame.x2;
        let total_written: u64 = 0n;

        for (let i = 0n; i < vlen; i = i + 1n) {
            const base = peek64(iov + i * 16n + 0n);
            const len = peek64(iov + i * 16n + 8n);
            if (fd === 1n || fd === 2n) {
                const src = <Ref<u8>>(<Opaque>base);
                for (let j = 0n; j < len; j = j + 1n) {
                    putchar(Deref(src[j]));
                }
            }
            total_written = total_written + len;
        }
        frame.x0 = total_written;
    } else if (syscall_nr === 93n || syscall_nr === 94n) {
        // sys_exit(int error_code) / sys_exit_group(int error_code)
        user_process_exit_code = frame.x0;
        user_process_exited = true;

        print("[tsos] Linux process exited via syscall 0x");
        printHex64(syscall_nr);
        print(" with exit code: 0x");
        printHex64(user_process_exit_code);
        print("\n");

        // Divert return address to kernel_exit_landing pad
        frame.elr = inline_asm<u64>(
            "adrp $0, kernel_exit_landing\nadd $0, $0, :lo12:kernel_exit_landing",
            "=r",
        );
        frame.spsr = 0x05n;
    } else if (syscall_nr === 96n) {
        // sys_set_tid_address(int *tidptr)
        frame.x0 = 1n; // tid = 1
    } else if (syscall_nr === 214n) {
        // sys_brk(unsigned long brk)
        const req_brk = frame.x0;
        if (req_brk !== 0n && req_brk >= current_brk) {
            const old_aligned = (current_brk + 4095n) & ~4095n;
            const new_aligned = (req_brk + 4095n) & ~4095n;
            for (let v = old_aligned; v < new_aligned; v = v + 4096n) {
                map_user_page(v, alloc_page(), true, false);
            }
            current_brk = req_brk;
        }
        frame.x0 = current_brk as u64;
    } else if (syscall_nr === 215n || syscall_nr === 223n) {
        // sys_munmap / sys_fadvise64
        frame.x0 = 0n; // success
    } else if (syscall_nr === 222n) {
        // sys_mmap(void *addr, size_t length, int prot, int flags, int fd, off_t offset)
        const addr = frame.x0;
        const length = frame.x1;
        const prot = frame.x2;
        const flags = frame.x3;
        const fd = frame.x4;
        const offset = frame.x5;

        let target_va = addr;
        const is_fixed = (flags & 0x10n) !== 0n; // MAP_FIXED
        if (!is_fixed && (target_va === 0n || target_va < 0x01000000n)) {
            target_va = next_user_mmap;
            const aligned_len = (length + 4095n) & ~4095n;
            next_user_mmap = next_user_mmap + aligned_len;
        }

        const is_write = (prot & 2n) !== 0n;
        const is_exec  = (prot & 4n) !== 0n;
        const is_anon  = (flags & 0x20n) !== 0n; // MAP_ANONYMOUS

        const va_start = target_va & ~4095n;
        const va_end   = (target_va + length + 4095n) & ~4095n;

        for (let v = va_start; v < va_end; v = v + 4096n) {
            const phys = alloc_page();
            if (!is_anon && (fd as number) >= 0) {
                const file_off = offset + (v - va_start);
                vfs_pread(fd as number, phys, 4096n, file_off);
            }
            map_user_page(v, phys, is_write, is_exec);
        }

        frame.x0 = target_va as u64;
    } else if (syscall_nr === 226n) {
        // sys_mprotect(void *addr, size_t len, int prot)
        frame.x0 = 0n; // success
    } else if (syscall_nr === 29n) {
        // sys_ioctl(int fd, unsigned long req, ...)
        frame.x0 = -25n as u64; // -ENOTTY
    } else if (syscall_nr === 56n) {
        // sys_openat(int dirfd, const char *pathname, int flags, mode_t mode)
        const path_ptr = frame.x1;
        const flags = frame.x2;
        const mode = frame.x3;

        let p_idx: u64 = 0n;
        while (true) {
            const ch = peek8(path_ptr + p_idx);
            poke8(scratch_path_buf + p_idx, ch);
            if (ch === (0 as u8)) break;
            p_idx = p_idx + 1n;
        }

        const path_str = <string>(<Opaque>scratch_path_buf);
        const res_fd = vfs_open(path_str, flags as u32, mode as u32);
        frame.x0 = res_fd as u64;
    } else if (syscall_nr === 57n) {
        // sys_close(int fd)
        const fd = frame.x0;
        const res = vfs_close(fd as number);
        frame.x0 = res as u64;
    } else if (syscall_nr === 63n) {
        // sys_read(int fd, void *buf, size_t count)
        const fd = frame.x0;
        const buf = frame.x1;
        const count = frame.x2;
        const bytes = vfs_read(fd as number, buf, count);
        frame.x0 = bytes;
    } else if (syscall_nr === 62n) {
        // sys_lseek(int fd, off_t offset, int whence)
        const fd = frame.x0;
        const offset = frame.x1;
        const whence = frame.x2;
        const new_off = vfs_lseek(fd as number, offset, whence as number);
        frame.x0 = new_off;
    } else if (syscall_nr === 79n) {
        // sys_newfstatat(int dirfd, const char *pathname, struct stat *statbuf, int flags)
        const path_ptr = frame.x1;
        const statbuf = frame.x2;

        let p_idx: u64 = 0n;
        while (true) {
            const ch = peek8(path_ptr + p_idx);
            poke8(scratch_path_buf + p_idx, ch);
            if (ch === (0 as u8)) break;
            p_idx = p_idx + 1n;
        }

        const path_str = <string>(<Opaque>scratch_path_buf);
        const res = vfs_stat(path_str, statbuf);
        frame.x0 = res as u64;
    } else if (syscall_nr === 80n) {
        // sys_fstat(int fd, struct stat *statbuf)
        const fd = frame.x0;
        const statbuf = frame.x1;
        const res = vfs_fstat(fd as number, statbuf);
        frame.x0 = res as u64;
    } else if (syscall_nr === 78n) {
        // sys_readlinkat(int dirfd, const char *pathname, char *buf, size_t bufsiz)
        frame.x0 = -22n as u64; // -EINVAL
    } else if (syscall_nr === 134n || syscall_nr === 135n) {
        // sys_rt_sigaction / sys_rt_sigprocmask
        frame.x0 = 0n; // success
    } else if (syscall_nr === 261n) {
        // sys_prlimit64(pid_t pid, int resource, const struct rlimit64 *new_limit, struct rlimit64 *old_limit)
        frame.x0 = 0n; // success
    } else if (syscall_nr === 278n) {
        // sys_getrandom(void *buf, size_t buflen, unsigned int flags)
        const buf = frame.x0;
        const buflen = frame.x1;
        for (let i = 0n; i < buflen; i = i + 1n) {
            poke8(buf + i, (0x41 + (i & 0x1fn)) as u8);
        }
        frame.x0 = buflen;
    } else if (syscall_nr === 172n || syscall_nr === 178n) {
        // sys_getpid / sys_gettid
        frame.x0 = 1n;
    } else if (syscall_nr >= 174n && syscall_nr <= 177n) {
        // sys_getuid, sys_geteuid, sys_getgid, sys_getegid
        frame.x0 = 0n;
    } else if (syscall_nr === 160n) {
        // sys_uname(struct utsname *buf)
        const buf = frame.x0;
        copy_string_to_user(buf + 0n, "Linux");
        copy_string_to_user(buf + 65n, "tsos");
        copy_string_to_user(buf + 130n, "6.6.0");
        copy_string_to_user(buf + 195n, "tsos-aarch64");
        copy_string_to_user(buf + 260n, "aarch64");
        frame.x0 = 0n;
    } else {
        print("[tsos] Unimplemented Linux syscall nr: 0x");
        printHex64(syscall_nr);
        print("\n");
        frame.x0 = -38n as u64; // -ENOSYS (-38)
    }
}
