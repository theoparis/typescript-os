TARGET_TRIPLE ?= aarch64-unknown-none-elf

TSLANG ?= tslang
ifeq ($(origin CC),default)
CC := clang
endif
QEMU ?= qemu-system-aarch64

BUILD_DIR ?= build
TARGET ?= $(BUILD_DIR)/boot/kernel.elf
LINKER_SCRIPT ?= linker.ld

TSFLAGS ?= --mtriple=$(TARGET_TRIPLE) --mm=rc --emit=obj
ASFLAGS ?= --target=$(TARGET_TRIPLE)
LDFLAGS ?= -fuse-ld=lld -nostdlib -T$(LINKER_SCRIPT) --target=$(TARGET_TRIPLE)
QEMUFLAGS ?= -M virt -cpu cortex-a53 -nographic

OBJS := $(BUILD_DIR)/boot.o $(BUILD_DIR)/kernel.o

export PATH := $(HOME)/src/TypeScriptCompiler/build/bin:$(PATH)

.PHONY: all clean run

all: $(TARGET)

$(TARGET): $(OBJS) $(LINKER_SCRIPT) | $(BUILD_DIR)/boot
	$(CC) $(LDFLAGS) $(OBJS) -o $@

$(BUILD_DIR)/boot.o: boot.s | $(BUILD_DIR)
	$(CC) $(ASFLAGS) -c $< -o $@

$(BUILD_DIR)/kernel.o: kernel.ts | $(BUILD_DIR)
	$(TSLANG) $(TSFLAGS) -o $@ $<

$(BUILD_DIR) $(BUILD_DIR)/boot:
	mkdir -p $@

clean:
	rm -rf $(BUILD_DIR)

run: $(TARGET)
	$(QEMU) $(QEMUFLAGS) -kernel $(TARGET)
