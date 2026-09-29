// Linux AArch64 Syscall Dispatcher for tsos
import {
    peek8,
    poke8,
    peek16,
    poke16,
    peek64,
    poke64,
    printHex64,
    putchar,
    has_char,
    now_ticks,
} from "./uart.ts";
import {
    alloc_page,
    get_page_size,
    get_page_mask,
    map_user_page,
    current_root_table,
    switch_user_root_table,
    clone_user_address_space,
} from "./mmu.ts";
import { execve_load } from "./elf.ts";
import {
    vfs_open,
    vfs_close,
    vfs_read,
    vfs_pread,
    vfs_lseek,
    vfs_fstat,
    vfs_stat,
    vfs_dup,
    vfs_dup2,
    vfs_write,
    vfs_pipe2,
    vfs_getdents64,
    vfs_tcgets,
    vfs_tcsets,
    current_vfs_proc,
    vfs_clone_proc_fds,
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

let current_proc_pid: u32 = 1 as u32;
let child_proc_pid: u32 = 0 as u32;
let child_proc_exit_code: u64 = 0n;
let child_proc_exited: boolean = false;
let parent_saved_frame: bigint = 0n;
let parent_saved_root: bigint = 0n;
let parent_saved_sp_el0: bigint = 0n;
let parent_saved_brk: bigint = 0n;
let parent_saved_mmap: bigint = 0n;

let current_brk: bigint = 0x0000000021000000n;
let next_user_mmap: bigint = 0x0000000022000000n;
let scratch_path_buf: bigint = 0n;
let scratch_stat_buf: bigint = 0n;
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
        scratch_stat_buf = alloc_page();
    }

    if (syscall_nr === 64n) {
        // sys_write(int fd, const char *buf, size_t count)
        const fd = frame.x0;
        const buf = frame.x1;
        const count = frame.x2;
        frame.x0 = vfs_write(fd as number, buf, count);
    } else if (syscall_nr === 65n) {
        // sys_readv(int fd, const struct iovec *iov, int vlen)
        const fd = frame.x0;
        const iov = frame.x1;
        const vlen = frame.x2;
        let total_read: u64 = 0n;
        for (let i = 0n; i < vlen; i = i + 1n) {
            const base = peek64(iov + i * 16n + 0n);
            const len  = peek64(iov + i * 16n + 8n);
            if (len > 0n) {
                const r = vfs_read(fd as number, base, len);
                if (r > 0n) {
                    total_read = total_read + r;
                    break;
                }
            }
        }
        frame.x0 = total_read;
    } else if (syscall_nr === 66n) {
        const fd = frame.x0;
        const iov = frame.x1;
        const vlen = frame.x2;
        let total_written: u64 = 0n;
        for (let i = 0n; i < vlen; i = i + 1n) {
            const base = peek64(iov + i * 16n + 0n);
            const len = peek64(iov + i * 16n + 8n);
            total_written = total_written + vfs_write(fd as number, base, len);
        }
        frame.x0 = total_written;
    } else if (syscall_nr === 93n || syscall_nr === 94n) {
        // sys_exit / sys_exit_group
        if (current_proc_pid === (1 as u32)) {
            user_process_exit_code = frame.x0;
            user_process_exited = true;

            print("[tsos] Linux process exited via syscall 0x");
            printHex64(syscall_nr);
            print(" with exit code: 0x");
            printHex64(user_process_exit_code);
            print("\n");

            frame.elr = inline_asm<u64>(
                "adrp $0, kernel_exit_landing\nadd $0, $0, :lo12:kernel_exit_landing",
                "=r",
            );
            frame.spsr = 0x05n;
            return;
        } else {
            // Child process exited: restore parent context
            child_proc_exit_code = frame.x0;
            child_proc_exited = true;
            current_proc_pid = 1 as u32;
            current_vfs_proc = 1 as u32;
            for (let i = 0n; i < 36n; i = i + 1n) {
                poke64(frame_ptr + i * 8n, peek64(parent_saved_frame + i * 8n));
            }
            inline_asm("msr sp_el0, $0", "r", parent_saved_sp_el0);
            current_brk = parent_saved_brk;
            next_user_mmap = parent_saved_mmap;

            switch_user_root_table(parent_saved_root);
            return;
        }
    } else if (syscall_nr === 96n) {
        // sys_set_tid_address(int *tidptr)
        frame.x0 = 1n; // tid = 1
    } else if (syscall_nr === 17n) {
        // sys_getcwd(char *buf, size_t size)
        const buf = frame.x0;
        copy_string_to_user(buf, "/");
        frame.x0 = buf; // returns pointer to buf
    } else if (syscall_nr === 48n || syscall_nr === 439n) {
        // sys_faccessat / sys_faccessat2
        const path_ptr = frame.x1;
        let p_idx: u64 = 0n;
        while (true) {
            const ch = peek8(path_ptr + p_idx);
            poke8(scratch_path_buf + p_idx, ch);
            if (ch === (0 as u8)) break;
            p_idx = p_idx + 1n;
        }
        const path_str = <string>(<Opaque>scratch_path_buf);
        const exists = vfs_stat(path_str, scratch_stat_buf) === 0;
        frame.x0 = exists ? 0n : (-2n as u64); // 0 = success, -ENOENT = -2
    } else if (syscall_nr === 205n) {
        // sys_getpeername(int fd, struct sockaddr *addr, socklen_t *addrlen)
        frame.x0 = -88n as u64; // -ENOTSOCK
    } else if (syscall_nr === 214n) {
        // sys_brk(unsigned long brk)
        const req_brk = frame.x0;
        if (req_brk !== 0n && req_brk >= current_brk) {
            const old_aligned = (current_brk + get_page_mask()) & ~get_page_mask();
            const new_aligned = (req_brk + get_page_mask()) & ~get_page_mask();
            for (let v = old_aligned; v < new_aligned; v = v + get_page_size()) {
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
            const aligned_len = (length + get_page_mask()) & ~get_page_mask();
            next_user_mmap = next_user_mmap + aligned_len;
        }

        const is_write = (prot & 2n) !== 0n;
        const is_exec  = (prot & 4n) !== 0n;
        const is_anon  = (flags & 0x20n) !== 0n; // MAP_ANONYMOUS

        const va_start = target_va & ~get_page_mask();
        const va_end   = (target_va + length + get_page_mask()) & ~get_page_mask();

        for (let v = va_start; v < va_end; v = v + get_page_size()) {
            const phys = alloc_page();
            if (!is_anon && (fd as number) >= 0) {
                const file_off = offset + (v - va_start);
                vfs_pread(fd as number, phys, get_page_size(), file_off);
            }
            map_user_page(v, phys, is_write, is_exec);
        }

        frame.x0 = target_va as u64;
    } else if (syscall_nr === 226n) {
        // sys_mprotect(void *addr, size_t len, int prot)
        frame.x0 = 0n; // success
    } else if (syscall_nr === 29n) {
        // sys_ioctl(int fd, unsigned long req, void *arg)
        const fd = frame.x0;
        const req = frame.x1;
        const arg = frame.x2;

        if (req === 0x5401n) {
            // TCGETS (termios)
            vfs_tcgets(arg);
            frame.x0 = 0n;
        } else if (req === 0x5402n || req === 0x5403n || req === 0x5404n) {
            // TCSETS, TCSETSW, TCSETSF
            vfs_tcsets(arg);
            frame.x0 = 0n;
        } else if (req === 0x5413n) {
            // TIOCGWINSZ
            if (arg !== 0n) {
                poke16(arg + 0n, 24 as u16); // 24 rows
                poke16(arg + 2n, 80 as u16); // 80 cols
                poke16(arg + 4n, 0 as u16);
                poke16(arg + 6n, 0 as u16);
            }
            frame.x0 = 0n;
        } else if (req === 0x5414n) {
            // TIOCSWINSZ
            frame.x0 = 0n;
        } else if (req === 0x540fn) {
            // TIOCGPGRP
            if (arg !== 0n) poke32(arg, 1 as u32);
            frame.x0 = 0n;
        } else if (req === 0x5410n) {
            // TIOCSPGRP
            frame.x0 = 0n;
        } else {
            frame.x0 = -25n as u64; // -ENOTTY
        }
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
    } else if (syscall_nr === 59n) {
        // sys_pipe2(int pipefd[2], int flags)
        const pipefd_ptr = frame.x0;
        const flags = frame.x1;
        const res = vfs_pipe2(pipefd_ptr, flags as u32);
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
    } else if (syscall_nr === 61n) {
        // sys_getdents64(int fd, struct linux_dirent64 *dirp, size_t count)
        const fd = frame.x0;
        const dirp = frame.x1;
        const count = frame.x2;
        const res = vfs_getdents64(fd as number, dirp, count);
        frame.x0 = res;
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
        const path_ptr = frame.x1;
        const buf = frame.x2;
        const bufsiz = frame.x3;
        if (peek8(path_ptr) === (47 as u8) && peek8(path_ptr + 1n) === (112 as u8)) {
            copy_string_to_user(buf, "/dev/tty");
            frame.x0 = 8n;
        } else {
            frame.x0 = -22n as u64; // -EINVAL
        }
    } else if (syscall_nr === 23n) {
        // sys_dup(int oldfd)
        const oldfd = frame.x0;
        const newfd = vfs_dup(oldfd as number);
        frame.x0 = newfd as u64;
    } else if (syscall_nr === 24n) {
        // sys_dup3(int oldfd, int newfd, int flags)
        const oldfd = frame.x0;
        const newfd = frame.x1;
        const res = vfs_dup2(oldfd as number, newfd as number);
        frame.x0 = res as u64;
    } else if (syscall_nr === 72n || syscall_nr === 73n) {
        // sys_pselect6 / sys_ppoll: wait for readiness on the TTY (fd 0)
        // with proper timeout semantics.
        let tmo_ptr: u64 = 0n;
        let monitors_stdin = false;

        if (syscall_nr === 73n) {
            // ppoll(struct pollfd *fds, nfds_t nfds, const struct timespec *tmo, ...)
            const fds = frame.x0;
            const nfds = frame.x1;
            tmo_ptr = frame.x2;
            for (let i = 0n; i < nfds; i = i + 1n) {
                const pfd_fd = peek32(fds + i * 8n) as u64;
                poke16(fds + i * 8n + 6n, 0 as u16); // Linux zeroes revents on entry
                if (pfd_fd === 0n) {
                    monitors_stdin = true;
                    if (has_char()) {
                        poke16(fds + i * 8n + 6n, 1 as u16); // POLLIN -> revents
                    }
                }
            }
        } else {
            // pselect6(int nfds, fd_set *readfds, fd_set *writefds, fd_set *exceptfds, timespec *tmo, sigmask)
            const nfds = frame.x0;
            const readfds = frame.x1;
            tmo_ptr = frame.x4;
            if (readfds !== 0n && nfds > 0n && (peek64(readfds) & 1n) !== 0n) {
                monitors_stdin = true;
            }
        }

        if (!monitors_stdin) {
            frame.x0 = 0n;
        } else if (has_char()) {
            frame.x0 = 1n;
        } else {
            let wait_ticks: u64 = 0n;
            let infinite = false;
            if (tmo_ptr === 0n) {
                infinite = true;
            } else {
                const tmo_sec = peek64(tmo_ptr);
                const tmo_nsec = peek64(tmo_ptr + 8n);
                if (tmo_sec === 0n && tmo_nsec === 0n) {
                    wait_ticks = 0n; // poll: return immediately
                } else {
                    // Timer runs at 50 Hz (20 ms per tick).
                    wait_ticks = tmo_sec * 50n + tmo_nsec / 20000000n + 1n;
                }
            }

            if (infinite) {
                while (!has_char()) {
                }
                frame.x0 = 1n;
            } else if (wait_ticks === 0n) {
                frame.x0 = 0n;
            } else {
                const deadline = now_ticks() + wait_ticks;
                while (!has_char() && now_ticks() < deadline) {
                }
                frame.x0 = has_char() ? 1n : 0n;
            }

            if (frame.x0 === 0n && syscall_nr === 72n && frame.x1 !== 0n) {
                // Report no ready descriptors (Linux clears the sets).
                poke64(frame.x1, 0n);
            }
        }
    } else if (syscall_nr === 154n) {
        // sys_setpgid(pid_t pid, pid_t pgid)
        frame.x0 = 0n;
    } else if (syscall_nr === 151n || syscall_nr === 152n) {
        // sys_setfsuid / sys_setfsgid
        frame.x0 = 0n; // previous uid/gid 0
    } else if (syscall_nr === 220n) {
        // sys_clone(unsigned long flags, void *child_stack, ...)
        const newsp = frame.x1;

        if (parent_saved_frame === 0n) {
            parent_saved_frame = alloc_page();
        }

        // Save parent trap frame
        for (let i = 0n; i < 36n; i = i + 1n) {
            poke64(parent_saved_frame + i * 8n, peek64(frame_ptr + i * 8n));
        }
        // Parent returns child PID 2
        poke64(parent_saved_frame + 0n, 2n);
        parent_saved_root = current_root_table;
        parent_saved_sp_el0 = inline_asm<u64>("mrs $0, sp_el0", "=r");
        parent_saved_brk = current_brk;
        parent_saved_mmap = next_user_mmap;

        // Clone address space for child
        const child_root = clone_user_address_space(parent_saved_root);

        current_proc_pid = 2 as u32;
        child_proc_pid = 2 as u32;
        child_proc_exited = false;
        current_vfs_proc = 2 as u32;
        vfs_clone_proc_fds(1 as u32, 2 as u32);

        // Child returns 0 from clone
        frame.x0 = 0n;
        if (newsp !== 0n) {
            inline_asm("msr sp_el0, $0", "r", newsp);
        }

        switch_user_root_table(child_root);
        return;
    } else if (syscall_nr === 221n) {
        // sys_execve(const char *filename, char *const argv[], char *const envp[])
        const path_ptr = frame.x0;
        const argv_ptr = frame.x1;

        let p_idx: u64 = 0n;
        while (true) {
            const ch = peek8(path_ptr + p_idx);
            poke8(scratch_path_buf + p_idx, ch);
            if (ch === (0 as u8)) break;
            p_idx = p_idx + 1n;
        }
        let path_buf: bigint = scratch_path_buf;

        if (peek8(scratch_path_buf) !== (47 as u8)) {
            const bin_path = alloc_page();
            poke8(bin_path + 0n, 47 as u8); // '/'
            poke8(bin_path + 1n, 98 as u8); // 'b'
            poke8(bin_path + 2n, 105 as u8); // 'i'
            poke8(bin_path + 3n, 110 as u8); // 'n'
            poke8(bin_path + 4n, 47 as u8); // '/'
            for (let i = 0n; i <= p_idx; i = i + 1n) {
                poke8(bin_path + 5n + i, peek8(scratch_path_buf + i));
            }
            if (vfs_stat(<string>(<Opaque>bin_path), scratch_stat_buf) === 0) {
                path_buf = bin_path;
            }
        }

        const ok = execve_load(<string>(<Opaque>path_buf), argv_ptr, frame_ptr);
        if (!ok) {
            frame.x0 = -2n as u64; // -ENOENT
        }
        return;
    } else if (syscall_nr === 260n) {
        // sys_wait4(pid_t pid, int *wstatus, int options, struct rusage *rusage)
        const status_ptr = frame.x1;
        if (child_proc_exited) {
            if (status_ptr !== 0n) {
                poke32(status_ptr, ((child_proc_exit_code & 0xffn) << 8n) as u32);
            }
            child_proc_exited = false;
            frame.x0 = (child_proc_pid as u64);
        } else {
            frame.x0 = -10n as u64; // -ECHILD
        }
    } else if (syscall_nr === 25n) {
        // sys_fcntl(int fd, int cmd, unsigned long arg)
        frame.x0 = 0n;
    } else if (syscall_nr === 113n) {
        // sys_clock_gettime(clockid_t which_clock, struct timespec *tp)
        const tp = frame.x1;
        poke64(tp + 0n, 1700000000n); // tv_sec
        poke64(tp + 8n, 0n);          // tv_nsec
        frame.x0 = 0n;
    } else if (syscall_nr === 148n) {
        // sys_getresuid(uid_t *ruid, uid_t *euid, uid_t *suid)
        if (frame.x0 !== 0n) poke32(frame.x0, 0 as u32);
        if (frame.x1 !== 0n) poke32(frame.x1, 0 as u32);
        if (frame.x2 !== 0n) poke32(frame.x2, 0 as u32);
        frame.x0 = 0n;
    } else if (syscall_nr === 150n) {
        // sys_getresgid(gid_t *rgid, gid_t *egid, gid_t *sgid)
        if (frame.x0 !== 0n) poke32(frame.x0, 0 as u32);
        if (frame.x1 !== 0n) poke32(frame.x1, 0 as u32);
        if (frame.x2 !== 0n) poke32(frame.x2, 0 as u32);
        frame.x0 = 0n;
    } else if (syscall_nr === 155n || syscall_nr === 173n) {
        // sys_getpgid / sys_getppid
        frame.x0 = 1n;
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
