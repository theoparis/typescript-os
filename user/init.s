// Linux AArch64 static ELF user program
.global _start
.text
_start:
    // write(1, msg, len)
    mov x8, #64         // sys_write
    mov x0, #1          // stdout
    adr x1, msg
    mov x2, #len_msg
    svc #0

    // exit(0)
    mov x8, #93         // sys_exit
    mov x0, #0          // status = 0
    svc #0

msg:
    .ascii "Hello from Linux-compatible static ELF in userspace (EL0) on tsos!\n"
    len_msg = . - msg
