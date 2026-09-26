.balign 2048
.global vector_table

// AArch64 Exception Vector Table
// Base address is programmed into VBAR_EL1.
// Table must be aligned to a 2048-byte boundary.
// 16 entries, each 128 bytes (32 instructions).

vector_table:
    // --- Current EL with SP0 ---
    .balign 128
    b .
    .balign 128
    b .
    .balign 128
    b .
    .balign 128
    b .

    // --- Current EL with SPx ---
    .balign 128
    b sync_current_el_spx
    .balign 128
    b irq_current_el_spx
    .balign 128
    b .
    .balign 128
    b .

    // --- Lower EL using AArch64 ---
    .balign 128
    b sync_lower_el_aarch64
    .balign 128
    b irq_lower_el_aarch64
    .balign 128
    b .
    .balign 128
    b .

    // --- Lower EL using AArch32 ---
    .balign 128
    b .
    .balign 128
    b .
    .balign 128
    b .
    .balign 128
    b .

sync_current_el_spx:
    // Save general purpose registers x0-x30 and system registers
    // Total frame size: 36 * 8 = 288 bytes (16-byte aligned)
    sub sp, sp, #288
    stp x0, x1, [sp, #0]
    stp x2, x3, [sp, #16]
    stp x4, x5, [sp, #32]
    stp x6, x7, [sp, #48]
    stp x8, x9, [sp, #64]
    stp x10, x11, [sp, #80]
    stp x12, x13, [sp, #96]
    stp x14, x15, [sp, #112]
    stp x16, x17, [sp, #128]
    stp x18, x19, [sp, #144]
    stp x20, x21, [sp, #160]
    stp x22, x23, [sp, #176]
    stp x24, x25, [sp, #192]
    stp x26, x27, [sp, #208]
    stp x28, x29, [sp, #224]
    str x30, [sp, #240]

    mrs x0, elr_el1
    mrs x1, spsr_el1
    mrs x2, esr_el1
    mrs x3, far_el1
    stp x0, x1, [sp, #248]
    stp x2, x3, [sp, #264]

    // Pass pointer to saved TrapFrame in x0
    mov x0, sp
    bl handle_sync_exception

    // Restore system registers (ELR and SPSR may have been modified by handler)
    ldp x0, x1, [sp, #248]
    msr elr_el1, x0
    msr spsr_el1, x1

    // Restore x0-x30
    ldp x0, x1, [sp, #0]
    ldp x2, x3, [sp, #16]
    ldp x4, x5, [sp, #32]
    ldp x6, x7, [sp, #48]
    ldp x8, x9, [sp, #64]
    ldp x10, x11, [sp, #80]
    ldp x12, x13, [sp, #96]
    ldp x14, x15, [sp, #112]
    ldp x16, x17, [sp, #128]
    ldp x18, x19, [sp, #144]
    ldp x20, x21, [sp, #160]
    ldp x22, x23, [sp, #176]
    ldp x24, x25, [sp, #192]
    ldp x26, x27, [sp, #208]
    ldp x28, x29, [sp, #224]
    ldr x30, [sp, #240]
    add sp, sp, #288
    eret

irq_current_el_spx:
    sub sp, sp, #288
    stp x0, x1, [sp, #0]
    stp x2, x3, [sp, #16]
    stp x4, x5, [sp, #32]
    stp x6, x7, [sp, #48]
    stp x8, x9, [sp, #64]
    stp x10, x11, [sp, #80]
    stp x12, x13, [sp, #96]
    stp x14, x15, [sp, #112]
    stp x16, x17, [sp, #128]
    stp x18, x19, [sp, #144]
    stp x20, x21, [sp, #160]
    stp x22, x23, [sp, #176]
    stp x24, x25, [sp, #192]
    stp x26, x27, [sp, #208]
    stp x28, x29, [sp, #224]
    str x30, [sp, #240]

    mrs x0, elr_el1
    mrs x1, spsr_el1
    mrs x2, esr_el1
    mrs x3, far_el1
    stp x0, x1, [sp, #248]
    stp x2, x3, [sp, #264]

    mov x0, sp
    bl handle_irq_exception

    ldp x0, x1, [sp, #248]
    msr elr_el1, x0
    msr spsr_el1, x1

    ldp x0, x1, [sp, #0]
    ldp x2, x3, [sp, #16]
    ldp x4, x5, [sp, #32]
    ldp x6, x7, [sp, #48]
    ldp x8, x9, [sp, #64]
    ldp x10, x11, [sp, #80]
    ldp x12, x13, [sp, #96]
    ldp x14, x15, [sp, #112]
    ldp x16, x17, [sp, #128]
    ldp x18, x19, [sp, #144]
    ldp x20, x21, [sp, #160]
    ldp x22, x23, [sp, #176]
    ldp x24, x25, [sp, #192]
    ldp x26, x27, [sp, #208]
    ldp x28, x29, [sp, #224]
    ldr x30, [sp, #240]
    add sp, sp, #288
    eret

sync_lower_el_aarch64:
    b sync_current_el_spx

irq_lower_el_aarch64:
    b irq_current_el_spx
