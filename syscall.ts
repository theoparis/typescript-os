// Linux AArch64 Syscall Dispatcher

import { print, printHex64, putchar } from "./uart.ts";

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
    // Return number of bytes written in x0
    frame.x0 = count;
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
    // Set SPSR_EL1 to EL1h (0x05) to switch back to kernel mode on eret
    frame.spsr = 0x05n;
  } else if (syscall_nr === 214n) {
    // sys_brk(unsigned long brk)
    const req_brk = frame.x0;
    if (req_brk !== 0n && req_brk >= current_brk) {
      current_brk = req_brk;
    }
    frame.x0 = current_brk as u64;
  } else if (syscall_nr === 160n) {
    // sys_uname(struct utsname *buf)
    // utsname format: char sysname[65], nodename[65], release[65], version[65], machine[65]
    const buf = frame.x0;
    copy_string_to_user(buf + 0n, "Linux");
    copy_string_to_user(buf + 65n, "tsos");
    copy_string_to_user(buf + 130n, "6.6.0");
    copy_string_to_user(buf + 195n, "tsos-aarch64");
    copy_string_to_user(buf + 260n, "aarch64");

    frame.x0 = 0n; // success = 0
  } else {
    print("[tsos] Unimplemented Linux syscall nr: 0x");
    printHex64(syscall_nr);
    print("\n");
    frame.x0 = -38n as u64; // -ENOSYS (-38)
  }
}
